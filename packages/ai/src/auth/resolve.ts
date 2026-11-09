import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { ModelsError } from "../utils/models-error.ts";
import { isInvalidGrantError } from "./errors.ts";

export { ModelsError, type ModelsErrorCode } from "../utils/models-error.ts";

import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
	signal?: AbortSignal;
}

/**
 * Auth resolution shared by all operations in a `Models` collection.
 * A stored credential owns the provider: ambient/env is consulted only when
 * nothing is stored. No silent env fallback after a failed refresh or for a
 * credential type without a matching handler.
 */
export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides?.signal);
	return raceWithAbortSignal(
		resolveProviderAuthWithSignal(provider, credentials, authContext, overrides, signal),
		signal,
	);
}

async function resolveProviderAuthWithSignal(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	signal.throwIfAborted();
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;

	if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
		return resolveApiKey(
			requestAuthContext,
			provider.auth.apiKey,
			provider.id,
			{
				type: "api_key",
				key: overrides.apiKey,
				env: overrides.env,
			},
			signal,
		);
	}

	const stored = await readCredential(credentials, provider.id, signal);
	if (stored) {
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(
				credentials,
				provider.id,
				provider.auth.oauth,
				stored,
				signal,
				overrides?.minOAuthValidityMs,
			);
		}
		if (stored.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
		}
		return undefined;
	}

	// Ambient (env vars, AWS profiles, ADC files).
	return provider.auth.apiKey
		? resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, undefined, signal)
		: undefined;
}

function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
const oauthRefreshFlights = new WeakMap<CredentialStore, Map<string, Promise<Credential | undefined>>>();

function authRequiredError(providerId: string, credentialInvalidated: boolean): ModelsError {
	const interactiveCommand = `/login ${providerId}`;
	return new ModelsError(
		"auth_required",
		`Authentication required for ${providerId}: the stored OAuth refresh token is no longer valid. Run \`phi\`, enter \`${interactiveCommand}\`, then retry this turn.`,
		{
			includeCauseInMessage: false,
			authRequired: {
				provider: providerId,
				reason: "invalid_grant",
				loginCommand: "phi",
				interactiveCommand,
				credentialInvalidated,
			},
		},
	);
}
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Refresh a stored OAuth credential under the credential-store lock and persist
 * the result before the lock is released. `needsRefresh` is re-checked under
 * the lock, so concurrent callers and processes refresh only once.
 *
 * Inside a process, concurrent callers for the same store and provider share
 * one refresh (singleflight). `signal` only stops this caller's wait: it is
 * never forwarded to the shared refresh, so one cancelled waiter cannot cancel
 * the rotation for unrelated waiters, and a refresh that has started always
 * persists the rotated token (the provider may already have rotated the refresh
 * token). The refresh is bounded only by a timeout.
 *
 * A structural `invalid_grant` answer removes the credential under the lock and
 * rejects with an `auth_required` ModelsError. Other refresh failures keep only
 * the typed failure category, never the untrusted provider error.
 *
 * Resolves with the stored OAuth credential after the operation, or undefined
 * when the provider no longer has an OAuth credential.
 */
export async function refreshStoredOAuthCredential(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	needsRefresh: (credential: OAuthCredential) => boolean,
	signal: AbortSignal,
): Promise<OAuthCredential | undefined> {
	signal.throwIfAborted();
	const post = await raceWithAbortSignal(sharedOAuthRefresh(credentials, providerId, oauth, needsRefresh), signal);
	return post?.type === "oauth" ? post : undefined;
}

/** One refresh result per store/provider inside a process; never sees a caller's signal. */
function sharedOAuthRefresh(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	needsRefresh: (credential: OAuthCredential) => boolean,
): Promise<Credential | undefined> {
	let flights = oauthRefreshFlights.get(credentials);
	if (!flights) {
		flights = new Map();
		oauthRefreshFlights.set(credentials, flights);
	}
	const existing = flights.get(providerId);
	if (existing) return existing;

	const flight = (async () => {
		let invalidGrant: unknown;
		let post: Credential | undefined;
		try {
			post = await credentials.modify(providerId, async (current) => {
				if (current?.type !== "oauth") return undefined; // logged out meanwhile
				if (!needsRefresh(current)) return undefined; // another process/request refreshed
				try {
					// Per-flight timeout only: a caller's own abort must not cancel the shared rotation.
					return await oauth.refresh(current, AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS));
				} catch (error) {
					if (isInvalidGrantError(error)) {
						invalidGrant = error;
						return null; // atomically remove the credential under the refresh lock
					}
					// Provider and extension refresh errors may contain token responses,
					// parser details, or other credential material. Preserve only the
					// typed failure category; never retain the untrusted error graph.
					throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, {
						includeCauseInMessage: false,
					});
				}
			});
		} catch (error) {
			if (error instanceof ModelsError) throw error;
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		if (invalidGrant) throw authRequiredError(providerId, true);
		return post;
	})();
	flights.set(providerId, flight);
	const clearFlight = () => {
		if (flights?.get(providerId) === flight) flights.delete(providerId);
	};
	void flight.then(clearFlight, clearFlight);
	return flight;
}

/**
 * OAuth resolution with process-local singleflight plus store locking: tokens
 * with less than five minutes remaining are refreshed through
 * `refreshStoredOAuthCredential`, which re-checks expiry under the store lock,
 * refreshes once globally, and persists the rotated credential before release.
 */
async function resolveStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
	signal: AbortSignal,
	minOAuthValidityMs?: number,
): Promise<AuthResult | undefined> {
	const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
	const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
	let credential = stored;

	if (expiresSoon(credential)) {
		// Optimistic check said expired; the authoritative check runs under the lock.
		const post = await refreshStoredOAuthCredential(credentials, providerId, oauth, expiresSoon, signal);
		if (!post) {
			const current = await readCredential(credentials, providerId, signal);
			if (!current) throw authRequiredError(providerId, false);
			return undefined; // credential type changed meanwhile; let the caller retry
		}
		credential = post;
		// The normal five-minute window triggers a refresh but does not impose a
		// provider contract. Explicit callers (such as bearer-token export) do
		// require the requested minimum after the refresh.
		if (minOAuthValidityMs !== undefined && expiresSoon(credential)) {
			throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${providerId}`);
		}
	}

	try {
		return { auth: await oauth.toAuth(credential), source: "OAuth" };
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	try {
		return await apiKey.resolve({ ctx: authContext, credential, signal });
	} catch (error) {
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}`, { cause: error });
	}
}

async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId, { signal });
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
