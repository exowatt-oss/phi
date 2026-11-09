import { readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { asRecord, readBoolean, readNumber, readString, readStringArray } from "./json.ts";
import { hasLoadableBundleKinds } from "./store.ts";

/**
 * Whether a bundle follows the hub (`latest`) or stays on the version it was
 * imported at (`pinned`). Only `latest` rows are ever moved by `/hub update` or
 * the startup check.
 */
export type HubTrack = "latest" | "pinned";

/**
 * Rows written before tracking existed carry no `track`. They are read as
 * `pinned`: those imports predate the notion of following the hub, so upgrading
 * them silently would be a surprise. Re-import without `@v` to opt them in.
 */
export const LEGACY_TRACK: HubTrack = "pinned";

/** How long a successful update check suppresses the next one (hub contract). */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** One row of `hub/state.json`, keyed by `owner/slug`. */
export interface HubBundleState {
	version: number;
	enabled: boolean;
	/** Absolute path of the materialized version dir; the linked packages entry. */
	path: string;
	/** Top-level resource dirs present in the bundle (skills, instructions, ...). */
	kinds: string[];
	/** Whether updates follow the hub or this version is pinned. */
	track: HubTrack;
	title?: string;
	importedAt?: string;
	/** True once `/hub apply-settings` merged this bundle's settings fragment. */
	settingsApplied?: boolean;
	/**
	 * True when the row on disk recorded no usable `enabled` field — missing, or
	 * not a boolean. `enabled` is then read as `false` so the row stays usable,
	 * but the value is a fallback rather than the user's recorded intent, and
	 * reconciliation must not unlink on the strength of it. Never persisted.
	 */
	enabledUnknown?: boolean;
}

export type HubState = Record<string, HubBundleState>;

/**
 * The one linking rule, applied by import, enable/disable, sync, and the startup
 * migration alike: a bundle earns its `packages` entry only when it is enabled
 * *and* ships a resource kind pi's package loader can resolve.
 *
 * Enabling a hub-only bundle (models / instructions / settings) is still
 * meaningful — its dedicated loaders read this state file — it just must not be
 * handed to the package loader, which would resolve the bundle root as an
 * extension and fail to import it.
 */
export function shouldLinkBundle(row: Pick<HubBundleState, "enabled" | "kinds">): boolean {
	return row.enabled && hasLoadableBundleKinds(row.kinds);
}

/** The whole `hub/state.json` document: the bundle rows plus client-wide fields. */
export interface HubStateFile {
	bundles: HubState;
	/** ISO timestamp of the last successful `/api/updates/check`, for throttling. */
	lastUpdateCheck?: string;
}

function parseBundles(record: Record<string, unknown>): HubState {
	const state: HubState = {};
	for (const [key, value] of Object.entries(record)) {
		const row = asRecord(value);
		const version = readNumber(row, "version");
		const path = readString(row, "path");
		if (version === undefined || !path) continue;
		const enabled = readBoolean(row, "enabled");
		state[key] = {
			version,
			enabled: enabled ?? false,
			enabledUnknown: enabled === undefined ? true : undefined,
			path,
			kinds: readStringArray(row, "kinds") ?? [],
			track: readString(row, "track") === "latest" ? "latest" : LEGACY_TRACK,
			title: readString(row, "title"),
			importedAt: readString(row, "importedAt"),
			settingsApplied: readBoolean(row, "settingsApplied"),
		};
	}
	return state;
}

/**
 * Reads both shapes: the current `{bundles, lastUpdateCheck}` envelope and the
 * original bare `{"owner/slug": row}` map. Bundle keys always contain a slash,
 * so a legacy row can never be mistaken for the `bundles` field.
 */
function parseHubStateFile(statePath: string, raw: string): HubStateFile {
	let parsed: Record<string, unknown> | undefined;
	try {
		parsed = asRecord(JSON.parse(raw));
	} catch {
		throw new Error(`${statePath} is not valid JSON. Fix or delete it to recover hub state.`);
	}
	if (!parsed) return { bundles: {} };

	const nested = asRecord(parsed.bundles);
	if (!nested) return { bundles: parseBundles(parsed) };
	return { bundles: parseBundles(nested), lastUpdateCheck: readString(parsed, "lastUpdateCheck") };
}

export async function readHubStateFile(statePath: string): Promise<HubStateFile> {
	let raw: string;
	try {
		raw = await readFile(statePath, "utf-8");
	} catch {
		return { bundles: {} };
	}
	return parseHubStateFile(statePath, raw);
}

/**
 * Same parse, read synchronously. Used only by the startup link migration, which
 * runs in the synchronous migration phase before `packages` is resolved and so
 * cannot await anything.
 */
export function readHubStateFileSync(statePath: string): HubStateFile {
	let raw: string;
	try {
		raw = readFileSync(statePath, "utf-8");
	} catch {
		return { bundles: {} };
	}
	return parseHubStateFile(statePath, raw);
}

export async function readHubState(statePath: string): Promise<HubState> {
	return (await readHubStateFile(statePath)).bundles;
}

/**
 * Project a row down to the fields that belong on disk, so a parse-time marker
 * like `enabledUnknown` can never be written back as if it were recorded state.
 */
function serializeBundle(row: HubBundleState): Record<string, unknown> {
	return {
		version: row.version,
		enabled: row.enabled,
		path: row.path,
		kinds: row.kinds,
		track: row.track,
		title: row.title,
		importedAt: row.importedAt,
		settingsApplied: row.settingsApplied,
	};
}

export async function writeHubStateFile(statePath: string, file: HubStateFile): Promise<void> {
	await mkdir(dirname(statePath), { recursive: true });
	const bundles: Record<string, unknown> = {};
	for (const key of Object.keys(file.bundles).sort()) {
		bundles[key] = serializeBundle(file.bundles[key]);
	}
	const document: Record<string, unknown> = { bundles };
	if (file.lastUpdateCheck) document.lastUpdateCheck = file.lastUpdateCheck;
	await writeFile(statePath, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
}

/** Write the bundle rows, preserving the client-wide fields already on disk. */
export async function writeHubState(statePath: string, state: HubState): Promise<void> {
	const existing = await readHubStateFile(statePath);
	await writeHubStateFile(statePath, { bundles: state, lastUpdateCheck: existing.lastUpdateCheck });
}

/**
 * Throttle for the startup check. An unparseable or future timestamp checks
 * immediately rather than wedging the client until the clock catches up.
 */
export function shouldCheckForUpdates(lastUpdateCheck: string | undefined, now: number = Date.now()): boolean {
	if (!lastUpdateCheck) return true;
	const previous = Date.parse(lastUpdateCheck);
	if (Number.isNaN(previous) || previous > now) return true;
	return now - previous >= UPDATE_CHECK_INTERVAL_MS;
}

export async function recordUpdateCheck(
	statePath: string,
	timestamp: string = new Date().toISOString(),
): Promise<void> {
	const file = await readHubStateFile(statePath);
	await writeHubStateFile(statePath, { bundles: file.bundles, lastUpdateCheck: timestamp });
}

/** Import (or re-import) a bundle. Enabled is the post-import truth, not a merge. */
export function withImported(state: HubState, key: string, row: HubBundleState): HubState {
	return { ...state, [key]: { ...row } };
}

/** Enable/disable keeps files and state; only the settings link changes. */
export function withEnabled(state: HubState, key: string, enabled: boolean): HubState {
	const row = state[key];
	if (!row) throw new Error(`${key} is not imported. Run /hub import ${key} first.`);
	return { ...state, [key]: { ...row, enabled } };
}

export function withSettingsApplied(state: HubState, key: string, applied: boolean): HubState {
	const row = state[key];
	if (!row) throw new Error(`${key} is not imported. Run /hub import ${key} first.`);
	return { ...state, [key]: { ...row, settingsApplied: applied } };
}

export function withRemoved(state: HubState, key: string): HubState {
	if (!(key in state)) return state;
	const next = { ...state };
	delete next[key];
	return next;
}
