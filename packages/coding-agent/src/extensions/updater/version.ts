import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compare, parse, type SemVer } from "semver";
import { getPackageDir } from "../../config.ts";

export const PHI_UPDATE_BASE_URL = "http://127.0.0.1:8789/downloads";
const VERSION_MANIFEST_NAME = "versions.json";
const LOCAL_RELEASE_NAME = "phi-version.json";
const DEFAULT_TIMEOUT_MS = 3000;

export interface PhiRelease {
	version: string;
	releaseId: string;
	commit: string;
	publishedAt: string;
	installer: string;
}

export interface PhiVersionsManifest {
	schemaVersion: 1;
	channel: string;
	latest: PhiRelease;
}

function parseRelease(value: unknown): PhiRelease | undefined {
	if (!value || typeof value !== "object") return undefined;
	const release = value as Record<string, unknown>;
	for (const key of ["version", "releaseId", "commit", "publishedAt", "installer"] as const) {
		if (typeof release[key] !== "string" || !release[key].trim()) return undefined;
	}
	return {
		version: release.version as string,
		releaseId: release.releaseId as string,
		commit: release.commit as string,
		publishedAt: release.publishedAt as string,
		installer: release.installer as string,
	};
}

export function parseVersionsManifest(value: unknown): PhiVersionsManifest | undefined {
	if (!value || typeof value !== "object") return undefined;
	const manifest = value as Record<string, unknown>;
	const latest = parseRelease(manifest.latest);
	if (manifest.schemaVersion !== 1 || typeof manifest.channel !== "string" || !latest) return undefined;
	return { schemaVersion: 1, channel: manifest.channel, latest };
}

interface ParsedPhiReleaseId {
	version: SemVer;
	sha: string;
	run?: bigint;
	attempt?: bigint;
}

const PHI_RELEASE_ID_PATTERN = /^([^+]+)\+([0-9a-f]{12})(?:\.r([1-9][0-9]*)\.([1-9][0-9]*))?$/i;
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

function parsePhiReleaseId(releaseId: string): ParsedPhiReleaseId | undefined {
	const match = PHI_RELEASE_ID_PATTERN.exec(releaseId);
	if (!match) return undefined;

	const [, versionText, sha, runText, attemptText] = match;
	const version = parse(versionText);
	const fullVersion = parse(releaseId);
	const expectedBuild = runText ? [sha, `r${runText}`, attemptText] : [sha];
	if (
		!version ||
		!fullVersion ||
		version.version !== versionText ||
		fullVersion.version !== versionText ||
		fullVersion.build.length !== expectedBuild.length ||
		fullVersion.build.some((part, index) => part !== expectedBuild[index])
	) {
		return undefined;
	}

	return {
		version,
		sha: sha.toLowerCase(),
		run: runText ? BigInt(runText) : undefined,
		attempt: attemptText ? BigInt(attemptText) : undefined,
	};
}

function isComparableRelease(release: PhiRelease, parsed: ParsedPhiReleaseId): boolean {
	const version = parse(release.version);
	const commit = release.commit.toLowerCase();
	return (
		version !== null &&
		version.version === release.version &&
		version.build.length === 0 &&
		compare(version, parsed.version) === 0 &&
		FULL_COMMIT_PATTERN.test(commit) &&
		commit.startsWith(parsed.sha)
	);
}

function compareNumber(left: number | bigint, right: number | bigint): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function exoIteration(version: SemVer): bigint | undefined {
	const [label, iteration, ...rest] = version.prerelease;
	if (label !== "exo" || typeof iteration !== "number" || iteration < 1 || rest.length > 0) return undefined;
	return BigInt(iteration);
}

/**
 * Compare phi package versions. Fork releases use `X.Y.Z-exo.N` as builds after
 * upstream `X.Y.Z`, so their chronology is `X.Y.Z < X.Y.Z-exo.1 < ...` even
 * though generic SemVer precedence puts every prerelease before `X.Y.Z`.
 */
function comparePhiVersion(left: SemVer, right: SemVer): number {
	for (const key of ["major", "minor", "patch"] as const) {
		const comparison = compareNumber(left[key], right[key]);
		if (comparison !== 0) return comparison;
	}

	const leftExo = exoIteration(left);
	const rightExo = exoIteration(right);
	const leftIsPhiRelease = left.prerelease.length === 0 || leftExo !== undefined;
	const rightIsPhiRelease = right.prerelease.length === 0 || rightExo !== undefined;
	if (leftIsPhiRelease && rightIsPhiRelease) {
		return compareNumber(leftExo ?? 0n, rightExo ?? 0n);
	}
	return compare(left, right);
}

function compareBuild(left: ParsedPhiReleaseId, right: ParsedPhiReleaseId): number | undefined {
	if (left.run === undefined || left.attempt === undefined || right.run === undefined || right.attempt === undefined) {
		return undefined;
	}
	const runComparison = compareNumber(left.run, right.run);
	return runComparison !== 0 ? runComparison : compareNumber(left.attempt, right.attempt);
}

/**
 * True when a release carries a well-formed, self-consistent identity (parseable
 * release id whose version and commit agree with the other fields), i.e. it can
 * take part in ordering at all.
 */
export function isComparablePhiRelease(release: PhiRelease): boolean {
	const parsed = parsePhiReleaseId(release.releaseId);
	return parsed !== undefined && isComparableRelease(release, parsed);
}

/** Return true only when the feed contains a strictly newer, consistently ordered phi release. */
export function isDifferentRelease(current: PhiRelease | undefined, latest: PhiRelease): boolean {
	if (!current) return false;

	const currentId = parsePhiReleaseId(current.releaseId);
	const latestId = parsePhiReleaseId(latest.releaseId);
	if (!currentId || !latestId || !isComparableRelease(current, currentId) || !isComparableRelease(latest, latestId)) {
		return false;
	}

	const versionComparison = comparePhiVersion(latestId.version, currentId.version);
	if (versionComparison < 0) return false;

	const buildComparison = compareBuild(latestId, currentId);
	if (versionComparison === 0) return buildComparison !== undefined && buildComparison > 0;

	// Do not move from structured chronology back to a legacy ID. When both
	// releases carry workflow chronology, reject contradictory signals (for
	// example, an older archived build claiming a higher package version).
	if (currentId.run !== undefined && latestId.run === undefined) return false;
	return buildComparison === undefined || buildComparison > 0;
}

export async function readCurrentPhiRelease(packageDir = getPackageDir()): Promise<PhiRelease | undefined> {
	try {
		return parseRelease(JSON.parse(await readFile(join(packageDir, LOCAL_RELEASE_NAME), "utf8")));
	} catch {
		return undefined;
	}
}

export async function fetchLatestPhiRelease(
	options: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<PhiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;
	const baseUrl = (options.baseUrl ?? process.env.PHI_UPDATE_BASE_URL ?? PHI_UPDATE_BASE_URL).replace(/\/+$/, "");
	const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/${VERSION_MANIFEST_NAME}`, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;
	return parseVersionsManifest(await response.json())?.latest;
}

/**
 * Outcome of comparing the installed release against the feed, with enough
 * detail for a CLI to explain itself. `checkForPhiUpdate` flattens this to
 * "update or nothing" for the quiet TUI notice.
 */
export type PhiUpdateCheck =
	| { status: "update"; current: PhiRelease; latest: PhiRelease }
	| { status: "current"; current: PhiRelease; latest: PhiRelease }
	/** No `phi-version.json` next to the binary: not installed by phi-install.sh. */
	| { status: "unmanaged" }
	/** Feed unreachable or malformed, PI_OFFLINE set, or the local metadata unusable. */
	| { status: "unavailable"; current: PhiRelease | undefined; reason: string };

export async function inspectPhiUpdate(
	options: { packageDir?: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<PhiUpdateCheck> {
	const packageDir = options.packageDir ?? getPackageDir();
	const current = await readCurrentPhiRelease(packageDir);
	if (!current) {
		// Absent means the installer never put this binary here; present but
		// unreadable is a different problem and must not be reported as "no metadata".
		if (!existsSync(join(packageDir, LOCAL_RELEASE_NAME))) return { status: "unmanaged" };
		return {
			status: "unavailable",
			current: undefined,
			reason: `installed release metadata is unreadable: ${join(packageDir, LOCAL_RELEASE_NAME)}`,
		};
	}
	if (process.env.PI_OFFLINE) return { status: "unavailable", current, reason: "PI_OFFLINE is set" };

	let latest: PhiRelease | undefined;
	try {
		latest = await fetchLatestPhiRelease(options);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { status: "unavailable", current, reason };
	}
	if (!latest) {
		return { status: "unavailable", current, reason: `no valid ${VERSION_MANIFEST_NAME} on the release feed` };
	}
	// isDifferentRelease() answers "strictly newer?" and says no for malformed
	// metadata too; that must not read as "up to date" (or be handed to --force).
	if (!isComparablePhiRelease(latest)) {
		return {
			status: "unavailable",
			current,
			reason: `release feed names an incomparable release: ${latest.releaseId}`,
		};
	}
	if (!isComparablePhiRelease(current)) {
		return {
			status: "unavailable",
			current,
			reason: `installed release metadata is incomparable: ${current.releaseId}`,
		};
	}
	return isDifferentRelease(current, latest)
		? { status: "update", current, latest }
		: { status: "current", current, latest };
}

export async function checkForPhiUpdate(): Promise<{ current: PhiRelease; latest: PhiRelease } | undefined> {
	try {
		const check = await inspectPhiUpdate();
		return check.status === "update" ? { current: check.current, latest: check.latest } : undefined;
	} catch {
		return undefined;
	}
}
