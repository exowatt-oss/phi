import { join } from "path";

/**
 * Filesystem layout for the hub client. Everything lives under the phi agent
 * dir so `PHI_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR` overrides are respected
 * (see `getAgentDir()` in `src/config.ts`).
 */
export interface HubPaths {
	agentDir: string;
	/** `hub.json` — url, token, handle, email. Written chmod 600. */
	configPath: string;
	/** `hub/` — everything the hub client owns. */
	hubDir: string;
	/** `hub/bundles/<owner>/<slug>/v<N>/` — the isolated bundle store. */
	bundlesDir: string;
	/** `hub/state.json` — per-bundle version/enabled/path/kinds rows. */
	statePath: string;
	/** `hub/backups/` — pre-apply settings and keybindings backups. */
	backupsDir: string;
	/** Global `settings.json`; the only user file import/enable/disable touches. */
	settingsPath: string;
	/** Global `keybindings.json`; only touched by `/hub apply-settings`. */
	keybindingsPath: string;
	/** Global `AGENTS.md`; exported by `/hub push` as `instructions/AGENTS.md`. */
	contextFilePath: string;
	/** Global `models.json`; exported by `/hub push` as `models/models.json`. */
	modelsFilePath: string;
	extensionsDir: string;
	skillsDir: string;
	promptsDir: string;
	themesDir: string;
}

export function createHubPaths(agentDir: string): HubPaths {
	const hubDir = join(agentDir, "hub");
	return {
		agentDir,
		configPath: join(agentDir, "hub.json"),
		hubDir,
		bundlesDir: join(hubDir, "bundles"),
		statePath: join(hubDir, "state.json"),
		backupsDir: join(hubDir, "backups"),
		settingsPath: join(agentDir, "settings.json"),
		keybindingsPath: join(agentDir, "keybindings.json"),
		contextFilePath: join(agentDir, "AGENTS.md"),
		modelsFilePath: join(agentDir, "models.json"),
		extensionsDir: join(agentDir, "extensions"),
		skillsDir: join(agentDir, "skills"),
		promptsDir: join(agentDir, "prompts"),
		themesDir: join(agentDir, "themes"),
	};
}

/** Absolute store directory for one materialized bundle version. */
export function bundleVersionDir(paths: HubPaths, owner: string, slug: string, version: number): string {
	return join(paths.bundlesDir, owner, slug, `v${version}`);
}

/** Directory holding every materialized version of one bundle. */
export function bundleSlugDir(paths: HubPaths, owner: string, slug: string): string {
	return join(paths.bundlesDir, owner, slug);
}
