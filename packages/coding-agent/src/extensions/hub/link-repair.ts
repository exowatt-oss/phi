/**
 * The one place `packages` links are reconciled against `hub/state.json`.
 *
 * Two callers share it so the rule cannot drift:
 * - the synchronous startup migration (`runMigrations`), which must drop a stale
 *   entry *before* the package manager resolves `packages`, and
 * - `/hub sync`, which additionally repairs a hand-deleted link and reports what
 *   it did.
 *
 * Everything here is synchronous on purpose. The startup migration runs before
 * any resource is resolved, so it cannot hand the work to a promise: by the time
 * an async repair settled, pi would already have tried to `jiti.import()` the
 * bundle root as an extension.
 */

import { statSync } from "fs";
import { join } from "path";
import { FileSettingsStorage, type SettingsStorage } from "../../core/settings-manager.ts";
import { createHubPaths } from "./paths.ts";
import { reconcilePackages } from "./settings-file.ts";
import { type HubBundleState, type HubState, readHubStateFileSync } from "./state.ts";
import { hasLoadableBundleKinds, LOADABLE_BUNDLE_KINDS } from "./store.ts";

export interface HubLinkRepair {
	key: string;
	path: string;
	action: "linked" | "unlinked";
	/**
	 * True when an *enabled* bundle's entry was dropped because it ships nothing
	 * the package loader can resolve. That is the case a pre-fix client created
	 * and the one that breaks startup; a disabled bundle losing its entry is
	 * ordinary drift.
	 */
	stale: boolean;
}

export interface RepairOptions {
	/**
	 * Also add a missing entry for a bundle that should have one. Off by default:
	 * a missing link cannot break startup, so the startup migration stays
	 * subtractive rather than re-adding an entry a user deliberately deleted.
	 * `/hub sync` opts in — repairing drift in both directions is what it is for.
	 */
	relink?: boolean;
}

function isPresent(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether this bundle ships anything the package loader can resolve.
 *
 * `hasLoadableBundleKinds(row.kinds)`, with a safety net for a row that records
 * no `kinds` at all. An empty `kinds` array is ambiguous: it is what a bundle
 * with nothing recognizable genuinely produces, but also what a hand-edited,
 * truncated, or partially-written state row looks like — and `parseBundles`
 * defaults the field to `[]` for any row whose `kinds` is missing or not an array
 * of strings. Unlinking is the destructive direction, so when the row cannot say
 * what the bundle ships, ask the directory instead of assuming the answer that
 * removes a working link.
 *
 * Every caller that can drop a link — the startup migration, `/hub sync`,
 * `/hub enable|disable`, and what `/hub status` reports as drift — resolves it
 * through here, so the three cannot disagree about the same legacy row.
 */
export function isBundleLinkable(row: Pick<HubBundleState, "kinds" | "path">): boolean {
	if (row.kinds.length > 0) return hasLoadableBundleKinds(row.kinds);
	return LOADABLE_BUNDLE_KINDS.some((kind) => isPresent(join(row.path, kind)));
}

/**
 * Whether this row should hold a `packages` entry: `true` link it, `false` drop
 * it, `undefined` leave it exactly as it is.
 *
 * `undefined` is for a row whose `enabled` field was missing or not a boolean.
 * It is read as disabled so the rest of the client keeps working, but that is a
 * fallback rather than recorded intent, and "disabled" is the value that unlinks
 * — so malformed state gets the non-destructive answer instead.
 */
export function resolveBundleLinkIntent(row: HubBundleState): boolean | undefined {
	if (row.enabledUnknown) return undefined;
	if (!row.enabled) return false;
	return isBundleLinkable(row);
}

/**
 * Bring `packages` in line with `shouldBeLinked` for every row in `state`.
 *
 * Returns one entry per settings mutation, ordered by bundle key, so callers can
 * report exactly what changed. Link/unlink are idempotent and skip the write
 * when nothing changes, so a clean machine performs no write at all.
 */
export function repairHubPackageLinks(
	storage: SettingsStorage,
	state: HubState,
	options: RepairOptions = {},
): HubLinkRepair[] {
	const link: string[] = [];
	const unlink: string[] = [];
	const keyByPath = new Map<string, string>();

	for (const key of Object.keys(state).sort()) {
		const row = state[key];
		// A store dir that is not there resolves to nothing, so its entry cannot be
		// the startup error this repairs — and linking a dead path would just be a
		// second kind of stale. Dropping it would also mean a transiently unavailable
		// store (unmounted volume, half-written import) silently costs a working link,
		// so leave it either way and let `/hub sync` report it missing.
		if (!isPresent(row.path)) continue;
		const wanted = resolveBundleLinkIntent(row);
		if (wanted === undefined) continue;
		if (!keyByPath.has(row.path)) keyByPath.set(row.path, key);
		if (wanted) {
			if (options.relink) link.push(row.path);
			continue;
		}
		unlink.push(row.path);
	}

	const enabledByPath = new Map<string, boolean>();
	for (const key of Object.keys(state)) enabledByPath.set(state[key].path, state[key].enabled);

	const applied = reconcilePackages(storage, { link, unlink });
	const repairs: HubLinkRepair[] = [];
	for (const path of applied.linked) {
		repairs.push({ key: keyByPath.get(path) ?? path, path, action: "linked", stale: false });
	}
	for (const path of applied.unlinked) {
		repairs.push({
			key: keyByPath.get(path) ?? path,
			path,
			action: "unlinked",
			stale: enabledByPath.get(path) ?? false,
		});
	}
	return repairs.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Startup migration: drop `packages` entries pi cannot load as packages.
 *
 * Older clients linked every bundle root, including a models/instructions/
 * settings-only bundle. Such a root has no `skills/`, `extensions/`, `prompts/`,
 * or `themes/` under it, so the package resolver falls back to treating the
 * directory itself as an extension and the extension loader fails to import it —
 * a startup error on every session and in every spawned subagent. Repairing it
 * here, before `packages` is read, is what makes those machines self-heal.
 *
 * Never throws: a malformed `hub/state.json` or `settings.json` is a hub problem
 * and must not stop pi from starting. Returns the keys whose stale entry was
 * removed, for the one line startup is allowed to print.
 *
 * Idempotent, and cheap on a clean machine (one state read, no settings write),
 * because it is called from more than one place: every path that can resolve
 * `packages` has to run it first, and `pi package` / `pi config` resolve before
 * the normal migration phase is reached.
 */
export function migrateHubPackageLinks(cwd: string, agentDir: string): string[] {
	try {
		const statePath = createHubPaths(agentDir).statePath;
		const state = readHubStateFileSync(statePath).bundles;
		if (Object.keys(state).length === 0) return [];
		const repairs = repairHubPackageLinks(new FileSettingsStorage(cwd, agentDir), state);
		return repairs.filter((repair) => repair.stale).map((repair) => repair.key);
	} catch {
		return [];
	}
}
