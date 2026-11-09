import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { HubClient, HubUpdateRow } from "./client.ts";
import { type HubEnvironment, importBundle, loadClient } from "./operations.ts";
import { parseBundleRef } from "./refs.ts";
import { type HubAutoUpdateMode, readHubAutoUpdateMode } from "./settings-file.ts";
import { type HubState, readHubStateFile, recordUpdateCheck, shouldCheckForUpdates } from "./state.ts";

/**
 * Update checking and the throttled startup check (hub contract, "Marketplace
 * (v2)" → "Client semantics").
 *
 * Two entry points share one round trip shape: `/hub update`, which the user
 * asked for and therefore applies every newer version, and the startup check,
 * which is asynchronous, throttled, silent on failure, and only upgrades what
 * `hubAutoUpdate` allows.
 */

/** An installed bundle that follows the hub. */
export interface TrackedBundle {
	key: string;
	version: number;
}

export interface AppliedUpdate {
	key: string;
	fromVersion: number;
	toVersion: number;
	ok: boolean;
	error?: string;
}

export interface UpdateRunResult {
	/** Track-latest bundles included in the check. */
	tracked: TrackedBundle[];
	/** Pinned bundles, listed so the user knows why they did not move. */
	pinned: string[];
	/** Newer versions the hub reported for tracked bundles. */
	available: HubUpdateRow[];
	/** Every attempt to move a bundle, successful or not. */
	applied: AppliedUpdate[];
	/** Tracked refs the hub no longer knows about. Never auto-removed. */
	missing: string[];
	/** Available updates deliberately left for the user (auto-update gating). */
	deferred: HubUpdateRow[];
}

export interface UpdateOptions {
	/** Limit the run to these `owner/slug` keys. */
	onlyKeys?: string[];
	signal?: AbortSignal;
}

/** The rows `/hub update` and the startup check are allowed to move. */
export function trackedBundles(state: HubState, onlyKeys?: string[]): TrackedBundle[] {
	const wanted = onlyKeys === undefined ? undefined : new Set(onlyKeys);
	return Object.keys(state)
		.sort()
		.filter((key) => state[key].track === "latest" && (wanted === undefined || wanted.has(key)))
		.map((key) => ({ key, version: state[key].version }));
}

function pinnedBundles(state: HubState, onlyKeys?: string[]): string[] {
	const wanted = onlyKeys === undefined ? undefined : new Set(onlyKeys);
	return Object.keys(state)
		.sort()
		.filter((key) => state[key].track !== "latest" && (wanted === undefined || wanted.has(key)));
}

interface CheckOutcome {
	tracked: TrackedBundle[];
	pinned: string[];
	available: HubUpdateRow[];
	missing: string[];
	client: HubClient;
}

/**
 * One `POST /api/updates/check` for every tracked bundle. The timestamp is
 * recorded only on success, so an offline session retries next time instead of
 * burning the 6-hour window.
 */
async function checkForUpdates(env: HubEnvironment, options: UpdateOptions): Promise<CheckOutcome> {
	const file = await readHubStateFile(env.paths.statePath);
	const tracked = trackedBundles(file.bundles, options.onlyKeys);
	const pinned = pinnedBundles(file.bundles, options.onlyKeys);
	const { client } = await loadClient(env);
	if (tracked.length === 0) {
		return { tracked, pinned, available: [], missing: [], client };
	}

	const check = await client.checkUpdates(
		tracked.map((entry) => ({ ref: entry.key, version: entry.version })),
		options.signal,
	);
	await recordUpdateCheck(env.paths.statePath);

	const installed = new Map(tracked.map((entry) => [entry.key, entry.version]));
	const available = check.updates.filter((row) => {
		const current = installed.get(row.key);
		return current !== undefined && row.latestVersion > current;
	});
	const missing = check.missing.filter((ref) => installed.has(ref));
	return { tracked, pinned, available, missing, client };
}

/** Re-import through the existing materialize + relink path, staying on latest. */
async function applyUpdates(
	env: HubEnvironment,
	rows: HubUpdateRow[],
	installed: Map<string, number>,
	signal?: AbortSignal,
): Promise<AppliedUpdate[]> {
	const applied: AppliedUpdate[] = [];
	for (const row of rows) {
		const fromVersion = installed.get(row.key) ?? 0;
		try {
			const result = await importBundle(env, `${row.key}@${row.latestVersion}`, { signal, track: "latest" });
			applied.push({
				key: row.key,
				fromVersion: result.previousVersion ?? fromVersion,
				toVersion: result.version,
				ok: true,
			});
		} catch (error) {
			applied.push({
				key: row.key,
				fromVersion,
				toVersion: row.latestVersion,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return applied;
}

/** `/hub update`: the user asked, so every newer version is applied. */
export async function updateBundles(env: HubEnvironment, options: UpdateOptions = {}): Promise<UpdateRunResult> {
	const outcome = await checkForUpdates(env, options);
	const installed = new Map(outcome.tracked.map((entry) => [entry.key, entry.version]));
	const applied = await applyUpdates(env, outcome.available, installed, options.signal);
	return {
		tracked: outcome.tracked,
		pinned: outcome.pinned,
		available: outcome.available,
		applied,
		missing: outcome.missing,
		deferred: [],
	};
}

export function formatUpdateResult(result: UpdateRunResult): string {
	if (result.tracked.length === 0) {
		return result.pinned.length === 0
			? "No bundles are tracking the latest version; nothing to update. Import without @v to follow the hub."
			: `No bundles are tracking the latest version. Pinned: ${result.pinned.join(", ")}.`;
	}

	const appliedByKey = new Map(result.applied.map((entry) => [entry.key, entry]));
	const availableByKey = new Map(result.available.map((row) => [row.key, row]));
	const missing = new Set(result.missing);
	const lines: string[] = [];

	for (const entry of result.tracked) {
		const applied = appliedByKey.get(entry.key);
		if (applied?.ok) {
			lines.push(`${entry.key} v${applied.fromVersion} → v${applied.toVersion}`);
			continue;
		}
		if (applied) {
			lines.push(`${entry.key} v${applied.fromVersion} → v${applied.toVersion} failed: ${applied.error}`);
			continue;
		}
		if (missing.has(entry.key)) {
			lines.push(`${entry.key} — no longer on the hub; left in place (remove it with /hub remove ${entry.key})`);
			continue;
		}
		const row = availableByKey.get(entry.key);
		if (row) {
			lines.push(`${entry.key} v${entry.version} → v${row.latestVersion} available`);
			continue;
		}
		lines.push(`${entry.key}@v${entry.version} — up to date`);
	}

	const updated = result.applied.filter((entry) => entry.ok).length;
	const head =
		updated === 0
			? `Checked ${result.tracked.length} tracked bundle(s); everything is current.`
			: `Updated ${updated} of ${result.tracked.length} tracked bundle(s). Restart phi or run /reload to pick up the change.`;
	if (result.pinned.length > 0) {
		lines.push(`Pinned, not checked: ${result.pinned.join(", ")}.`);
	}
	return [head, "", ...lines].join("\n");
}

// ============================================================================
// Startup check
// ============================================================================

/** Org bundles are gated by org publishers, which is the trust `"org"` buys. */
export function shouldAutoUpdate(mode: HubAutoUpdateMode, ownerIsOrg: boolean | undefined): boolean {
	if (mode === "off") return false;
	if (mode === "all") return true;
	return ownerIsOrg === true;
}

/**
 * Org ownership from the check response when the hub reports it, otherwise from
 * the bundle's own metadata. Anything unresolved is personal: an auto-update is
 * never granted on a guess.
 */
async function resolveOwnerIsOrg(
	client: HubClient,
	row: HubUpdateRow,
	signal?: AbortSignal,
): Promise<boolean | undefined> {
	if (row.ownerIsOrg !== undefined) return row.ownerIsOrg;
	try {
		return (await client.getBundle(parseBundleRef(row.key), signal)).ownerIsOrg;
	} catch {
		return undefined;
	}
}

export type StartupSkipReason = "no-tracked-bundles" | "throttled" | "signed-out" | "unreachable";

export interface StartupCheckOutcome {
	ran: boolean;
	skipped?: StartupSkipReason;
	mode: HubAutoUpdateMode;
	available: HubUpdateRow[];
	applied: AppliedUpdate[];
	deferred: HubUpdateRow[];
	missing: string[];
}

/**
 * The session-start check. Never throws, never prompts, and never blocks: the
 * caller fires it without awaiting, and every failure path returns quietly.
 */
export async function runStartupUpdateCheck(
	env: HubEnvironment,
	options: { now?: number; signal?: AbortSignal } = {},
): Promise<StartupCheckOutcome> {
	const mode = readHubAutoUpdateMode(env.storage);
	const empty = { ran: false, mode, available: [], applied: [], deferred: [], missing: [] };

	const file = await readHubStateFile(env.paths.statePath);
	if (trackedBundles(file.bundles).length === 0) return { ...empty, skipped: "no-tracked-bundles" };
	if (!shouldCheckForUpdates(file.lastUpdateCheck, options.now)) return { ...empty, skipped: "throttled" };

	const { config } = await loadClient(env);
	if (!config.token) return { ...empty, skipped: "signed-out" };

	let outcome: CheckOutcome;
	try {
		outcome = await checkForUpdates(env, { signal: options.signal });
	} catch {
		// Offline, hub down, or a hub without the endpoint: startup stays silent.
		return { ...empty, skipped: "unreachable" };
	}

	const qualifying: HubUpdateRow[] = [];
	const deferred: HubUpdateRow[] = [];
	for (const row of outcome.available) {
		const ownerIsOrg = mode === "org" ? await resolveOwnerIsOrg(outcome.client, row, options.signal) : row.ownerIsOrg;
		if (shouldAutoUpdate(mode, ownerIsOrg)) qualifying.push(row);
		else deferred.push(row);
	}

	const installed = new Map(outcome.tracked.map((entry) => [entry.key, entry.version]));
	const applied = await applyUpdates(env, qualifying, installed, options.signal);
	return { ran: true, mode, available: outcome.available, applied, deferred, missing: outcome.missing };
}

function pendingCount(outcome: StartupCheckOutcome): number {
	return outcome.deferred.length + outcome.applied.filter((entry) => !entry.ok).length;
}

/** The one-line status the footer carries after a startup check. */
export function formatStartupStatus(outcome: StartupCheckOutcome): string | undefined {
	const updated = outcome.applied.filter((entry) => entry.ok).length;
	const pending = pendingCount(outcome);
	if (updated > 0 && pending > 0) return `hub: updated ${updated} bundle(s), ${pending} more — /hub update`;
	if (updated > 0) return `hub: updated ${updated} bundle(s)`;
	if (pending > 0) return `hub: ${pending} update(s) available — /hub update`;
	return undefined;
}

/** The one notification a startup check is allowed to raise. */
export function formatStartupNotice(outcome: StartupCheckOutcome): string | undefined {
	const status = formatStartupStatus(outcome);
	if (!status && outcome.missing.length === 0) return undefined;

	const lines: string[] = [];
	if (status) lines.push(status);
	for (const entry of outcome.applied) {
		lines.push(
			entry.ok
				? `  ${entry.key} v${entry.fromVersion} → v${entry.toVersion}`
				: `  ${entry.key} v${entry.fromVersion} → v${entry.toVersion} failed: ${entry.error}`,
		);
	}
	if (outcome.applied.some((entry) => entry.ok)) {
		lines.push("Updated bundles are wired up already; their resources take effect in your next session.");
	}
	for (const row of outcome.deferred) {
		lines.push(`  ${row.key} v${row.latestVersion} available — /hub update`);
	}
	for (const ref of outcome.missing) {
		lines.push(`  ${ref} is no longer on the hub; it was left in place.`);
	}
	return lines.join("\n");
}

/**
 * Fire-and-forget wrapper used by `session_start`. Failures are swallowed on
 * purpose: a hub problem must never be the first thing a session says.
 */
export async function announceStartupUpdateCheck(env: HubEnvironment, ctx: ExtensionContext): Promise<void> {
	try {
		const outcome = await runStartupUpdateCheck(env);
		const status = formatStartupStatus(outcome);
		if (status) ctx.ui.setStatus("hub", status);
		const notice = formatStartupNotice(outcome);
		if (notice) ctx.ui.notify(notice, "info");
	} catch {
		// Silent by contract.
	}
}
