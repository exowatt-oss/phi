import type { InlineExtension } from "../core/extensions/types.ts";
import agentMailExtension from "./agent-mail/index.ts";
import codemodeExtension from "./codemode/index.ts";
import contextBudgetExtension from "./context-budget/index.ts";
import feadsAgentExtension from "./feads-agent/index.ts";
import hubExtension from "./hub/index.ts";
import llamaExtension from "./llama/index.ts";
import loopExtension from "./loop/index.ts";
import mcpExtension from "./mcp/index.ts";
import memoryExtension from "./memory/index.ts";
import overseerExtension from "./overseer/index.ts";
import remoteExtension from "./remote/index.ts";
import stallGuardExtension from "./stall-guard/index.ts";
import subagentsExtension from "./subagents/index.ts";
import superviewFeedExtension from "./superview-feed.ts";
import toolSearchExtension from "./tool-search/index.ts";
import updaterExtension from "./updater/index.ts";
import workspaceStateExtension from "./workspace-state/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "feads-agent", factory: feadsAgentExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	// phi: the native MCP runtime (extensions/mcp) is phi's own; upstream's built-in MCP is not shipped.
	// Not replaceable: a user extension that aliases `/mcp` (e.g. the hub's agent-cli-compat bundle)
	// must not silently unload phi's MCP servers and tools, as upstream's replaceable rule would.
	{ name: "mcp", factory: mcpExtension, hidden: true, builtin: true },
	{ name: "hub", factory: hubExtension, hidden: true },
	{ name: "subagents", factory: subagentsExtension, hidden: true },
	{ name: "agent-mail", factory: agentMailExtension, hidden: true },
	{ name: "overseer", factory: overseerExtension, hidden: true },
	{ name: "stall-guard", factory: stallGuardExtension, hidden: true },
	{ name: "context-budget", factory: contextBudgetExtension, hidden: true },
	// Before superview-feed: handlers for one event run in registration order, so the emitter
	// has published the settle record by the time the feed builds its payload from it.
	{ name: "workspace-state", factory: workspaceStateExtension, hidden: true },
	{ name: "superview-feed", factory: superviewFeedExtension, hidden: true },
	// After the extensions above: a message_end replacement they make is what phi remote shows.
	{ name: "remote", factory: remoteExtension, hidden: true },
	{ name: "loop", factory: loopExtension, hidden: true },
	{ name: "updater", factory: updaterExtension, hidden: true },
	{ name: "memory", factory: memoryExtension, hidden: true },
];
