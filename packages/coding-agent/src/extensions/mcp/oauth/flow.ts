/**
 * Talking to the authorization server: the token endpoint (both grants), dynamic
 * client registration, and the authorization-code + PKCE browser flow.
 *
 * The browser flow is the fallback path, never the hot one. It is the only place
 * in the OAuth implementation that binds a socket, and it binds an EPHEMERAL one
 * (`listen(0)`) rather than a port derived from the server URL: a deterministic
 * port is what makes several sessions collide, and an unhandled `EADDRINUSE`
 * event is what turns that collision into a crashed process. Here the listen
 * error is awaited, and a port that cannot be bound degrades to registering a
 * fresh client instead of failing the session.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { asRecord, readNumber, readString, safeJsonParse } from "../json.ts";
import type { RequestOptions } from "../protocol.ts";
import type { AuthorizationServerMetadata } from "./discovery.ts";
import { requireAuthorizationEndpoint } from "./discovery.ts";
import {
	isValidMcpOAuthLeaseExpiry,
	isValidMcpOAuthLeaseId,
	MCP_OAUTH_CALLBACK_PATH,
	McpOAuthHostError,
	type McpOAuthHostIntegration,
	validateLoopbackRedirectUri,
} from "./host.ts";
import { assertSafeEndpoint, isLoopbackHost, OAuthError, oauthFetch } from "./http.ts";
import type { OAuthClientInfo, OAuthTokens } from "./store.ts";

/** The path mcp-remote registers, kept identical so its clients stay reusable. */
export const CALLBACK_PATH = MCP_OAUTH_CALLBACK_PATH;

/** How long a user gets to finish a login in the browser. */
export const DEFAULT_BROWSER_FLOW_TIMEOUT_MS = 30 * 60_000;

/** Network steps of the flow are quick; only the human is slow. */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

const CLIENT_NAME = "phi";

export interface TokenExchangeResult {
	tokens: OAuthTokens;
	client: OAuthClientInfo;
}

/**
 * POST the token endpoint. Client authentication follows the server's advertised
 * methods, defaulting to `client_secret_post`, which is what dynamic
 * registration hands out in practice.
 */
export async function requestTokens(
	metadata: AuthorizationServerMetadata,
	client: OAuthClientInfo,
	form: URLSearchParams,
	options: RequestOptions,
): Promise<OAuthTokens> {
	const endpoint = assertSafeEndpoint(metadata.token_endpoint, "token_endpoint");
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};
	const body = new URLSearchParams(form);
	body.set("client_id", client.client_id);
	if (client.client_secret) {
		if (usesBasicAuth(metadata)) {
			const credentials = `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`;
			headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
		} else {
			body.set("client_secret", client.client_secret);
		}
	}

	if (options.signal?.aborted) throw new OAuthError("request_cancelled");
	// A rotating refresh token or authorization code is consumed on receipt. Once
	// the POST starts, a session restart must not abort the response carrying its
	// replacement: let the caller persist it and release the lock, bounded only
	// by the request's own timeout. Discovery and browser consent stay cancellable.
	const response = await oauthFetch(
		endpoint,
		{ method: "POST", headers, body: body.toString() },
		{ timeoutMs: options.timeoutMs },
	);
	const text = await response.text().catch(() => "");
	if (!response.ok) throw new OAuthError("token_rejected", response.status);
	return parseTokens(text);
}

export async function refreshTokens(
	metadata: AuthorizationServerMetadata,
	client: OAuthClientInfo,
	refreshToken: string,
	resource: string | undefined,
	options: RequestOptions,
): Promise<OAuthTokens> {
	const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
	if (client.scope) form.set("scope", client.scope);
	// The renewed token has to be scoped to the same resource as the original, or a
	// server that issues audience-bound tokens hands back one this server refuses.
	if (resource) form.set("resource", resource);
	const tokens = await requestTokens(metadata, client, form, options);
	// Non-rotating servers omit the refresh token; rotating ones replace it. Keep
	// whichever we now hold rather than assuming either behaviour.
	return { ...tokens, refresh_token: tokens.refresh_token ?? refreshToken };
}

export async function registerClient(
	metadata: AuthorizationServerMetadata,
	request: { redirectUri: string; scope?: string },
	options: RequestOptions,
): Promise<OAuthClientInfo> {
	if (!metadata.registration_endpoint) throw new OAuthError("registration_unavailable");
	const endpoint = assertSafeEndpoint(metadata.registration_endpoint, "registration_endpoint");
	const payload: Record<string, unknown> = {
		client_name: CLIENT_NAME,
		redirect_uris: [request.redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
	};
	if (request.scope) payload.scope = request.scope;

	const response = await oauthFetch(
		endpoint,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(payload),
		},
		options,
	);
	const text = await response.text().catch(() => "");
	if (!response.ok) throw new OAuthError("registration_rejected", response.status);
	const record = asRecord(safeJsonParse(text));
	const clientId = readString(record, "client_id");
	if (!clientId) throw new OAuthError("registration_missing_client_id");
	return {
		client_id: clientId,
		client_secret: readString(record, "client_secret"),
		redirect_uris: [request.redirectUri],
		scope: readString(record, "scope") ?? request.scope,
	};
}

export interface BrowserFlowOptions {
	metadata: AuthorizationServerMetadata;
	/** A client from disk or from `mcp.json`; absent means register a new one. */
	client?: OAuthClientInfo;
	scope?: string;
	/** RFC 8707 resource indicator, when the server published one to name. */
	resource?: string;
	serverName: string;
	openBrowser: (url: string) => void;
	/** Optional per-session host for remote callback exposure and browser presentation. */
	host?: McpOAuthHostIntegration;
	notice?: (message: string, level: "info" | "warning") => void;
	/** Called once the callback socket is up, so the login lock can publish the port. */
	onCallbackPort?: (port: number) => void | Promise<void>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function runAuthorizationCodeFlow(options: BrowserFlowOptions): Promise<TokenExchangeResult> {
	const authorizationEndpoint = requireAuthorizationEndpoint(options.metadata);
	const requestOptions: RequestOptions = { signal: options.signal, timeoutMs: TOKEN_REQUEST_TIMEOUT_MS };

	// A cached client can only be reused on the exact redirect URI it registered.
	// Without a host, retain the existing port-reuse behaviour. A host maps the
	// remote listener to its own local loopback port, so the remote side always
	// binds an ephemeral port and asks the host to reserve the preferred local one.
	const registered = registeredCallback(options.client);
	const listenerPort = options.host ? 0 : (registered?.port ?? 0);
	let listener = await startCallbackServer(listenerPort).catch((error: unknown) => {
		if (!registered || options.host) throw error;
		return undefined;
	});
	let client = options.client;
	let redirectUri = registered?.uri ?? "";
	if (!listener) {
		listener = await startCallbackServer(0);
		client = undefined;
		options.notice?.(
			`mcp: ${options.serverName} OAuth callback port ${registered?.port} is in use; registering a new client on port ${listener.port}.`,
			"info",
		);
	}
	if (!options.host && (!client || !redirectUri)) redirectUri = `http://localhost:${listener.port}${CALLBACK_PATH}`;

	let leaseId: string | undefined;
	let outcome: "complete" | "cancelled" | "failed" = "failed";
	try {
		await options.onCallbackPort?.(listener.port);
		if (options.host) {
			let prepared: Awaited<ReturnType<McpOAuthHostIntegration["prepareCallback"]>>;
			try {
				prepared = await options.host.prepareCallback({
					serverName: options.serverName,
					remotePort: listener.port,
					path: CALLBACK_PATH,
					preferredRedirectUri: hostPreferredRedirectUri(options.client),
					signal: options.signal,
				});
			} catch (error) {
				if (error instanceof McpOAuthHostError) throw error;
				throw new McpOAuthHostError("bridge_error");
			}
			if (!isValidMcpOAuthLeaseId(prepared.leaseId)) throw new McpOAuthHostError("invalid_response");
			leaseId = prepared.leaseId;
			if (!isValidMcpOAuthLeaseExpiry(prepared.expiresAt)) throw new McpOAuthHostError("invalid_response");
			redirectUri = validateLoopbackRedirectUri(prepared.redirectUri, CALLBACK_PATH);
			// A dynamic client is bound to its declared redirect URIs. A configured
			// client without that declaration keeps the legacy server-side validation.
			if (client?.redirect_uris && !client.redirect_uris.includes(redirectUri)) client = undefined;
		}
		const scope = options.scope ?? client?.scope ?? options.metadata.scopes_supported?.join(" ");
		if (!client) client = await registerClient(options.metadata, { redirectUri, scope }, requestOptions);

		const verifier = base64Url(randomBytes(32));
		const state = base64Url(randomBytes(16));
		const authorizeUrl = new URL(authorizationEndpoint);
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("client_id", client.client_id);
		authorizeUrl.searchParams.set("redirect_uri", redirectUri);
		authorizeUrl.searchParams.set("code_challenge", base64Url(createHash("sha256").update(verifier).digest()));
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("state", state);
		const effectiveScope = scope ?? client.scope;
		if (effectiveScope) authorizeUrl.searchParams.set("scope", effectiveScope);
		// Monday rejects an authorization request with no `resource` outright, so this
		// is load-bearing rather than advisory wherever a resource document exists.
		if (options.resource) authorizeUrl.searchParams.set("resource", options.resource);

		const target = authorizeUrl.toString();
		options.notice?.(`mcp: ${options.serverName} needs an OAuth login — opening a browser.`, "warning");
		if (options.host) {
			if (!leaseId) throw new OAuthError("host_lease_missing");
			try {
				await options.host.presentAuthorization({
					leaseId,
					serverName: options.serverName,
					authorizationUrl: target,
					redirectUri,
					signal: options.signal,
				});
			} catch (error) {
				if (error instanceof McpOAuthHostError) throw error;
				throw new McpOAuthHostError("bridge_error");
			}
		} else {
			try {
				options.openBrowser(target);
			} catch {
				throw new OAuthError("browser_open_failed");
			}
		}

		const code = await listener.waitForCode(state, {
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? DEFAULT_BROWSER_FLOW_TIMEOUT_MS,
		});
		const tokens = await requestTokens(
			options.metadata,
			client,
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				code_verifier: verifier,
				...(options.resource ? { resource: options.resource } : {}),
			}),
			requestOptions,
		);
		outcome = "complete";
		return { tokens, client };
	} catch (error) {
		if (options.signal?.aborted || (error instanceof McpOAuthHostError && error.code === "user_denied")) {
			outcome = "cancelled";
		}
		throw error;
	} finally {
		// The lease must be closed while the callback listener is still live, and
		// before the caller releases the cross-process login lock.
		if (leaseId && options.host) {
			await options.host.close({ leaseId, outcome }).catch(() => undefined);
		}
		await listener.close();
	}
}

interface CallbackListener {
	port: number;
	waitForCode(state: string, options: { signal?: AbortSignal; timeoutMs: number }): Promise<string>;
	close(): Promise<void>;
}

/**
 * Bind the callback server. `listen` reports `EADDRINUSE` as an event, so the
 * error listener is attached before listening and the promise rejects instead of
 * taking the process down — the failure mode that makes concurrent mcp-remote
 * startups crash.
 *
 * Both loopback stacks are bound on the same port when possible, because the
 * redirect URI says `localhost` and which family that resolves to is the
 * browser's decision, not ours.
 */
async function startCallbackServer(port: number): Promise<CallbackListener> {
	const pending: Array<{ resolve: (value: { code: string; state: string }) => void }> = [];
	let received: { code: string; state: string } | undefined;
	let failure = false;

	const handle: RequestListener = (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== CALLBACK_PATH) {
			response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
			return;
		}
		const error = url.searchParams.get("error");
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") ?? "";
		if (error) {
			// The authorization server controls both error fields. Keep them out of
			// thrown errors, notices, and MCP diagnostics.
			failure = true;
			received = { code: "", state };
			respondHtml(response, 400, "Login failed", "You can close this tab and check phi for details.");
		} else if (!code) {
			respondHtml(response, 400, "Login failed", "The authorization server returned no code.");
			failure = true;
		} else {
			respondHtml(response, 200, "Login complete", "You can close this tab and return to phi.");
			received = { code, state };
		}
		for (const waiter of pending.splice(0)) waiter.resolve(received ?? { code: "", state: "" });
	};

	const primary = createServer(handle);
	await listen(primary, port, "127.0.0.1");
	const address = primary.address() as AddressInfo | null;
	if (!address) {
		primary.close();
		throw new OAuthError("callback_listener_failed");
	}

	const servers = [primary];
	const secondary = createServer(handle);
	// Best effort: a host without IPv6, or with something already on ::1, simply
	// keeps the IPv4 listener.
	if (
		await listen(secondary, address.port, "::1").then(
			() => true,
			() => false,
		)
	)
		servers.push(secondary);
	else secondary.close();

	return {
		port: address.port,
		async waitForCode(expectedState, waitOptions): Promise<string> {
			const result =
				received ??
				(await new Promise<{ code: string; state: string }>((resolve, reject) => {
					const timer = setTimeout(() => {
						cleanup();
						reject(new OAuthError("callback_timeout"));
					}, waitOptions.timeoutMs);
					const onAbort = (): void => {
						cleanup();
						reject(new OAuthError("callback_cancelled"));
					};
					const waiter = {
						resolve: (value: { code: string; state: string }) => {
							cleanup();
							resolve(value);
						},
					};
					const cleanup = (): void => {
						clearTimeout(timer);
						waitOptions.signal?.removeEventListener("abort", onAbort);
						const index = pending.indexOf(waiter);
						if (index >= 0) pending.splice(index, 1);
					};
					if (waitOptions.signal?.aborted) {
						onAbort();
						return;
					}
					waitOptions.signal?.addEventListener("abort", onAbort, { once: true });
					pending.push(waiter);
				}));
			if (failure) throw new OAuthError("callback_rejected");
			if (!result.code) throw new OAuthError("callback_missing_code");
			if (!statesMatch(result.state, expectedState)) throw new OAuthError("callback_state_mismatch");
			return result.code;
		},
		async close(): Promise<void> {
			await Promise.all(
				servers.map(
					(server) =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
							// Liveness probes leave idle sockets behind; do not wait for them.
							server.closeAllConnections?.();
						}),
				),
			);
		},
	};
}

function listen(server: Server, port: number, host: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (): void => {
			server.removeListener("listening", onListening);
			reject(new OAuthError("callback_port_unavailable"));
		};
		const onListening = (): void => {
			server.removeListener("error", onError);
			// Late socket errors (a browser hanging up mid-request, a liveness probe
			// disconnecting) must not become unhandled events either.
			server.on("error", () => undefined);
			server.on("clientError", (_error, socket) => socket.destroy());
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function respondHtml(response: ServerResponse, status: number, title: string, detail: string): void {
	response
		.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
		.end(`<!doctype html><title>${title}</title><h1>${title}</h1><p>${detail}</p>`);
}

/** The registered loopback callback, when a cached client pinned one. */
function registeredCallback(client: OAuthClientInfo | undefined): { uri: string; port: number } | undefined {
	for (const uri of client?.redirect_uris ?? []) {
		try {
			const parsed = new URL(uri);
			if (!isLoopbackHost(parsed.hostname) || !parsed.port) continue;
			return { uri, port: Number.parseInt(parsed.port, 10) };
		} catch {
			// A malformed registered URI just means we cannot reuse it.
		}
	}
	return undefined;
}

function hostPreferredRedirectUri(client: OAuthClientInfo | undefined): string | undefined {
	for (const uri of client?.redirect_uris ?? []) {
		try {
			return validateLoopbackRedirectUri(uri, CALLBACK_PATH);
		} catch {
			// A malformed or non-callback registered URI cannot be offered as a preference.
		}
	}
	return undefined;
}

function usesBasicAuth(metadata: AuthorizationServerMetadata): boolean {
	const methods = metadata.token_endpoint_auth_methods_supported;
	if (!methods) return false;
	return methods.includes("client_secret_basic") && !methods.includes("client_secret_post");
}

function parseTokens(text: string): OAuthTokens {
	const record = asRecord(safeJsonParse(text));
	const accessToken = readString(record, "access_token");
	if (!accessToken) throw new OAuthError("token_missing_access_token");
	const expiresIn = readNumber(record, "expires_in");
	return {
		access_token: accessToken,
		token_type: readString(record, "token_type") ?? "Bearer",
		refresh_token: readString(record, "refresh_token"),
		expires_in: expiresIn,
		expires_at: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined,
		scope: readString(record, "scope"),
	};
}

function statesMatch(actual: string, expected: string): boolean {
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function base64Url(bytes: Buffer): string {
	return bytes.toString("base64url");
}
