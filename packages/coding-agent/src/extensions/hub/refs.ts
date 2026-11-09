/**
 * Bundle references: `owner/slug`, optionally pinned with `@3`, `@v3`, or
 * `@latest`. Both segments become path components of the local store, so they
 * are validated strictly rather than merely parsed.
 */

const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export interface BundleRef {
	owner: string;
	slug: string;
	/** Undefined means "latest". */
	version?: number;
}

/** A ref segment that is safe to use as a single filesystem path component. */
export function isSafeRefSegment(value: string): boolean {
	if (value.length === 0 || value.length > 64) return false;
	if (value === "." || value === "..") return false;
	return SEGMENT_PATTERN.test(value);
}

function parseVersion(raw: string, input: string): number | undefined {
	if (raw === "latest") return undefined;
	const digits = raw.startsWith("v") ? raw.slice(1) : raw;
	if (!/^\d+$/.test(digits)) {
		throw new Error(`Invalid bundle version in "${input}". Use owner/slug, owner/slug@3, or owner/slug@latest.`);
	}
	const version = Number.parseInt(digits, 10);
	if (version < 1) {
		throw new Error(`Invalid bundle version in "${input}". Versions start at 1.`);
	}
	return version;
}

export function parseBundleRef(input: string): BundleRef {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Missing bundle reference. Use owner/slug.");
	}

	const at = trimmed.indexOf("@");
	const base = at < 0 ? trimmed : trimmed.slice(0, at);
	const version = at < 0 ? undefined : parseVersion(trimmed.slice(at + 1), trimmed);

	const parts = base.split("/");
	if (parts.length !== 2) {
		throw new Error(`Invalid bundle reference "${trimmed}". Use owner/slug.`);
	}
	const [owner, slug] = parts;
	if (!owner || !isSafeRefSegment(owner)) {
		throw new Error(`Invalid bundle owner in "${trimmed}".`);
	}
	if (!slug || !isSafeRefSegment(slug)) {
		throw new Error(`Invalid bundle slug in "${trimmed}".`);
	}

	return version === undefined ? { owner, slug } : { owner, slug, version };
}

/** Stable `owner/slug` key used by `hub/state.json` and the events API. */
export function bundleKey(ref: { owner: string; slug: string }): string {
	return `${ref.owner}/${ref.slug}`;
}

export function formatBundleRef(ref: BundleRef): string {
	return ref.version === undefined ? bundleKey(ref) : `${bundleKey(ref)}@v${ref.version}`;
}
