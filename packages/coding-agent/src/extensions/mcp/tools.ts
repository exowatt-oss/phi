/** Projection of MCP catalogue entries onto phi tools. */

import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../../core/tools/truncate.ts";
import { effectiveToolMode } from "./config.ts";
import { errorMessage } from "./json.ts";
import type { McpCallResult, McpToolInfo } from "./protocol.ts";
import type { McpServerRuntime } from "./runtime.ts";

/** Comfortably inside every provider's function-name limit, including OpenAI's 64. */
const MAX_TOOL_NAME_LENGTH = 64;

export interface RegisteredTool {
	name: string;
	serverName: string;
	mcpName: string;
	toolMode: "lazy" | "eager";
	description: string;
}

/**
 * Names are assigned by the stable server/tool pair, not by connection arrival
 * order. This matters when background handshakes finish in a different order.
 */
export class ToolNameRegistry {
	private readonly assignments = new Map<string, string>();
	private readonly owners = new Map<string, string>();
	private ambiguousServers = new Set<string>();

	setServerNames(serverNames: readonly string[]): void {
		const counts = new Map<string, number>();
		for (const serverName of serverNames) {
			const normalized = sanitize(serverName);
			counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
		}
		this.ambiguousServers = new Set(
			[...counts.entries()].filter(([, count]) => count > 1).map(([serverName]) => serverName),
		);
	}

	allocate(serverName: string, toolName: string, usedNames: Set<string>): string {
		const key = `${serverName}\u0000${toolName}`;
		const existing = this.assignments.get(key);
		if (existing) return existing;

		const base = clampName(`mcp_${sanitize(serverName)}_${sanitize(toolName)}`);
		const ambiguous = this.ambiguousServers.has(sanitize(serverName));
		const preferred = ambiguous ? clampName(base, `_${shortHash(key)}`) : base;
		const owner = this.owners.get(preferred);
		if (!owner && !usedNames.has(preferred)) {
			this.assignments.set(key, preferred);
			this.owners.set(preferred, key);
			return preferred;
		}
		if (owner === key) return preferred;

		let suffix = `_${shortHash(key)}`;
		let candidate = clampName(base, suffix);
		let counter = 2;
		while (usedNames.has(candidate) || this.owners.has(candidate)) {
			suffix = `_${shortHash(key)}_${counter++}`;
			candidate = clampName(base, suffix);
		}
		this.assignments.set(key, candidate);
		this.owners.set(candidate, key);
		return candidate;
	}
}

export function describeTool(serverName: string, tool: McpToolInfo): string {
	return `[${serverName}] ${tool.description ?? `MCP tool "${tool.name}".`}`;
}

/**
 * Project a server catalogue onto pi tool definitions. The caller registers every
 * server's definitions with one `registerTools` call: a registration refreshes the
 * whole tool registry, so per-tool registration of a large catalogue is quadratic
 * and blocks the event loop for seconds.
 */
export function buildServerTools(
	host: McpServerRuntime,
	catalog: readonly McpToolInfo[],
	usedNames: Set<string>,
	nameRegistry: ToolNameRegistry,
	definitions: ToolDefinition<any, any, any>[],
): RegisteredTool[] {
	const tools: RegisteredTool[] = [];
	for (const tool of catalog) {
		const name = nameRegistry.allocate(host.serverName, tool.name, usedNames);
		usedNames.add(name);
		const registered: RegisteredTool = {
			name,
			serverName: host.serverName,
			mcpName: tool.name,
			toolMode: effectiveToolMode(host.entry, tool.name),
			description: describeTool(host.serverName, tool),
		};
		tools.push(registered);
		definitions.push(toolDefinition(host, tool, registered));
	}
	return tools;
}

function toolDefinition(host: McpServerRuntime, tool: McpToolInfo, registered: RegisteredTool): ToolDefinition {
	return {
		name: registered.name,
		label: tool.title ?? `${host.serverName}: ${tool.name}`,
		description: registered.description,
		autoActivateOnCall: () => registered.toolMode === "eager" || host.isToolLoaded(tool.name),
		parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
		async execute(_toolCallId, params, signal) {
			host.markToolLoaded(tool.name);
			let result: McpCallResult;
			try {
				const client = await host.ensureConnection(signal);
				result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, signal);
			} catch (error) {
				if (isCatalogInvalidatingError(error)) {
					// Do not replace the useful original tool error with a refresh failure.
					await host.refreshCatalog().catch(() => undefined);
				}
				throw new Error(`MCP call ${host.serverName}/${tool.name} failed: ${errorMessage(error)}`);
			}

			const body = [result.text, ...result.notes].filter((part) => part.length > 0).join("\n");
			if (result.isError) {
				if (isCatalogInvalidatingText(body)) await host.refreshCatalog().catch(() => undefined);
				throw new Error(`${host.serverName}/${tool.name} returned an error: ${body || "no detail provided"}`);
			}

			const truncation = truncateHead(body, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let text = truncation.content || "(the tool returned no content)";
			if (truncation.truncated) {
				text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Narrow the arguments to see the rest.]`;
			}
			return {
				content: [{ type: "text", text }],
				details: {
					server: host.serverName,
					tool: tool.name,
					notes: result.notes,
					truncated: truncation.truncated,
				},
			};
		},
	};
}

function isCatalogInvalidatingError(error: unknown): boolean {
	const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
	if (code === -32601 || code === -32602) return true;
	return isCatalogInvalidatingText(errorMessage(error));
}

function isCatalogInvalidatingText(text: string): boolean {
	return /(?:unknown|undefined|not found|invalid|does not exist).{0,40}(?:tool|schema|argument)|(?:tool|schema|argument).{0,40}(?:unknown|undefined|not found|invalid|does not exist)/i.test(
		text,
	);
}

function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

function clampName(base: string, suffix = ""): string {
	const budget = MAX_TOOL_NAME_LENGTH - suffix.length;
	if (base.length <= budget) return `${base}${suffix}`;
	const hash = shortHash(base);
	return `${base.slice(0, budget - hash.length - 1)}_${hash}${suffix}`;
}

function shortHash(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 6);
}
