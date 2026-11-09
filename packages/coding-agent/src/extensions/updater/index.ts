import { spawn } from "node:child_process";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { AUTO_UPDATE_CHECK_INTERVAL_MS, autoUpdatePhi } from "./auto-update.ts";
import { checkForPhiUpdate, PHI_UPDATE_BASE_URL, type PhiRelease, readCurrentPhiRelease } from "./version.ts";

type PhiUpdate = NonNullable<Awaited<ReturnType<typeof checkForPhiUpdate>>>;

/**
 * Shell that fetches the installer and runs it. Deliberately not `curl | sh`:
 * with a pipe, a failed download leaves `sh` reading empty stdin and exiting 0,
 * so the upgrade would report success having installed nothing. Download to a
 * temp file first and run `sh` only once curl has succeeded; the exit status
 * is the installer's (or curl's).
 */
export const PHI_UPGRADE_SHELL_SCRIPT = [
	// Plain mktemp (no template) honours TMPDIR on both BSD and GNU.
	'tmp="$(mktemp)" || exit 1',
	"trap 'rm -f \"$tmp\"' EXIT INT TERM",
	'curl -fsSL "$1" -o "$tmp" || { echo "phi-upgrade: download failed: $1" >&2; exit 1; }',
	'[ -s "$tmp" ] || { echo "phi-upgrade: downloaded installer is empty: $1" >&2; exit 1; }',
	'PHI_INSTALL_BASE_URL="$2" sh "$tmp"',
].join("\n");

/** The one-liner a human runs when phi cannot upgrade itself. */
export function getPhiInstallerCommand(
	appName = "phi",
	downloadsBaseUrl = process.env.PHI_UPDATE_BASE_URL ?? PHI_UPDATE_BASE_URL,
): string {
	return `curl -fsSL ${downloadsBaseUrl.replace(/\/+$/, "")}/${appName}-install.sh | sh`;
}

export class NoNewerPhiReleaseError extends Error {
	constructor() {
		super("No strictly newer phi release is available; refusing to reinstall or downgrade.");
		this.name = "NoNewerPhiReleaseError";
	}
}

export function getPhiArchiveBaseUrl(releaseId: string, downloadsBaseUrl = PHI_UPDATE_BASE_URL): string {
	const downloadsBase = downloadsBaseUrl.replace(/\/+$/, "");
	if (!downloadsBase.endsWith("/downloads"))
		throw new Error(`phi update base URL must end in /downloads: ${downloadsBase}`);
	const feedRoot = downloadsBase.slice(0, -"/downloads".length);
	return `${feedRoot}/archive/phi/${encodeURIComponent(releaseId)}/downloads`;
}

export async function runPhiUpgrade(
	options: {
		installerUrl?: string;
		archiveBaseUrl?: string;
		checkForUpdate?: () => Promise<PhiUpdate | undefined>;
		/** Install exactly this release instead of asking `checkForUpdate` (CLI `--force`). */
		release?: PhiRelease;
		/** Stream the installer to the terminal instead of capturing it (CLI use). */
		inheritStdio?: boolean;
	} = {},
): Promise<string> {
	let release = options.release;
	if (!release) {
		const update = await (options.checkForUpdate ?? checkForPhiUpdate)();
		if (!update) throw new NoNewerPhiReleaseError();
		release = update.latest;
	}
	if (release.installer !== "phi-install.sh") {
		throw new Error(`unsupported phi installer in feed metadata: ${release.installer}`);
	}

	const downloadsBaseUrl = process.env.PHI_UPDATE_BASE_URL ?? PHI_UPDATE_BASE_URL;
	const archiveBaseUrl = options.archiveBaseUrl ?? getPhiArchiveBaseUrl(release.releaseId, downloadsBaseUrl);
	const installerUrl = options.installerUrl ?? process.env.PHI_INSTALLER_URL ?? `${archiveBaseUrl}/phi-install.sh`;
	const inheritStdio = options.inheritStdio === true;
	return await new Promise<string>((resolve, reject) => {
		const child = spawn("sh", ["-c", PHI_UPGRADE_SHELL_SCRIPT, "phi-upgrade", installerUrl, archiveBaseUrl], {
			stdio: inheritStdio ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let output = "";
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-16_384);
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve(output.trim());
			else {
				const reason = signal ? `installer stopped by ${signal}` : `installer exited with status ${code ?? "?"}`;
				reject(new Error(output.trim() ? `${reason}: ${output.trim()}` : reason));
			}
		});
	});
}

/** The release this process runs: what phi-version.json said when phi started. */
let runningRelease: Promise<PhiRelease | undefined> | undefined;

export default function updaterExtension(pi: ExtensionAPI): void {
	let updateNoticeKey: string | undefined;
	let sessionGeneration = 0;
	let activeCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let autoUpdateWasOn = false;
	let lastAutoCheckAt = 0;
	let autoUpdateRunning = false;
	const reportedFailures = new Set<string>();
	runningRelease ??= readCurrentPhiRelease();

	const autoUpdateEnabled = (ctx: ExtensionContext): boolean => {
		try {
			return SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: ctx.isProjectTrusted(),
			}).getAutoUpdate();
		} catch {
			return false;
		}
	};

	const showUpdateNotice = (ctx: ExtensionContext, update: PhiUpdate) => {
		updateNoticeKey = "phi-update";
		ctx.ui.setStatus(
			updateNoticeKey,
			ctx.ui.theme.fg(
				"warning",
				`newer phi available (${update.latest.releaseId}) · /upgrade, or turn on Auto-update in /settings`,
			),
		);
	};

	/** Show "restart to use it" once the release on disk differs from the one running. */
	const showInstalledNotice = async (ctx: ExtensionContext, generation: number) => {
		const [running, installed] = await Promise.all([runningRelease, readCurrentPhiRelease()]);
		if (generation !== sessionGeneration || !running || !installed) return;
		if (installed.releaseId === running.releaseId) return;
		updateNoticeKey = "phi-update";
		ctx.ui.setStatus(
			updateNoticeKey,
			ctx.ui.theme.fg("accent", `phi ${installed.version} installed · restart phi to use it`),
		);
	};

	const runAutoUpdate = async (ctx: ExtensionContext, generation: number) => {
		if (autoUpdateRunning) return;
		autoUpdateRunning = true;
		lastAutoCheckAt = Date.now();
		try {
			const result = await autoUpdatePhi({
				checkForUpdate: checkForPhiUpdate,
				upgrade: (release) => runPhiUpgrade({ release }),
				lockPath: join(getAgentDir(), "phi-auto-update.lock"),
			});
			if (generation !== sessionGeneration) return;
			if (result.status === "updated") {
				ctx.ui.notify(`Auto-update installed phi ${result.release.version}. Restart phi to use it.`, "info");
			} else if (result.status === "failed" && !reportedFailures.has(result.release.releaseId)) {
				reportedFailures.add(result.release.releaseId);
				ctx.ui.notify(`phi auto-update failed (will retry): ${result.error}`, "warning");
			}
			await showInstalledNotice(ctx, generation);
		} catch {
			// Fail quiet; the next tick retries.
		} finally {
			autoUpdateRunning = false;
		}
	};

	const tick = () => {
		const ctx = activeCtx;
		if (!ctx) return;
		const enabled = autoUpdateEnabled(ctx);
		const justEnabled = enabled && !autoUpdateWasOn;
		autoUpdateWasOn = enabled;
		if (!enabled) return;
		if (justEnabled || Date.now() - lastAutoCheckAt >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
			void runAutoUpdate(ctx, sessionGeneration);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const generation = ++sessionGeneration;
		activeCtx = ctx;
		autoUpdateWasOn = autoUpdateEnabled(ctx);
		if (!timer) {
			// Poll the setting every minute so turning Auto-update on in /settings acts
			// right away; the feed itself is asked at most every 30 minutes.
			timer = setInterval(tick, 60_000);
			timer.unref?.();
		}
		if (autoUpdateWasOn) {
			void runAutoUpdate(ctx, generation);
			return;
		}
		void checkForPhiUpdate().then((update) => {
			if (!update || generation !== sessionGeneration) return;
			showUpdateNotice(ctx, update);
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionGeneration++;
		activeCtx = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (updateNoticeKey) ctx.ui.setStatus(updateNoticeKey, undefined);
	});

	pi.registerCommand("upgrade", {
		description: "Install the latest phi release from a configured release feed",
		acceptsArgs: false,
		handler: async (_args, ctx) => {
			ctx.ui.notify("Installing the latest phi release…", "info");
			try {
				await runPhiUpgrade();
				if (updateNoticeKey) ctx.ui.setStatus(updateNoticeKey, undefined);
				ctx.ui.notify("phi upgraded successfully. Restart phi to use the new release.", "info");
			} catch (error) {
				if (error instanceof NoNewerPhiReleaseError) {
					ctx.ui.notify(error.message, "info");
					return;
				}
				ctx.ui.notify(`phi upgrade failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
