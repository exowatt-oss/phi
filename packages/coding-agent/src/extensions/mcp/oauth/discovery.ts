/**
 * Finding the authorization server behind a 401, and the resource indicator the
 * grant has to name.
 *
 * The MCP spec routes discovery through `WWW-Authenticate: Bearer
 * resource_metadata="…"` and `/.well-known/oauth-protected-resource`. Not every
 * server publishes that document, so reading it stays best effort — but where it
 * exists it is authoritative twice over: it names the authorization server, and
 * it names the RFC 8707 `resource` that server expects. Monday's authorization
 * endpoint refuses a request that omits `resource` outright ("resource parameter
 * is required"), and its protected-resource document is the only place the value
 * is published, so this is not an optional nicety.
 *
 * Authorization-server metadata (RFC 8414) derived from the MCP URL's own origin
 * is the fallback that works when nothing is published, so it stays in the
 * candidate list — just behind whatever the resource document named.
 */

import { asArray, asRecord, readString } from "../json.ts";
import type { RequestOptions } from "../protocol.ts";
import { assertSafeEndpoint, fetchJsonDocument, isSafeEndpoint, OAuthError } from "./http.ts";

export interface AuthorizationServerMetadata {
	issuer?: string;
	authorization_endpoint?: string;
	token_endpoint: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
	token_endpoint_auth_methods_supported?: string[];
	code_challenge_methods_supported?: string[];
	/** True when nothing was discoverable and the spec's default paths were assumed. */
	assumed?: boolean;
}

/** The parts of an RFC 9728 protected-resource document that change what we send. */
export interface ProtectedResourceMetadata {
	resource?: string;
	authorization_servers?: string[];
	scopes_supported?: string[];
}

export interface Discovery {
	metadata: AuthorizationServerMetadata;
	/**
	 * The RFC 8707 `resource` to send with the authorization request and every
	 * grant, or undefined for a server that published no protected-resource
	 * document — in which case the parameter is omitted entirely rather than
	 * guessed, so a server that predates RFC 8707 sees exactly what it did before.
	 */
	resource?: string;
	/** Scopes the protected resource advertises; preferred over the AS's own list. */
	scopes?: string[];
}

export interface WwwAuthenticateChallenge {
	scheme: string;
	params: Record<string, string>;
}

/**
 * Pull the quoted parameters out of a `WWW-Authenticate` header. Only the
 * parameters matter here (`resource_metadata`, `scope`, `error`), so the parse
 * stays deliberately simple rather than implementing RFC 9110 in full.
 */
export function parseWwwAuthenticate(header: string | undefined): WwwAuthenticateChallenge | undefined {
	if (!header) return undefined;
	const scheme = header.trim().split(/[\s,]+/, 1)[0] ?? "";
	if (!scheme) return undefined;
	const params: Record<string, string> = {};
	for (const match of header.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g)) {
		const name = match[1]?.toLowerCase();
		const value = match[2] ?? match[3];
		if (name && value !== undefined) params[name] = value;
	}
	return { scheme: scheme.toLowerCase(), params };
}

export interface DiscoveryInput {
	serverUrl: string;
	/** The challenge that triggered discovery, when there was one. */
	challenge?: WwwAuthenticateChallenge;
	/** From `mcp.json`, for a server whose authorization server cannot be discovered. */
	authorizationServer?: string;
}

export async function discoverAuthorizationServer(input: DiscoveryInput, options: RequestOptions): Promise<Discovery> {
	const resourceMetadata = await fetchProtectedResourceMetadata(input, options);
	const resource = selectResource(input.serverUrl, resourceMetadata);
	const scopes = resourceMetadata?.scopes_supported;

	for (const candidate of authorizationServerCandidates(input, resourceMetadata)) {
		const document = await fetchJsonDocument(candidate, options).catch(() => undefined);
		const metadata = parseMetadata(document);
		if (metadata) return { metadata, resource, scopes };
	}

	// Servers older than RFC 8414 publish nothing; the MCP spec's fallback is the
	// origin's default endpoints. Same origin as the server that challenged us.
	let origin: string;
	try {
		origin = new URL(input.serverUrl).origin;
	} catch {
		throw new OAuthError("discovery_failed");
	}
	const token = `${origin}/token`;
	if (!isSafeEndpoint(token)) throw new OAuthError("discovery_insecure");
	return {
		metadata: {
			issuer: origin,
			authorization_endpoint: `${origin}/authorize`,
			token_endpoint: token,
			registration_endpoint: `${origin}/register`,
			assumed: true,
		},
		resource,
		scopes,
	};
}

/**
 * Read the protected-resource document, from the challenge's own pointer first
 * and then the two spec locations. Every step is allowed to 404: plenty of
 * servers publish nothing here, and that must cost one request and no failure.
 */
async function fetchProtectedResourceMetadata(
	input: DiscoveryInput,
	options: RequestOptions,
): Promise<ProtectedResourceMetadata | undefined> {
	for (const candidate of protectedResourceCandidates(input)) {
		const document = await fetchJsonDocument(candidate, options).catch(() => undefined);
		const parsed = parseProtectedResourceMetadata(document);
		if (parsed) return parsed;
	}
	return undefined;
}

function protectedResourceCandidates(input: DiscoveryInput): string[] {
	const candidates: string[] = [];
	const add = (url: string | undefined): void => {
		if (!url || !isSafeEndpoint(url) || candidates.includes(url)) return;
		candidates.push(url);
	};

	add(input.challenge?.params.resource_metadata);
	let parsed: URL;
	try {
		parsed = new URL(input.serverUrl);
	} catch {
		return candidates;
	}
	// RFC 9728 inserts the resource's path after the well-known segment; a server
	// hosting one MCP endpoint per origin publishes at the bare path instead.
	const path = parsed.pathname.replace(/\/+$/, "");
	if (path) add(`${parsed.origin}/.well-known/oauth-protected-resource${path}`);
	add(`${parsed.origin}/.well-known/oauth-protected-resource`);
	return candidates;
}

function parseProtectedResourceMetadata(
	document: Record<string, unknown> | undefined,
): ProtectedResourceMetadata | undefined {
	const record = asRecord(document);
	if (!record) return undefined;
	const resource = readString(record, "resource");
	const authorizationServers = readStringArray(record, "authorization_servers");
	// A document with neither field tells us nothing; treat it as absent so the
	// next location still gets a look.
	if (!resource && !authorizationServers) return undefined;
	return {
		resource,
		authorization_servers: authorizationServers,
		scopes_supported: readStringArray(record, "scopes_supported"),
	};
}

/**
 * The resource indicator to name in the grant. The published value wins when it
 * covers the endpoint we are calling — that is the string the authorization
 * server recognises, and it is often shorter than the MCP URL (serval publishes
 * its bare origin). A published value that covers something else is a
 * misconfiguration we cannot resolve, so ask for the endpoint itself and let the
 * server reject it with its own error rather than failing the login here.
 */
function selectResource(serverUrl: string, metadata: ProtectedResourceMetadata | undefined): string | undefined {
	if (!metadata) return undefined;
	const requested = canonicalResource(serverUrl);
	if (!requested) return undefined;
	if (metadata.resource && resourceCovers(metadata.resource, requested)) return metadata.resource;
	return requested;
}

/** RFC 8707 section 2: a resource URI carries no fragment. Everything else stays. */
function canonicalResource(serverUrl: string): string | undefined {
	try {
		const url = new URL(serverUrl);
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

/** True when `requested` sits at or under `configured`: same origin, path prefix. */
function resourceCovers(configured: string, requested: string): boolean {
	let left: URL;
	let right: URL;
	try {
		left = new URL(configured);
		right = new URL(requested);
	} catch {
		return false;
	}
	if (left.origin !== right.origin) return false;
	// Compare with trailing slashes so `/api` does not appear to cover `/api123`.
	const configuredPath = left.pathname.endsWith("/") ? left.pathname : `${left.pathname}/`;
	const requestedPath = right.pathname.endsWith("/") ? right.pathname : `${right.pathname}/`;
	return requestedPath.startsWith(configuredPath);
}

function authorizationServerCandidates(
	input: DiscoveryInput,
	resourceMetadata: ProtectedResourceMetadata | undefined,
): string[] {
	const candidates: string[] = [];
	const add = (url: string | undefined): void => {
		if (!url || !isSafeEndpoint(url) || candidates.includes(url)) return;
		candidates.push(url);
	};

	if (input.authorizationServer) {
		if (input.authorizationServer.includes("/.well-known/")) add(input.authorizationServer);
		else for (const url of issuerCandidates(input.authorizationServer, "issuer")) add(url);
	}

	// A named authorization server outranks anything derived from the MCP URL:
	// Monday serves an authorization-server document on the MCP origin whose token
	// endpoint does not know the clients its real authorization server registers.
	for (const entry of resourceMetadata?.authorization_servers ?? []) {
		for (const url of issuerCandidates(entry, "issuer")) add(url);
	}

	for (const url of issuerCandidates(input.serverUrl, "guess")) add(url);
	return candidates;
}

/**
 * Where to look for authorization-server metadata, and in which order.
 *
 * The order depends on where the URL came from, because the two cases mean
 * different things:
 *
 * - `issuer` — somebody declared this string as the issuer (an `mcp.json`
 *   `auth.authorizationServer`, or a protected-resource document's
 *   `authorization_servers`). RFC 8414 inserts the well-known segment between
 *   host and path for such an issuer, so that location is authoritative and comes
 *   first. It matters: Atlassian's issuer carries a tenant path, and only the
 *   path-scoped document names its `registration_endpoint` — the origin-level one
 *   parses fine and would silently leave dynamic registration unavailable.
 * - `guess` — derived from the MCP endpoint URL, whose path is not an issuer
 *   path. Origin-level first is what our fleet actually serves, and reversing it
 *   would cost every one of those connections an extra 404.
 */
function issuerCandidates(issuer: string, kind: "issuer" | "guess"): string[] {
	let parsed: URL;
	try {
		parsed = new URL(issuer);
	} catch {
		return [];
	}
	const path = parsed.pathname.replace(/\/+$/, "");
	const origin = parsed.origin;
	const scoped = path ? [`${origin}/.well-known/oauth-authorization-server${path}`] : [];
	const atOrigin = `${origin}/.well-known/oauth-authorization-server`;
	return [
		...(kind === "issuer" ? [...scoped, atOrigin] : [atOrigin, ...scoped]),
		`${origin}/.well-known/openid-configuration`,
		...(path ? [`${origin}${path}/.well-known/openid-configuration`] : []),
	];
}

function parseMetadata(document: Record<string, unknown> | undefined): AuthorizationServerMetadata | undefined {
	const record = asRecord(document);
	const tokenEndpoint = readString(record, "token_endpoint");
	if (!tokenEndpoint || !isSafeEndpoint(tokenEndpoint)) return undefined;

	const authorizationEndpoint = readString(record, "authorization_endpoint");
	const registrationEndpoint = readString(record, "registration_endpoint");
	return {
		issuer: readString(record, "issuer"),
		authorization_endpoint:
			authorizationEndpoint && isSafeEndpoint(authorizationEndpoint) ? authorizationEndpoint : undefined,
		token_endpoint: tokenEndpoint,
		registration_endpoint:
			registrationEndpoint && isSafeEndpoint(registrationEndpoint) ? registrationEndpoint : undefined,
		scopes_supported: readStringArray(record, "scopes_supported"),
		token_endpoint_auth_methods_supported: readStringArray(record, "token_endpoint_auth_methods_supported"),
		code_challenge_methods_supported: readStringArray(record, "code_challenge_methods_supported"),
	};
}

function readStringArray(record: Record<string, unknown> | undefined, key: string): string[] | undefined {
	const values = asArray(record?.[key]);
	if (!values) return undefined;
	const strings = values.filter((entry): entry is string => typeof entry === "string");
	return strings.length > 0 ? strings : undefined;
}

/** Used by the browser flow, which cannot proceed without an authorization endpoint. */
export function requireAuthorizationEndpoint(metadata: AuthorizationServerMetadata): string {
	if (!metadata.authorization_endpoint) throw new OAuthError("missing_authorization_endpoint");
	return assertSafeEndpoint(metadata.authorization_endpoint, "authorization_endpoint");
}
