import { rmdir, stat } from "fs/promises";
import { hostname, userInfo } from "os";
import { join } from "path";
import { APP_NAME } from "../../config.ts";
import { FileSettingsStorage, type SettingsStorage } from "../../core/settings-manager.ts";
import type { DeviceFlowStart, HubBundleSummary, HubProfile } from "./client.ts";
import { HubClient, HubError } from "./client.ts";
import { buildBundleFiles, type ExportCandidate, inferBundleKind } from "./export.ts";
import { type HubConfig, isHubToken, readHubConfig, resolveHubUrl, writeHubConfig } from "./hub-config.ts";
import { InstructionsProvider } from "./instructions.ts";
import { type HubLinkRepair, isBundleLinkable, repairHubPackageLinks, resolveBundleLinkIntent } from "./link-repair.ts";
import { bundleSlugDir, bundleVersionDir, createHubPaths, type HubPaths } from "./paths.ts";
import { type BundleRef, bundleKey, isSafeRefSegment, parseBundleRef } from "./refs.ts";
import { linkPackage, readLinkedPackagePaths, relinkPackage, unlinkPackage } from "./settings-file.ts";
import {
	applyFragment,
	diffFragment,
	type FragmentDiffEntry,
	fragmentIsEmpty,
	readBundleFragment,
	revertLatestBackup,
	type SettingsFragment,
} from "./settings-fragment.ts";
import {
	type HubState,
	type HubTrack,
	readHubState,
	shouldLinkBundle,
	withEnabled,
	withImported,
	withRemoved,
	withSettingsApplied,
	writeHubState,
} from "./state.ts";
import {
	detectBundleKinds,
	materializeBundle,
	removeStoreDir,
	validateBundleFilePath,
	writeProvenance,
} from "./store.ts";

/** Everything the hub operations need. Constructed once per session; no I/O in the constructor. */
export interface HubEnvironment {
	paths: HubPaths;
	storage: SettingsStorage;
	instructions: InstructionsProvider;
}

export function createHubEnvironment(cwd: string, agentDir: string): HubEnvironment {
	const paths = createHubPaths(agentDir);
	return {
		paths,
		storage: new FileSettingsStorage(cwd, agentDir),
		instructions: new InstructionsProvider(paths),
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function loadClient(env: HubEnvironment): Promise<{ client: HubClient; config: HubConfig }> {
	const config = await readHubConfig(env.paths.configPath);
	return { client: new HubClient(config.url, config.token), config };
}

// ============================================================================
// Status
// ============================================================================

export interface HubStatusRow {
	key: string;
	version: number;
	enabled: boolean;
	kinds: string[];
	path: string;
	/** Whether the store path is present in the global `packages` array. */
	linked: boolean;
	/**
	 * Whether this bundle belongs in `packages` at all. Only the four pi resource
	 * kinds are loaded from there; a models/instructions/settings-only bundle is
	 * enabled through `hub/state.json` and must stay unlinked.
	 */
	linkable: boolean;
	/**
	 * What reconciliation would do with this row: `true` it belongs in `packages`,
	 * `false` it does not, `undefined` the row is too malformed to say and both
	 * `/hub sync` and the startup migration will leave it alone. Reported drift is
	 * derived from this, so status cannot advertise a repair sync then declines.
	 */
	expectedLink: boolean | undefined;
	/** Whether the materialized store directory still exists on disk. */
	present: boolean;
	track: HubTrack;
	title?: string;
	settingsApplied: boolean;
}

export interface HubStatus {
	url: string;
	signedIn: boolean;
	handle?: string;
	email?: string;
	rows: HubStatusRow[];
}

export async function hubStatus(env: HubEnvironment): Promise<HubStatus> {
	const config = await readHubConfig(env.paths.configPath);
	const state = await readHubState(env.paths.statePath);
	const linked = new Set(readLinkedPackagePaths(env.storage));

	const rows: HubStatusRow[] = [];
	for (const key of Object.keys(state).sort()) {
		const row = state[key];
		rows.push({
			key,
			version: row.version,
			enabled: row.enabled,
			kinds: row.kinds,
			path: row.path,
			linked: linked.has(row.path),
			linkable: isBundleLinkable(row),
			expectedLink: resolveBundleLinkIntent(row),
			present: await pathExists(row.path),
			track: row.track,
			title: row.title,
			settingsApplied: row.settingsApplied ?? false,
		});
	}

	return { url: config.url, signedIn: Boolean(config.token), handle: config.handle, email: config.email, rows };
}

export function formatStatus(status: HubStatus): string {
	const lines = [`phi hub: ${status.url}`];
	lines.push(status.signedIn ? `signed in as ${status.handle ?? "(unknown handle)"}` : "not signed in (/hub login)");
	if (status.rows.length === 0) {
		lines.push("no bundles imported (/hub search <query>, /hub import <owner>/<slug>)");
		return lines.join("\n");
	}
	lines.push("");
	for (const row of status.rows) {
		const flags = [row.enabled ? "enabled" : "disabled", row.track === "latest" ? "tracking latest" : "pinned"];
		if (!row.linkable) flags.push("no packages link needed");
		if (row.expectedLink !== undefined && row.expectedLink !== row.linked) {
			flags.push(row.linked ? "link drift: still linked" : "link drift: not linked");
		}
		if (!row.present) flags.push("files missing");
		if (row.settingsApplied) flags.push("settings applied");
		const kinds = row.kinds.length > 0 ? ` [${row.kinds.join(", ")}]` : "";
		lines.push(`${row.key}@v${row.version}${kinds} — ${flags.join(", ")}`);
	}
	return lines.join("\n");
}

// ============================================================================
// Authentication
// ============================================================================

export function defaultDeviceName(): string {
	let user = "phi";
	try {
		user = userInfo().username || user;
	} catch {
		// Some sandboxes have no passwd entry.
	}
	return `${APP_NAME} on ${hostname()} (${user})`;
}

export interface DeviceFlowCallbacks {
	onStart(start: DeviceFlowStart): void;
	onPoll?(elapsedSeconds: number): void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Device flow per the hub contract: start, show the code, poll until approved. */
export async function loginWithDeviceFlow(
	env: HubEnvironment,
	callbacks: DeviceFlowCallbacks,
	signal?: AbortSignal,
): Promise<HubProfile> {
	const config = await readHubConfig(env.paths.configPath);
	const url = resolveHubUrl(config.url);
	const client = new HubClient(url);

	const start = await client.startDeviceFlow(defaultDeviceName(), signal);
	callbacks.onStart(start);

	const intervalMs = Math.max(1, start.intervalSeconds) * 1000;
	const deadline = Date.now() + Math.max(30, start.expiresInSeconds) * 1000;
	const startedAt = Date.now();

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new HubError("Sign-in cancelled.");
		await sleep(intervalMs);
		const result = await client.pollDeviceFlow(start.deviceCode, signal);
		if (result.status === "approved") {
			client.setToken(result.token);
			const profile = result.profile ?? (await client.whoami(signal));
			await writeHubConfig(env.paths.configPath, {
				url,
				token: result.token,
				handle: profile.handle,
				email: profile.email,
			});
			return profile;
		}
		if (result.status === "denied") throw new HubError("Sign-in was denied in the browser.");
		if (result.status === "expired") throw new HubError("The sign-in code expired. Run /hub login again.");
		callbacks.onPoll?.(Math.round((Date.now() - startedAt) / 1000));
	}
	throw new HubError("The sign-in code expired. Run /hub login again.");
}

/** Accept a token pasted from the hub UI instead of running the device flow. */
export async function loginWithToken(env: HubEnvironment, token: string, signal?: AbortSignal): Promise<HubProfile> {
	const trimmed = token.trim();
	if (!isHubToken(trimmed)) {
		throw new HubError("That does not look like a phi hub token (expected phk_ followed by 40 hex characters).");
	}
	const config = await readHubConfig(env.paths.configPath);
	const url = resolveHubUrl(config.url);
	const client = new HubClient(url, trimmed);
	const profile = await client.whoami(signal);
	await writeHubConfig(env.paths.configPath, { url, token: trimmed, handle: profile.handle, email: profile.email });
	return profile;
}

export async function whoami(env: HubEnvironment, signal?: AbortSignal): Promise<HubProfile> {
	const { client } = await loadClient(env);
	return client.whoami(signal);
}

// ============================================================================
// Search
// ============================================================================

export async function searchBundles(
	env: HubEnvironment,
	query: { q?: string; kind?: string; owner?: string },
	signal?: AbortSignal,
): Promise<HubBundleSummary[]> {
	const { client } = await loadClient(env);
	return client.searchBundles(query, signal);
}

export function formatSearchResults(results: HubBundleSummary[]): string {
	if (results.length === 0) return "No bundles matched.";
	return results
		.map((result) => {
			const version = result.latestVersion === undefined ? "" : `@v${result.latestVersion}`;
			const kind = result.kind ? ` (${result.kind})` : "";
			const installs = result.installCount === undefined ? "" : ` · ${result.installCount} installs`;
			const description = result.description ? `\n    ${result.description}` : "";
			return `${result.owner}/${result.slug}${version}${kind}${installs}${description}`;
		})
		.join("\n");
}

// ============================================================================
// Import / enable / disable / remove
// ============================================================================

export interface ImportResult {
	key: string;
	version: number;
	kinds: string[];
	path: string;
	enabled: boolean;
	/** Whether the bundle got a `packages` entry; false for hub-only kinds. */
	linked: boolean;
	fileCount: number;
	previousVersion?: number;
	hasSettingsFragment: boolean;
	track: HubTrack;
}

export interface ImportOptions {
	signal?: AbortSignal;
	/**
	 * Overrides the track the ref implies. `/hub update` uses it to re-import an
	 * explicit version while keeping the bundle on the latest track.
	 */
	track?: HubTrack;
}

/**
 * Materialize into the isolated store and, when the bundle ships a resource kind
 * pi's package loader can resolve, link it with exactly one absolute-path entry
 * in the global `packages` array. Nothing else in the user's settings or resource
 * directories is touched.
 *
 * A models/instructions/settings-only bundle is never linked: those kinds load
 * from `hub/state.json` through their own loaders, and a `packages` entry
 * pointing at a root with no `skills/`, `extensions/`, `prompts/`, or `themes/`
 * makes pi resolve the root itself as an extension and fail to import it.
 *
 * A ref without `@v` follows the hub (`track: "latest"`); a pinned ref stays put
 * (`track: "pinned"`).
 */
export async function importBundle(
	env: HubEnvironment,
	input: string,
	options: ImportOptions = {},
): Promise<ImportResult> {
	const { signal } = options;
	const requested = parseBundleRef(input);
	const track: HubTrack = options.track ?? (requested.version === undefined ? "latest" : "pinned");
	const { client } = await loadClient(env);

	const metadata = await client.getBundle(requested, signal);
	const version = requested.version ?? metadata.latestVersion;
	if (version === undefined) {
		throw new HubError(`${bundleKey(requested)} has no published versions yet.`);
	}
	const ref: BundleRef = { owner: requested.owner, slug: requested.slug, version };

	const files = await client.getVersionFiles(ref, signal);
	const key = bundleKey(ref);
	const state = await readHubState(env.paths.statePath);
	const previous = state[key];
	const versionDir = bundleVersionDir(env.paths, ref.owner, ref.slug, version);

	// Validate every path before touching disk, so a hostile or malformed
	// payload cannot delete an already-installed version on its way to failing.
	for (const file of files) validateBundleFilePath(file.path);

	// Re-materialize from scratch so a re-import never merges with a stale tree.
	await removeStoreDir(versionDir);
	await materializeBundle(versionDir, files);
	await writeProvenance(versionDir, { owner: ref.owner, slug: ref.slug, version });

	const kinds = detectBundleKinds(files.map((file) => file.path));
	const enabled = previous?.enabled ?? true;
	const linked = shouldLinkBundle({ enabled, kinds });
	if (linked) {
		if (previous && previous.path !== versionDir) {
			relinkPackage(env.storage, previous.path, versionDir);
		} else {
			linkPackage(env.storage, versionDir);
		}
	} else {
		// Nothing here the package loader can resolve, so neither version dir may be
		// left in `packages`: not the superseded one (a version that dropped its last
		// loadable kind), and not this one (a hub-only bundle an older client linked,
		// whose entry can outlive its state row). Unlink is idempotent and skips the
		// write when there is no match, so the common fresh-import case costs nothing.
		if (previous) unlinkPackage(env.storage, previous.path);
		unlinkPackage(env.storage, versionDir);
	}

	await writeHubState(
		env.paths.statePath,
		withImported(state, key, {
			version,
			enabled,
			path: versionDir,
			kinds,
			track,
			title: metadata.title,
			importedAt: new Date().toISOString(),
			settingsApplied: previous?.settingsApplied,
		}),
	);
	env.instructions.invalidate();

	// Only after the new version is on disk and linked.
	if (previous && previous.path !== versionDir) {
		await removeStoreDir(previous.path);
	}

	await client.recordEvent(ref, "imported", version);

	return {
		key,
		version,
		kinds,
		path: versionDir,
		enabled,
		linked,
		fileCount: files.length,
		previousVersion: previous?.version,
		hasSettingsFragment: kinds.includes("settings"),
		track,
	};
}

/**
 * `/hub install` is import that always follows the hub. Pinning is a different
 * intent, so a pinned ref is refused here rather than silently tracked.
 */
export async function installBundle(
	env: HubEnvironment,
	input: string,
	options: ImportOptions = {},
): Promise<ImportResult> {
	const requested = parseBundleRef(input);
	if (requested.version !== undefined) {
		const key = bundleKey(requested);
		throw new HubError(
			`/hub install always tracks the latest version. To pin ${key} at v${requested.version}, run /hub import ${key}@${requested.version}.`,
		);
	}
	return importBundle(env, bundleKey(requested), { ...options, track: "latest" });
}

function requireRow(state: HubState, key: string) {
	const row = state[key];
	if (!row) throw new HubError(`${key} is not imported. Run /hub import ${key} first.`);
	return row;
}

/**
 * Enable/disable is a state change first and a link change only when the bundle
 * is linkable. Enabling a hub-only bundle takes effect through its own loader, so
 * `unlinkPackage` runs on that path too: it is the idempotent way to clear an
 * entry a pre-fix client may have left behind.
 */
export async function setBundleEnabled(
	env: HubEnvironment,
	input: string,
	enabled: boolean,
): Promise<{ key: string; changed: boolean; version: number; linked: boolean; linkable: boolean }> {
	const ref = parseBundleRef(input);
	const key = bundleKey(ref);
	const state = await readHubState(env.paths.statePath);
	const row = requireRow(state, key);

	// `enabled` is the caller's explicit intent, so the row's own (possibly
	// unrecorded) flag is irrelevant here; what still needs resolving is whether
	// the bundle is loadable, which a legacy empty-`kinds` row can only answer
	// from disk.
	const linked = resolveBundleLinkIntent({ ...row, enabled, enabledUnknown: undefined }) ?? false;
	const changed = linked ? linkPackage(env.storage, row.path) : unlinkPackage(env.storage, row.path);
	await writeHubState(env.paths.statePath, withEnabled(state, key, enabled));
	env.instructions.invalidate();

	const { client } = await loadClient(env);
	await client.recordEvent(ref, enabled ? "enabled" : "disabled", row.version);

	return {
		key,
		changed: changed || row.enabled !== enabled,
		version: row.version,
		linked,
		linkable: isBundleLinkable(row),
	};
}

export async function removeBundle(env: HubEnvironment, input: string): Promise<{ key: string; version: number }> {
	const ref = parseBundleRef(input);
	const key = bundleKey(ref);
	const state = await readHubState(env.paths.statePath);
	const row = requireRow(state, key);

	unlinkPackage(env.storage, row.path);
	await removeStoreDir(bundleSlugDir(env.paths, ref.owner, ref.slug));
	// Prune the owner directory when it held only this bundle; ENOTEMPTY is fine.
	await rmdir(join(env.paths.bundlesDir, ref.owner)).catch(() => {});
	await writeHubState(env.paths.statePath, withRemoved(state, key));
	env.instructions.invalidate();

	const { client } = await loadClient(env);
	await client.recordEvent(ref, "removed", row.version);

	return { key, version: row.version };
}

// ============================================================================
// Settings fragments
// ============================================================================

export interface SettingsApplyPlan {
	key: string;
	fragment: SettingsFragment;
	diff: FragmentDiffEntry[];
}

export async function planSettingsApply(env: HubEnvironment, input: string): Promise<SettingsApplyPlan> {
	const key = bundleKey(parseBundleRef(input));
	const state = await readHubState(env.paths.statePath);
	const row = requireRow(state, key);

	const fragment = await readBundleFragment(row.path);
	if (fragmentIsEmpty(fragment)) {
		throw new HubError(`${key} ships no settings/ fragment.`);
	}
	return { key, fragment, diff: await diffFragment(env.storage, env.paths.keybindingsPath, fragment) };
}

export async function commitSettingsApply(env: HubEnvironment, plan: SettingsApplyPlan): Promise<string[]> {
	const applied = await applyFragment(env.storage, env.paths, plan.fragment, plan.diff);
	const state = await readHubState(env.paths.statePath);
	await writeHubState(env.paths.statePath, withSettingsApplied(state, plan.key, true));

	const { client } = await loadClient(env);
	await client.recordEvent(parseBundleRef(plan.key), "applied", state[plan.key]?.version);

	return applied.backups;
}

export async function revertSettings(env: HubEnvironment): Promise<{ timestamp: string; restored: string[] }> {
	const result = await revertLatestBackup(env.storage, env.paths);
	if (!result) throw new HubError("No hub settings backup to revert; /hub apply-settings has not run yet.");
	return { timestamp: result.timestamp, restored: result.restored };
}

// ============================================================================
// Sync
// ============================================================================

export interface SyncRow {
	key: string;
	version: number;
	latestVersion?: number;
	updateAvailable: boolean;
	repaired: string[];
	error?: string;
}

/**
 * Reconcile local state with the hub: repair link drift, report newer versions.
 *
 * The link half is `repairHubPackageLinks` — the same code the startup migration
 * runs, with `relink` on because `/hub sync` is explicitly asked to fix drift in
 * both directions. So a models/instructions/settings-only bundle an older client
 * linked is unlinked here too, and the rule cannot drift between the two callers.
 */
export async function syncBundles(env: HubEnvironment, signal?: AbortSignal): Promise<SyncRow[]> {
	const state = await readHubState(env.paths.statePath);
	const { client, config } = await loadClient(env);
	const repairsByKey = new Map<string, HubLinkRepair>();
	for (const repair of repairHubPackageLinks(env.storage, state, { relink: true })) {
		repairsByKey.set(repair.key, repair);
	}
	const rows: SyncRow[] = [];

	for (const key of Object.keys(state).sort()) {
		const row = state[key];
		const repair = repairsByKey.get(key);
		const repaired: string[] = [];
		if (repair?.action === "linked") repaired.push("relinked");
		if (repair?.action === "unlinked") {
			repaired.push(repair.stale ? "unlinked (no loadable resources)" : "unlinked");
		}

		const entry: SyncRow = { key, version: row.version, updateAvailable: false, repaired };
		if (!(await pathExists(row.path))) {
			entry.error = "store directory is missing; re-import to restore it";
		}
		if (config.token) {
			try {
				const metadata = await client.getBundle(parseBundleRef(key), signal);
				entry.latestVersion = metadata.latestVersion;
				entry.updateAvailable = metadata.latestVersion !== undefined && metadata.latestVersion > row.version;
			} catch (error) {
				entry.error = error instanceof Error ? error.message : String(error);
			}
		}
		rows.push(entry);
	}
	env.instructions.invalidate();
	return rows;
}

export function formatSyncRows(rows: SyncRow[]): string {
	if (rows.length === 0) return "No bundles imported; nothing to sync.";
	return rows
		.map((row) => {
			const notes: string[] = [];
			if (row.updateAvailable) notes.push(`update available: v${row.latestVersion}`);
			if (row.repaired.length > 0) notes.push(row.repaired.join(", "));
			if (row.error) notes.push(row.error);
			return `${row.key}@v${row.version}${notes.length > 0 ? ` — ${notes.join("; ")}` : " — up to date"}`;
		})
		.join("\n");
}

// ============================================================================
// Publish
// ============================================================================

export interface PublishInput {
	slug: string;
	title: string;
	description: string;
	kind?: string;
	tags?: string[];
	changelog?: string;
	candidates: ExportCandidate[];
	/**
	 * Org handle to publish under (marketplace v2). The caller must be a
	 * publisher of that org; the hub rejects it otherwise. Omitted publishes to
	 * the signed-in profile.
	 */
	owner?: string;
}

export interface PublishResult {
	key: string;
	version: number;
	fileCount: number;
	kind: string;
	/** True when the bundle was published under an org handle rather than the user's. */
	publishedToOrg: boolean;
}

export async function publishBundle(
	env: HubEnvironment,
	input: PublishInput,
	signal?: AbortSignal,
): Promise<PublishResult> {
	if (input.candidates.length === 0) {
		throw new HubError("Select at least one item to publish.");
	}
	const { client, config } = await loadClient(env);
	if (!config.handle) {
		const profile = await client.whoami(signal);
		await writeHubConfig(env.paths.configPath, { ...config, handle: profile.handle, email: profile.email });
		config.handle = profile.handle;
	}

	const files = await buildBundleFiles(input.candidates);
	const kind = input.kind ?? inferBundleKind(input.candidates);
	const owner = input.owner?.trim() || config.handle;
	if (!isSafeRefSegment(owner)) {
		throw new HubError(`"${owner}" is not a valid owner handle.`);
	}
	await client.createBundle(
		{
			slug: input.slug,
			title: input.title,
			description: input.description,
			kind,
			tags: input.tags ?? [],
			owner: owner === config.handle ? undefined : owner,
		},
		signal,
	);

	const ref: BundleRef = { owner, slug: input.slug };
	const version = await client.publishVersion(ref, { changelog: input.changelog, files }, signal);
	return { key: bundleKey(ref), version, fileCount: files.length, kind, publishedToOrg: owner !== config.handle };
}
