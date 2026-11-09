import type { McpClient } from "./client.ts";
import type { ServerConfig, ServerEntry } from "./config.ts";
import { errorMessage } from "./json.ts";
import { OAuthError } from "./oauth/http.ts";
import { McpError, type McpServerIdentity, type McpToolInfo } from "./protocol.ts";

export type ServerConnectionStatus = "idle" | "cached" | "connecting" | "ready" | "failed" | "closed";

/** The narrow surface shared by proxy tools and the finder. */
export interface McpServerRuntime {
	readonly entry: ServerEntry;
	readonly serverName: string;
	readonly status: ServerConnectionStatus;
	readonly catalog: readonly McpToolInfo[];
	readonly identity: McpServerIdentity | undefined;
	readonly error: string | undefined;
	ensureConnection(signal?: AbortSignal): Promise<McpClient>;
	refreshCatalog(): Promise<void>;
	isToolLoaded(mcpName: string): boolean;
	markToolLoaded(mcpName: string): void;
}

export interface McpFinderRuntime {
	getServers(): readonly McpServerRuntime[];
	getCatalogEntries(): readonly FinderCatalogEntry[];
	ensureServer(serverName: string): Promise<McpServerRuntime>;
	markToolLoaded(entry: FinderCatalogEntry): void;
	describeInventory(): string;
}

export interface FinderCatalogEntry {
	name: string;
	serverName: string;
	mcpName: string;
	toolMode: "lazy" | "eager";
	description: string;
}

/** Keep transport/server failures useful without exposing transport details. */
export function safeMcpError(error: unknown, config?: ServerConfig): string {
	if (config?.type === "http" && config.auth.mode === "oauth" && !(error instanceof OAuthError)) {
		// The OAuth transport builds a 401 from the status and the authorizer's own
		// local reason (such as "needs a sign-in"), never from server text.
		if (error instanceof McpError && error.code === 401) return error.message;
		return "MCP OAuth request failed.";
	}
	let message = errorMessage(error);
	if (config?.type === "http") {
		message = message.split(config.url).join("[endpoint]");
		const authValues =
			config.auth.mode === "oauth"
				? [
						config.auth.mode,
						config.auth.scope,
						config.auth.clientId,
						config.auth.clientSecret,
						config.auth.authorizationServer,
					]
				: [config.auth.mode];
		for (const value of [...(config.headers ? Object.values(config.headers) : []), ...authValues].filter(
			(value): value is string => !!value,
		)) {
			message = message.split(value).join("[redacted]");
		}
	} else if (config?.type === "stdio") {
		for (const value of [
			config.command,
			...(config.args ?? []),
			config.cwd,
			...(config.env ? Object.values(config.env) : []),
		].filter((value): value is string => !!value)) {
			message = message.split(value).join("[stdio transport]");
		}
		message = message.replace(/\nstderr:\s*[\s\S]*/i, "");
	}
	return message
		.replace(/https?:\/\/[^\s'"]+/gi, "[endpoint]")
		.replace(/(Bearer|Basic)\s+[^\s]+/gi, "$1 [redacted]")
		.replace(
			/([?&](?:token|secret|password|key|authorization|state|code|code_verifier|code_challenge|client_secret|refresh_token|access_token|error_description|redirect_uri)=)[^&\s]+/gi,
			"$1[redacted]",
		)
		.replace(/(?:^|\s)(?:\/[^\s]+|[A-Za-z]:\\[^\s]+)/g, " [path]")
		.slice(0, 500);
}
