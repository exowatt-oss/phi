import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { SettingsStorage } from "../../core/settings-manager.ts";
import { asRecord } from "./json.ts";
import { mergeIntoGlobalSettings, readGlobalSettings, replaceGlobalSettings } from "./settings-file.ts";

/**
 * Bundles may ship `settings/settings.json` and `settings/keybindings.json`
 * fragments. They are never auto-applied: `/hub apply-settings` shows a
 * key-by-key diff, writes a timestamped backup, then deep-merges.
 */

export type FragmentTarget = "settings.json" | "keybindings.json";

export interface SettingsFragment {
	settings?: Record<string, unknown>;
	keybindings?: Record<string, unknown>;
}

export interface FragmentDiffEntry {
	target: FragmentTarget;
	/** Dotted path of the leaf being set, e.g. `compaction.reserveTokens`. */
	key: string;
	before: unknown;
	after: unknown;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${path} is not valid JSON.`);
	}
	const record = asRecord(parsed);
	if (!record) throw new Error(`${path} must contain a JSON object.`);
	return record;
}

/** Read the `settings/` fragment shipped inside a materialized bundle version. */
export async function readBundleFragment(versionDir: string): Promise<SettingsFragment> {
	const settingsDir = join(versionDir, "settings");
	return {
		settings: await readJsonObject(join(settingsDir, "settings.json")),
		keybindings: await readJsonObject(join(settingsDir, "keybindings.json")),
	};
}

export function fragmentIsEmpty(fragment: SettingsFragment): boolean {
	const settingsKeys = Object.keys(fragment.settings ?? {}).length;
	const keybindingKeys = Object.keys(fragment.keybindings ?? {}).length;
	return settingsKeys === 0 && keybindingKeys === 0;
}

function collectDiff(
	target: FragmentTarget,
	current: Record<string, unknown>,
	overlay: Record<string, unknown>,
	prefix: string,
	out: FragmentDiffEntry[],
): void {
	for (const [key, overlayValue] of Object.entries(overlay)) {
		const path = prefix ? `${prefix}.${key}` : key;
		const overlayRecord = asRecord(overlayValue);
		const currentRecord = asRecord(current[key]);
		if (overlayRecord && currentRecord) {
			collectDiff(target, currentRecord, overlayRecord, path, out);
			continue;
		}
		const before = current[key];
		if (JSON.stringify(before) === JSON.stringify(overlayValue)) continue;
		out.push({ target, key: path, before, after: overlayValue });
	}
}

/** Key-by-key diff of what applying the fragment would change. Empty means a no-op. */
export async function diffFragment(
	storage: SettingsStorage,
	keybindingsPath: string,
	fragment: SettingsFragment,
): Promise<FragmentDiffEntry[]> {
	const entries: FragmentDiffEntry[] = [];
	if (fragment.settings) {
		collectDiff("settings.json", readGlobalSettings(storage), fragment.settings, "", entries);
	}
	if (fragment.keybindings) {
		const current = (await readJsonObject(keybindingsPath)) ?? {};
		collectDiff("keybindings.json", current, fragment.keybindings, "", entries);
	}
	return entries;
}

export function formatDiffEntry(entry: FragmentDiffEntry): string {
	const before = entry.before === undefined ? "(unset)" : JSON.stringify(entry.before);
	return `${entry.target}  ${entry.key}: ${before} -> ${JSON.stringify(entry.after)}`;
}

/** Sortable, filesystem-safe timestamp used to group a settings+keybindings backup pair. */
export function backupTimestamp(now: Date = new Date()): string {
	return now.toISOString().replace(/[:.]/g, "-");
}

export interface AppliedFragment {
	timestamp: string;
	backups: string[];
	diff: FragmentDiffEntry[];
}

/**
 * Back up, then deep-merge. The backup is written before any mutation so
 * `/hub revert-settings` always has a pre-apply snapshot to restore.
 */
export async function applyFragment(
	storage: SettingsStorage,
	paths: { backupsDir: string; keybindingsPath: string },
	fragment: SettingsFragment,
	diff: FragmentDiffEntry[],
	now: Date = new Date(),
): Promise<AppliedFragment> {
	const timestamp = backupTimestamp(now);
	await mkdir(paths.backupsDir, { recursive: true });
	const backups: string[] = [];

	if (fragment.settings) {
		const backupPath = join(paths.backupsDir, `${timestamp}-settings.json`);
		await writeFile(backupPath, JSON.stringify(readGlobalSettings(storage), null, 2), "utf-8");
		backups.push(backupPath);
	}
	if (fragment.keybindings) {
		const backupPath = join(paths.backupsDir, `${timestamp}-keybindings.json`);
		const current = (await readJsonObject(paths.keybindingsPath)) ?? {};
		await writeFile(backupPath, JSON.stringify(current, null, 2), "utf-8");
		backups.push(backupPath);
	}

	if (fragment.settings) {
		mergeIntoGlobalSettings(storage, fragment.settings);
	}
	if (fragment.keybindings) {
		const current = (await readJsonObject(paths.keybindingsPath)) ?? {};
		const merged = { ...current, ...fragment.keybindings };
		await writeFile(paths.keybindingsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
	}

	return { timestamp, backups, diff };
}

/** Newest backup group, or undefined when nothing has been applied yet. */
export async function findLatestBackup(
	backupsDir: string,
): Promise<{ timestamp: string; settings?: string; keybindings?: string } | undefined> {
	let names: string[];
	try {
		names = await readdir(backupsDir);
	} catch {
		return undefined;
	}
	const timestamps = new Set<string>();
	for (const name of names) {
		const match = /^(.+)-(settings|keybindings)\.json$/.exec(name);
		if (match) timestamps.add(match[1]);
	}
	const latest = [...timestamps].sort().pop();
	if (!latest) return undefined;
	return {
		timestamp: latest,
		settings: names.includes(`${latest}-settings.json`) ? join(backupsDir, `${latest}-settings.json`) : undefined,
		keybindings: names.includes(`${latest}-keybindings.json`)
			? join(backupsDir, `${latest}-keybindings.json`)
			: undefined,
	};
}

/** Restore the newest backup group verbatim. */
export async function revertLatestBackup(
	storage: SettingsStorage,
	paths: { backupsDir: string; keybindingsPath: string },
): Promise<{ timestamp: string; restored: FragmentTarget[] } | undefined> {
	const latest = await findLatestBackup(paths.backupsDir);
	if (!latest) return undefined;

	const restored: FragmentTarget[] = [];
	if (latest.settings) {
		replaceGlobalSettings(storage, await readFile(latest.settings, "utf-8"));
		restored.push("settings.json");
	}
	if (latest.keybindings) {
		await writeFile(paths.keybindingsPath, await readFile(latest.keybindings, "utf-8"), "utf-8");
		restored.push("keybindings.json");
	}
	return { timestamp: latest.timestamp, restored };
}
