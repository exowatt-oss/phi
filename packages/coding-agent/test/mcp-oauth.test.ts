/**
 * Native OAuth for the builtin HTTP MCP transport.
 *
 * These tests drive a real loopback HTTP server that plays both roles a live MCP
 * deployment plays — the resource server that answers 401 and the authorization
 * server that issues tokens — so discovery, PKCE, the refresh grant, dynamic
 * client registration and the callback are exercised end to end rather than
 * mocked. Nothing here reaches the network: every URL is 127.0.0.1.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSessionInteractive, setSessionInteractive } from "../src/config.ts";
import { DEFAULT_CONNECT_TIMEOUT_MS, oauthAuthorizerOptions } from "../src/extensions/mcp/client.ts";
import {
	loadBridgeConfig,
	MCP_BROWSER_AUTH_ENV_VAR,
	mcpBrowserAuthAllowed,
	serverConfigFingerprint,
} from "../src/extensions/mcp/config.ts";
import { createHttpTransport } from "../src/extensions/mcp/http-transport.ts";
import { DEFAULT_AUTH_LOG_NAME, fingerprint, readOAuthEvents } from "../src/extensions/mcp/oauth/audit.ts";
import { discoverAuthorizationServer } from "../src/extensions/mcp/oauth/discovery.ts";
import { registerClient, requestTokens, runAuthorizationCodeFlow } from "../src/extensions/mcp/oauth/flow.ts";
import type { McpOAuthHostIntegration } from "../src/extensions/mcp/oauth/host.ts";
import { acquireLoginLock } from "../src/extensions/mcp/oauth/lock.ts";
import { createOAuthAuthorizer, type OAuthAuthorizerOptions } from "../src/extensions/mcp/oauth/provider.ts";
import {
	CredentialStore,
	credentialPaths,
	MCP_AUTH_DIR_ENV_VAR,
	MCP_REMOTE_CONFIG_DIR_ENV_VAR,
	type OAuthClientInfo,
	type OAuthTokens,
	resolveCredentialPaths,
	serverKey,
} from "../src/extensions/mcp/oauth/store.ts";
import { safeMcpError } from "../src/extensions/mcp/runtime.ts";

const REQUEST_OPTIONS = { timeoutMs: 10_000 };
const OAUTH_SECRET_MARKERS = [
	"URL_MARKER",
	"STATE_MARKER",
	"PKCE_MARKER",
	"CODE_MARKER",
	"CLIENT_SECRET_MARKER",
	"REFRESH_TOKEN_MARKER",
	"ACCESS_TOKEN_MARKER",
	"ERROR_DESCRIPTION_MARKER",
];

function expectNoOAuthMarkers(values: readonly unknown[]): void {
	const text = values.map((value) => String(value ?? "")).join("\n");
	for (const marker of OAUTH_SECRET_MARKERS) expect(text).not.toContain(marker);
}

let authDir: string;
let fakes: Fake[];

let previousAuthDir: string | undefined;
let previousBrowserAuth: string | undefined;

beforeEach(() => {
	authDir = mkdtempSync(join(tmpdir(), "phi-mcp-oauth-"));
	fakes = [];
	// Every test in this file must be pinned to the temp dir: an unset override
	// resolves to the developer's real ~/.mcp-auth, which these tests write to.
	previousAuthDir = process.env[MCP_AUTH_DIR_ENV_VAR];
	previousBrowserAuth = process.env[MCP_BROWSER_AUTH_ENV_VAR];
	process.env[MCP_AUTH_DIR_ENV_VAR] = authDir;
	delete process.env[MCP_BROWSER_AUTH_ENV_VAR];
	setSessionInteractive(false);
});

afterEach(async () => {
	for (const fake of fakes) await fake.close();
	vi.restoreAllMocks();
	if (previousAuthDir === undefined) delete process.env[MCP_AUTH_DIR_ENV_VAR];
	else process.env[MCP_AUTH_DIR_ENV_VAR] = previousAuthDir;
	if (previousBrowserAuth === undefined) delete process.env[MCP_BROWSER_AUTH_ENV_VAR];
	else process.env[MCP_BROWSER_AUTH_ENV_VAR] = previousBrowserAuth;
	setSessionInteractive(false);
	rmSync(authDir, { recursive: true, force: true });
});

interface FakeOptions {
	/** The bearer the resource server currently accepts. */
	accessToken?: string;
	/** The refresh token the token endpoint currently accepts. */
	refreshToken?: string;
	/** Return a new refresh token on refresh, as a rotating server does. */
	rotateRefresh?: boolean;
	/** Reject the refresh grant, as an expired or revoked one is rejected. */
	refreshRejected?: boolean;
	/** Publish no authorization-server metadata at all. */
	noMetadata?: boolean;
	/** Refuse dynamic client registration. */
	noRegistration?: boolean;
	/** Delay before the simulated browser hits the callback, to widen races. */
	browserDelayMs?: number;
	/** Delay inside the token endpoint, to widen the window two refreshes can overlap in. */
	tokenDelayMs?: number;
	/**
	 * Called once the token endpoint has a refresh request in hand and before it
	 * answers. A barrier rather than a delay: it makes "a peer landed tokens while
	 * my refresh was in flight" deterministic instead of a race against a timer.
	 */
	onRefreshRequest?: () => Promise<void>;
	/** Hold the response after consuming the grant, as a rotating server can. */
	onTokenResponse?: (grant: string) => Promise<void>;
	/** Authorization-server-controlled text used only by redaction tests. */
	errorMarker?: string;
	expiresIn?: number;
	/**
	 * Publish an RFC 9728 protected-resource document. Absent means 404 at both
	 * well-known locations, which is what several of our live servers do.
	 */
	resourceMetadata?: (origin: string) => Record<string, unknown>;
	/**
	 * Serve authorization-server metadata at the RFC 8414 path-scoped location for
	 * this issuer path as well, with its own registration endpoint — the shape a
	 * multi-tenant authorization server has.
	 */
	scopedMetadataPath?: string;
}

interface Fake {
	url: string;
	origin: string;
	/** "METHOD /path" for every request the server saw, in order. */
	requests: string[];
	grants: string[];
	/** The refresh credentials actually submitted, so reuse is observable. */
	refreshTokens: Array<string | null>;
	authorizeUrls: string[];
	/** The `resource` parameter each token request carried, in order. */
	resourceParams: Array<string | null>;
	registrations: number;
	/** Follows the authorize URL like a browser would, completing the callback. */
	browser(url: string): Promise<void>;
	browserErrors: string[];
	close(): Promise<void>;
}

/**
 * One server, both roles, exactly as our real deployments are shaped: the MCP
 * endpoint and the authorization server share an origin, and
 * `/.well-known/oauth-protected-resource` answers 404 the way the live server
 * does — so a login that works here cannot be relying on it.
 */
async function startFake(options: FakeOptions = {}): Promise<Fake> {
	const requests: string[] = [];
	const grants: string[] = [];
	const refreshTokens: Array<string | null> = [];
	const authorizeUrls: string[] = [];
	const resourceParams: Array<string | null> = [];
	const browserErrors: string[] = [];
	let registrations = 0;
	let accessToken = options.accessToken ?? "seeded-access";
	let refreshToken = options.refreshToken;
	let issued = 0;
	let clientId = "preregistered-client";
	const challenges = new Map<string, string>();

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		requests.push(`${request.method} ${url.pathname}`);
		void handle(request, response, url);
	});

	const handle = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
		const body = await readBody(request);
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			// Several live servers 404 this. Discovery must survive it, and must use it
			// when it is there.
			if (!options.resourceMetadata) {
				json(response, 404, { error: "not_found" });
				return;
			}
			json(response, 200, options.resourceMetadata(origin));
			return;
		}
		if (
			options.scopedMetadataPath &&
			url.pathname === `/.well-known/oauth-authorization-server${options.scopedMetadataPath}`
		) {
			json(response, 200, {
				issuer: `${origin}${options.scopedMetadataPath}`,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}${options.scopedMetadataPath}/register`,
				code_challenge_methods_supported: ["S256"],
			});
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			if (options.noMetadata) {
				json(response, 404, { error: "not_found" });
				return;
			}
			json(response, 200, {
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
				code_challenge_methods_supported: ["S256"],
				scopes_supported: ["read", "write"],
			});
			return;
		}
		if (url.pathname === "/register") {
			if (options.noRegistration) {
				json(response, 400, {
					error: "invalid_client_metadata",
					error_description: options.errorMarker ?? "registration is closed",
				});
				return;
			}
			registrations++;
			clientId = `dcr-client-${registrations}`;
			json(response, 200, {
				client_id: clientId,
				client_secret: "dcr-secret",
				redirect_uris: (JSON.parse(body) as { redirect_uris: string[] }).redirect_uris,
				scope: "read write",
			});
			return;
		}
		if (url.pathname === "/token") {
			if (options.tokenDelayMs) await new Promise((resolve) => setTimeout(resolve, options.tokenDelayMs));
			const form = new URLSearchParams(body);
			const grant = form.get("grant_type") ?? "";
			grants.push(grant);
			resourceParams.push(form.get("resource"));
			if (grant === "refresh_token") {
				refreshTokens.push(form.get("refresh_token"));
				if (options.onRefreshRequest) await options.onRefreshRequest();
				if (options.refreshRejected || form.get("refresh_token") !== refreshToken) {
					json(response, 400, {
						error: "invalid_grant",
						error_description: options.errorMarker ?? "refresh token is not valid",
					});
					return;
				}
				accessToken = `refreshed-${++issued}`;
				if (options.rotateRefresh) refreshToken = `rotated-${issued}`;
				await options.onTokenResponse?.(grant);
				json(response, 200, {
					access_token: accessToken,
					token_type: "Bearer",
					expires_in: options.expiresIn ?? 3600,
					...(options.rotateRefresh ? { refresh_token: refreshToken } : {}),
				});
				return;
			}
			if (grant === "authorization_code") {
				const verifier = form.get("code_verifier") ?? "";
				const expected = challenges.get(form.get("code") ?? "");
				// Verify PKCE the way the authorization server does, so a flow that
				// skipped or mismatched the verifier fails the test.
				if (!expected || base64Url(createHash("sha256").update(verifier).digest()) !== expected) {
					json(response, 400, {
						error: "invalid_grant",
						error_description: options.errorMarker ?? "PKCE verification failed",
					});
					return;
				}
				challenges.delete(form.get("code") ?? "");
				accessToken = `granted-${++issued}`;
				refreshToken = `refresh-${issued}`;
				await options.onTokenResponse?.(grant);
				json(response, 200, {
					access_token: accessToken,
					token_type: "Bearer",
					refresh_token: refreshToken,
					expires_in: options.expiresIn ?? 3600,
					scope: "read write",
				});
				return;
			}
			json(response, 400, { error: "unsupported_grant_type" });
			return;
		}
		if (url.pathname === "/mcp") {
			if (request.headers.authorization !== `Bearer ${accessToken}`) {
				response.writeHead(401, {
					"content-type": "application/json",
					"www-authenticate": `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
				});
				response.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
			const message = JSON.parse(body) as { id?: number; method?: string };
			if (message.method === "initialize") {
				json(response, 200, {
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: "2025-06-18",
						serverInfo: { name: "fake-oauth-mcp", version: "1" },
					},
				});
				return;
			}
			if (message.method === "tools/list") {
				json(response, 200, { jsonrpc: "2.0", id: message.id, result: { tools: [] } });
				return;
			}
			response.writeHead(202).end();
			return;
		}
		json(response, 404, { error: "not_found" });
	};

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	const fake: Fake = {
		url: `${origin}/mcp`,
		origin,
		requests,
		grants,
		refreshTokens,
		authorizeUrls,
		resourceParams,
		get registrations() {
			return registrations;
		},
		browserErrors,
		async browser(target: string): Promise<void> {
			authorizeUrls.push(target);
			try {
				const parsed = new URL(target);
				const challenge = parsed.searchParams.get("code_challenge");
				const redirect = parsed.searchParams.get("redirect_uri");
				const state = parsed.searchParams.get("state");
				if (!challenge || !redirect || !state) throw new Error(`authorize URL is missing parameters: ${target}`);
				const code = `code-${authorizeUrls.length}`;
				challenges.set(code, challenge);
				if (options.browserDelayMs) await new Promise((resolve) => setTimeout(resolve, options.browserDelayMs));
				const callback = new URL(redirect);
				callback.searchParams.set("code", code);
				callback.searchParams.set("state", state);
				const answer = await fetch(callback, { redirect: "manual" });
				await answer.text();
			} catch (error) {
				browserErrors.push(String(error));
			}
		},
		close(): Promise<void> {
			return new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			});
		},
	};
	fakes.push(fake);
	return fake;
}

function json(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise<string>((resolve) => {
		let text = "";
		request.on("data", (chunk) => {
			text += String(chunk);
		});
		request.on("end", () => resolve(text));
	});
}

function barrier(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function base64Url(bytes: Buffer): string {
	return bytes.toString("base64url");
}

function storeFor(serverUrl: string): CredentialStore {
	return new CredentialStore(credentialPaths(authDir, serverKey(serverUrl)));
}

function seed(serverUrl: string, tokens: OAuthTokens | undefined, client?: OAuthClientInfo): void {
	const paths = credentialPaths(authDir, serverKey(serverUrl));
	mkdirSync(authDir, { recursive: true });
	if (tokens) writeFileSync(paths.tokens, JSON.stringify(tokens), { mode: 0o600 });
	if (client) writeFileSync(paths.clientInfo, JSON.stringify(client), { mode: 0o600 });
}

function readJsonFile(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function authorizerFor(fake: Fake, overrides: Partial<OAuthAuthorizerOptions> = {}) {
	const openBrowser = vi.fn((url: string) => void fake.browser(url));
	const notice = vi.fn();
	const authorizer = createOAuthAuthorizer({
		notice,
		serverUrl: fake.url,
		serverName: "demo",
		interactive: true,
		store: storeFor(fake.url),
		openBrowser,
		lockPollIntervalMs: 20,
		lockWaitTimeoutMs: 15_000,
		browserTimeoutMs: 15_000,
		...overrides,
	});
	return { authorizer, openBrowser, notice };
}

describe("MCP native OAuth", () => {
	it("refuses to open a browser when the session is not interactive", async () => {
		const fake = await startFake({ accessToken: "unknown-to-us" });
		const { authorizer, openBrowser } = authorizerFor(fake, { interactive: false });
		const transport = createHttpTransport({ url: fake.url, authorizer });

		// A headless run has nobody to complete a login, so the 401 must surface as a
		// fast failure rather than a browser tab and a callback socket held open.
		await expect(transport.request("initialize", {}, REQUEST_OPTIONS)).rejects.toThrow();
		expect(openBrowser).not.toHaveBeenCalled();
		expect(fake.authorizeUrls).toEqual([]);
		// The remedy is the same whether the cause was `auth.browser: false` or the run
		// mode, so the message names it instead of guessing which one applied.
		expect(authorizer.describeFailure()).toMatch(/cannot open a browser/);
		expect(authorizer.describeFailure()).toMatch(/run `phi mcp login demo` in a terminal/);
		// No refresh token, so not even discovery runs: the refusal costs one request.
		expect(fake.requests.some((entry) => entry.includes(".well-known"))).toBe(false);
	});

	it("keeps an explicit non-interactive OAuth policy from invoking a remote host", async () => {
		const fake = await startFake({ accessToken: "unknown-to-us" });
		const host: McpOAuthHostIntegration = {
			prepareCallback: vi.fn(),
			presentAuthorization: vi.fn(),
			close: vi.fn(),
		};
		const { authorizer } = authorizerFor(fake, { interactive: false, host });
		const transport = createHttpTransport({ url: fake.url, authorizer });

		await expect(transport.request("initialize", {}, REQUEST_OPTIONS)).rejects.toThrow();
		expect(host.prepareCallback).not.toHaveBeenCalled();
		expect(host.presentAuthorization).not.toHaveBeenCalled();
		expect(host.close).not.toHaveBeenCalled();
		await transport.close();
	});

	it("keeps authorization-server text out of OAuth failures, notices, and MCP diagnostics", async () => {
		const markerText = OAUTH_SECRET_MARKERS.join(" ");
		const fake = await startFake({
			accessToken: "server-side-only",
			refreshToken: "REFRESH_TOKEN_MARKER",
			refreshRejected: true,
			noMetadata: true,
			noRegistration: true,
			errorMarker: markerText,
		});
		seed(
			fake.url,
			{
				access_token: "ACCESS_TOKEN_MARKER",
				refresh_token: "REFRESH_TOKEN_MARKER",
				expires_at: Date.now() - 1_000,
			},
			{ client_id: "CODE_MARKER", client_secret: "CLIENT_SECRET_MARKER" },
		);
		const { authorizer, notice } = authorizerFor(fake, { interactive: false });
		const config = { type: "http", url: `${fake.url}?state=STATE_MARKER`, auth: { mode: "oauth" } } as const;
		const transport = createHttpTransport({ url: config.url, authorizer });
		let transportError: unknown;
		try {
			await transport.request("initialize", {}, REQUEST_OPTIONS);
		} catch (error) {
			transportError = error;
		}
		const directRefresh = requestTokens(
			{
				token_endpoint: `${fake.origin}/token?code_challenge=PKCE_MARKER`,
			},
			{ client_id: "CODE_MARKER", client_secret: "CLIENT_SECRET_MARKER" },
			new URLSearchParams({ grant_type: "refresh_token", refresh_token: "REFRESH_TOKEN_MARKER" }),
			REQUEST_OPTIONS,
		);
		const directRegistration = registerClient(
			{
				token_endpoint: `${fake.origin}/token`,
				registration_endpoint: `${fake.origin}/register?access_token=ACCESS_TOKEN_MARKER`,
			},
			{ redirectUri: "http://localhost:49152/oauth/callback", scope: "STATE_MARKER" },
			REQUEST_OPTIONS,
		);
		const directDiscovery = discoverAuthorizationServer(
			{ serverUrl: `not-a-url-${OAUTH_SECRET_MARKERS.join("-")}` },
			REQUEST_OPTIONS,
		);
		const [refreshError, registrationError, discoveryError] = await Promise.all(
			[directRefresh, directRegistration, directDiscovery].map(async (promise) => {
				try {
					await promise;
					return undefined;
				} catch (error) {
					return error;
				}
			}),
		);
		await transport.close();

		expect(transportError).toBeDefined();
		expect(authorizer.describeFailure()).toBeTruthy();
		expectNoOAuthMarkers([
			transportError,
			authorizer.describeFailure(),
			safeMcpError(transportError, config),
			...notice.mock.calls.flat(),
			refreshError,
			registrationError,
			discoveryError,
		]);
	});

	it("keeps callback URL, state, and error_description markers out of notices and failures", async () => {
		const fake = await startFake({ accessToken: "unknown-to-us" });
		let remotePort = 0;
		const notice = vi.fn();
		const host: McpOAuthHostIntegration = {
			async prepareCallback(input) {
				remotePort = input.remotePort;
				return {
					leaseId: "lease-redaction",
					redirectUri: "http://127.0.0.1:49152/oauth/callback",
					expiresAt: Date.now() + 300_000,
				};
			},
			async presentAuthorization() {
				const callback = new URL(`http://127.0.0.1:${remotePort}/oauth/callback`);
				callback.searchParams.set("error", "access_denied");
				callback.searchParams.set("error_description", "ERROR_DESCRIPTION_MARKER");
				callback.searchParams.set("state", "STATE_MARKER");
				await fetch(callback);
			},
			close: vi.fn(),
		};
		let failure: unknown;
		try {
			await runAuthorizationCodeFlow({
				metadata: {
					authorization_endpoint: `${fake.origin}/authorize?code=CODE_MARKER&state=STATE_MARKER`,
					token_endpoint: `${fake.origin}/token?access_token=ACCESS_TOKEN_MARKER`,
					registration_endpoint: `${fake.origin}/register?client_secret=CLIENT_SECRET_MARKER`,
				},
				serverName: "demo",
				openBrowser: () => undefined,
				host,
				notice,
			});
		} catch (error) {
			failure = error;
		}
		await fake.close();

		expect(failure).toBeDefined();
		expect(host.close).toHaveBeenCalledWith({ leaseId: "lease-redaction", outcome: "failed" });
		expectNoOAuthMarkers([failure, safeMcpError(failure), ...notice.mock.calls.flat()]);
	});

	it("redacts a browser launcher failure that contains the authorization URL", async () => {
		const fake = await startFake();
		let failure: unknown;
		try {
			await runAuthorizationCodeFlow({
				metadata: {
					authorization_endpoint: `${fake.origin}/authorize?state=STATE_MARKER&code=CODE_MARKER`,
					token_endpoint: `${fake.origin}/token?access_token=ACCESS_TOKEN_MARKER`,
				},
				client: { client_id: "CLIENT_SECRET_MARKER" },
				serverName: "demo",
				openBrowser: (target) => {
					throw new Error(`browser failed for ${target} PKCE_MARKER REFRESH_TOKEN_MARKER`);
				},
			});
		} catch (error) {
			failure = error;
		}
		await fake.close();

		expect(failure).toMatchObject({ code: "browser_open_failed" });
		expectNoOAuthMarkers([failure, safeMcpError(failure)]);
	});

	it("turns a 401 into discovery, registration, a PKCE login, and one retry", async () => {
		const fake = await startFake({ accessToken: "unknown-to-us" });
		const { authorizer, openBrowser } = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer });

		const identity = (await transport.request("initialize", {}, REQUEST_OPTIONS)) as {
			serverInfo: { name: string };
		};
		expect(identity.serverInfo.name).toBe("fake-oauth-mcp");

		// Discovery went to the authorization-server document; the protected-resource
		// document was consulted but 404s, so the login cannot have depended on it.
		expect(fake.requests).toContain("GET /.well-known/oauth-authorization-server");
		expect(fake.requests).toContain("GET /.well-known/oauth-protected-resource");
		expect(fake.browserErrors).toEqual([]);
		expect(openBrowser).toHaveBeenCalledTimes(1);
		expect(fake.registrations).toBe(1);
		expect(fake.grants).toEqual(["authorization_code"]);

		const authorize = new URL(fake.authorizeUrls[0] as string);
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
		expect(authorize.searchParams.get("code_verifier")).toBeNull();
		expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/oauth\/callback$/);
		// This server publishes no protected-resource document, so there is no resource
		// indicator to name and the parameter is omitted rather than invented: a server
		// predating RFC 8707 must see exactly what it saw before.
		expect(authorize.searchParams.get("resource")).toBeNull();
		expect(fake.resourceParams).toEqual([null]);

		// Exactly one 401 and one retry, not a loop.
		expect(fake.requests.filter((entry) => entry === "POST /mcp")).toHaveLength(2);

		const paths = credentialPaths(authDir, serverKey(fake.url));
		const stored = readJsonFile(paths.tokens);
		expect(stored.access_token).toBe("granted-1");
		expect(stored.refresh_token).toBe("refresh-1");
		expect(stored.expires_at).toBeTypeOf("number");
		expect(statSync(paths.tokens).mode & 0o777).toBe(0o600);
		expect(readJsonFile(paths.clientInfo).client_id).toBe("dcr-client-1");
		expect(statSync(paths.clientInfo).mode & 0o777).toBe(0o600);
		// The lock is released, not left for the next session to reason about.
		expect(() => statSync(paths.lock)).toThrow();

		await transport.close();
	});

	it("renews an expired token silently, without a browser or a listening socket", async () => {
		const fake = await startFake({ accessToken: "stale-access", refreshToken: "seeded-refresh" });
		seed(
			fake.url,
			{ access_token: "stale-access", refresh_token: "seeded-refresh", expires_at: Date.now() - 1_000 },
			{ client_id: "seeded-client", client_secret: "seeded-secret" },
		);
		const { authorizer, openBrowser } = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer });

		await transport.request("initialize", {}, REQUEST_OPTIONS);

		// No browser means no callback server was ever bound: that code path is the
		// only thing in the implementation that listens.
		expect(openBrowser).not.toHaveBeenCalled();
		expect(fake.grants).toEqual(["refresh_token"]);
		expect(fake.registrations).toBe(0);
		// The expiry was known, so the 401 round trip was skipped entirely.
		expect(fake.requests.filter((entry) => entry === "POST /mcp")).toHaveLength(1);

		const stored = readJsonFile(credentialPaths(authDir, serverKey(fake.url)).tokens);
		expect(stored.access_token).toBe("refreshed-1");
		// The server returned no new refresh token, so the working one is kept.
		expect(stored.refresh_token).toBe("seeded-refresh");
		await transport.close();
	});

	it("sends a cached token as `Bearer` even when the server called it `bearer`", async () => {
		// Regression: platform-ops issues `"token_type": "bearer"` and then rejects
		// `Authorization: bearer <token>` with 401 while accepting `Bearer`. Echoing
		// the server's own spelling back cost a pointless refresh on every request,
		// and a browser login once the refresh token rotated out.
		const fake = await startFake({ accessToken: "cased-access", refreshToken: "seeded-refresh" });
		seed(
			fake.url,
			{
				access_token: "cased-access",
				refresh_token: "seeded-refresh",
				token_type: "bearer",
				expires_at: Date.now() + 600_000,
			},
			{ client_id: "seeded-client", client_secret: "seeded-secret" },
		);
		const { authorizer, openBrowser } = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer });

		await transport.request("initialize", {}, REQUEST_OPTIONS);

		// The cached token was accepted first time: no 401, so no renewal and no login.
		expect(fake.grants).toEqual([]);
		expect(openBrowser).not.toHaveBeenCalled();
		expect(fake.requests.filter((entry) => entry === "POST /mcp")).toHaveLength(1);
		await transport.close();
	});

	it("renews on a 401 when the cached token carries no expiry, and persists a rotated refresh token", async () => {
		const fake = await startFake({
			accessToken: "server-side-only",
			refreshToken: "seeded-refresh",
			rotateRefresh: true,
		});
		seed(
			fake.url,
			{ access_token: "cached-but-dead", refresh_token: "seeded-refresh" },
			{ client_id: "seeded-client", client_secret: "seeded-secret" },
		);
		const { authorizer, openBrowser } = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer });

		await transport.request("initialize", {}, REQUEST_OPTIONS);

		expect(openBrowser).not.toHaveBeenCalled();
		expect(fake.grants).toEqual(["refresh_token"]);
		const stored = readJsonFile(credentialPaths(authDir, serverKey(fake.url)).tokens);
		expect(stored.access_token).toBe("refreshed-1");
		expect(stored.refresh_token).toBe("rotated-1");
		await transport.close();
	});

	it("falls back to the browser when the refresh token is rejected, and drops the dead one", async () => {
		const fake = await startFake({
			accessToken: "server-side-only",
			refreshToken: "seeded-refresh",
			refreshRejected: true,
		});
		seed(
			fake.url,
			{ access_token: "cached-but-dead", refresh_token: "seeded-refresh" },
			{ client_id: "seeded-client", client_secret: "seeded-secret" },
		);
		const { authorizer, openBrowser } = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer });

		await transport.request("initialize", {}, REQUEST_OPTIONS);

		expect(fake.grants).toEqual(["refresh_token", "authorization_code"]);
		expect(openBrowser).toHaveBeenCalledTimes(1);
		// A client was already cached, so the fallback reuses it instead of registering.
		expect(fake.registrations).toBe(0);
		const stored = readJsonFile(credentialPaths(authDir, serverKey(fake.url)).tokens);
		expect(stored.access_token).toBe("granted-1");
		expect(stored.refresh_token).toBe("refresh-1");
		await transport.close();
	});

	it("serializes concurrent first-time logins into a single browser prompt", async () => {
		const fake = await startFake({ accessToken: "unknown-to-us", browserDelayMs: 120 });
		const first = authorizerFor(fake);
		const second = authorizerFor(fake);
		const transports = [
			createHttpTransport({ url: fake.url, authorizer: first.authorizer }),
			createHttpTransport({ url: fake.url, authorizer: second.authorizer }),
		];

		await Promise.all(transports.map((transport) => transport.request("initialize", {}, REQUEST_OPTIONS)));

		const prompts = first.openBrowser.mock.calls.length + second.openBrowser.mock.calls.length;
		expect(prompts).toBe(1);
		expect(fake.registrations).toBe(1);
		expect(fake.grants).toEqual(["authorization_code"]);
		// The loser waited on the lock and adopted the winner's tokens; it did not
		// merely find them already cached before trying.
		expect(fake.authorizeUrls).toHaveLength(1);
		const notices = [...first.notice.mock.calls, ...second.notice.mock.calls].map(([message]) => String(message));
		expect(
			notices.filter((message) => message.includes("reused an OAuth login from another phi session")),
		).toHaveLength(1);
		expect(readJsonFile(credentialPaths(authDir, serverKey(fake.url)).tokens).access_token).toBe("granted-1");
		for (const transport of transports) await transport.close();
	});

	it("lets one session refresh a rotating credential while the others adopt its result", async () => {
		// The production failure this prevents: a rotating server deletes the old
		// refresh token on first use, so a second process refreshing concurrently is
		// told `invalid_grant` and drags everyone through a browser login.
		const fake = await startFake({
			accessToken: "stale-access",
			refreshToken: "seeded-refresh",
			rotateRefresh: true,
			tokenDelayMs: 150,
		});
		seed(
			fake.url,
			{ access_token: "stale-access", refresh_token: "seeded-refresh", expires_at: Date.now() - 1_000 },
			{ client_id: "seeded-client", client_secret: "seeded-secret" },
		);
		const peers = [authorizerFor(fake), authorizerFor(fake), authorizerFor(fake)];
		const transports = peers.map((peer) => createHttpTransport({ url: fake.url, authorizer: peer.authorizer }));

		await Promise.all(transports.map((transport) => transport.request("initialize", {}, REQUEST_OPTIONS)));

		// One refresh for three sessions, and no browser: the losers waited on the
		// lock and adopted the winner's tokens. (Three sessions in one process; the
		// lock's pid/port liveness probe for genuinely separate processes is covered
		// by the lock suite below.)
		expect(fake.grants).toEqual(["refresh_token"]);
		expect(peers.some((peer) => peer.openBrowser.mock.calls.length > 0)).toBe(false);
		expect(fake.authorizeUrls).toEqual([]);
		expect(readJsonFile(credentialPaths(authDir, serverKey(fake.url)).tokens).refresh_token).toBe("rotated-1");
		// And the lock is handed back, not left for the next session to break.
		expect(() => statSync(credentialPaths(authDir, serverKey(fake.url)).lock)).toThrow();

		for (const transport of transports) await transport.close();
	});

	it("persists a rotating refresh after cancellation so a restarted connection adopts it", async () => {
		// FastMCP rotates before answering. Cancelling the old session in that
		// window must not lose the only refresh token the server still accepts.
		const rotated = barrier();
		const respond = barrier();
		const fake = await startFake({
			accessToken: "stale-access",
			refreshToken: "seeded-refresh",
			rotateRefresh: true,
			onTokenResponse: async () => {
				rotated.resolve();
				await respond.promise;
			},
		});
		seed(
			fake.url,
			{ access_token: "stale-access", refresh_token: "seeded-refresh", expires_at: Date.now() - 1_000 },
			{ client_id: "seeded-client", client_secret: "seeded-secret" },
		);
		const first = authorizerFor(fake);
		const restartedStore = storeFor(fake.url);
		const reads = vi.spyOn(restartedStore, "readTokens");
		const restarted = authorizerFor(fake, { store: restartedStore });
		const oldTransport = createHttpTransport({ url: fake.url, authorizer: first.authorizer });
		const newTransport = createHttpTransport({ url: fake.url, authorizer: restarted.authorizer });
		const controller = new AbortController();
		const oldRequest = oldTransport
			.request("initialize", {}, { ...REQUEST_OPTIONS, signal: controller.signal })
			.catch((error: unknown) => error);
		let newRequest: Promise<unknown> | undefined;
		try {
			await rotated.promise;
			controller.abort();
			newRequest = newTransport.request(
				"initialize",
				{},
				{ ...REQUEST_OPTIONS, signal: new AbortController().signal },
			);
			// Read the expired credential and enter the refresh lock while the old
			// response is still held, rather than merely finding fresh tokens later.
			await expect.poll(() => reads.mock.calls.length).toBeGreaterThanOrEqual(3);
			respond.resolve();

			await expect(oldRequest).resolves.toMatchObject({ message: "The MCP OAuth request was cancelled." });
			await expect(newRequest).resolves.toMatchObject({ serverInfo: { name: "fake-oauth-mcp" } });
			await expect(restartedStore.readTokens()).resolves.toMatchObject({
				access_token: "refreshed-1",
				refresh_token: "rotated-1",
			});
			await expect(restarted.authorizer.authorization(REQUEST_OPTIONS)).resolves.toBe("Bearer refreshed-1");
			expect(fake.refreshTokens).toEqual(["seeded-refresh"]);
			expect(fake.grants).toEqual(["refresh_token"]);
			expect(first.openBrowser).not.toHaveBeenCalled();
			expect(restarted.openBrowser).not.toHaveBeenCalled();
			const events = await readOAuthEvents({ env: process.env });
			expect(events).toContainEqual(expect.objectContaining({ event: "refresh.ok", rotated: true }));
			expect(events).toContainEqual(expect.objectContaining({ event: "token.adopted", detail: "peer-refresh" }));
			expect(events.some((event) => event.event === "login.start" || event.event === "refresh.failed")).toBe(false);
			expect(() => statSync(restartedStore.paths.lock)).toThrow();
		} finally {
			respond.resolve();
			await Promise.allSettled([oldRequest, newRequest]);
			await oldTransport.close();
			await newTransport.close();
		}
	});

	it("persists an authorization-code exchange after cancellation once the server consumed the code", async () => {
		const consumed = barrier();
		const respond = barrier();
		const fake = await startFake({
			onTokenResponse: async () => {
				consumed.resolve();
				await respond.promise;
			},
		});
		const first = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer: first.authorizer });
		const controller = new AbortController();
		const request = transport
			.request("initialize", {}, { ...REQUEST_OPTIONS, signal: controller.signal })
			.catch((error: unknown) => error);
		try {
			await consumed.promise;
			controller.abort();
			respond.resolve();
			await expect(request).resolves.toMatchObject({ message: "The MCP OAuth request was cancelled." });

			await expect(storeFor(fake.url).readTokens()).resolves.toMatchObject({
				access_token: "granted-1",
				refresh_token: "refresh-1",
			});
			const restarted = authorizerFor(fake);
			await expect(restarted.authorizer.authorization(REQUEST_OPTIONS)).resolves.toBe("Bearer granted-1");
			expect(restarted.openBrowser).not.toHaveBeenCalled();
			expect(first.openBrowser).toHaveBeenCalledTimes(1);
			expect(fake.grants).toEqual(["authorization_code"]);
			expect(() => statSync(storeFor(fake.url).paths.lock)).toThrow();
		} finally {
			respond.resolve();
			await request;
			await transport.close();
		}
	});

	it("does not submit a token grant when the caller was already cancelled", async () => {
		const fake = await startFake({ refreshToken: "seeded-refresh" });
		const controller = new AbortController();
		controller.abort();

		await expect(
			requestTokens(
				{ token_endpoint: `${fake.origin}/token` },
				{ client_id: "seeded-client" },
				new URLSearchParams({ grant_type: "refresh_token", refresh_token: "seeded-refresh" }),
				{ ...REQUEST_OPTIONS, signal: controller.signal },
			),
		).rejects.toMatchObject({ code: "request_cancelled" });
		expect(fake.requests).toEqual([]);
	});

	it("still times out a cancelled refresh and releases its lock when the response never arrives", async () => {
		const rotated = barrier();
		const respond = barrier();
		const fake = await startFake({
			refreshToken: "seeded-refresh",
			rotateRefresh: true,
			onTokenResponse: async () => {
				rotated.resolve();
				await respond.promise;
			},
		});
		seed(
			fake.url,
			{ access_token: "stale-access", refresh_token: "seeded-refresh", expires_at: Date.now() - 1_000 },
			{ client_id: "seeded-client" },
		);
		const { authorizer, openBrowser } = authorizerFor(fake);
		const controller = new AbortController();
		const request = authorizer.authorization({ timeoutMs: 1_000, signal: controller.signal });
		try {
			await rotated.promise;
			controller.abort();
			await request;

			const events = await readOAuthEvents({ env: process.env });
			expect(events).toContainEqual(
				expect.objectContaining({ event: "refresh.failed", errorCode: "request_timeout" }),
			);
			expect(openBrowser).not.toHaveBeenCalled();
			expect(() => statSync(storeFor(fake.url).paths.lock)).toThrow();
		} finally {
			respond.resolve();
			await request;
		}
	});

	it("adopts a peer's newer tokens instead of deleting them when its own refresh is refused", async () => {
		// A refusal means "this refresh token is dead", which on a rotating server is
		// also what the loser of a race sees. Deleting the store then would throw away
		// the working credential the winner had just written.
		let store: CredentialStore | undefined;
		const fake = await startFake({
			accessToken: "peer-access",
			refreshToken: "live-refresh",
			// The peer's write happens exactly while this session's doomed refresh is
			// in flight, which is the moment the old code deleted it.
			onRefreshRequest: async () => {
				await store?.writeTokens({
					access_token: "peer-access",
					refresh_token: "live-refresh",
					expires_at: Date.now() + 600_000,
				});
			},
		});
		store = storeFor(fake.url);
		seed(
			fake.url,
			{ access_token: "dead-access", refresh_token: "superseded-refresh", expires_at: Date.now() + 600_000 },
			{ client_id: "seeded-client", client_secret: "seeded-secret" },
		);
		const { authorizer, openBrowser } = authorizerFor(fake, { store });
		// Prime this session with the superseded credential.
		await authorizer.authorization(REQUEST_OPTIONS);

		const transport = createHttpTransport({ url: fake.url, authorizer });
		await transport.request("initialize", {}, REQUEST_OPTIONS);

		// The refusal was survived without a browser, and the peer's working
		// credential is still on disk rather than deleted.
		expect(fake.grants).toEqual(["refresh_token"]);
		expect(openBrowser).not.toHaveBeenCalled();
		expect(fake.authorizeUrls).toEqual([]);
		const stored = readJsonFile(credentialPaths(authDir, serverKey(fake.url)).tokens);
		expect(stored.refresh_token).toBe("live-refresh");
		expect(stored.access_token).toBe("peer-access");
		await transport.close();
	});

	it("leaves a peer's tokens alone when the credential it decided was dead is already gone", async () => {
		// Discarding is a compare-and-delete: an older phi that does not take the
		// refresh lock can still write working tokens between this session's read and
		// its delete, and those are the ones worth keeping.
		const fake = await startFake({ accessToken: "peer-access", refreshToken: "live-refresh", refreshRejected: true });
		const store = storeFor(fake.url);
		await store.writeTokens({ access_token: "dead-access", refresh_token: "dead-refresh" });
		await store.discardTokens("some-other-session's-token");

		await expect(store.readTokens()).resolves.toMatchObject({ access_token: "dead-access" });
		// Naming the credential it actually read does delete it.
		await store.discardTokens("dead-access");
		await expect(store.readTokens()).resolves.toBeUndefined();
	});

	it("never deletes a credential a peer publishes while the discard is in flight", async () => {
		// The discard must be atomic with respect to its own decision: a read
		// followed by a delete would drop whatever landed in between, which is the
		// working credential by definition. The implementation removes that window by
		// construction — it renames the file out of the way and judges the object it
		// took, so a peer's later write is a different file it never touches — which
		// is why this asserts the invariant across interleavings rather than trying
		// to hit one window.
		const fake = await startFake({});
		const store = storeFor(fake.url);

		for (let attempt = 0; attempt < 25; attempt++) {
			await store.writeTokens({ access_token: "dead-access", refresh_token: "dead-refresh" });
			await Promise.all([
				store.discardTokens("dead-access"),
				// The peer's write is interleaved at a different point each attempt.
				(async () => {
					for (let tick = 0; tick < attempt % 4; tick++) await Promise.resolve();
					await store.writeTokens({ access_token: `peer-${attempt}`, refresh_token: "live-refresh" });
				})(),
			]);

			// Whatever the interleaving, the peer's credential is what survives — never
			// an empty store the next session has to fix with a browser login.
			await expect(store.readTokens()).resolves.toMatchObject({ access_token: `peer-${attempt}` });
		}
	});

	it("keeps the fresher credential when two sessions discard at once", async () => {
		// Two discarders and a peer: whoever puts a credential back must not bury a
		// newer one that landed while it was deciding.
		const fake = await startFake({});
		const store = storeFor(fake.url);

		for (let attempt = 0; attempt < 15; attempt++) {
			await store.writeTokens({ access_token: "older", refresh_token: "older", expires_at: Date.now() + 60_000 });
			await Promise.all([
				store.discardTokens("condemned-by-one"),
				store.discardTokens("condemned-by-two"),
				(async () => {
					for (let tick = 0; tick < attempt % 5; tick++) await Promise.resolve();
					await store.writeTokens({
						access_token: "newer",
						refresh_token: "newer",
						expires_at: Date.now() + 600_000,
					});
				})(),
			]);

			await expect(store.readTokens()).resolves.toMatchObject({ access_token: "newer" });
		}
	});

	it("records a rotating refresh in the audit log, by fingerprint and never in clear", async () => {
		// The diagnosis this log exists for: when a server rotates, the refresh token
		// every other process still holds is dead, and the trail has to make that
		// visible after the fact rather than only in a session notice nobody kept.
		const fake = await startFake({
			accessToken: "stale-access",
			refreshToken: "REFRESH_TOKEN_MARKER",
			rotateRefresh: true,
		});
		seed(
			fake.url,
			{ access_token: "stale-access", refresh_token: "REFRESH_TOKEN_MARKER", expires_at: Date.now() - 1_000 },
			{ client_id: "seeded-client", client_secret: "CLIENT_SECRET_MARKER" },
		);
		const { authorizer } = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer });

		await transport.request("initialize", {}, REQUEST_OPTIONS);

		const events = await readOAuthEvents({ env: process.env });
		const renewed = events.find((event) => event.event === "refresh.ok");
		expect(events.map((event) => event.event)).toContain("refresh.start");
		expect(renewed?.rotated).toBe(true);
		expect(renewed?.refreshToken).toBe(fingerprint("REFRESH_TOKEN_MARKER"));
		expect(renewed?.newRefreshToken).not.toBe(renewed?.refreshToken);
		expect(renewed?.server).toBe("demo");
		// The store the process actually resolved to — fingerprinted, because the key
		// is a digest of the server URL and a URL can carry a bearer in its path. It
		// still answers the question it is there for: two processes on the same
		// credential file report the same value.
		// Which credential file the process actually resolved to — a recurring bug on
		// its own.
		expect(renewed?.key).toBe(fingerprint(serverKey(fake.url)));
		expectNoOAuthMarkers([readFileSync(join(authDir, DEFAULT_AUTH_LOG_NAME), "utf8")]);

		await transport.close();
	});

	it("records a refused refresh token with its OAuth code, and the discard that follows", async () => {
		const fake = await startFake({
			accessToken: "unknown-to-us",
			refreshToken: "REFRESH_TOKEN_MARKER",
			refreshRejected: true,
		});
		seed(
			fake.url,
			{ access_token: "dead-access", refresh_token: "REFRESH_TOKEN_MARKER", expires_at: Date.now() + 600_000 },
			{ client_id: "seeded-client", client_secret: "CLIENT_SECRET_MARKER" },
		);
		const { authorizer } = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer });

		await transport.request("initialize", {}, REQUEST_OPTIONS);

		const events = await readOAuthEvents({ env: process.env });
		const names = events.map((event) => event.event);
		// The full story of one forced re-login, in order.
		expect(names).toContain("unauthorized");
		expect(names).toContain("refresh.failed");
		expect(names.indexOf("tokens.discarded")).toBeGreaterThan(names.indexOf("refresh.failed"));
		expect(names).toContain("login.ok");
		const failed = events.find((event) => event.event === "refresh.failed");
		expect(failed?.status).toBe(400);
		expect(failed?.errorCode).toBeTypeOf("string");
		expectNoOAuthMarkers([readFileSync(join(authDir, DEFAULT_AUTH_LOG_NAME), "utf8")]);

		await transport.close();
	});

	it("leaves a statically authenticated server untouched", async () => {
		const fake = await startFake({ accessToken: "static-token" });
		const working = createHttpTransport({ url: fake.url, headers: { Authorization: "Bearer static-token" } });
		await working.request("initialize", {}, REQUEST_OPTIONS);
		await working.close();

		const broken = createHttpTransport({ url: fake.url, headers: { Authorization: "Bearer wrong" } });
		await expect(broken.request("initialize", {}, REQUEST_OPTIONS)).rejects.toThrow(
			/returned HTTP 401: \{"error":"unauthorized"\}$/,
		);
		await broken.close();

		// No authorizer, so nothing discovered anything and no credential was stored.
		expect(fake.requests.some((entry) => entry.includes(".well-known"))).toBe(false);
		expect(fake.grants).toEqual([]);
		expect(() => statSync(credentialPaths(authDir, serverKey(fake.url)).tokens)).toThrow();
	});

	it("reports why a login failed instead of a bare 401", async () => {
		// No metadata anywhere, so the spec's assumed endpoints are tried, and
		// registration there is refused: the surviving 401 has to say so.
		const fake = await startFake({ accessToken: "unknown-to-us", noMetadata: true, noRegistration: true });
		const { authorizer, openBrowser } = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer });
		await expect(transport.request("initialize", {}, REQUEST_OPTIONS)).rejects.toThrow(
			/MCP OAuth server returned HTTP 401.*rejected client registration/s,
		);
		expect(openBrowser).not.toHaveBeenCalled();
		await transport.close();
	});

	it("names the published resource on the authorization request and on every grant", async () => {
		// Monday's authorization endpoint answers "resource parameter is required" and
		// never issues a code without it, so a login for a server with a
		// protected-resource document has to carry the RFC 8707 indicator throughout.
		const fake = await startFake({
			accessToken: "unknown-to-us",
			resourceMetadata: (origin) => ({
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
				scopes_supported: ["boards:read", "boards:write"],
			}),
		});
		const { authorizer } = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer });

		await transport.request("initialize", {}, REQUEST_OPTIONS);

		const authorize = new URL(fake.authorizeUrls[0] as string);
		expect(authorize.searchParams.get("resource")).toBe(`${fake.origin}/mcp`);
		// The resource's own scopes outrank the authorization server's list.
		expect(authorize.searchParams.get("scope")).toBe("boards:read boards:write");
		expect(fake.grants).toEqual(["authorization_code"]);
		expect(fake.resourceParams).toEqual([`${fake.origin}/mcp`]);
		await transport.close();
	});

	it("names the resource on a silent refresh too, so the renewed token keeps its audience", async () => {
		const fake = await startFake({
			accessToken: "stale-access",
			refreshToken: "seeded-refresh",
			resourceMetadata: (origin) => ({ resource: `${origin}/mcp`, authorization_servers: [origin] }),
		});
		seed(
			fake.url,
			{ access_token: "stale-access", refresh_token: "seeded-refresh", expires_at: Date.now() - 1_000 },
			{ client_id: "seeded-client", client_secret: "seeded-secret" },
		);
		const { authorizer, openBrowser } = authorizerFor(fake);
		const transport = createHttpTransport({ url: fake.url, authorizer });

		await transport.request("initialize", {}, REQUEST_OPTIONS);

		expect(openBrowser).not.toHaveBeenCalled();
		expect(fake.grants).toEqual(["refresh_token"]);
		expect(fake.resourceParams).toEqual([`${fake.origin}/mcp`]);
		await transport.close();
	});

	it("prefers the authorization server the protected-resource document names", async () => {
		// Monday's shape: the MCP origin also serves an authorization-server document,
		// but its token endpoint does not know the clients the real authorization server
		// registers, so registering with one and exchanging at the other fails.
		const authorizationServer = await startFake();
		const resourceServer = await startFake({
			// A resource published as the bare origin, as serval publishes it: it covers
			// the `/mcp` endpoint, and it is the string the authorization server knows.
			resourceMetadata: (origin) => ({ resource: origin, authorization_servers: [authorizationServer.origin] }),
		});
		const discovery = await discoverAuthorizationServer(
			{
				serverUrl: resourceServer.url,
				challenge: {
					scheme: "bearer",
					params: { resource_metadata: `${resourceServer.origin}/.well-known/oauth-protected-resource` },
				},
			},
			REQUEST_OPTIONS,
		);

		// The MCP origin publishes a perfectly parseable authorization-server document
		// too, and it loses to the one the resource named.
		expect(discovery.metadata.token_endpoint).toBe(`${authorizationServer.origin}/token`);
		expect(discovery.metadata.assumed).toBeUndefined();
		expect(discovery.resource).toBe(resourceServer.origin);
	});

	it("reads a path-bearing issuer's metadata at its RFC 8414 location, not the origin's", async () => {
		// Atlassian's shape: the protected resource names an issuer with a tenant path,
		// and only the path-scoped document carries its registration_endpoint. The
		// origin-level one parses fine, so preferring it silently loses dynamic
		// registration instead of failing visibly.
		const tenant = "/tenant-abc";
		const authorizationServer = await startFake({ scopedMetadataPath: tenant });
		const resourceServer = await startFake({
			resourceMetadata: () => ({ authorization_servers: [`${authorizationServer.origin}${tenant}`] }),
		});

		const discovery = await discoverAuthorizationServer({ serverUrl: resourceServer.url }, REQUEST_OPTIONS);

		expect(discovery.metadata.issuer).toBe(`${authorizationServer.origin}${tenant}`);
		expect(discovery.metadata.registration_endpoint).toBe(`${authorizationServer.origin}${tenant}/register`);
	});

	it("asks for the endpoint itself when the published resource covers something else", async () => {
		// A resource document naming a different origin is a server-side mistake we
		// cannot resolve. Sending its value would ask for a token for somebody else, so
		// the endpoint we actually call is named and the server gets to judge it.
		const fake = await startFake({
			resourceMetadata: () => ({ resource: "https://not-this-server.example/mcp" }),
		});
		const discovery = await discoverAuthorizationServer({ serverUrl: fake.url }, REQUEST_OPTIONS);
		expect(discovery.resource).toBe(fake.url);
		expect(discovery.metadata.token_endpoint).toBe(`${fake.origin}/token`);
	});

	it("refuses a callback that carries the wrong state", async () => {
		const fake = await startFake();
		await expect(
			runAuthorizationCodeFlow({
				metadata: {
					issuer: fake.origin,
					authorization_endpoint: `${fake.origin}/authorize`,
					token_endpoint: `${fake.origin}/token`,
					registration_endpoint: `${fake.origin}/register`,
				},
				serverName: "demo",
				timeoutMs: 10_000,
				openBrowser: (target) => {
					const tampered = new URL(target);
					tampered.searchParams.set("state", "not-the-state-we-sent");
					void fake.browser(tampered.toString());
				},
			}),
		).rejects.toThrow(/state/);
	});
});

describe("MCP OAuth login lock", () => {
	const paths = () => credentialPaths(authDir, "lock-test");
	const noTokens = () => Promise.resolve(false);

	it("takes over a lock whose holder is gone, however recently it was written", async () => {
		// A wall-clock rule would still be honouring this one: it is seconds old.
		writeFileSync(paths().lock, JSON.stringify({ pid: 0x7ffffff0, port: 0, timestamp: Date.now() }));
		const acquisition = await acquireLoginLock(paths(), { hasTokens: noTokens, waitTimeoutMs: 500 });
		expect(acquisition.kind).toBe("held");
		if (acquisition.kind === "held") await acquisition.holder.release();
		expect(() => statSync(paths().lock)).toThrow();
	});

	it("treats a lock this process wrote but no longer holds as abandoned", async () => {
		// mcp-remote's own lock shape, and the shape phi leaves behind after a crash.
		writeFileSync(paths().lock, JSON.stringify({ pid: process.pid, port: 0, timestamp: Date.now() }));
		const acquisition = await acquireLoginLock(paths(), { hasTokens: noTokens, waitTimeoutMs: 500 });
		expect(acquisition.kind).toBe("held");
		if (acquisition.kind === "held") await acquisition.holder.release();
	});

	it("waits for a lock whose record has not been written yet", async () => {
		// Creating the lock is atomic, but the record lands in a second write, so a
		// live lock is briefly an empty file. Treating that window as "names no
		// holder, delete it" let a waiter become a second holder: two browser
		// prompts, two client registrations, and one session left presenting tokens
		// the other had already replaced. Only a lock that *stays* unreadable is broken.
		writeFileSync(paths().lock, "");
		let tokens = false;
		// The holder finishes its second write, then completes the login.
		const wroteRecord = setTimeout(() => {
			// pid 1 is always alive, and port 0 means "not listening yet".
			writeFileSync(paths().lock, JSON.stringify({ pid: 1, port: 0, timestamp: Date.now() }));
		}, 30);
		const grantedTokens = setTimeout(() => {
			tokens = true;
		}, 90);

		try {
			const acquisition = await acquireLoginLock(paths(), {
				hasTokens: () => Promise.resolve(tokens),
				pollIntervalMs: 10,
				waitTimeoutMs: 2_000,
			});
			// It adopted the holder's tokens instead of starting a rival login.
			expect(acquisition.kind).toBe("tokens");
			// And it never deleted the lock it was waiting on.
			expect(statSync(paths().lock).isFile()).toBe(true);
		} finally {
			clearTimeout(wroteRecord);
			clearTimeout(grantedTokens);
		}
	});

	it("steals a live holder's lock only when its published callback port is dead", async () => {
		// pid 1 is always alive, so the port probe is the only thing that can decide.
		writeFileSync(paths().lock, JSON.stringify({ pid: 1, port: 65_000, timestamp: Date.now() }));
		const dead = await acquireLoginLock(paths(), {
			hasTokens: noTokens,
			probePort: () => Promise.resolve(false),
			waitTimeoutMs: 500,
		});
		expect(dead.kind).toBe("held");
		if (dead.kind === "held") await dead.holder.release();

		writeFileSync(paths().lock, JSON.stringify({ pid: 1, port: 65_000, timestamp: Date.now() }));
		const alive = await acquireLoginLock(paths(), {
			hasTokens: noTokens,
			probePort: () => Promise.resolve(true),
			pollIntervalMs: 10,
			waitTimeoutMs: 60,
		});
		// A live holder is waited for, never interrupted.
		expect(alive.kind).toBe("timeout");
		expect(statSync(paths().lock).isFile()).toBe(true);
	});

	it("ends a wait as soon as the holder's tokens appear", async () => {
		writeFileSync(paths().lock, JSON.stringify({ pid: 1, port: 65_000, timestamp: Date.now() }));
		let polls = 0;
		const acquisition = await acquireLoginLock(paths(), {
			hasTokens: () => Promise.resolve(++polls > 2),
			probePort: () => Promise.resolve(true),
			pollIntervalMs: 10,
			waitTimeoutMs: 5_000,
		});
		expect(acquisition.kind).toBe("tokens");
		// Somebody else's lock is left for them to release.
		expect(statSync(paths().lock).isFile()).toBe(true);
	});
});

describe("MCP OAuth credential store", () => {
	it("keys a server exactly as mcp-remote does", () => {
		// Regression on interoperability: these hashes name real files in ~/.mcp-auth.
		expect(serverKey("https://mcp.monday.com/mcp")).toBe("1c5d0321d13e058d07a48b098dce764c");
		expect(serverKey("https://mcp.atlassian.com/v1/mcp/authv2")).toBe("8d8bab2a93ad41172215aecfb4b6d869");
	});

	it("prefers the mcp-remote version directory that already holds the login", async () => {
		const base = mkdtempSync(join(tmpdir(), "phi-mcp-auth-base-"));
		const previousBase = process.env[MCP_REMOTE_CONFIG_DIR_ENV_VAR];
		const previousOverride = process.env[MCP_AUTH_DIR_ENV_VAR];
		delete process.env[MCP_AUTH_DIR_ENV_VAR];
		process.env[MCP_REMOTE_CONFIG_DIR_ENV_VAR] = base;
		try {
			const url = "https://example.test/mcp";
			mkdirSync(join(base, "mcp-remote-0.1.30"), { recursive: true });
			mkdirSync(join(base, "mcp-remote-0.1.37"), { recursive: true });
			// Newest directory wins when nothing is cached anywhere.
			expect((await resolveCredentialPaths(url)).dir).toBe(join(base, "mcp-remote-0.1.37"));

			writeFileSync(
				join(base, "mcp-remote-0.1.30", `${serverKey(url)}_tokens.json`),
				JSON.stringify({ access_token: "old" }),
			);
			// An existing login is followed, so an old mcp-remote session still counts.
			expect((await resolveCredentialPaths(url)).dir).toBe(join(base, "mcp-remote-0.1.30"));
		} finally {
			if (previousBase === undefined) delete process.env[MCP_REMOTE_CONFIG_DIR_ENV_VAR];
			else process.env[MCP_REMOTE_CONFIG_DIR_ENV_VAR] = previousBase;
			if (previousOverride !== undefined) process.env[MCP_AUTH_DIR_ENV_VAR] = previousOverride;
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("writes credentials 0600 into a 0700 directory and tolerates unreadable ones", async () => {
		const nested = join(authDir, "fresh");
		const store = new CredentialStore(credentialPaths(nested, serverKey("https://example.test/mcp")));
		await store.writeTokens({ access_token: "a", refresh_token: "r", expires_at: 42 });
		await store.writeClientInfo({ client_id: "c", client_secret: "s" });

		expect(statSync(nested).mode & 0o777).toBe(0o700);
		expect(statSync(store.paths.tokens).mode & 0o777).toBe(0o600);
		expect(statSync(store.paths.clientInfo).mode & 0o777).toBe(0o600);
		expect((await store.readTokens())?.access_token).toBe("a");
		expect((await store.readClientInfo())?.client_secret).toBe("s");

		writeFileSync(store.paths.tokens, "{ not json");
		expect(await store.readTokens()).toBeUndefined();
		await store.discardTokens();
		expect(await store.readTokens()).toBeUndefined();
	});
});

describe("MCP OAuth configuration", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "phi-mcp-oauth-config-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function parse(servers: Record<string, unknown>) {
		// 0600 keeps the loader's own permission warning out of the assertions.
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }), {
			encoding: "utf8",
			mode: 0o600,
		});
		return loadBridgeConfig(agentDir);
	}

	function oauthAuth(config: Awaited<ReturnType<typeof parse>>, name: string) {
		const entry = config.servers.find((server) => server.name === name)?.config;
		if (entry?.type !== "http" || entry.auth.mode !== "oauth") throw new Error(`${name} is not an OAuth HTTP server`);
		return entry.auth;
	}

	it("defaults HTTP servers to OAuth and opts out for a configured Authorization header", async () => {
		const config = await parse({
			plain: { type: "http", url: "https://plain.test/mcp" },
			static: { type: "http", url: "https://static.test/mcp", headers: { authorization: "Bearer x" } },
			stdio: { command: "echo", args: ["hi"] },
		});
		const byName = new Map(config.servers.map((entry) => [entry.name, entry.config]));
		// `browser` is deliberately left unset here; see the run-mode test below.
		expect(byName.get("plain")).toMatchObject({ auth: { mode: "oauth" } });
		expect(byName.get("static")).toMatchObject({ auth: { mode: "none" } });
		expect(byName.get("stdio")?.type).toBe("stdio");
		expect(config.warnings).toEqual([]);
	});

	it("accepts the shorthand, the object form, and warns on anything else", async () => {
		const config = await parse({
			off: { type: "http", url: "https://a.test/mcp", auth: "none" },
			on: { type: "http", url: "https://b.test/mcp", auth: "oauth" },
			detailed: {
				type: "http",
				url: "https://c.test/mcp",
				auth: {
					clientId: "abc",
					clientSecret: "shh",
					scope: "read",
					authorizationServer: "https://issuer.test",
					browser: false,
				},
			},
			bogus: { type: "http", url: "https://d.test/mcp", auth: "magic" },
		});
		const byName = new Map(config.servers.map((entry) => [entry.name, entry.config]));
		expect(byName.get("off")).toMatchObject({ auth: { mode: "none" } });
		expect(byName.get("on")).toMatchObject({ auth: { mode: "oauth" } });
		expect(byName.get("detailed")).toMatchObject({
			auth: {
				mode: "oauth",
				clientId: "abc",
				clientSecret: "shh",
				scope: "read",
				authorizationServer: "https://issuer.test",
				browser: false,
			},
		});
		expect(byName.get("bogus")).toMatchObject({ auth: { mode: "oauth" } });
		expect(config.warnings.join(" ")).toMatch(/"auth" is "magic"/);
	});

	it("defaults session interactivity to false so a missed wire-up cannot open a browser", () => {
		// `main.ts` sets this from the resolved app mode. If that call is ever lost,
		// the safe direction is refusing the browser, not opening one in a headless run.
		expect(isSessionInteractive()).toBe(false);
		try {
			setSessionInteractive(true);
			expect(isSessionInteractive()).toBe(true);
		} finally {
			setSessionInteractive(false);
		}
	});

	it("leaves auth.browser unset unless configured, so the run mode decides", async () => {
		const config = await parse({
			plain: { type: "http", url: "https://plain.test/mcp" },
			word: { type: "http", url: "https://word.test/mcp", auth: "oauth" },
			flag: { type: "http", url: "https://flag.test/mcp", auth: true },
			pinned: { type: "http", url: "https://pinned.test/mcp", auth: { browser: false } },
			forced: { type: "http", url: "https://forced.test/mcp", auth: { interactive: true } },
		});
		const auth = (name: string) => {
			const entry = config.servers.find((server) => server.name === name)?.config;
			if (entry?.type !== "http" || entry.auth.mode !== "oauth")
				throw new Error(`${name} is not an OAuth HTTP server`);
			return entry.auth;
		};
		// Every spelling that means "OAuth, no further opinion" must leave `browser`
		// unset: materialising `true` here is what made a headless run open a browser
		// nobody could answer and then hold the callback port until it timed out.
		expect(auth("plain").browser).toBeUndefined();
		expect(auth("word").browser).toBeUndefined();
		expect(auth("flag").browser).toBeUndefined();
		// An explicit setting still wins outright, in either spelling and direction.
		expect(auth("pinned").browser).toBe(false);
		expect(auth("forced").browser).toBe(true);
	});

	it("applies the browser-auth precedence matrix", async () => {
		const config = await parse({ plain: { type: "http", url: "https://plain.test/mcp" } });
		const plain = config.servers[0]?.config;
		if (plain?.type !== "http") throw new Error("plain is not an HTTP server");
		const host: McpOAuthHostIntegration = {
			prepareCallback: vi.fn(),
			presentAuthorization: vi.fn(),
			close: vi.fn(),
		};

		expect(oauthAuthorizerOptions("plain", plain, undefined)?.interactive).toBe(false);
		setSessionInteractive(true);
		expect(oauthAuthorizerOptions("plain", plain, undefined)?.interactive).toBe(true);
		setSessionInteractive(false);
		expect(oauthAuthorizerOptions("plain", plain, { oauthHost: host })?.interactive).toBe(true);

		const display = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
		try {
			process.env.DISPLAY = ":0";
			for (const value of ["1", "true", "TRUE", "yes", "YES"]) {
				process.env[MCP_BROWSER_AUTH_ENV_VAR] = value;
				expect(mcpBrowserAuthAllowed()).toBe(true);
				expect(oauthAuthorizerOptions("plain", plain, undefined)?.interactive).toBe(true);
			}
			process.env[MCP_BROWSER_AUTH_ENV_VAR] = "on";
			expect(mcpBrowserAuthAllowed()).toBe(false);

			// A desktop host's server on a headless Linux box (P3 on a VM) sets the
			// opt-in too, but xdg-open has no display there: nobody could finish a login.
			process.env[MCP_BROWSER_AUTH_ENV_VAR] = "1";
			delete process.env.DISPLAY;
			delete process.env.WAYLAND_DISPLAY;
			const canShow = process.platform === "darwin" || process.platform === "win32";
			expect(mcpBrowserAuthAllowed()).toBe(canShow);
			expect(oauthAuthorizerOptions("plain", plain, undefined)?.interactive).toBe(canShow);
		} finally {
			for (const [key, value] of Object.entries(display)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}

		const vetoed = { ...plain, auth: { ...plain.auth, browser: false } };
		setSessionInteractive(true);
		process.env[MCP_BROWSER_AUTH_ENV_VAR] = "1";
		expect(oauthAuthorizerOptions("plain", vetoed, { oauthHost: host })?.interactive).toBe(false);
	});

	it("keeps the MCP network timeout separate from human OAuth consent", async () => {
		const config = await parse({
			plain: {
				type: "http",
				url: "https://plain.test/mcp",
				timeoutMs: 15_000,
				auth: { browserTimeoutMs: 30 * 60_000 },
			},
		});
		const plain = config.servers[0]?.config;
		if (plain?.type !== "http") throw new Error("plain is not an HTTP server");
		expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(15_000);
		expect(plain.timeoutMs).toBe(15_000);
		expect(oauthAuthorizerOptions("plain", plain, undefined)).toMatchObject({
			browserTimeoutMs: 30 * 60_000,
		});
	});

	it("leaves the OAuth wait timeouts unset unless configured", async () => {
		const config = await parse({
			plain: { type: "http", url: "https://plain.test/mcp" },
			detailed: { type: "http", url: "https://detailed.test/mcp", auth: { scope: "read" } },
			bogus: { type: "http", url: "https://bogus.test/mcp", auth: { browserTimeoutMs: 0, lockWaitTimeoutMs: -1 } },
		});
		const auth = (name: string) => oauthAuth(config, name);
		// Undefined is load-bearing: it keeps flow.ts's thirty-minute browser default
		// and lock.ts's five-minute wait default when nobody configured anything.
		expect(auth("plain").browserTimeoutMs).toBeUndefined();
		expect(auth("plain").lockWaitTimeoutMs).toBeUndefined();
		expect(auth("detailed").browserTimeoutMs).toBeUndefined();
		expect(auth("detailed").lockWaitTimeoutMs).toBeUndefined();
		// A non-positive wait would expire before it started, so it warns and defaults.
		expect(auth("bogus").browserTimeoutMs).toBeUndefined();
		expect(auth("bogus").lockWaitTimeoutMs).toBeUndefined();
		expect(config.warnings.join(" ")).toMatch(/"auth.browserTimeoutMs" is 0/);
		expect(config.warnings.join(" ")).toMatch(/"auth.lockWaitTimeoutMs" is -1/);
	});

	it("reads the OAuth wait timeouts and forwards them to the authorizer", async () => {
		const config = await parse({
			zip: {
				type: "http",
				url: "https://zip.test/mcp",
				auth: { browserTimeoutMs: 30_000, lockWaitTimeoutMs: 30_000 },
			},
			snake: {
				type: "http",
				url: "https://snake.test/mcp",
				auth: { browser_timeout_ms: 1_000, lock_wait_timeout_ms: 2_000 },
			},
		});
		expect(oauthAuth(config, "zip")).toMatchObject({ browserTimeoutMs: 30_000, lockWaitTimeoutMs: 30_000 });
		expect(oauthAuth(config, "snake")).toMatchObject({ browserTimeoutMs: 1_000, lockWaitTimeoutMs: 2_000 });
		expect(config.warnings).toEqual([]);

		// The point of the config keys: they must reach the provider options that
		// bound the lock wait and the browser flow.
		const zip = config.servers.find((server) => server.name === "zip")?.config;
		if (zip?.type !== "http") throw new Error("zip is not an HTTP server");
		expect(oauthAuthorizerOptions("zip", zip, undefined)).toMatchObject({
			browserTimeoutMs: 30_000,
			lockWaitTimeoutMs: 30_000,
		});

		const plain = await parse({ plain: { type: "http", url: "https://plain.test/mcp" } });
		const plainConfig = plain.servers[0]?.config;
		if (plainConfig?.type !== "http") throw new Error("plain is not an HTTP server");
		const options = oauthAuthorizerOptions("plain", plainConfig, undefined);
		expect(options?.browserTimeoutMs).toBeUndefined();
		expect(options?.lockWaitTimeoutMs).toBeUndefined();
	});

	it("keeps client secrets out of the cache fingerprint but keeps the client identity", () => {
		const fingerprint = (auth: Record<string, unknown>): string =>
			serverConfigFingerprint("demo", { type: "http", url: "https://c.test/mcp", auth });
		// Rotating a secret must not invalidate a cached catalogue...
		expect(fingerprint({ clientId: "abc", clientSecret: "shh" })).toBe(
			fingerprint({ clientId: "abc", clientSecret: "rotated" }),
		);
		// ...but pointing at a different client, or turning OAuth off, must.
		expect(fingerprint({ clientId: "abc" })).not.toBe(fingerprint({ clientId: "xyz" }));
		expect(fingerprint({ clientId: "abc" })).not.toBe(
			serverConfigFingerprint("demo", { type: "http", url: "https://c.test/mcp", auth: "none" }),
		);
	});
});
