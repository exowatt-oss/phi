import { phaseForStatus, type SafeActivity, sanitizeSafeActivity } from "../feads-agent/presence-publisher.ts";
import { feadsSessionState } from "../feads-agent/session-state.ts";
import { SuperviewTransport } from "../superview-transport.ts";
import type { SubagentRunSnapshot } from "./types.ts";

export interface SubagentPublisherOptions {
	parentSessionId?: string;
	group?: string;
	model?: string;
	cwd: string;
}

const MAX_RECENT_TERMINAL_KEYS = 256;

function agentKeyForRun(run: SubagentRunSnapshot): string {
	return run.runId ?? run.id;
}

function isTerminalRun(run: SubagentRunSnapshot): boolean {
	return run.endedAt !== undefined || run.status === "done" || run.status === "failed" || run.status === "aborted";
}

function safeActivityForRun(
	run: SubagentRunSnapshot,
	status: "working" | "idle" | "done" | "failed" | "aborted" | "unknown",
): SafeActivity | undefined {
	const latest = run.timeline.at(-1);
	if (latest?.kind === "tool" && run.activity === latest.detail) {
		return sanitizeSafeActivity({ kind: "tool", name: latest.name });
	}
	return sanitizeSafeActivity(run.activity) ?? phaseForStatus(status);
}

export class SubagentStatusPublisher {
	private readonly transport: SuperviewTransport;
	private readonly options: SubagentPublisherOptions;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private latest = new Map<string, SubagentRunSnapshot>();
	private emitted = new Map<string, { fingerprint: string; event: "subagent_update" | "subagent_end" }>();
	private recentTerminalKeys = new Set<string>();

	constructor(options: SubagentPublisherOptions, transport?: SuperviewTransport) {
		this.options = options;
		feadsSessionState.ensureSession(options.parentSessionId ?? "unknown");
		this.transport = transport ?? new SuperviewTransport({ parentSessionId: options.parentSessionId });
		this.heartbeat = setInterval(() => this.publishHeartbeat(), 30_000);
	}

	update(runs: SubagentRunSnapshot[]): void {
		const keys = new Set<string>();
		for (const run of runs) {
			const key = agentKeyForRun(run);
			if (this.recentTerminalKeys.has(key)) continue;
			const terminal = isTerminalRun(run);
			this.latest.set(key, run);
			this.emitIfChanged(run, terminal ? "subagent_end" : "subagent_update");
			if (terminal) {
				this.releaseTerminal(key);
			} else {
				keys.add(key);
			}
		}
		if (keys.size > 0) this.transport.publish({ v: 1, event: "heartbeat", ts: Date.now(), agents: [...keys] });
	}

	complete(runs: SubagentRunSnapshot[]): void {
		for (const run of runs) {
			const key = agentKeyForRun(run);
			if (this.recentTerminalKeys.has(key)) continue;
			this.latest.set(key, run);
			this.emitIfChanged(run, "subagent_end");
			this.releaseTerminal(key);
		}
	}

	dispose(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		this.transport.dispose();
	}

	private publishHeartbeat(): void {
		this.transport.publish({ v: 1, event: "heartbeat", ts: Date.now(), agents: [...this.latest.keys()] });
	}

	private emitIfChanged(run: SubagentRunSnapshot, event: "subagent_update" | "subagent_end"): void {
		const key = agentKeyForRun(run);
		const fingerprint = JSON.stringify(run);
		const previous = this.emitted.get(key);
		if (previous?.fingerprint === fingerprint && previous.event === event) return;
		this.emitted.set(key, { fingerprint, event });
		this.emit(run, event);
	}

	private releaseTerminal(key: string): void {
		this.latest.delete(key);
		this.emitted.delete(key);
		this.recentTerminalKeys.delete(key);
		this.recentTerminalKeys.add(key);
		while (this.recentTerminalKeys.size > MAX_RECENT_TERMINAL_KEYS) {
			const oldest = this.recentTerminalKeys.values().next().value;
			if (oldest === undefined) break;
			this.recentTerminalKeys.delete(oldest);
		}
	}

	private emit(run: SubagentRunSnapshot, event: "subagent_update" | "subagent_end"): void {
		const status =
			run.status === "running"
				? "working"
				: run.status === "pending"
					? "working"
					: run.status === "done"
						? "done"
						: run.status === "failed"
							? "failed"
							: run.status === "aborted"
								? "aborted"
								: "unknown";
		const usage = run.usage;
		const safeActivity = safeActivityForRun(run, status);
		this.transport.publish({
			v: 1,
			event,
			ts: Date.now(),
			agent: {
				agentKey: agentKeyForRun(run),
				runId: run.runId,
				handle: run.handle ?? run.id,
				displayName: run.name,
				kind: "subagent",
				pid: run.pid,
				parentAgentKey: this.options.parentSessionId,
				parentSessionId: this.options.parentSessionId,
				group: this.options.group,
				sessionId: undefined,
				model: run.model ?? this.options.model,
				status,
				activity: { tool: run.activity },
				...(safeActivity ? { safeActivity } : {}),
				turns: usage.turns,
				tokens: { input: usage.input, output: usage.output },
				costUsd: usage.cost,
				ctxPct: run.contextWindow ? (usage.contextTokens / run.contextWindow) * 100 : 0,
				cwd: run.cwd ?? this.options.cwd,
				startedAt: run.startedAt,
				endedAt: run.endedAt,
				lastSeenAt: Date.now(),
				source: "socket",
			},
		});
	}
}
