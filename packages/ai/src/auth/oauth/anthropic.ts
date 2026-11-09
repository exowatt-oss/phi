/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { OAuthTokenError } from "../errors.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
// Preferred so the port can be forwarded into containers or over SSH. Anthropic accepts any loopback port,
// so login falls back to a free port when this one cannot be bound (#10571).
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
/** Claude Code's manual flow: the browser lands on a page that shows `code#state` to paste back. */
const COPY_CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const ANTHROPIC_BROWSER_LOGIN_METHOD = "browser";
const ANTHROPIC_COPY_CODE_LOGIN_METHOD = "copy_code";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

type ParsedAuthorizationInput = { code?: string; state?: string; redirectUri: string };

function parseAuthorizationInput(input: string, localRedirectUri = REDIRECT_URI): ParsedAuthorizationInput {
	// Codes and URLs never contain whitespace; a URL copied out of a wrapped terminal line does.
	const value = input.replace(/\s+/g, "");
	if (!value) return { redirectUri: COPY_CODE_REDIRECT_URI };

	try {
		const url = new URL(value);
		const isLocalCallback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
			redirectUri: isLocalCallback ? localRedirectUri : COPY_CODE_REDIRECT_URI,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state, redirectUri: COPY_CODE_REDIRECT_URI };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
			redirectUri: COPY_CODE_REDIRECT_URI,
		};
	}

	return { code: value, redirectUri: COPY_CODE_REDIRECT_URI };
}

/** Token transport failures may carry response data in messages, stacks, or causes. */
function formatTokenRequestError(error: unknown): string {
	if (error instanceof OAuthTokenError) {
		const code = OAUTH_ERROR_CODES.has(error.oauthErrorCode) ? error.oauthErrorCode : "token_endpoint_error";
		const status = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : 0;
		return `OAuth token request failed. status=${status}; url=${TOKEN_URL}; error=${code}`;
	}
	if (error instanceof Error && ["AbortError", "TimeoutError", "TypeError"].includes(error.name)) {
		return `OAuth token endpoint request failed (${error.name})`;
	}
	return "OAuth token endpoint request failed";
}

const OAUTH_ERROR_CODES = new Set([
	"invalid_request",
	"invalid_client",
	"invalid_grant",
	"unauthorized_client",
	"unsupported_grant_type",
	"invalid_scope",
	"access_denied",
	"server_error",
	"temporarily_unavailable",
]);

async function postJson(url: string, body: Record<string, string | number>, signal: AbortSignal): Promise<string> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
		});
	} catch (error) {
		// A custom fetch may reject with a response, token body, or crafted Error.
		const kind =
			error instanceof Error && ["AbortError", "TimeoutError", "TypeError"].includes(error.name)
				? ` (${error.name})`
				: "";
		throw new Error(`OAuth token endpoint request failed${kind}. url=${url}`);
	}

	const responseBody = await response.text();

	if (!response.ok) {
		let oauthErrorCode = "token_endpoint_error";
		try {
			const parsed = JSON.parse(responseBody) as { error?: unknown };
			if (typeof parsed.error === "string" && OAUTH_ERROR_CODES.has(parsed.error)) {
				oauthErrorCode = parsed.error;
			}
		} catch {
			// The status and endpoint are enough; token response bodies are secret-bearing.
		}
		throw new OAuthTokenError(oauthErrorCode, response.status, url);
	}

	return responseBody;
}

type AnthropicTokenResponse = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope?: string;
};

function parseTokenResponse(responseBody: string, operation: "exchange" | "refresh"): AnthropicTokenResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(responseBody);
	} catch {
		// JSON.parse errors can include response bytes; never retain them as a cause.
		throw new Error(`Anthropic token ${operation} returned invalid JSON. url=${TOKEN_URL}`);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as Record<string, unknown>).access_token !== "string" ||
		!(parsed as Record<string, unknown>).access_token ||
		typeof (parsed as Record<string, unknown>).refresh_token !== "string" ||
		!(parsed as Record<string, unknown>).refresh_token ||
		typeof (parsed as Record<string, unknown>).expires_in !== "number" ||
		!Number.isFinite((parsed as Record<string, unknown>).expires_in) ||
		((parsed as Record<string, unknown>).expires_in as number) <= 0
	) {
		throw new Error(`Anthropic token ${operation} returned an invalid token response. url=${TOKEN_URL}`);
	}
	return parsed as AnthropicTokenResponse;
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				state,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			},
			signal,
		);
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatTokenRequestError(error)}`,
		);
	}

	const tokenData = parseTokenResponse(responseBody, "exchange");

	return {
		type: "oauth",
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

async function loginAnthropic(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const startCallbackServer = (port: number) =>
		startOAuthCallbackServer({
			providerName: "Anthropic",
			host: CALLBACK_HOST,
			port,
			path: CALLBACK_PATH,
			redirectHost: "localhost",
			state: verifier,
			complete: async (code) => code,
			signal: interaction.signal,
		});
	// The callback server only makes the same-machine browser path automatic. If the preferred port is
	// taken, a free loopback port is used; without any callback server, login continues with the pasted code.
	const callback = await startCallbackServer(CALLBACK_PORT)
		.catch(() => startCallbackServer(0))
		.catch(() => undefined);
	const localRedirectUri = callback?.redirectUri ?? REDIRECT_URI;

	const buildAuthUrl = (redirect: string) =>
		`${AUTHORIZE_URL}?${new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirect,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		}).toString()}`;

	try {
		const manualUrl = buildAuthUrl(COPY_CODE_REDIRECT_URI);
		interaction.notify({
			type: "auth_url",
			url: callback ? buildAuthUrl(localRedirectUri) : manualUrl,
			copyUrl: manualUrl,
			instructions: "Finish login in the browser. If it shows a code, paste it below.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Paste the authorization code here:",
			placeholder: "code#state",
		});
		let code: string | undefined;
		let state = verifier;
		let redirectUri = localRedirectUri;
		if (result.type === "callback") {
			// The callback server already checked `state` against the verifier.
			code = result.value;
		} else {
			const parsed = parseAuthorizationInput(result.input, localRedirectUri);
			if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			code = parsed.code;
			state = parsed.state ?? verifier;
			redirectUri = parsed.redirectUri;
		}

		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await exchangeAuthorizationCode(code, state, verifier, redirectUri, interaction.signal);
	} finally {
		callback?.close();
	}
}

async function loginAnthropicCopyCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: COPY_CODE_REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});
	const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;
	interaction.notify({
		type: "auth_url",
		url: authUrl,
		// phi: UIs that copy `copyUrl` (the TUI's "press c") get the same code-showing URL here.
		copyUrl: authUrl,
		instructions: "Complete login in your browser, then copy the code Anthropic shows and paste it here.",
	});

	const input = await interaction.prompt({
		type: "manual_code",
		message: "Paste the code Anthropic shows after you sign in:",
		placeholder: "code#state",
		signal: interaction.signal,
	});
	const parsed = parseAuthorizationInput(input);
	if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
	if (!parsed.code) throw new Error("Missing authorization code");
	interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
	return await exchangeAuthorizationCode(
		parsed.code,
		parsed.state ?? verifier,
		verifier,
		COPY_CODE_REDIRECT_URI,
		interaction.signal,
	);
}

/**
 * Refresh Anthropic OAuth token
 */
async function refreshAnthropicToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			signal,
		);
	} catch (error) {
		if (error instanceof OAuthTokenError) throw error;
		throw new Error(
			`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatTokenRequestError(error)}`,
		);
	}

	const data = parseTokenResponse(responseBody, "refresh");

	return {
		type: "oauth",
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const anthropicOAuth: OAuthAuth = {
	name: "Anthropic (Claude Pro/Max)",
	isSubscription: true,

	async login(interaction) {
		const method = await interaction.prompt({
			type: "select",
			message: "Select Anthropic login method:",
			options: [
				{ id: ANTHROPIC_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
				{ id: ANTHROPIC_COPY_CODE_LOGIN_METHOD, label: "Copy code login (headless)" },
			],
		});

		if (method === ANTHROPIC_COPY_CODE_LOGIN_METHOD) {
			return loginAnthropicCopyCode(interaction);
		}
		if (method !== ANTHROPIC_BROWSER_LOGIN_METHOD) {
			throw new Error(`Unknown Anthropic login method: ${method}`);
		}

		return loginAnthropic(interaction);
	},

	refresh: (credential, signal) => refreshAnthropicToken(credential.refresh, signal),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
