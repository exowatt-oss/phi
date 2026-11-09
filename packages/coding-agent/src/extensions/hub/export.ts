import { readdir, readFile, stat } from "fs/promises";
import { join, relative, sep } from "path";
import type { SettingsStorage } from "../../core/settings-manager.ts";
import type { HubPaths } from "./paths.ts";
import { assertNoSecrets, isForbiddenBundleFileName } from "./secrets.ts";
import { readGlobalSettings } from "./settings-file.ts";
import { assertBundleWithinCaps, type BundleFile, validateBundleFilePath } from "./store.ts";

/**
 * What `/hub push` is allowed to export. Provider credentials are structurally
 * excluded: `models.json` and `auth.json` are never candidates, and only the
 * whitelisted settings keys below can ever leave the machine.
 */

/** Settings keys that describe taste, not credentials or machine-local paths. */
export const EXPORTABLE_SETTINGS_KEYS = [
	"theme",
	"defaultThinkingLevel",
	"compaction",
	"retry",
	"enabledModels",
	"steeringMode",
	"followUpMode",
] as const;

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".cache"]);

export type ExportKind = "extensions" | "skills" | "prompts" | "themes" | "instructions" | "settings" | "models";

export interface ExportCandidate {
	/** Stable identifier used by `/hub push` selection and the `hub_publish` tool. */
	id: string;
	label: string;
	kind: ExportKind;
	/** Bundle-relative destination prefix, e.g. `skills/my-skill`. */
	target: string;
	/** Absolute source path, or undefined for synthesized candidates. */
	sourcePath?: string;
	/** Pre-rendered files for synthesized candidates (settings fragments). */
	files?: BundleFile[];
}

async function listDirectory(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir);
		return entries.filter((name) => !name.startsWith(".")).sort();
	} catch {
		return [];
	}
}

async function collectFiles(sourcePath: string, targetPrefix: string): Promise<BundleFile[]> {
	const info = await stat(sourcePath);
	if (info.isFile()) {
		return [{ path: validateBundleFilePath(targetPrefix), content: await readFile(sourcePath) }];
	}

	const files: BundleFile[] = [];
	const queue = [sourcePath];
	while (queue.length > 0) {
		const dir = queue.pop();
		if (!dir) continue;
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			if (isForbiddenBundleFileName(entry.name)) continue;
			const suffix = relative(sourcePath, absolute).split(sep).join("/");
			files.push({
				path: validateBundleFilePath(`${targetPrefix}/${suffix}`),
				content: await readFile(absolute),
			});
		}
	}
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Whitelisted subset of the user's global settings, or undefined when nothing matches. */
export function pickExportableSettings(settings: Record<string, unknown>): Record<string, unknown> | undefined {
	const picked: Record<string, unknown> = {};
	for (const key of EXPORTABLE_SETTINGS_KEYS) {
		if (settings[key] !== undefined) picked[key] = settings[key];
	}
	return Object.keys(picked).length > 0 ? picked : undefined;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Everything on this machine that could become part of a bundle. */
export async function discoverExportCandidates(paths: HubPaths, storage: SettingsStorage): Promise<ExportCandidate[]> {
	const candidates: ExportCandidate[] = [];

	const resourceDirs: Array<{ kind: ExportKind; dir: string }> = [
		{ kind: "extensions", dir: paths.extensionsDir },
		{ kind: "skills", dir: paths.skillsDir },
		{ kind: "prompts", dir: paths.promptsDir },
		{ kind: "themes", dir: paths.themesDir },
	];
	for (const { kind, dir } of resourceDirs) {
		for (const name of await listDirectory(dir)) {
			if (isForbiddenBundleFileName(name)) continue;
			candidates.push({
				id: `${kind}/${name}`,
				label: `${kind}/${name}`,
				kind,
				target: `${kind}/${name}`,
				sourcePath: join(dir, name),
			});
		}
	}

	try {
		await stat(paths.contextFilePath);
		candidates.push({
			id: "instructions/AGENTS.md",
			label: "instructions/AGENTS.md (global AGENTS.md)",
			kind: "instructions",
			target: "instructions/AGENTS.md",
			sourcePath: paths.contextFilePath,
		});
	} catch {
		// No global context file to export.
	}

	try {
		await stat(paths.modelsFilePath);
		candidates.push({
			id: "models/models.json",
			label: "models/models.json (global models.json — credentials must be $ENV/!command references)",
			kind: "models",
			target: "models/models.json",
			sourcePath: paths.modelsFilePath,
		});
	} catch {
		// No global models.json to export.
	}

	const exportableSettings = pickExportableSettings(readGlobalSettings(storage));
	if (exportableSettings) {
		candidates.push({
			id: "settings/settings.json",
			label: `settings/settings.json (${Object.keys(exportableSettings).join(", ")})`,
			kind: "settings",
			target: "settings/settings.json",
			files: [
				{
					path: "settings/settings.json",
					content: Buffer.from(`${JSON.stringify(exportableSettings, null, 2)}\n`, "utf-8"),
				},
			],
		});
	}

	const keybindings = await readJsonFile(paths.keybindingsPath);
	if (keybindings && Object.keys(keybindings).length > 0) {
		candidates.push({
			id: "settings/keybindings.json",
			label: `settings/keybindings.json (${Object.keys(keybindings).length} bindings)`,
			kind: "settings",
			target: "settings/keybindings.json",
			files: [
				{
					path: "settings/keybindings.json",
					content: Buffer.from(`${JSON.stringify(keybindings, null, 2)}\n`, "utf-8"),
				},
			],
		});
	}

	return candidates;
}

/** Materialize the selected candidates into the publish payload, secret-guarded. */
export async function buildBundleFiles(candidates: ExportCandidate[]): Promise<BundleFile[]> {
	const files: BundleFile[] = [];
	for (const candidate of candidates) {
		if (candidate.files) {
			files.push(...candidate.files);
			continue;
		}
		if (!candidate.sourcePath) continue;
		files.push(...(await collectFiles(candidate.sourcePath, candidate.target)));
	}
	assertNoSecrets(files);
	assertBundleWithinCaps(files);
	return files;
}

/** Best-effort `kind` label for the bundle from what is being exported. */
export function inferBundleKind(candidates: ExportCandidate[]): string {
	const kinds = new Set(candidates.map((candidate) => candidate.kind));
	if (kinds.size !== 1) return "mixed";
	const [only] = [...kinds];
	if (only === "extensions") return "extension";
	if (only === "skills") return "skill";
	if (only === "prompts") return "prompt";
	if (only === "themes") return "theme";
	if (only === "models") return "models";
	if (only === "settings") {
		return candidates.every((candidate) => candidate.target === "settings/keybindings.json")
			? "keybindings"
			: "settings";
	}
	return only;
}
