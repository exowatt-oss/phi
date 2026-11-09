import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { asRecord, readNumber, readString } from "./json.ts";

/** Publish/import caps, mirrored from the hub's server-side validation. */
export const MAX_BUNDLE_FILES = 200;
export const MAX_BUNDLE_FILE_BYTES = 512 * 1024;
export const MAX_BUNDLE_TOTAL_BYTES = 5 * 1024 * 1024;

/** Marker written next to every materialized version so a store dir is self-describing. */
export const PROVENANCE_FILE = ".phi-hub.json";

/**
 * Top-level directories a bundle may contain: the four pi resource kinds the
 * `packages` array can resolve, then the hub-only kinds that have their own
 * loaders.
 */
export const LOADABLE_BUNDLE_KINDS = ["skills", "extensions", "prompts", "themes"] as const;

/**
 * Kinds pi's package loader knows nothing about. Each has a dedicated loader
 * driven by `hub/state.json` instead: `instructions/` is injected per turn,
 * `settings/` is only ever merged by `/hub apply-settings`, and `models/` is
 * layered beneath the user's own `models.json` by the model runtime.
 */
export const HUB_ONLY_BUNDLE_KINDS = ["instructions", "settings", "models"] as const;

export const BUNDLE_KINDS = [...LOADABLE_BUNDLE_KINDS, ...HUB_ONLY_BUNDLE_KINDS] as const;

/**
 * Whether pi's package loader has anything to load from this bundle root.
 *
 * A `packages` entry points at the bundle root, and pi resolves it by looking
 * for `skills/`, `extensions/`, `prompts/`, or `themes/` beneath it. A root with
 * none of those is not a package at all: the resolver falls back to treating the
 * directory itself as an extension and the extension loader then fails to import
 * it. So a bundle carrying only hub-only kinds (models, instructions, settings)
 * must never be linked — it is enabled through `hub/state.json` alone.
 */
export function hasLoadableBundleKinds(kinds: readonly string[]): boolean {
	return kinds.some((kind) => (LOADABLE_BUNDLE_KINDS as readonly string[]).includes(kind));
}

export interface BundleFile {
	path: string;
	/**
	 * Raw file bytes. Bundles carry binary assets (logos, fonts, templates) as
	 * well as text, so this stays a Buffer end to end — decoding to a string
	 * anywhere in the publish/import path silently corrupts every byte that is
	 * not valid UTF-8. Use {@link bundleFileText} when a check needs characters.
	 */
	content: Buffer;
}

/** Lossy UTF-8 view of a bundle file, for text-only checks (secret scans, parsing). */
export function bundleFileText(file: BundleFile): string {
	return file.content.toString("utf-8");
}

export interface BundleProvenance {
	owner: string;
	slug: string;
	version: number;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Validate a bundle-relative path before it is ever joined onto a real
 * directory. Anything that could escape the store, collide with git metadata,
 * or smuggle in a Windows drive/UNC path is rejected outright.
 */
export function validateBundleFilePath(path: string): string {
	if (!path || path.trim() !== path) {
		throw new Error(`Invalid bundle path ${JSON.stringify(path)}: must be a trimmed relative path.`);
	}
	if (path.includes("\\")) {
		throw new Error(`Invalid bundle path ${JSON.stringify(path)}: backslashes are not allowed.`);
	}
	if (CONTROL_CHARACTERS.test(path)) {
		throw new Error(`Invalid bundle path ${JSON.stringify(path)}: control characters are not allowed.`);
	}
	if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
		throw new Error(`Invalid bundle path ${JSON.stringify(path)}: must be relative.`);
	}

	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") {
			throw new Error(`Invalid bundle path ${JSON.stringify(path)}: empty or "." path segment.`);
		}
		if (segment === "..") {
			throw new Error(`Invalid bundle path ${JSON.stringify(path)}: ".." escapes the bundle store.`);
		}
		if (segment === ".git") {
			throw new Error(`Invalid bundle path ${JSON.stringify(path)}: git metadata is not allowed.`);
		}
	}
	return path;
}

export function assertBundleWithinCaps(files: BundleFile[]): void {
	if (files.length === 0) {
		throw new Error("Nothing to publish: the bundle has no files.");
	}
	if (files.length > MAX_BUNDLE_FILES) {
		throw new Error(`Too many files: ${files.length} exceeds the ${MAX_BUNDLE_FILES}-file limit.`);
	}
	let total = 0;
	for (const file of files) {
		const bytes = file.content.byteLength;
		if (bytes > MAX_BUNDLE_FILE_BYTES) {
			throw new Error(`${file.path} is ${bytes} bytes, over the ${MAX_BUNDLE_FILE_BYTES}-byte per-file limit.`);
		}
		total += bytes;
	}
	if (total > MAX_BUNDLE_TOTAL_BYTES) {
		throw new Error(`Bundle is ${total} bytes, over the ${MAX_BUNDLE_TOTAL_BYTES}-byte per-version limit.`);
	}
}

/** Which of the known bundle kinds the file list actually contains. */
export function detectBundleKinds(paths: string[]): string[] {
	const kinds = new Set<string>();
	for (const path of paths) {
		const top = path.split("/")[0];
		if (top && (BUNDLE_KINDS as readonly string[]).includes(top)) kinds.add(top);
	}
	return [...kinds].sort();
}

/** Write every file into the version dir. Paths are validated before any write. */
export async function materializeBundle(versionDir: string, files: BundleFile[]): Promise<void> {
	for (const file of files) validateBundleFilePath(file.path);
	await mkdir(versionDir, { recursive: true });
	for (const file of files) {
		const target = join(versionDir, file.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.content);
	}
}

export async function writeProvenance(versionDir: string, provenance: BundleProvenance): Promise<void> {
	await mkdir(versionDir, { recursive: true });
	await writeFile(join(versionDir, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`, "utf-8");
}

export async function readProvenance(versionDir: string): Promise<BundleProvenance | undefined> {
	let raw: string;
	try {
		raw = await readFile(join(versionDir, PROVENANCE_FILE), "utf-8");
	} catch {
		return undefined;
	}
	let record: Record<string, unknown> | undefined;
	try {
		record = asRecord(JSON.parse(raw));
	} catch {
		return undefined;
	}
	const owner = readString(record, "owner");
	const slug = readString(record, "slug");
	const version = readNumber(record, "version");
	if (!owner || !slug || version === undefined) return undefined;
	return { owner, slug, version };
}

export async function removeStoreDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}
