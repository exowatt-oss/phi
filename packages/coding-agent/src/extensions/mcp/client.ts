/**
 * One connected MCP server: handshake, tool catalogue, tool invocation.
 *
 * `connectServer()` performs the whole `initialize` ->
 * `notifications/initialized` -> `tools/list` sequence, so a caller that gets a
 * client back knows the server is reachable and has already named its tools.
 */

import { isSessionInteractive } from "../../config.ts";
import { type HttpServerConfig, mcpBrowserAuthAllowed, type ServerConfig } from "./config.ts";
import { createHttpTransport } from "./http-transport.ts";
import type { McpOAuthHostIntegration } from "./oauth/host.ts";
import { createOAuthAuthorizer, type McpAuthorizer, type OAuthAuthorizerOptions } from "./oauth/provider.ts";
import {
	CLIENT_INFO,
	MCP_FALLBACK_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
	type McpCallResult,
	McpError,
	type McpServerIdentity,
	type McpToolInfo,
	type McpTransport,
	parseCallToolResult,
	parseInitializeResult,
	parseToolsListResult,
} from "./protocol.ts";
import { createStdioTransport } from "./stdio-transport.ts";

/** Bound so one unlucky server cannot stall phi startup or a tool call forever. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** tools/list is paginated; stop after this many pages rather than loop on a broken cursor. */
const MAX_TOOL_PAGES = 20;

export interface McpClient {
	readonly serverName: string;
	readonly endpoint: string;
	readonly identity: McpServerIdentity;
	readonly tools: McpToolInfo[];
	callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
	close(): Promise<void>;
}

export interface ConnectHooks {
	/** Progress a user needs to see, such as an OAuth login opening a browser. */
	notice?: (message: string, level: "info" | "warning") => void;
	/** Prompt the human for MCP form-mode elicitation; absent means cancel immediately. */
	elicit?: (params: Record<string, unknown>) => Promise<unknown>;
	/** Host integration scoped to this MCP manager/session, never process-global. */
	oauthHost?: McpOAuthHostIntegration;
}

export async function connectServer(
	serverName: string,
	config: ServerConfig,
	signal?: AbortSignal,
	hooks?: ConnectHooks,
): Promise<McpClient> {
	const transport = createTransport(serverName, config, hooks);
	const connectTimeoutMs = config.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const callTimeoutMs = config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
	transport.setRequestHandler(async (method, params) => {
		if (method !== "elicitation/create") throw new McpError(`Unsupported server request: ${method}`, -32601);
		if (!hooks?.elicit) {
			hooks?.notice?.("An MCP server requested input, but no interactive UI is available.", "warning");
			return { action: "cancel" };
		}
		return hooks.elicit(params);
	});

	try {
		const identity = await initialize(transport, { signal, timeoutMs: connectTimeoutMs });
		transport.setProtocolVersion?.(identity.protocolVersion);
		await transport.notify("notifications/initialized", {}, { signal, timeoutMs: connectTimeoutMs });
		const tools = await listTools(transport, { signal, timeoutMs: connectTimeoutMs });

		return {
			serverName,
			endpoint: transport.endpoint,
			identity,
			tools,
			async callTool(toolName, args, callSignal) {
				const result = await transport.request(
					"tools/call",
					{ name: toolName, arguments: args },
					{ signal: callSignal, timeoutMs: callTimeoutMs },
				);
				return parseCallToolResult(result);
			},
			close: () => transport.close(),
		};
	} catch (error) {
		await transport.close().catch(() => {});
		throw error;
	}
}

function createTransport(serverName: string, config: ServerConfig, hooks: ConnectHooks | undefined): McpTransport {
	if (config.type === "http") {
		return createHttpTransport({
			url: config.url,
			headers: config.headers,
			authorizer: createAuthorizer(serverName, config, hooks),
		});
	}
	return createStdioTransport({
		command: config.command,
		args: config.args,
		env: config.env,
		cwd: config.cwd,
	});
}

/**
 * An authorizer is constructed eagerly but does nothing until a request needs a
 * credential: it reads no file and makes no request while the server is happy
 * with what it is given, so an unauthenticated or statically authenticated server
 * pays nothing for it.
 */
function createAuthorizer(
	serverName: string,
	config: HttpServerConfig,
	hooks: ConnectHooks | undefined,
): McpAuthorizer | undefined {
	const options = oauthAuthorizerOptions(serverName, config, hooks);
	return options ? createOAuthAuthorizer(options) : undefined;
}

/** Split out from `createAuthorizer` so the config-to-OAuth wiring is assertable. */
export function oauthAuthorizerOptions(
	serverName: string,
	config: HttpServerConfig,
	hooks: ConnectHooks | undefined,
): OAuthAuthorizerOptions | undefined {
	if (config.auth.mode !== "oauth") return undefined;
	return {
		serverUrl: config.url,
		serverName,
		scope: config.auth.scope,
		clientId: config.auth.clientId,
		clientSecret: config.auth.clientSecret,
		authorizationServer: config.auth.authorizationServer,
		// An explicit `auth.browser` wins; otherwise the run mode decides. A host
		// can present the workstation browser for an otherwise headless SSH session.
		interactive:
			config.auth.browser ?? (isSessionInteractive() || hooks?.oauthHost !== undefined || mcpBrowserAuthAllowed()),
		// Undefined leaves the flow and lock modules on their own defaults.
		browserTimeoutMs: config.auth.browserTimeoutMs,
		lockWaitTimeoutMs: config.auth.lockWaitTimeoutMs,
		notice: hooks?.notice,
		host: hooks?.oauthHost,
	};
}

/**
 * Offer the current revision first. A server that refuses it outright gets one
 * retry at the previous revision; anything else is a real failure.
 */
async function initialize(
	transport: McpTransport,
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<McpServerIdentity> {
	const params = (protocolVersion: string): Record<string, unknown> => ({
		protocolVersion,
		capabilities: { elicitation: {} },
		clientInfo: CLIENT_INFO,
	});

	try {
		return parseInitializeResult(await transport.request("initialize", params(MCP_PROTOCOL_VERSION), options));
	} catch (error) {
		if (!isProtocolVersionRejection(error)) throw error;
		return parseInitializeResult(
			await transport.request("initialize", params(MCP_FALLBACK_PROTOCOL_VERSION), options),
		);
	}
}

function isProtocolVersionRejection(error: unknown): boolean {
	if (!(error instanceof McpError)) return false;
	// -32602 is "invalid params", which is what servers return for an unsupported revision.
	if (error.code === -32602) return true;
	return /protocol\s*version/i.test(error.message);
}

async function listTools(
	transport: McpTransport,
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<McpToolInfo[]> {
	const collected: McpToolInfo[] = [];
	let cursor: string | undefined;

	for (let page = 0; page < MAX_TOOL_PAGES; page++) {
		const params: Record<string, unknown> = cursor ? { cursor } : {};
		const { tools, nextCursor } = parseToolsListResult(await transport.request("tools/list", params, options));
		collected.push(...tools);
		if (!nextCursor || nextCursor === cursor) break;
		cursor = nextCursor;
	}

	return collected;
}
