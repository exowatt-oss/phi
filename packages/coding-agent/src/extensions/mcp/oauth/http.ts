/**
 * The small HTTP surface the OAuth code shares: one fetch wrapper with the
 * transport's timeout semantics, endpoint validation, and an error type whose
 * messages are safe to show a user.
 *
 * Every URL used here (authorization server, token endpoint, registration
 * endpoint) is discovered from a remote document, so each one is validated
 * before it is fetched or handed to a browser: TLS, or plain HTTP only on
 * loopback, which is what a local test server and a callback URL need.
 */

import { safeJsonParse } from "../json.ts";
import { type RequestOptions, withTimeout } from "../protocol.ts";

/** Local OAuth failure codes. Wire text is never copied into an OAuthError. */
export const OAUTH_ERROR_CODES = [
	"unsafe_endpoint",
	"request_cancelled",
	"request_timeout",
	"request_failed",
	"discovery_failed",
	"discovery_insecure",
	"missing_authorization_endpoint",
	"token_rejected",
	"token_missing_access_token",
	"registration_unavailable",
	"registration_rejected",
	"registration_missing_client_id",
	"callback_listener_failed",
	"callback_port_unavailable",
	"callback_timeout",
	"callback_cancelled",
	"callback_rejected",
	"callback_missing_code",
	"callback_state_mismatch",
	"browser_open_failed",
	"host_lease_missing",
] as const;

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

const OAUTH_ERROR_MESSAGES: Record<OAuthErrorCode, string> = {
	unsafe_endpoint: "The OAuth endpoint is not allowed.",
	request_cancelled: "The OAuth request was cancelled.",
	request_timeout: "The OAuth authorization server did not respond in time.",
	request_failed: "Could not reach the OAuth authorization server.",
	discovery_failed: "OAuth authorization-server discovery failed.",
	discovery_insecure: "OAuth authorization-server discovery returned an unsafe endpoint.",
	missing_authorization_endpoint: "The authorization server published no authorization endpoint.",
	token_rejected: "The authorization server rejected the token request.",
	token_missing_access_token: "The token endpoint returned no access token.",
	registration_unavailable:
		"The authorization server does not support dynamic client registration; configure auth.clientId.",
	registration_rejected: "The authorization server rejected client registration.",
	registration_missing_client_id: "The registration response contained no client identifier.",
	callback_listener_failed: "The local OAuth callback server could not start.",
	callback_port_unavailable: "The local OAuth callback port is unavailable.",
	callback_timeout: "Timed out waiting for the OAuth login to complete.",
	callback_cancelled: "The OAuth login was cancelled.",
	callback_rejected: "The authorization server refused the OAuth login.",
	callback_missing_code: "The OAuth callback returned no authorization code.",
	callback_state_mismatch: "The OAuth callback failed state validation; the login was discarded.",
	browser_open_failed: "Could not open the browser for the OAuth login.",
	host_lease_missing: "The OAuth host bridge returned no lease.",
};

/** An OAuth step failed with a local message and an optional allowlisted status. */
export class OAuthError extends Error {
	/**
	 * HTTP status when the authorization server answered. It decides whether a
	 * cached credential is dead (4xx) or merely unreachable (network, 5xx), which
	 * is the difference between re-authorising and leaving a working login alone.
	 */
	readonly status: number | undefined;
	readonly code: OAuthErrorCode;

	constructor(code: OAuthErrorCode, status?: number) {
		super(OAUTH_ERROR_MESSAGES[code]);
		this.name = "OAuthError";
		this.code = code;
		this.status =
			status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
	}
}

/** True when the authorization server rejected the credential itself. */
export function isCredentialRejection(error: unknown): boolean {
	if (!(error instanceof OAuthError) || error.status === undefined) return false;
	return error.status >= 400 && error.status < 500;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** https anywhere, http only on loopback. */
export function isSafeEndpoint(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "https:") return true;
		return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
	} catch {
		return false;
	}
}

export function assertSafeEndpoint(url: string, _label: string): string {
	if (!isSafeEndpoint(url)) throw new OAuthError("unsafe_endpoint");
	return url;
}

export async function oauthFetch(url: string, init: RequestInit, options: RequestOptions): Promise<Response> {
	const { signal, timedOut } = withTimeout(options);
	try {
		return await fetch(url, { ...init, signal });
	} catch {
		if (options.signal?.aborted) throw new OAuthError("request_cancelled");
		if (timedOut()) throw new OAuthError("request_timeout");
		throw new OAuthError("request_failed");
	}
}

/** Read a JSON document, or undefined when the endpoint answers with anything else. */
export async function fetchJsonDocument(
	url: string,
	options: RequestOptions,
): Promise<Record<string, unknown> | undefined> {
	const response = await oauthFetch(url, { headers: { Accept: "application/json" } }, options);
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
	const payload = safeJsonParse(await response.text());
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	return payload as Record<string, unknown>;
}
