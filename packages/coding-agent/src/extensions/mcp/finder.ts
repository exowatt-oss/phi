import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "../../core/extensions/types.ts";
import { effectiveToolMode } from "./config.ts";
import type { FinderCatalogEntry, McpFinderRuntime } from "./runtime.ts";

export const FINDER_TOOL_NAME = "mcp_find_tools";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
const NAME_MATCH_SCORE = 3;
const DESCRIPTION_MATCH_SCORE = 1;

interface Scored {
	entry: FinderCatalogEntry;
	score: number;
}

export function registerToolFinder(pi: ExtensionAPI, runtime: McpFinderRuntime): void {
	pi.registerTool(finderToolDefinition(pi, runtime));
}

/** The finder's definition, for registering it in the same batch as a catalogue. */
export function finderToolDefinition(pi: ExtensionAPI, runtime: McpFinderRuntime): ToolDefinition<any, any, any> {
	return defineTool({
		name: FINDER_TOOL_NAME,
		label: "Find MCP Tools",
		description: [
			"Search the catalogue of MCP server tools that are connected but not yet loaded, and load the matches so you can call them.",
			`Not loaded yet: ${runtime.describeInventory()}.`,
			"Query with the capability you need — a few words for the action you want ('list datasources', 'create an issue', 'query metrics') — or with an exact tool name you already know.",
			"The matching tools become callable immediately — call the tool it returns on your next step.",
		].join(" "),
		promptSnippet: "Load MCP server tools on demand — they are not loaded until you search for them",
		promptGuidelines: [
			`MCP tools are not in your tool list until you load them. When a task needs one, call ${FINDER_TOOL_NAME} with the capability you want, then call the tool it loads.`,
			`If you know an MCP tool's exact name but cannot call it, pass that name to ${FINDER_TOOL_NAME} to load it.`,
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Capability, keywords, or an exact tool name. Matched against tool names and descriptions.",
			}),
			server: Type.Optional(Type.String({ description: "Restrict the search to one server by its bridge name." })),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_LIMIT,
					description: `Maximum tools to load. Default ${DEFAULT_LIMIT}.`,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const limit = clampLimit(params.limit);
			const wanted = params.server?.toLowerCase();
			// A failed server stays failed for the session (until /mcp reconnect): a
			// search neither retries its handshake nor offers its cached tools.
			const failed = () => runtime.getServers().filter((entry) => entry.status === "failed");
			const usable = () => {
				const down = new Set(failed().map((entry) => entry.serverName));
				return runtime.getCatalogEntries().filter((entry) => !down.has(entry.serverName));
			};
			let catalog = usable();

			if (wanted) {
				const server = runtime.getServers().find((entry) => entry.serverName.toLowerCase() === wanted);
				if (!server) {
					return text(
						`No bridged server named "${params.server}". Connected: ${runtime.describeInventory()}.`,
						params.query,
					);
				}
				if (server.status !== "failed") await runtime.ensureServer(server.serverName).catch(() => undefined);
				catalog = usable().filter((entry) => entry.serverName.toLowerCase() === wanted);
			} else if (rank(catalog, params.query).length === 0) {
				// A cached/ready catalogue already answers a match immediately. Only
				// force the remaining handshakes when it cannot answer this query.
				const pending = runtime
					.getServers()
					.filter((entry) => entry.status !== "ready" && entry.status !== "closed" && entry.status !== "failed");
				await Promise.all(pending.map((entry) => runtime.ensureServer(entry.serverName).catch(() => undefined)));
				catalog = usable();
			}

			const ranked = rank(catalog, params.query);
			if (ranked.length === 0) {
				const down = failed()
					.filter((entry) => !wanted || entry.serverName.toLowerCase() === wanted)
					.map((entry) => `\n  ${entry.serverName}: ${entry.error ?? "unavailable"}`);
				return text(
					`No MCP tool matched "${params.query}". Not loaded yet: ${runtime.describeInventory()}. Try broader or different words.` +
						(down.length > 0 ? `\nUnavailable this session:${down.join("")}` : ""),
					params.query,
				);
			}

			const chosen = ranked.slice(0, limit).map((match) => match.entry);
			const instructions = firstLoadInstructions(runtime, chosen);
			const activeBefore = pi.getActiveTools();
			const added = chosen.map((entry) => entry.name).filter((name) => !activeBefore.includes(name));
			for (const entry of chosen) runtime.markToolLoaded(entry);
			const activeAfter = pi.getActiveTools();
			const missing = chosen.map((entry) => entry.name).filter((name) => !activeAfter.includes(name));
			if (missing.length > 0) pi.setActiveTools([...new Set([...activeAfter, ...missing])]);

			const lines = [added.length > 0 ? `Loaded ${added.length} tool(s):` : "Already loaded:"];
			for (const entry of chosen) lines.push(`  ${entry.name}`);
			const withheld = ranked.length - chosen.length;
			if (withheld > 0)
				lines.push(`(${withheld} weaker match(es) not loaded — refine the query or raise "limit" to see them.)`);
			lines.push("Call one of these directly now.");
			for (const { serverName, text: body } of instructions)
				lines.push("", `Instructions from ${serverName}:`, "", body);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { query: params.query, matches: chosen.map((entry) => entry.name), added },
			};
		},
	});
}

/**
 * A lazy server's instructions stay out of the system prompt, so they arrive
 * with the first tools loaded from it instead. The result stays in history, so
 * later loads from the same server do not repeat them. A lazy server with
 * `eagerTools` already has its instructions in the system prompt.
 */
function firstLoadInstructions(
	runtime: McpFinderRuntime,
	chosen: readonly FinderCatalogEntry[],
): Array<{ serverName: string; text: string }> {
	const out: Array<{ serverName: string; text: string }> = [];
	for (const serverName of new Set(chosen.filter((entry) => entry.toolMode === "lazy").map((e) => e.serverName))) {
		const server = runtime.getServers().find((entry) => entry.serverName === serverName);
		if (!server?.entry.injectInstructions) continue;
		const body = server.identity?.instructions?.trim();
		if (!body) continue;
		if (
			server.catalog.some(
				(tool) => server.isToolLoaded(tool.name) || effectiveToolMode(server.entry, tool.name) === "eager",
			)
		)
			continue;
		out.push({ serverName, text: body });
	}
	return out;
}

function text(body: string, query: string) {
	return { content: [{ type: "text" as const, text: body }], details: { query, matches: [], added: [] } };
}

function clampLimit(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested)));
}

function rank(catalog: FinderCatalogEntry[], query: string): Scored[] {
	const trimmed = query.trim().toLowerCase();
	const exact = catalog.find((entry) => entry.name.toLowerCase() === trimmed);
	if (exact) return [{ entry: exact, score: Number.POSITIVE_INFINITY }];
	const terms = [...new Set(trimmed.split(/[^a-z0-9]+/).filter(Boolean))];
	if (terms.length === 0) return [];
	const scored: Scored[] = [];
	for (const entry of catalog) {
		const haystackName = `${entry.name} ${entry.serverName}`.toLowerCase();
		const haystackText = entry.description.toLowerCase();
		let score = 0;
		for (const term of terms) {
			if (haystackName.includes(term)) score += NAME_MATCH_SCORE;
			else if (haystackText.includes(term)) score += DESCRIPTION_MATCH_SCORE;
		}
		if (score > 0) scored.push({ entry, score });
	}
	return scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
}
