/**
 * The narrow host surface used by native MCP OAuth browser logins.
 *
 * The OAuth engine owns the callback server, state, PKCE, token exchange, and
 * credential store. A host only makes the callback reachable from a browser and
 * presents the authorization URL. Keeping this interface per session means the
 * engine remains usable in an embedded process without a global bridge client.
 */

import { isLoopbackHost } from "./http.ts";

export const MCP_OAUTH_BRIDGE_SCHEMA = 1;
export const MCP_OAUTH_CALLBACK_PATH = "/oauth/callback";
export const MCP_OAUTH_MIN_PORT = 1024;
export const MCP_OAUTH_MAX_PORT = 65_535;
export const MCP_OAUTH_MAX_URL_LENGTH = 8 * 1024;
export const MCP_OAUTH_MAX_SERVER_NAME_LENGTH = 256;
export const MCP_OAUTH_MAX_REQUEST_ID_LENGTH = 128;
export const MCP_OAUTH_MAX_LEASE_ID_LENGTH = 128;
export const MCP_OAUTH_MAX_REQUEST_BYTES = 256 * 1024;
export const MCP_OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;
export const MCP_OAUTH_MAX_LEASE_TTL_MS = 30 * 60_000;

export function isValidMcpOAuthRequestId(value: unknown): value is string {
	return (
		isBoundedMcpOAuthString(value, MCP_OAUTH_MAX_REQUEST_ID_LENGTH) &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	);
}

export function isValidMcpOAuthLeaseId(value: unknown): value is string {
	return isBoundedMcpOAuthString(value, MCP_OAUTH_MAX_LEASE_ID_LENGTH);
}

export function isValidMcpOAuthLeaseTtl(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MCP_OAUTH_MAX_LEASE_TTL_MS;
}

/** Compatibility validation for the local host API's synthesized absolute expiry. */
export function isValidMcpOAuthLeaseExpiry(value: unknown, now = Date.now()): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > now &&
		value <= now + MCP_OAUTH_MAX_LEASE_TTL_MS
	);
}

function isBoundedMcpOAuthString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		!Array.from(value).some((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x1f || code === 0x7f;
		})
	);
}

/** The exact protocol-v1 error code set emitted by the Forca bridge. */
export const MCP_OAUTH_BRIDGE_ERROR_CODES = [
	"unsupported_protocol",
	"invalid_request",
	"user_denied",
	"local_port_unavailable",
	"connection_lost",
	"expired",
	"browser_open_failed",
	"bridge_error",
] as const;

export type McpOAuthBridgeErrorCode = (typeof MCP_OAUTH_BRIDGE_ERROR_CODES)[number];

/** Local adapter failures are not wire responses, but use the same `code` field. */
export type McpOAuthHostCode = McpOAuthBridgeErrorCode | "invalid_response" | "command_failed" | "timeout" | "aborted";

/** An error safe to show in phi logs: it never includes bridge payloads. */
export class McpOAuthHostError extends Error {
	readonly code: McpOAuthHostCode;

	constructor(code: McpOAuthHostCode) {
		super(`MCP OAuth host bridge ${code.replaceAll("_", " ")}.`);
		this.name = "McpOAuthHostError";
		this.code = code;
	}
}

export interface McpOAuthHostIntegration {
	prepareCallback(input: {
		serverName: string;
		remotePort: number;
		path: typeof MCP_OAUTH_CALLBACK_PATH;
		preferredRedirectUri?: string;
		signal?: AbortSignal;
	}): Promise<{
		leaseId: string;
		redirectUri: string;
		expiresAt: number;
	}>;

	presentAuthorization(input: {
		leaseId: string;
		serverName: string;
		authorizationUrl: string;
		redirectUri: string;
		signal?: AbortSignal;
	}): Promise<void>;

	close(input: { leaseId: string; outcome: "complete" | "cancelled" | "failed" }): Promise<void>;
}

/**
 * Validate the exact callback URI a host returned. The original string is
 * returned unchanged so registration, authorization, and token exchange all
 * use byte-for-byte the same value.
 */
export function validateLoopbackRedirectUri(uri: string, path = MCP_OAUTH_CALLBACK_PATH): string {
	try {
		if (uri.length > MCP_OAUTH_MAX_URL_LENGTH || uri.trim() !== uri || /[\u0000-\u001f\u007f]/.test(uri))
			throw new McpOAuthHostError("invalid_response");
		const parsed = new URL(uri);
		const port = Number.parseInt(parsed.port, 10);
		if (
			parsed.protocol !== "http:" ||
			!isLoopbackHost(parsed.hostname) ||
			!parsed.port ||
			!Number.isInteger(port) ||
			port < MCP_OAUTH_MIN_PORT ||
			port > MCP_OAUTH_MAX_PORT ||
			parsed.username ||
			parsed.password ||
			parsed.pathname !== path ||
			parsed.search ||
			parsed.hash
		) {
			throw new McpOAuthHostError("invalid_response");
		}
		return uri;
	} catch (error) {
		if (error instanceof McpOAuthHostError) throw error;
		throw new McpOAuthHostError("invalid_response");
	}
}
