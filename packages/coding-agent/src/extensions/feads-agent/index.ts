import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, SubagentSpawnEvent } from "../../core/extensions/types.ts";
import { loadBridgeConfig, type ServerManifestEntry } from "../mcp/config.ts";
import { resolveFeadsCredential } from "./credential.ts";
import {
	formatFeadsPresenceStatus,
	getFeadsPresenceStatus,
	setFeadsPresenceAlertListener,
} from "./presence-publisher.ts";
import { feadsSessionState, __testing as sessionStateTesting } from "./session-state.ts";
import { registerWorkspaceStateSink, __testing as sinkTesting } from "./workspace-state-sink.ts";

const DEFAULT_FEADS_URL = "http://127.0.0.1:8788";
const HEARTBEAT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 2_500;
const NO_FEADS_INPUT = /^\/(?:skill:)?no-feads(?:\s|$)/;
const MISSING_TOKEN_WARNING =
	"Feads Agentwatch can't see this session: no FEADS_AGENT_TOKEN in phi's environment or ~/.pi/agent/phi.env. Run /feads-status.";

/** Once per process: a /new or resume must not repeat the startup warning. */
let missingTokenWarned = false;

type Flare = { board_id: string; issue_id: string };

function feadsUrl(): string {
	return (process.env.FEADS_URL ?? DEFAULT_FEADS_URL).replace(/\/$/, "");
}

function request(url: string, init: RequestInit): void {
	void fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => undefined);
}

function issueValues(value: unknown, result: Set<string>): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) issueValues(item, result);
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		if (["issue_id", "target_issue", "mine"].includes(key) && typeof child === "string") {
			const match = child.match(/[a-z0-9._-]+-[a-z0-9]+$/i);
			if (match) result.add(match[0]);
		}
		issueValues(child, result);
	}
}

function flareFor(issueId: string, args: unknown): Flare {
	let board: string | undefined;
	if (args && typeof args === "object") {
		const candidate = (args as Record<string, unknown>).board;
		if (typeof candidate === "string") board = candidate;
	}
	board ??= process.env.FEADS_BOARD;
	board ??= issueId.split("-", 1)[0];
	return { board_id: board, issue_id: issueId };
}

function raise(token: string, flare: Flare): void {
	request(`${feadsUrl()}/api/flares`, {
		method: "PUT",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(flare),
	});
}

function drop(token: string, flare: Flare): void {
	request(`${feadsUrl()}/api/flares`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(flare),
	});
}

function delegate(event: SubagentSpawnEvent, token: string): void {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	void fetch(`${feadsUrl()}/api/agent/delegate`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ handle: event.handle, display_name: event.name }),
		signal: controller.signal,
	})
		.then((response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
		})
		.catch(() => {
			console.warn("[feads-agent] delegation failed");
		})
		.finally(() => clearTimeout(timeout));
}

/** A feads server is one named `feads` or one whose HTTP URL host contains `feads.`. */
function isFeadsServer(entry: ServerManifestEntry): boolean {
	if (!entry.enabled) return false;
	if (entry.name.toLowerCase() === "feads") return true;
	const config = entry.entry?.config;
	if (config?.type !== "http") return false;
	try {
		return new URL(config.url).hostname.toLowerCase().includes("feads.");
	} catch {
		return false;
	}
}

/** Effective MCP config, loaded the same way the mcp extension does (user + trusted project). */
async function hasFeadsMcpServer(ctx: ExtensionContext): Promise<boolean> {
	try {
		const config = await loadBridgeConfig(getAgentDir(), { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
		return config.manifest.some(isFeadsServer);
	} catch {
		return false;
	}
}

/** Warnings reach the TUI and RPC hosts (as a `notify` UI request); headless modes get stderr. */
function warn(ctx: ExtensionContext, message: string): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.error(message);
	} catch {
		// A stale ctx (session replaced) or a closed UI must never affect the session.
	}
}

async function warnIfTokenMissing(ctx: ExtensionContext): Promise<void> {
	if (missingTokenWarned || process.env.PI_SUBAGENT_ID || feadsSessionState.current.disabled) return;
	if (resolveFeadsCredential({ includeLegacy: true }).token) return;
	if (!(await hasFeadsMcpServer(ctx))) return;
	if (missingTokenWarned || feadsSessionState.current.disabled) return;
	missingTokenWarned = true;
	warn(ctx, MISSING_TOKEN_WARNING);
}

export default function feadsAgentExtension(pi: ExtensionAPI): void {
	// Delegation and flares stay canonical-only: FEADS_AGENT_TOKEN from the environment, else phi.env.
	const parentToken = resolveFeadsCredential({ includeLegacy: false }).token;
	let releaseAlertListener: (() => void) | undefined;
	const flares = new Map<string, Flare>();
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	const clear = (dropFlares: boolean) => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		if (dropFlares && parentToken && !feadsSessionState.current.disabled) {
			for (const flare of flares.values()) drop(parentToken, flare);
		}
		flares.clear();
	};
	const disable = () => {
		feadsSessionState.disable("command");
		clear(false);
	};

	pi.registerCommand("no-feads", {
		description: "Disable all Feads requests for this session",
		acceptsArgs: false,
		handler: async (_args, ctx) => {
			disable();
			ctx.ui.notify("Feads disabled for this session; subagents still launch normally.", "info");
		},
	});

	pi.registerCommand("feads-status", {
		description: "Show safe Feads Agentwatch runtime-presence status",
		acceptsArgs: false,
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatFeadsPresenceStatus(getFeadsPresenceStatus()), "info");
		},
	});

	pi.on("input", (event) => {
		if (!NO_FEADS_INPUT.test(event.text.trim())) return { action: "continue" };
		disable();
		// /skill:no-feads still expands and reaches the model; this hook only owns
		// deterministic runtime state. The built-in /no-feads command is handled first.
		return { action: "continue" };
	});

	pi.on("tool_call", (event) => {
		if (
			!feadsSessionState.current.disabled ||
			(!event.toolName.startsWith("mcp_feads_") && !event.toolName.startsWith("feads_"))
		) {
			return;
		}
		return { block: true, reason: "Feads is disabled for this session by /no-feads." };
	});

	if (parentToken) {
		pi.onSubagentSpawn((event) => {
			if (feadsSessionState.current.disabled) return {};
			// Fire the request and return before its first network settlement. A lease
			// cannot be injected without making process launch wait, so the child keeps
			// inherited identity if it uses Feads at all.
			delegate(event, parentToken);
			return {};
		});
	}

	pi.on("session_start", (event, ctx) => {
		feadsSessionState.startSession(ctx.sessionManager.getSessionId(), event);
		clear(false);
		releaseAlertListener?.();
		releaseAlertListener = undefined;
		// Nested subagents publish nothing themselves (the parent owns their rows) and must stay quiet.
		if (process.env.PI_SUBAGENT_ID) return;
		releaseAlertListener = setFeadsPresenceAlertListener((alert) => {
			if (!feadsSessionState.current.disabled) warn(ctx, alert.message);
		});
		// Fire and forget: the MCP config read must not delay session start.
		void warnIfTokenMissing(ctx).catch(() => undefined);
	});
	pi.on("session_shutdown", () => {
		releaseAlertListener?.();
		releaseAlertListener = undefined;
		clear(true);
	});

	// workspace-state contract v1 sink: awaiting-human goes to the epic as a comment plus
	// status `blocked`, restored on the next turn. Store-driven rather than `agent_settled`
	// driven, because this extension loads before the emitter and would otherwise read the
	// previous turn's record. Registered unconditionally so a tokenless reload displaces a
	// previous session's sink instead of leaving it live.
	registerWorkspaceStateSink(pi, { token: parentToken });

	if (!process.env.PI_SUBAGENT_ID || !parentToken) return;

	const touch = (args: unknown) => {
		if (feadsSessionState.current.disabled) return;
		const issues = new Set<string>();
		issueValues(args, issues);
		for (const issueId of issues) {
			const flare = flareFor(issueId, args);
			flares.set(`${flare.board_id}:${flare.issue_id}`, flare);
			raise(parentToken, flare);
		}
		if (flares.size > 0 && !heartbeat) {
			heartbeat = setInterval(() => {
				if (feadsSessionState.current.disabled) return;
				for (const flare of flares.values()) raise(parentToken, flare);
			}, HEARTBEAT_MS);
		}
	};

	pi.on("tool_execution_start", (event) => {
		if (event.toolName.startsWith("mcp_feads_") || event.toolName.startsWith("feads_")) touch(event.args);
	});
}

export const __testing = {
	delegate,
	issueValues,
	flareFor,
	sink: sinkTesting,
	NO_FEADS_ENV: sessionStateTesting.NO_FEADS_ENV,
	NO_FEADS_INPUT,
	MISSING_TOKEN_WARNING,
	isFeadsServer,
	resetMissingTokenWarning(): void {
		missingTokenWarned = false;
	},
};
