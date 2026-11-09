/**
 * OAuth policy for one HTTP MCP server: which credential to send, and what to do
 * when the server rejects it.
 *
 * The order matters more than any single step. A session that is already
 * authorized sends a cached access token and does nothing else. A session whose
 * token has expired renews it with the stored refresh token — one POST, no
 * browser, no listening socket, which is the property that lets fifteen phi
 * sessions share one login. Only when there is no usable refresh token does the
 * browser flow run, and then exactly one process runs it while the others wait
 * for the tokens it writes.
 *
 * Nothing here logs a token, a code, or a verifier: the only values that reach a
 * message are endpoints, standard OAuth error codes, and file paths.
 */

import { openBrowser } from "../../../utils/open-browser.ts";
import type { RequestOptions } from "../protocol.ts";
import { fingerprint, type OAuthAuditEvent, recordOAuthEvent, safeUrl } from "./audit.ts";
import type { Discovery, WwwAuthenticateChallenge } from "./discovery.ts";
import { discoverAuthorizationServer, parseWwwAuthenticate } from "./discovery.ts";
import { refreshTokens, runAuthorizationCodeFlow } from "./flow.ts";
import type { McpOAuthHostIntegration } from "./host.ts";
import { isCredentialRejection, OAuthError } from "./http.ts";
import { acquireLoginLock } from "./lock.ts";
import { CredentialStore, type OAuthClientInfo, type OAuthTokens } from "./store.ts";

/** Renew slightly early so a request does not race its own token expiry. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * How long to wait for a peer's refresh before doing it anyway. A refresh is one
 * POST, so this only has to cover a slow round trip — not a human at a browser.
 */
export const DEFAULT_REFRESH_LOCK_WAIT_MS = 20_000;

/** Either a peer's tokens were adopted, or this session may refresh, holding the lock. */
type RefreshSlot = { kind: "adopted" } | { kind: "proceed"; release?: () => Promise<void> };

/**
 * RFC 6750 says the `Bearer` auth scheme is matched case-insensitively, but real
 * resource servers disagree: platform-ops issues `"token_type": "bearer"` and
 * then rejects `Authorization: bearer <token>` with 401 while accepting
 * `Bearer`. Echoing the server's own spelling back at it is therefore not safe,
 * so normalize the one scheme we understand and pass anything else through
 * untouched (a DPoP or Basic token_type must not be rewritten to Bearer).
 */
function authScheme(tokenType: string | undefined): string {
	if (!tokenType) return "Bearer";
	return tokenType.toLowerCase() === "bearer" ? "Bearer" : tokenType;
}

export interface OAuthAuthorizerOptions {
	serverUrl: string;
	serverName: string;
	/** Overrides the scope from a registered client or from server metadata. */
	scope?: string;
	/** A pre-registered client, for servers without dynamic registration. */
	clientId?: string;
	clientSecret?: string;
	/** Skip discovery and use this authorization server (issuer or metadata URL). */
	authorizationServer?: string;
	/** False in headless use: refresh silently, never open a browser. */
	interactive: boolean;
	notice?: (message: string, level: "info" | "warning") => void;
	/** Injection points for tests; production uses the platform browser and `~/.mcp-auth`. */
	openBrowser?: (url: string) => void;
	/** Per-session remote callback/browser host; absent keeps local browser behaviour. */
	host?: McpOAuthHostIntegration;
	store?: CredentialStore;
	browserTimeoutMs?: number;
	lockPollIntervalMs?: number;
	lockWaitTimeoutMs?: number;
	/** Wait for a peer's silent refresh before refreshing anyway. */
	refreshLockWaitMs?: number;
	now?: () => number;
}

/** What the HTTP transport needs from OAuth, and nothing more. */
export interface McpAuthorizer {
	/** Header value for the next request, or undefined when nothing is cached yet. */
	authorization(options: RequestOptions): Promise<string | undefined>;
	/** Recover from a 401. True when a new credential is available and the request should be retried. */
	handleUnauthorized(challengeHeader: string | undefined, options: RequestOptions): Promise<boolean>;
	/** Why the last recovery failed, for the transport's error message. */
	describeFailure(): string | undefined;
}

export function createOAuthAuthorizer(options: OAuthAuthorizerOptions): McpAuthorizer {
	return new OAuthAuthorizer(options);
}

class OAuthAuthorizer implements McpAuthorizer {
	private readonly options: OAuthAuthorizerOptions;
	private readonly now: () => number;
	private storePromise: Promise<CredentialStore> | undefined;
	private tokensPromise: Promise<OAuthTokens | undefined> | undefined;
	private tokens: OAuthTokens | undefined;
	private discovery: Discovery | undefined;
	private client: OAuthClientInfo | undefined;
	private recovery: Promise<boolean> | undefined;
	private recoveryInteractive = false;
	private sentAccessToken: string | undefined;
	/** Resolved lazily with the store, so an event can name the file it read. */
	private auditPaths: { key: string; dir: string } | undefined;
	/** Access tokens the server has already rejected, so a re-read cannot readopt them. */
	private readonly rejected = new Set<string>();
	private failure: string | undefined;

	constructor(options: OAuthAuthorizerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	async authorization(options: RequestOptions): Promise<string | undefined> {
		let tokens = await this.cachedTokens();
		if (tokens && this.isExpired(tokens)) {
			this.audit({ event: "token.expired", ...this.tokenFacts(tokens) });
			// A stored absolute expiry is our own addition, so this is only an
			// optimization: it saves the 401 round trip, and a failure here is not
			// interesting because the 401 path handles it properly.
			await this.recover(undefined, options, "expired").catch(() => undefined);
			tokens = this.tokens;
		}
		if (!tokens) return undefined;
		if (tokens.access_token !== this.sentAccessToken) {
			// Only on change: one line per request would bury the transitions that matter.
			this.audit({ event: "token.sent", ...this.tokenFacts(tokens) });
		}
		this.sentAccessToken = tokens.access_token;
		return `${authScheme(tokens.token_type)} ${tokens.access_token}`;
	}

	handleUnauthorized(challengeHeader: string | undefined, options: RequestOptions): Promise<boolean> {
		// The server refused the token we just sent. Recording its fingerprint is what
		// makes a cross-process rotation race legible after the fact.
		this.audit({ event: "unauthorized", accessToken: fingerprint(this.sentAccessToken) });
		return this.recover(parseWwwAuthenticate(challengeHeader), options, "unauthorized");
	}

	describeFailure(): string | undefined {
		return this.failure;
	}

	/**
	 * One recovery at a time: concurrent tool calls must not start two logins. A
	 * silent renewal already in flight is awaited first — if it succeeds there is
	 * nothing left to do — but it never suppresses a login the 401 path needs.
	 */
	private recover(
		challenge: WwwAuthenticateChallenge | undefined,
		options: RequestOptions,
		mode: "expired" | "unauthorized",
	): Promise<boolean> {
		const allowInteractive = mode === "unauthorized" && this.options.interactive;
		const existing = this.recovery;
		if (existing && (this.recoveryInteractive || !allowInteractive)) return existing;

		const attempt = (async (): Promise<boolean> => {
			if (existing && (await existing.catch(() => false))) return true;
			return this.runRecovery(challenge, options, mode, allowInteractive);
		})().finally(() => {
			if (this.recovery === attempt) {
				this.recovery = undefined;
				this.recoveryInteractive = false;
			}
		});
		this.recovery = attempt;
		this.recoveryInteractive = allowInteractive;
		return attempt;
	}

	private async runRecovery(
		challenge: WwwAuthenticateChallenge | undefined,
		options: RequestOptions,
		mode: "expired" | "unauthorized",
		allowInteractive: boolean,
	): Promise<boolean> {
		this.failure = undefined;
		const store = await this.store();

		// Another session may have renewed while this request was in flight, in
		// which case there is nothing to do but pick its tokens up. It has to be a
		// live token that is not the one just refused, or this would loop.
		const stored = await store.readTokens();
		if (
			this.adopt(stored, {
				requireDifferentFrom: mode === "unauthorized" ? this.sentAccessToken : undefined,
				requireFresh: true,
			})
		) {
			this.audit({ event: "token.adopted", mode, ...this.tokenFacts(stored) });
			return true;
		}

		// The refresh token may only exist on disk, when a token this session never
		// held was written by another one.
		const refreshToken = this.tokens?.refresh_token ?? (this.isUsable(stored) ? stored.refresh_token : undefined);
		// Nothing to refresh and nobody to sign in: fail before discovery, the login
		// lock, or a callback socket, so a headless session answers at once.
		if (!refreshToken && !allowInteractive) {
			this.failure = this.loginRequired();
			return false;
		}

		let discovery: Discovery;
		try {
			discovery = await this.ensureDiscovery(challenge, options);
		} catch (error) {
			this.failure = describeOAuthFailure(error);
			return false;
		}

		const client = this.client ?? (await this.ensureClient(store));
		if (refreshToken && client) {
			// A rotating server deletes the old refresh token the moment one process
			// uses it, so two processes refreshing at once means the loser presents a
			// token that no longer exists and is told its login is dead. Serialize on
			// the same cross-process lock the browser flow uses: one refresh, everyone
			// else adopts its result.
			const slot = await this.refreshUnderLock(store, mode);
			if (slot.kind === "adopted") return true;

			// Inside the `try`: this runs with the refresh lock held, so anything that
			// throws before the `finally` would strand it for the rest of the process.
			try {
				this.audit({ event: "refresh.start", mode, refreshToken: fingerprint(refreshToken) });
				const renewed = await refreshTokens(discovery.metadata, client, refreshToken, discovery.resource, options);
				await this.persistTokens(store, renewed);
				this.audit({
					event: "refresh.ok",
					mode,
					refreshToken: fingerprint(refreshToken),
					newRefreshToken: fingerprint(renewed.refresh_token),
					// A rotating server invalidates the token every other process still holds.
					rotated: renewed.refresh_token !== undefined && renewed.refresh_token !== refreshToken,
					...this.tokenFacts(renewed),
				});
				this.options.notice?.(`mcp: ${this.options.serverName} OAuth token renewed.`, "info");
				return true;
			} catch (error) {
				this.failure = describeOAuthFailure(error);
				this.audit({
					event: "refresh.failed",
					mode,
					refreshToken: fingerprint(refreshToken),
					...failureFacts(error),
				});
				if (!isCredentialRejection(error)) return false;

				// "Rejected" does not always mean "dead". On a rotating server it also
				// means another process got there first, in which case the store now
				// holds a *working* credential that this session must not delete.
				// It must also differ from the access token the server just refused:
				// a peer that rotated only the refresh token leaves the dead bearer in
				// place, and re-adopting it would retry straight back into the 401.
				const replacement = await store.readTokens();
				if (
					replacement?.refresh_token !== refreshToken &&
					this.adopt(replacement, {
						requireDifferentFrom: mode === "unauthorized" ? this.sentAccessToken : undefined,
						requireFresh: true,
					})
				) {
					this.audit({ event: "token.adopted", mode, detail: "after-rejection", ...this.tokenFacts(replacement) });
					return true;
				}
				// Nothing newer on disk: the refresh token really is dead for every
				// session, so drop it rather than making each new one pay for the
				// same rejection.
				await this.discardTokens(store);
			} finally {
				await slot.release?.();
			}
		}

		if (!allowInteractive) {
			// A rejected refresh token lands here too; its remedy is the same sign-in.
			this.failure = this.loginRequired();
			return false;
		}
		return this.login(store, discovery, options);
	}

	/**
	 * The reason is either an explicit `auth.browser: false` or a headless run;
	 * both have the same remedy, so name that instead of guessing which it was.
	 * A login from a terminal is stored and then refreshes silently here too.
	 */
	private loginRequired(): string {
		const name = this.options.serverName;
		return `MCP server "${name}" needs a sign-in and this session cannot open a browser: run \`phi mcp login ${name}\` in a terminal`;
	}

	/**
	 * Hold the cross-process lock for the duration of one refresh, or adopt the
	 * tokens whoever holds it produces.
	 *
	 * Unlike the login path this never gives up on the session: a lock held by a
	 * slow or wedged peer degrades to refreshing anyway (the old behaviour), which
	 * is at worst one wasted round trip. Blocking a tool call on somebody else's
	 * lock would be a worse failure than the race it prevents.
	 */
	private async refreshUnderLock(store: CredentialStore, mode: string): Promise<RefreshSlot> {
		const current = this.tokens?.access_token;
		const acquisition = await acquireLoginLock(store.paths, {
			hasTokens: async () => {
				const tokens = await store.readTokens();
				// Only a *different* and still-live token ends the wait; re-reading the
				// one we already hold would exit into the same failure.
				return this.isUsable(tokens) && tokens.access_token !== current && !this.isExpired(tokens);
			},
			pollIntervalMs: this.options.lockPollIntervalMs,
			waitTimeoutMs: this.options.refreshLockWaitMs ?? DEFAULT_REFRESH_LOCK_WAIT_MS,
			now: this.now,
		});

		if (acquisition.kind === "tokens") {
			const tokens = await store.readTokens();
			if (this.adopt(tokens, { requireDifferentFrom: current, requireFresh: true })) {
				this.audit({ event: "token.adopted", mode, detail: "peer-refresh", ...this.tokenFacts(tokens) });
				return { kind: "adopted" };
			}
			return { kind: "proceed" };
		}
		if (acquisition.kind === "timeout") {
			this.audit({ event: "login.timeout", mode, detail: "refresh-lock" });
			return { kind: "proceed" };
		}

		// We hold the lock. Re-read once: the winner may have landed between the
		// last check and the acquisition.
		// Anything that throws between here and the caller's `finally` would strand
		// the lock: this process would keep treating an abandoned holder as live for
		// the rest of its run, and every peer would wait out the timeout.
		try {
			const tokens = await store.readTokens().catch(() => undefined);
			if (this.adopt(tokens, { requireDifferentFrom: current, requireFresh: true })) {
				this.audit({ event: "token.adopted", mode, detail: "peer-refresh", ...this.tokenFacts(tokens) });
				await acquisition.holder.release().catch(() => undefined);
				return { kind: "adopted" };
			}
		} catch (error) {
			await acquisition.holder.release().catch(() => undefined);
			throw error;
		}
		// The lock stays held until the refresh has landed on disk; releasing it here
		// would serialize nothing.
		return { kind: "proceed", release: () => acquisition.holder.release().catch(() => undefined) };
	}

	/**
	 * Run the browser flow, but only if we win the cross-process lock. Everyone
	 * else waits for the winner's tokens, which is what keeps fifteen concurrent
	 * sessions down to one browser tab.
	 */
	private async login(store: CredentialStore, discovery: Discovery, options: RequestOptions): Promise<boolean> {
		const acquisition = await acquireLoginLock(store.paths, {
			hasTokens: async () => this.isUsable(await store.readTokens()),
			signal: options.signal,
			pollIntervalMs: this.options.lockPollIntervalMs,
			waitTimeoutMs: this.options.lockWaitTimeoutMs,
			now: this.now,
		});

		if (acquisition.kind === "tokens") {
			const adopted = await store.readTokens();
			if (this.adopt(adopted, {})) {
				this.audit({ event: "login.adopted", ...this.tokenFacts(adopted) });
				this.options.notice?.(
					`mcp: ${this.options.serverName} reused an OAuth login from another phi session.`,
					"info",
				);
				return true;
			}
			this.failure = `${this.options.serverName} OAuth login completed elsewhere but produced no usable token.`;
			return false;
		}
		if (acquisition.kind === "timeout") {
			this.audit({ event: "login.timeout" });
			this.failure = `${this.options.serverName} is waiting for an OAuth login another phi session started; retry with /reload once it finishes.`;
			return false;
		}

		// Inside the `try` for the same reason as the refresh lock above: the login
		// lock is held from here, and a throw before the `finally` would keep every
		// other session waiting on a holder nobody owns.
		try {
			this.audit({ event: "login.start" });
			// The winner may have finished between the last check and the lock.
			if (this.adopt(await store.readTokens(), {})) return true;

			const result = await runAuthorizationCodeFlow({
				metadata: discovery.metadata,
				client: this.client,
				// An explicit scope wins, then what the protected resource advertises, then
				// the authorization server's own list (applied inside the flow).
				scope: this.options.scope ?? discovery.scopes?.join(" "),
				resource: discovery.resource,
				serverName: this.options.serverName,
				openBrowser: this.options.openBrowser ?? openBrowser,
				host: this.options.host,
				notice: this.options.notice,
				onCallbackPort: (port) => acquisition.holder.publishPort(port),
				signal: options.signal,
				timeoutMs: this.options.browserTimeoutMs,
			});
			this.client = result.client;
			await store.writeClientInfo(result.client).catch(() => undefined);
			await this.persistTokens(store, result.tokens);
			this.audit({
				event: "login.ok",
				refreshToken: fingerprint(result.tokens.refresh_token),
				...this.tokenFacts(result.tokens),
			});
			this.options.notice?.(`mcp: ${this.options.serverName} OAuth login complete.`, "info");
			return true;
		} catch (error) {
			this.failure = describeOAuthFailure(error);
			this.audit({ event: "login.failed", ...failureFacts(error) });
			return false;
		} finally {
			await acquisition.holder.release();
		}
	}

	private async ensureDiscovery(
		challenge: WwwAuthenticateChallenge | undefined,
		options: RequestOptions,
	): Promise<Discovery> {
		if (this.discovery) return this.discovery;
		const discovery = await discoverAuthorizationServer(
			{
				serverUrl: this.options.serverUrl,
				challenge,
				authorizationServer: this.options.authorizationServer,
			},
			options,
		);
		this.discovery = discovery;
		return discovery;
	}

	private async ensureClient(store: CredentialStore): Promise<OAuthClientInfo | undefined> {
		if (this.options.clientId) {
			this.client = {
				client_id: this.options.clientId,
				client_secret: this.options.clientSecret,
				scope: this.options.scope,
			};
			return this.client;
		}
		this.client = await store.readClientInfo();
		return this.client;
	}

	private store(): Promise<CredentialStore> {
		if (this.options.store) {
			this.noteStore(this.options.store);
			return Promise.resolve(this.options.store);
		}
		this.storePromise =
			this.storePromise ??
			CredentialStore.open(this.options.serverUrl).then((store) => {
				this.noteStore(store);
				return store;
			});
		return this.storePromise;
	}

	/** Which directory a login resolved to is itself a recurring bug source, so name it on every event. */
	private noteStore(store: CredentialStore): void {
		// The store key is an MD5 of the server URL, and a URL can carry a bearer in
		// its path, so it is fingerprinted like any other credential-derived value.
		// Its diagnostic job — telling whether two processes resolved to the same
		// credential file — survives intact, because the fingerprint is stable.
		this.auditPaths = { key: fingerprint(store.paths.key) ?? "unknown", dir: store.paths.dir };
	}

	/** Expiry and identity of a token, with no part of the token itself. */
	private tokenFacts(tokens: OAuthTokens | undefined): Partial<OAuthAuditEvent> {
		if (!tokens) return {};
		return {
			accessToken: fingerprint(tokens.access_token),
			expiresIn: tokens.expires_in,
			expiresAt: isoTime(tokens.expires_at),
		};
	}

	private audit(event: Omit<OAuthAuditEvent, "server">): void {
		recordOAuthEvent({
			server: this.options.serverName,
			serverUrl: safeUrl(this.options.serverUrl),
			...this.auditPaths,
			...event,
		});
	}

	private async cachedTokens(): Promise<OAuthTokens | undefined> {
		if (this.tokens) return this.tokens;
		if (!this.tokensPromise) {
			this.tokensPromise = this.store().then((store) => store.readTokens());
		}
		const tokens = await this.tokensPromise;
		if (!this.tokens && this.isUsable(tokens)) this.tokens = tokens;
		return this.tokens;
	}

	private async persistTokens(store: CredentialStore, tokens: OAuthTokens): Promise<void> {
		this.tokens = tokens;
		this.rejected.delete(tokens.access_token);
		this.failure = undefined;
		// A cache write failure costs a re-login later; it must not fail the session.
		await store.writeTokens(tokens).catch(() => {
			this.options.notice?.(`mcp: ${this.options.serverName} OAuth tokens could not be cached.`, "warning");
		});
	}

	private async discardTokens(store: CredentialStore): Promise<void> {
		const dead = this.tokens?.access_token;
		this.audit({ event: "tokens.discarded", accessToken: fingerprint(dead) });
		if (this.tokens) this.rejected.add(this.tokens.access_token);
		this.tokens = undefined;
		this.tokensPromise = Promise.resolve(undefined);
		// Compare-and-delete: a peer — or an older phi that does not take the refresh
		// lock — may have written working tokens since this session read them, and
		// those are precisely the ones worth keeping.
		await store.discardTokens(dead);
	}

	/** Take tokens found on disk when they are usable and not the ones just refused. */
	private adopt(
		tokens: OAuthTokens | undefined,
		constraints: { requireDifferentFrom?: string; requireFresh?: boolean },
	): boolean {
		if (!this.isUsable(tokens)) return false;
		if (constraints.requireDifferentFrom && tokens.access_token === constraints.requireDifferentFrom) return false;
		if (constraints.requireFresh && this.isExpired(tokens)) return false;
		this.tokens = tokens;
		this.tokensPromise = Promise.resolve(tokens);
		this.failure = undefined;
		return true;
	}

	private isUsable(tokens: OAuthTokens | undefined): tokens is OAuthTokens {
		if (!tokens?.access_token) return false;
		return !this.rejected.has(tokens.access_token);
	}

	private isExpired(tokens: OAuthTokens): boolean {
		return tokens.expires_at !== undefined && this.now() >= tokens.expires_at - EXPIRY_SKEW_MS;
	}
}

function describeOAuthFailure(error: unknown): string {
	return error instanceof OAuthError ? error.message : "OAuth recovery failed.";
}

/** A hand-edited or hostile `expires_at` must not throw inside a diagnostic. */
function isoTime(epochMs: number | undefined): string | undefined {
	if (epochMs === undefined) return undefined;
	const date = new Date(epochMs);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Only the allowlisted OAuth code and HTTP status: an error message can quote a server body. */
function failureFacts(error: unknown): Partial<OAuthAuditEvent> {
	if (!(error instanceof OAuthError)) return { detail: "non-oauth-error" };
	return { errorCode: error.code, status: error.status };
}

export { OAuthError };
