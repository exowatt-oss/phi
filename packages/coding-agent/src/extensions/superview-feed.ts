import type { AgentSession } from "../core/agent-session.ts";
import { agentSessionRegistry } from "../core/agent-session-registry.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { type SafeActivity, sanitizeSafeActivity } from "./feads-agent/presence-publisher.ts";
import { feadsSessionState } from "./feads-agent/session-state.ts";
import { isNestedSubagent } from "./subagents/index.ts";
import { getHostIdentity } from "./superview-host-identity.ts";
import { SuperviewTransport } from "./superview-transport.ts";
import { workspaceStateStore } from "./workspace-state/state.ts";

function preview(value: unknown): string | undefined {
	try {
		const text = JSON.stringify(value);
		return text.length > 240 ? `${text.slice(0, 237)}...` : text;
	} catch {
		return undefined;
	}
}

type AgentStatus = "working" | "idle" | "done" | "failed" | "aborted" | "unknown";

/** First line of the child's first user prompt; embedded sessions rarely carry a name. */
function firstUserLine(session: AgentSession): string | undefined {
	for (const message of session.messages) {
		if (message.role !== "user") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content.find((part): part is { type: "text"; text: string } => part.type === "text")?.text;
		const line = text
			?.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0);
		if (!line) return undefined;
		return line.length > 60 ? `${line.slice(0, 57)}...` : line;
	}
	return undefined;
}

export default function superviewFeedExtension(pi: ExtensionAPI): void {
	// The parent-side publisher is authoritative for child rows and preserves lineage.
	if (isNestedSubagent()) return;

	let host: ReturnType<typeof getHostIdentity>;
	try {
		host = getHostIdentity();
	} catch {
		host = undefined;
	}
	let transport: SuperviewTransport | undefined;
	let lastStatus: AgentStatus = "idle";
	let sessionId = "unknown";
	let startedAt = 0;
	let turns = 0;
	let input = 0;
	let output = 0;
	let costUsd = 0;
	let activity: { tool?: string; argsPreview?: string } = {};
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let model: string | undefined;

	// In-process child sessions (workflow runners, embedded subagents). They load no
	// extensions of their own and spawn no `phi` child, so the parent feed is the
	// only place that can publish them. Keyed by the child's session id.
	const children = new Map<string, (publishEnd?: boolean) => void>();

	const disposeSessionResources = (): void => {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
		transport?.dispose();
		transport = undefined;
	};

	const trackChild = (child: AgentSession): void => {
		const childId = child.sessionId;
		if (children.has(childId)) return;
		let name: string | undefined;
		let childTurns = 0;
		let childInput = 0;
		let childOutput = 0;
		let childCost = 0;
		let childActivity: { tool?: string; argsPreview?: string } = {};
		let lastStop: string | undefined;
		const childStartedAt = Date.now();
		const publishChild = (event: string, next: AgentStatus, safeActivity?: SafeActivity) => {
			name ??= child.sessionManager.getSessionName() ?? firstUserLine(child);
			const usage = child.getContextUsage();
			transport?.publish({
				v: 1,
				event,
				ts: Date.now(),
				agent: {
					agentKey: childId,
					runId: childId,
					displayName: name ?? "embedded agent",
					kind: "subagent",
					pid: process.pid,
					parentAgentKey: sessionId,
					parentSessionId: sessionId,
					sessionId: childId,
					model: child.model?.id,
					status: next,
					activity: childActivity,
					...(safeActivity ? { safeActivity } : {}),
					turns: childTurns,
					tokens: { input: childInput, output: childOutput },
					costUsd: childCost,
					ctxPct: usage?.tokens && usage.contextWindow ? (usage.tokens / usage.contextWindow) * 100 : 0,
					...(host ? { host } : {}),
					startedAt: childStartedAt,
					...(event === "subagent_end" ? { endedAt: Date.now() } : {}),
					lastSeenAt: Date.now(),
					source: "socket",
				},
			});
		};
		const unsubscribe = child.subscribe((event) => {
			switch (event.type) {
				case "agent_start":
					publishChild("subagent_update", "working", "thinking");
					return;
				case "tool_execution_start":
					childActivity = { tool: event.toolName, argsPreview: preview(event.args) };
					publishChild(
						"subagent_update",
						"working",
						sanitizeSafeActivity({ kind: "tool", name: event.toolName }) ?? "thinking",
					);
					return;
				case "tool_execution_end":
					childActivity = {};
					publishChild("subagent_update", "working", "thinking");
					return;
				case "message_end":
					if (event.message.role === "assistant") {
						childTurns++;
						childInput += event.message.usage.input;
						childOutput += event.message.usage.output;
						childCost += event.message.usage.cost.total;
						lastStop = event.message.stopReason;
						publishChild("subagent_update", "working", "thinking");
					}
					return;
				case "agent_end":
					publishChild("subagent_update", "idle");
					return;
				default:
					return;
			}
		});
		children.set(childId, (publishEnd = true) => {
			unsubscribe();
			children.delete(childId);
			if (!publishEnd) return;
			const terminal: AgentStatus = lastStop === "error" ? "failed" : lastStop === "aborted" ? "aborted" : "done";
			publishChild("subagent_end", terminal, "done");
		});
	};

	const untrackCreated = agentSessionRegistry.onCreated((child) => {
		// The current main session never lands here: a replacement main is registered
		// before its session_start, which then drops it from `children`.
		if (child.sessionId === sessionId) return;
		trackChild(child);
	});
	const untrackDisposed = agentSessionRegistry.onDisposed((child) => children.get(child.sessionId)?.());

	const agent = (ctx: ExtensionContext, status: AgentStatus, safeActivity?: SafeActivity) => ({
		agentKey: sessionId,
		runId: process.env.PI_SUBAGENT_ID,
		handle: process.env.PI_SUBAGENT_HANDLE,
		displayName: ctx.sessionManager.getSessionName() ?? process.env.PI_SUBAGENT_NAME ?? "main",
		kind: process.env.PI_SUBAGENT_ID ? "subagent" : "main",
		pid: process.pid,
		parentAgentKey: undefined,
		sessionId,
		model,
		status,
		activity,
		...(safeActivity ? { safeActivity } : {}),
		turns,
		tokens: { input, output },
		costUsd,
		ctxPct: (() => {
			const usage = ctx.getContextUsage();
			return usage?.tokens && usage.contextWindow ? (usage.tokens / usage.contextWindow) * 100 : 0;
		})(),
		// workspace-state contract v1: the agent's own end state and the decision it is waiting
		// on, camelCase per Forca's TS types. Both are absent while no record applies — the store
		// is cleared at agent_start — so a consumer reads presence as "this is current".
		...(() => {
			const record = workspaceStateStore.current;
			if (!record) return {};
			return { endState: record.end_state, ...(record.question ? { question: record.question } : {}) };
		})(),
		cwd: ctx.cwd,
		...(host ? { host } : {}),
		startedAt,
		lastSeenAt: Date.now(),
		source: "socket",
	});
	const publish = (ctx: ExtensionContext, event: string, status: AgentStatus, safeActivity?: SafeActivity) => {
		lastStatus = status;
		transport?.publish({ v: 1, event, ts: Date.now(), agent: agent(ctx, status, safeActivity) });
	};

	pi.on("session_start", (event, ctx) => {
		disposeSessionResources();
		sessionId = ctx.sessionManager.getSessionId();
		// A replacement main session (/new, resume, fork) registers before this fires.
		children.get(sessionId)?.(false);
		feadsSessionState.ensureSession(sessionId, event);
		startedAt = Date.now();
		model = ctx.model?.id;
		transport = new SuperviewTransport({ parentSessionId: sessionId });
		publish(ctx, "agent_register", "idle", "starting");
		heartbeat = setInterval(
			() =>
				transport?.publish({ v: 1, event: "heartbeat", ts: Date.now(), agents: [sessionId, ...children.keys()] }),
			30_000,
		);
	});
	pi.on("agent_start", (_event, ctx) => publish(ctx, "subagent_update", "working", "thinking"));
	pi.on("agent_settled", (_event, ctx) => publish(ctx, "subagent_update", "idle"));
	pi.on("tool_execution_start", (event, ctx) => {
		activity = { tool: event.toolName, argsPreview: preview(event.args) };
		publish(
			ctx,
			"subagent_update",
			"working",
			sanitizeSafeActivity({ kind: "tool", name: event.toolName }) ?? "thinking",
		);
	});
	pi.on("tool_execution_end", (_event, ctx) => {
		activity = {};
		publish(ctx, "subagent_update", "working", "thinking");
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") {
			turns++;
			input += event.message.usage.input;
			output += event.message.usage.output;
			costUsd += event.message.usage.cost.total;
			publish(ctx, "subagent_update", "working", "thinking");
		}
	});
	pi.on("model_select", (event, ctx) => {
		model = event.model.id;
		publish(ctx, "subagent_update", "idle");
	});
	// A rename must reach the feed immediately; republish with the last real status so a mid-turn auto-name can't flip a working row to idle.
	pi.on("session_info_changed", (_event, ctx) => publish(ctx, "subagent_update", lastStatus));
	pi.on("session_shutdown", (_event, ctx) => {
		publish(ctx, "agent_end", "done", "done");
		untrackCreated();
		untrackDisposed();
		for (const release of [...children.values()]) release();
		disposeSessionResources();
	});
}
