/* Outbound network features are opt-in in a source build. */

type Env = Record<string, string | undefined>;

function firstSet(env: Env, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = env[name];
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

function isTruthyFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** An explicit opt-in is required before querying the upstream release feed. */
export function isVersionCheckEnabled(env: Env = process.env): boolean {
	if (firstSet(env, ["PHI_SKIP_VERSION_CHECK", "PI_SKIP_VERSION_CHECK"]) !== undefined) return false;
	return isTruthyFlag(firstSet(env, ["PHI_ENABLE_VERSION_CHECK", "PI_ENABLE_VERSION_CHECK"]));
}

/** No remote model-catalog overlay is fetched unless a URL is configured. */
export function getModelCatalogBaseUrl(env: Env = process.env): string | undefined {
	return firstSet(env, ["PHI_MODEL_CATALOG_URL", "PI_MODEL_CATALOG_URL"]);
}

/** Transcripts stay local unless sharing is explicitly enabled. */
export function isSessionShareEnabled(env: Env = process.env): boolean {
	return isTruthyFlag(firstSet(env, ["PHI_ENABLE_SHARE", "PI_ENABLE_SHARE"]));
}

export const SESSION_SHARE_DISABLED_MESSAGE =
	"/share is disabled by default because it uploads the session transcript to a GitHub gist. " +
	"Use /export for a local copy, or set PHI_ENABLE_SHARE=1 for a session that is safe to share.";
