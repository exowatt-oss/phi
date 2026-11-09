import chalk from "chalk";
import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { type StartupProgressHandle, showStartupInput, showStartupSelector } from "./startup-ui.ts";

export function createProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	settingsManager: SettingsManager;
	hasUI: boolean;
	startupProgress?: Pick<StartupProgressHandle, "pause" | "resume">;
	pauseStartupProgress?: () => Promise<void>;
	resumeStartupProgress?: () => Promise<void>;
}): ProjectTrustContext {
	const pauseStartupProgress = async (): Promise<void> => {
		if (options.pauseStartupProgress) {
			await options.pauseStartupProgress();
			return;
		}
		await options.startupProgress?.pause();
	};
	const resumeStartupProgress = async (): Promise<void> => {
		if (options.resumeStartupProgress) {
			await options.resumeStartupProgress();
			return;
		}
		await options.startupProgress?.resume();
	};

	return {
		cwd: options.cwd,
		mode: options.mode === "interactive" ? "tui" : options.mode,
		hasUI: options.hasUI,
		ui: {
			select: async (title, selectOptions) => {
				if (!options.hasUI) {
					return undefined;
				}
				if (options.mode !== "interactive") {
					return undefined;
				}
				await pauseStartupProgress();
				try {
					return await showStartupSelector(
						options.settingsManager,
						title,
						selectOptions.map((option) => ({ label: option, value: option })),
					);
				} finally {
					await resumeStartupProgress();
				}
			},
			confirm: async (title, message) => {
				if (!options.hasUI) {
					return false;
				}
				if (options.mode !== "interactive") {
					return false;
				}
				await pauseStartupProgress();
				try {
					return (
						(await showStartupSelector(options.settingsManager, `${title}\n${message}`, [
							{ label: "Yes", value: true },
							{ label: "No", value: false },
						])) ?? false
					);
				} finally {
					await resumeStartupProgress();
				}
			},
			input: async (title, placeholder) => {
				if (!options.hasUI) {
					return undefined;
				}
				if (options.mode !== "interactive") {
					return undefined;
				}
				await pauseStartupProgress();
				try {
					return await showStartupInput(options.settingsManager, title, placeholder);
				} finally {
					await resumeStartupProgress();
				}
			},
			notify: (message, type = "info") => {
				if (options.mode !== "interactive") {
					const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
					console.error(color(message));
				}
			},
		},
	};
}
