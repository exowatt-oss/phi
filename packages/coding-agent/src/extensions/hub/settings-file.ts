import type { PackageSource, SettingsStorage } from "../../core/settings-manager.ts";
import { asRecord } from "./json.ts";

/**
 * Every write to the user's global `settings.json` goes through pi's own
 * `SettingsStorage`, so the hub inherits its lock-and-read-modify-write
 * behaviour and its 2-space JSON formatting. The hub only ever touches the
 * `packages` array (link/unlink) or an explicitly approved settings fragment.
 */

export type SettingsDocument = Record<string, unknown> & { packages?: PackageSource[] };

function parseSettingsDocument(current: string | undefined): SettingsDocument {
	if (!current || current.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(current);
	} catch {
		throw new Error("Global settings.json is not valid JSON. Fix it before running hub commands.");
	}
	const record = asRecord(parsed);
	if (!record) {
		throw new Error("Global settings.json must contain a JSON object.");
	}
	return record as SettingsDocument;
}

function packageSourceValue(entry: PackageSource): string | undefined {
	if (typeof entry === "string") return entry;
	const source = asRecord(entry)?.source;
	return typeof source === "string" ? source : undefined;
}

export function readGlobalSettings(storage: SettingsStorage): SettingsDocument {
	let document: SettingsDocument = {};
	storage.withLock("global", (current) => {
		document = parseSettingsDocument(current);
		return undefined;
	});
	return document;
}

/**
 * What the startup check is allowed to upgrade on its own:
 * - `org`: only bundles owned by an org profile, whose publishers gate releases
 * - `all`: every bundle tracking latest, personal ones included
 * - `off`: nothing; the check only reports
 */
export type HubAutoUpdateMode = "org" | "all" | "off";

export const DEFAULT_HUB_AUTO_UPDATE: HubAutoUpdateMode = "org";

/**
 * `hubAutoUpdate` in the user's global `settings.json`. Read straight off the
 * file rather than through `Settings` so the hub owns its own key, and anything
 * unrecognized falls back to the default instead of failing a session start.
 */
export function readHubAutoUpdateMode(storage: SettingsStorage): HubAutoUpdateMode {
	const value = readGlobalSettings(storage).hubAutoUpdate;
	if (value === "org" || value === "all" || value === "off") return value;
	return DEFAULT_HUB_AUTO_UPDATE;
}

/** Every package source currently listed in global settings. */
export function readLinkedPackagePaths(storage: SettingsStorage): string[] {
	const packages = readGlobalSettings(storage).packages ?? [];
	return packages.map(packageSourceValue).filter((value): value is string => value !== undefined);
}

/**
 * Apply a `packages` mutation. Returning `undefined` from `mutate` means "no
 * change", which skips the write entirely so an unrelated settings file is
 * never rewritten.
 */
function updatePackages(
	storage: SettingsStorage,
	mutate: (packages: PackageSource[]) => PackageSource[] | undefined,
): boolean {
	let changed = false;
	storage.withLock("global", (current) => {
		const document = parseSettingsDocument(current);
		const packages = Array.isArray(document.packages) ? [...document.packages] : [];
		const next = mutate(packages);
		if (!next) return undefined;
		document.packages = next;
		changed = true;
		return JSON.stringify(document, null, 2);
	});
	return changed;
}

/** Add one absolute store path to `packages`. Idempotent. */
export function linkPackage(storage: SettingsStorage, packagePath: string): boolean {
	return updatePackages(storage, (packages) => {
		if (packages.some((entry) => packageSourceValue(entry) === packagePath)) return undefined;
		return [...packages, packagePath];
	});
}

/** Remove that one entry and nothing else. Idempotent. */
export function unlinkPackage(storage: SettingsStorage, packagePath: string): boolean {
	return updatePackages(storage, (packages) => {
		const next = packages.filter((entry) => packageSourceValue(entry) !== packagePath);
		return next.length === packages.length ? undefined : next;
	});
}

/**
 * Apply many link/unlink decisions in one locked read-modify-write.
 *
 * Reconciliation has to be atomic: deciding from a snapshot taken outside the
 * lock and then writing once per bundle leaves a window where a concurrent hub
 * command sees a half-reconciled `packages` array, and turns one repair into
 * several writes. The wanted set is computed from `hub/state.json`, which does
 * not depend on the current `packages` contents, so the only thing that must be
 * read under the lock is what is already linked — which is exactly what decides
 * whether each entry still needs adding or dropping.
 *
 * Returns the paths actually added and removed, so callers report real changes
 * rather than intentions. No net change means no write at all.
 */
export function reconcilePackages(
	storage: SettingsStorage,
	plan: { link: readonly string[]; unlink: readonly string[] },
): { linked: string[]; unlinked: string[] } {
	const linked: string[] = [];
	const unlinked: string[] = [];
	// Two state rows can name the same store path (a hand-edited duplicate key).
	// Contradictory intents cancel out rather than letting the destructive one win.
	const contested = new Set(plan.link.filter((path) => plan.unlink.includes(path)));
	updatePackages(storage, (packages) => {
		const present = new Set(packages.map(packageSourceValue).filter((value): value is string => value !== undefined));
		const drop = new Set(plan.unlink.filter((path) => present.has(path) && !contested.has(path)));
		const add = plan.link.filter((path) => !present.has(path) && !contested.has(path));
		if (drop.size === 0 && add.length === 0) return undefined;
		unlinked.push(...drop);
		linked.push(...add);
		const kept = packages.filter((entry) => {
			const value = packageSourceValue(entry);
			return value === undefined || !drop.has(value);
		});
		return [...kept, ...add];
	});
	return { linked, unlinked };
}

/** Repoint an existing entry in place so an upgrade never leaves both versions linked. */
export function relinkPackage(storage: SettingsStorage, previousPath: string, nextPath: string): boolean {
	return updatePackages(storage, (packages) => {
		const withoutBoth = packages.filter((entry) => {
			const value = packageSourceValue(entry);
			return value !== previousPath && value !== nextPath;
		});
		return [...withoutBoth, nextPath];
	});
}

/** Recursive merge used for approved settings fragments; the overlay wins on leaves. */
export function deepMergeJson(
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overlayValue] of Object.entries(overlay)) {
		const overlayRecord = asRecord(overlayValue);
		const baseRecord = asRecord(result[key]);
		result[key] = overlayRecord && baseRecord ? deepMergeJson(baseRecord, overlayRecord) : overlayValue;
	}
	return result;
}

/** Merge an approved fragment into global settings. Never called without an explicit user OK. */
export function mergeIntoGlobalSettings(storage: SettingsStorage, fragment: Record<string, unknown>): void {
	storage.withLock("global", (current) => {
		const document = parseSettingsDocument(current);
		return JSON.stringify(deepMergeJson(document, fragment), null, 2);
	});
}

/** Restore a previously backed-up settings.json verbatim. */
export function replaceGlobalSettings(storage: SettingsStorage, contents: string): void {
	parseSettingsDocument(contents);
	storage.withLock("global", () => contents);
}
