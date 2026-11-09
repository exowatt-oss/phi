import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import type { HubPaths } from "./paths.ts";
import type { HubState } from "./state.ts";
import { readHubState } from "./state.ts";

/**
 * `instructions/*.md` from enabled bundles, rendered as a system-prompt block.
 *
 * The block is recomputed from `hub/state.json` and injected per turn through
 * `before_agent_start`, so it leaves no residue: nothing is written into the
 * session, and the turn after a bundle is disabled simply no longer contains it.
 */

export const INSTRUCTIONS_HEADING = "## Shared instructions (phi hub)";

async function readInstructionFiles(versionDir: string): Promise<Array<{ name: string; content: string }>> {
	const dir = join(versionDir, "instructions");
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md")).sort();
	} catch {
		return [];
	}
	const files: Array<{ name: string; content: string }> = [];
	for (const name of names) {
		const content = (await readFile(join(dir, name), "utf-8")).trim();
		if (content) files.push({ name, content });
	}
	return files;
}

export async function renderInstructionsBlock(state: HubState): Promise<string> {
	const sections: string[] = [];
	for (const key of Object.keys(state).sort()) {
		const row = state[key];
		if (!row.enabled) continue;
		for (const file of await readInstructionFiles(row.path)) {
			sections.push(`### ${key} — instructions/${file.name}\n\n${file.content}`);
		}
	}
	if (sections.length === 0) return "";
	return [
		INSTRUCTIONS_HEADING,
		"",
		"These instructions come from phi hub bundles that are currently enabled on this machine.",
		"They apply only while the bundle is enabled.",
		"",
		sections.join("\n\n"),
	].join("\n");
}

/**
 * Caches the rendered block and re-reads it only when `hub/state.json` changes,
 * so a hub operation in another process is picked up on the next turn without
 * paying for file reads every turn.
 */
export class InstructionsProvider {
	private readonly paths: HubPaths;
	private cachedBlock = "";
	private cachedStamp: string | undefined;

	constructor(paths: HubPaths) {
		this.paths = paths;
	}

	/** Drop the cache so the next read reflects a mutation made in this process. */
	invalidate(): void {
		this.cachedStamp = undefined;
	}

	async getBlock(): Promise<string> {
		let stamp: string;
		try {
			const info = await stat(this.paths.statePath);
			stamp = `${info.mtimeMs}:${info.size}`;
		} catch {
			this.cachedBlock = "";
			this.cachedStamp = "missing";
			return "";
		}
		if (this.cachedStamp === stamp) return this.cachedBlock;

		this.cachedBlock = await renderInstructionsBlock(await readHubState(this.paths.statePath));
		this.cachedStamp = stamp;
		return this.cachedBlock;
	}
}
