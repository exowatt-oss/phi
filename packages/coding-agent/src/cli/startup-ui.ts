import {
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { existsSync } from "fs";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir, getEnvAgentDir, getSettingsPath, PACKAGE_NAME } from "../config.ts";
import { areExperimentalFeaturesEnabled } from "../core/experimental.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import {
	StartupProgressComponent,
	type StartupProgressStage,
} from "../modes/interactive/components/startup-progress.ts";
import { SYSTEM_THEME_NAME } from "../modes/interactive/theme/system-theme.ts";
import {
	getTerminalTheme,
	initTheme,
	loadThemeFromPath,
	markTerminalColorsPending,
	resolveThemeSetting,
	setRegisteredThemes,
	setTerminalColors,
	setTheme,
	type Theme,
} from "../modes/interactive/theme/theme.ts";
import { requestTerminalColors } from "../modes/interactive/theme/theme-controller.ts";

const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const OFFICIAL_APP_NAME = "pi";
const OFFICIAL_CONFIG_DIR_NAME = ".pi";

interface DistributionMetadata {
	packageName: string;
	appName: string;
	configDirName: string;
}

function isOfficialDistribution({ packageName, appName, configDirName }: DistributionMetadata): boolean {
	return (
		packageName === OFFICIAL_PACKAGE_NAME &&
		appName === OFFICIAL_APP_NAME &&
		configDirName === OFFICIAL_CONFIG_DIR_NAME
	);
}

function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();
	for (const resource of resources) {
		if (!resource.enabled) continue;
		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}
			themes.push(loadedTheme);
		} catch {
			// Startup prompts should not fail because a theme is broken. The normal
			// resource loader reports theme diagnostics later in startup.
		}
	}
	return themes;
}

async function loadStartupThemes(settingsManager: SettingsManager): Promise<Theme[]> {
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		settingsManager: globalSettingsManager,
	});
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	return loadThemes(resolvedPaths.themes);
}

export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	// The system theme starts in grayscale until the terminal reports its colors.
	markTerminalColorsPending();
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	setKeybindings(KeybindingsManager.create());
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export interface StartupProgressHandle {
	update(stage: StartupProgressStage): void;
	pause(): Promise<void>;
	resume(): Promise<void>;
	close(): Promise<void>;
}

const INITIAL_STARTUP_PROGRESS_STAGE: StartupProgressStage = {
	current: 1,
	total: 6,
	message: "Loading session",
};

const STARTUP_UI_CLEAR_DELAY_MS = 25;

function createStartupProgressUi(
	settingsManager: SettingsManager,
	stage: StartupProgressStage,
	onCancel: () => void,
): { ui: TUI; component: StartupProgressComponent } {
	// This UI intentionally does not load package resources or query the terminal. It is
	// the first thing shown while those slower startup steps are still pending. The system
	// theme with no reported colors uses the terminal's own palette and default colors.
	setRegisteredThemes([]);
	initTheme(SYSTEM_THEME_NAME);
	setKeybindings(KeybindingsManager.create());

	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	const component = new StartupProgressComponent(ui, stage, onCancel);
	ui.addChild(component);
	ui.setFocus(component);
	ui.start();
	return { ui, component };
}

/**
 * Start the minimal loader shown during interactive startup. Unlike startup prompts,
 * this path must not resolve packages, custom themes, or terminal color queries.
 */
export function startStartupProgress(settingsManager: SettingsManager): StartupProgressHandle {
	let stage = { ...INITIAL_STARTUP_PROGRESS_STAGE };
	let ui: TUI | undefined;
	let component: StartupProgressComponent | undefined;
	let paused = false;
	let closed = false;
	let cancelRequested = false;
	let closePromise: Promise<void> | undefined;
	let transition: Promise<void> = Promise.resolve();

	const cleanupOnExit = (): void => {
		const activeComponent = component;
		const activeUi = ui;
		component = undefined;
		ui = undefined;
		try {
			activeComponent?.dispose();
		} catch {
			// Process teardown must not be interrupted by component cleanup errors.
		} finally {
			try {
				activeUi?.stop();
			} catch {
				// Process teardown must not be interrupted by terminal cleanup errors.
			}
		}
	};
	process.once("exit", cleanupOnExit);

	const enqueue = (operation: () => Promise<void> | void): Promise<void> => {
		const next = transition.then(operation);
		transition = next.catch(() => {});
		return next;
	};

	const stopMountedUi = async (): Promise<void> => {
		const activeUi = ui;
		const activeComponent = component;
		ui = undefined;
		component = undefined;
		if (!activeUi) return;

		try {
			activeUi.clear();
			activeUi.requestRender();
			await new Promise((resolve) => setTimeout(resolve, STARTUP_UI_CLEAR_DELAY_MS));
			await activeUi.terminal.drainInput(1000, 50);
		} catch {
			// Terminal cleanup below is still attempted if rendering or draining fails.
		} finally {
			try {
				activeComponent?.dispose();
			} catch {
				// Cleanup is best effort; restoring the terminal remains the priority.
			} finally {
				try {
					activeUi.stop();
				} catch {
					// Cleanup is best effort; restoring the terminal remains the priority.
				}
			}
		}
	};

	const mount = (): void => {
		if (closed || paused || ui) return;
		const mounted = createStartupProgressUi(settingsManager, stage, () => {
			if (cancelRequested || closed) return;
			cancelRequested = true;
			void handle.close().finally(() => process.exit(130));
		});
		ui = mounted.ui;
		component = mounted.component;
	};

	const handle: StartupProgressHandle = {
		update(nextStage) {
			if (closed) return;
			stage = { ...nextStage };
			component?.setStage(stage);
			ui?.invalidate();
			ui?.requestRender();
		},
		pause() {
			if (closed || paused) return transition;
			paused = true;
			return enqueue(stopMountedUi);
		},
		resume() {
			if (closed || !paused) return transition;
			paused = false;
			return enqueue(() => {
				if (!closed && !paused) mount();
			});
		},
		close() {
			if (closePromise) return closePromise;
			closed = true;
			paused = false;
			closePromise = enqueue(async () => {
				try {
					await stopMountedUi();
				} finally {
					process.off("exit", cleanupOnExit);
				}
			});
			return closePromise;
		},
	};

	mount();
	return handle;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	const themeSetting = settingsManager.getThemeSetting();
	queryStartupTerminalColors(ui, () => {
		setTheme(resolveThemeSetting(themeSetting, getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	});
}

/**
 * Query the terminal's colors without waiting for them. When they arrive, including after the timeout,
 * record them for the system theme and "" (terminal default) tokens, run `onColors`, and re-render.
 */
function queryStartupTerminalColors(ui: TUI, onColors: () => void): void {
	void requestTerminalColors(ui, (colors) => {
		setTerminalColors(colors);
		onColors();
		ui.invalidate();
		ui.requestRender();
	});
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * First-time setup runs when all of these hold:
 * - this is the official Pi distribution (not a fork/rebrand)
 * - experimental features are enabled (PI_EXPERIMENTAL=1)
 * - the default agent directory is used (no custom agent dir override)
 * - setup was not completed before (settings.json does not exist)
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (
		!isOfficialDistribution({
			packageName: PACKAGE_NAME,
			appName: APP_NAME,
			configDirName: CONFIG_DIR_NAME,
		})
	) {
		return false;
	}
	if (!areExperimentalFeaturesEnabled()) {
		return false;
	}
	if (getEnvAgentDir()) {
		return false;
	}
	return !existsSync(settingsPath);
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager);
	});
}

/** Show the first-time setup dialog and persist the result */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};

		ui.start();
		let previewTheme = SYSTEM_THEME_NAME;
		setTheme(previewTheme);
		const component = new FirstTimeSetupComponent({
			onThemePreview: (themeName) => {
				previewTheme = themeName;
				setTheme(themeName);
				ui.requestRender();
			},
			onSubmit: (result) => void finish(result),
			onCancel: () => void finish(undefined),
		});
		ui.addChild(component);
		ui.setFocus(component);
		ui.requestRender();
		// The terminal's colors regenerate the system theme; re-rendering rebuilds the dialog with it.
		queryStartupTerminalColors(ui, () => setTheme(previewTheme));
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager);
	});
}
