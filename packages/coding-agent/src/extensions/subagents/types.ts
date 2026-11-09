/**
 * Shared types for the built-in subagents extension.
 *
 * A "run" is one child phi process working one task. Everything the UI shows
 * (dashboard widget, footer status, transcript rendering, /subagents command)
 * is derived from `SubagentRunSnapshot`, which is also what gets persisted on
 * the tool result as `SubagentToolDetails` — so a resumed session renders the
 * same board a live one does.
 */

export type SubagentMode = "single" | "parallel" | "chain";

/** customType of the message that delivers background subagent results. */
export const SUBAGENT_RESULTS_MESSAGE_TYPE = "subagent-results";

/** A question/blocker delivered from a child without ending its run. */
export const SUBAGENT_MESSAGE_TYPE = "subagent_message";

export type SubagentMessageKind = "progress" | "question" | "blocker";

export interface SubagentReport {
	kind: SubagentMessageKind;
	message: string;
	at: number;
}

export interface SubagentPendingQuestion extends SubagentReport {
	kind: "question" | "blocker";
	toolCallId: string;
	timeoutSeconds: number;
}

export interface SubagentMessageDetails extends SubagentPendingQuestion {
	name: string;
	runId: string;
}

/** Custom message reminding the model, after a compaction, that background runs are still in flight. */
export const SUBAGENT_COMPACTION_NOTE_MESSAGE_TYPE = "subagent-compaction-note";

/**
 * Custom message carrying a watchdog note into the parent session. For a
 * background run it wakes the parent (followUp + triggerTurn) at most once per
 * run per condition: soft stall, over budget, killed. Recovery notices stay in
 * the TUI and never enter model context.
 */
export const SUBAGENT_STALL_NOTE_MESSAGE_TYPE = "subagent-stall-note";

/** Details persisted on stall-note messages. */
export interface SubagentStallNoteDetails {
	name: string;
	verdict: "soft-stall" | "over-budget" | "stall-kill" | "budget-kill" | "tool-runaway" | "hard-cap-kill";
	runId?: string;
}

/**
 * Custom message recording that background runs died with a previous phi
 * process before their results were delivered. Appended at session start when
 * a background launch receipt on the branch has no matching results message,
 * so the model re-launches instead of waiting for results that can never come.
 */
export const SUBAGENT_LOST_MESSAGE_TYPE = "subagent-lost";

export type AgentScope = "user" | "project" | "both";

export type SubagentStatus = "pending" | "running" | "done" | "failed" | "aborted";

/** Aggregated per-run usage, accumulated from the child's assistant messages. */
export interface SubagentUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Total cost in dollars. */
	cost: number;
	/** Context tokens of the child's last assistant message (its live context size). */
	contextTokens: number;
	turns: number;
	toolCalls: number;
}

/** A distilled transcript item: enough to see what the agent did, small enough to persist. */
export type SubagentTimelineItem =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; detail: string; isError?: boolean };

/** Safe diagnostics distilled from the child JSON event stream. */
export interface SubagentRecoveryMetadata {
	/** Number of same-model auto_retry_start events observed. */
	retryCount: number;
	/** True when at least one auto-retry ended successfully. */
	retryRecovered: boolean;
	/** Safe model transitions observed in error_fallback events. */
	fallbackTransitions: Array<{ from: string; to: string }>;
	/** The error-fallback chain restored a prior model. */
	fallbackRestored: boolean;
	/** The error-fallback chain had no usable model left. */
	fallbackExhausted: boolean;
}

export interface SubagentRunSnapshot {
	/** UUID-v7 identity for this run. */
	runId?: string;
	/** Stable friendly handle, e.g. "ws-a-x7k2". */
	handle?: string;
	/** OS process id of the child, once spawned. */
	pid?: number;
	/** Set when the child runs in its own systemd scope (see isolation.ts). */
	isolation?: {
		/** Transient unit name without the `.scope` suffix. */
		unit: string;
		/** Human summary of the ceiling, e.g. "MemoryMax=9.4 GiB, CPUQuota=8 CPUs". */
		summary: string;
	};
	/** Highest `memory.peak` observed for the child's cgroup while it ran. */
	memoryPeakBytes?: number;
	/** Kernel OOM kills recorded inside the child's cgroup (`memory.events oom_kill`). */
	oomKills?: number;
	/** Isolated child was SIGKILLed by something other than phi: the OOM killer at the ceiling, almost certainly. */
	suspectedOomKill?: boolean;
	/** Backwards-compatible row key alias for runId. */
	id: string;
	/** Display name: explicit task name, agent name, or model label. */
	name: string;
	/** Named agent used, if any. */
	agentName?: string;
	agentSource: "user" | "project" | "none";
	task: string;
	/** Resolved provider/modelId requested for the child (undefined = child default). */
	model?: string;
	/** Concrete provider/modelId named by the child response, when available. */
	servedModel?: string;
	/** Safe recovery diagnostics from auto-retry and provider-fallback events. */
	recovery?: SubagentRecoveryMetadata;
	/** Short display label, e.g. "example-medium:max" or "opus-4-5". */
	modelLabel?: string;
	thinkingLevel?: string;
	/** Context window of the resolved model, for ctx% display. */
	contextWindow?: number;
	cwd?: string;
	/** 1-based step number in chain mode. */
	step?: number;

	status: SubagentStatus;
	startedAt?: number;
	endedAt?: number;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	stderrTail?: string;
	/** Timestamp of the last parsed semantic child event (raw bytes do not count). */
	lastEventAt?: number;
	/** Timestamp of the first parsed event; used to show spawn grace in status/debugging. */
	firstParsedEventAt?: number;
	/** Soft watchdog flag: the child has been silent past the stall threshold. */
	stalled?: boolean;
	/** The default budget was exceeded while the child was still producing. */
	overBudget?: boolean;
	/** First over-budget notice and last 15-minute recheck timestamps. */
	overBudgetAt?: number;
	budgetLastCheckedAt?: number;
	/** Assistant text accumulated from message_update deltas before a killed turn. */
	inFlightText?: string;
	/** Set when the run was terminated by the watchdog, its budget, or a kill action. */
	killedBy?: "watchdog" | "budget" | "kill-action";
	/** Most recent child-to-parent report, including non-interrupting progress. */
	lastReport?: SubagentReport;
	/** Question currently awaiting an answer on the stdin control channel. */
	pendingQuestion?: SubagentPendingQuestion;
	/** Whether a child turn is in flight or the child is waiting for a new one/EOF. */
	turnState?: "mid-turn" | "idle-awaiting-close";
	/** Last successful parent control-channel write. */
	lastParentMessageAt?: number;

	usage: SubagentUsageTotals;
	/** One-line description of what the agent is doing right now (last tool call / phase). */
	activity?: string;
	timeline: SubagentTimelineItem[];
	/** Number of timeline items dropped to stay within the cap. */
	timelineDropped: number;
	/** The child's final assistant text (the run's deliverable). */
	finalText: string;
}

export interface SubagentToolDetails {
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	runs: SubagentRunSnapshot[];
	/**
	 * True when the tool call returned immediately (a launch receipt) and the
	 * results arrive later as a `subagent-results` custom message.
	 */
	background?: boolean;
}

/** Details persisted on the background results message. */
export interface SubagentResultsMessageDetails {
	mode: SubagentMode;
	/** Runs whose results this message carries (never one already delivered). */
	runs: SubagentRunSnapshot[];
	/**
	 * Set on per-run deliveries from a background parallel group while siblings
	 * are still running, and on the closing message of such a group.
	 */
	group?: { size: number; finished: number; stillRunning: string[]; deliveredEarlier?: string[] };
}

/** Details persisted on the lost-subagents recovery message. */
export interface SubagentLostMessageDetails {
	runIds: string[];
	names: string[];
}

export function newUsageTotals(): SubagentUsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolCalls: 0 };
}

export function isRunActive(run: SubagentRunSnapshot): boolean {
	return run.status === "pending" || run.status === "running";
}

export function isRunFailed(run: SubagentRunSnapshot): boolean {
	return run.status === "failed" || run.status === "aborted";
}
