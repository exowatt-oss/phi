/**
 * The runtime side of the `models` bundle kind: turn the enabled model bundles
 * in `hub/state.json` into the list of `models/models.json` files the model
 * runtime should layer beneath the user's own `~/.pi/agent/models.json`.
 *
 * This is the only hub code the model runtime reaches for. It is deliberately a
 * plain, dependency-light function so the composition root (SDK / session
 * services) can pass it to `ModelRuntime.create` as a resolver without pulling
 * the whole hub extension into core.
 */

import { statSync } from "fs";
import { join } from "path";
import { MODELS_BUNDLE_PATH } from "./models-guard.ts";
import { createHubPaths } from "./paths.ts";
import { type HubStateFile, readHubStateFile } from "./state.ts";

function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Absolute `models/models.json` paths for every enabled bundle whose kinds
 * include `models`, ordered by bundle key so a multi-bundle merge is
 * deterministic. Disabled or removed bundles never appear, so a reload that
 * re-reads state picks up a toggle without any other bookkeeping.
 *
 * A bundle whose state row claims `models` but whose file is missing on disk is
 * skipped rather than surfaced as a load error: the model runtime treats a
 * missing source the same way, and a half-materialized store should not break
 * model loading.
 */
export async function enabledModelBundlePaths(agentDir: string): Promise<string[]> {
	const paths = createHubPaths(agentDir);
	const empty: HubStateFile = { bundles: {} };
	const state = (await readHubStateFile(paths.statePath).catch(() => empty)).bundles;
	const result: string[] = [];
	for (const key of Object.keys(state).sort()) {
		const row = state[key];
		if (!row.enabled || !row.kinds.includes("models")) continue;
		const modelsFile = join(row.path, MODELS_BUNDLE_PATH);
		if (fileExists(modelsFile)) result.push(modelsFile);
	}
	return result;
}
