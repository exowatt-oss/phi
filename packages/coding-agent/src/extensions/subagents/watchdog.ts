/**
 * Liveness watchdog for subagent child processes.
 *
 * The watchdog counts parsed child lifecycle and stream events as liveness. Raw
 * process output is deliberately not a heartbeat: a retrying provider can emit
 * stderr forever while doing no useful work. A short spawn grace allows a model
 * to produce its first event before silence is judged.
 *
 * The default wall-clock budget is a soft cost signal. It only kills a child
 * that is also idle; an explicit per-task timeout remains a hard cap.
 *
 * Event traffic is not proof of progress, though: a tool that streams output
 * forever (a `createdb` re-printing "Password:" with no TTY) emits a
 * `tool_execution_update` per chunk and so never looks idle. Two wall clocks
 * bound that case regardless of traffic: a per-tool-call ceiling
 * (`toolMaxMs`) and, for runs without an explicit timeout, an absolute run
 * ceiling (`maxHardRuntimeMs`).
 */

import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "@earendil-works/pi-ai";

/** Minimum stream-side hard fuse when the model stream idle guard is enabled. */
export const MIN_STREAM_HARD_MS = 15 * 60_000;
/** Minimum time before a child with no parsed event can receive a stall verdict. */
export const MIN_SPAWN_GRACE_MS = 10 * 60_000;
/** Default interval for re-checking a child that is over its soft budget. */
export const DEFAULT_BUDGET_RECHECK_MS = 15 * 60_000;
/** Default wall-clock ceiling for one outstanding tool execution. */
export const DEFAULT_TOOL_MAX_MS = 90 * 60_000;
/** Default absolute run ceiling for runs without an explicit timeoutSeconds. */
export const DEFAULT_MAX_HARD_RUNTIME_MS = 360 * 60_000;

/** Resolved watchdog thresholds, all in milliseconds. */
export interface SubagentWatchdogConfig {
	/** Master switch. When false no watchdog or default-budget kill is allowed. */
	enabled: boolean;
	/** Soft stall flag while awaiting model output (no outstanding tool execution). */
	streamSoftMs: number;
	/** Hard kill while awaiting model output; 0 means soft flags only. */
	streamHardMs: number;
	/** Soft stall flag while a tool execution is outstanding. */
	toolSoftMs: number;
	/** Hard kill while a tool execution is outstanding. */
	toolHardMs: number;
	/** Default wall-clock budget for the whole run. 0 disables the budget. */
	maxRuntimeMs: number;
	/**
	 * Kill when one tool execution has been outstanding this long, even if it is
	 * still streaming updates. Undefined or 0 disables.
	 */
	toolMaxMs?: number;
	/**
	 * Absolute wall-clock cap for runs without an explicit timeoutSeconds; kills
	 * even a producing child. Undefined or 0 disables.
	 */
	maxHardRuntimeMs?: number;
	/** How often the runner evaluates the watchdog. */
	checkIntervalMs: number;
	/** How often an over-budget, still-producing run is re-evaluated. */
	budgetRecheckMs?: number;
	/** Grace before a run with no parsed event can receive a stall verdict. */
	spawnGraceMs?: number;
}

export const DEFAULT_WATCHDOG_CONFIG: SubagentWatchdogConfig = {
	enabled: true,
	streamSoftMs: 5 * 60_000,
	// Keep the process-level watchdog outside the default 7m transport guard.
	streamHardMs: Math.max(MIN_STREAM_HARD_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS * 3),
	toolSoftMs: 20 * 60_000,
	toolHardMs: 60 * 60_000,
	maxRuntimeMs: 120 * 60_000,
	toolMaxMs: DEFAULT_TOOL_MAX_MS,
	maxHardRuntimeMs: DEFAULT_MAX_HARD_RUNTIME_MS,
	checkIntervalMs: 5_000,
	budgetRecheckMs: DEFAULT_BUDGET_RECHECK_MS,
	spawnGraceMs: Math.max(MIN_STREAM_HARD_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS * 3, MIN_SPAWN_GRACE_MS),
};

/** Raw settings shape (minutes, human-edited settings.json). */
export interface SubagentsWatchdogSettings {
	/** Disables every watchdog kill, including the default budget. */
	watchdogEnabled?: boolean;
	stallSoftMinutes?: number;
	stallHardMinutes?: number;
	toolStallSoftMinutes?: number;
	toolStallHardMinutes?: number;
	maxRunMinutes?: number;
	toolMaxMinutes?: number;
	maxHardRunMinutes?: number;
}

function minutesToMs(minutes: number | undefined, fallbackMs: number): number {
	if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return fallbackMs;
	return minutes * 60_000;
}

/**
 * Resolve raw settings (minutes) into a runnable config (ms). Stream-side hard
 * kills are never shorter than either the normal 15-minute fuse or three times
 * the provider stream-idle guard. When that guard is disabled, stream-side
 * hard kills are disabled too and the watchdog can only flag a soft stall.
 */
export function resolveWatchdogConfig(
	settings?: SubagentsWatchdogSettings,
	streamIdleTimeoutMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
): SubagentWatchdogConfig {
	const defaults = DEFAULT_WATCHDOG_CONFIG;
	const streamSoftMs = minutesToMs(settings?.stallSoftMinutes, defaults.streamSoftMs);
	const toolSoftMs = minutesToMs(settings?.toolStallSoftMinutes, defaults.toolSoftMs);
	const configuredStreamHardMs = minutesToMs(settings?.stallHardMinutes, defaults.streamHardMs);
	const guardMs = Number.isFinite(streamIdleTimeoutMs) ? streamIdleTimeoutMs : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	const streamHardMs =
		guardMs <= 0 ? 0 : Math.max(streamSoftMs, MIN_STREAM_HARD_MS, configuredStreamHardMs, guardMs * 3);
	const toolHardMs = Math.max(toolSoftMs, minutesToMs(settings?.toolStallHardMinutes, defaults.toolHardMs));
	const maxRuntimeMs = minutesToMs(settings?.maxRunMinutes, defaults.maxRuntimeMs);
	// The wall-clock ceilings never undercut the idle-based thresholds they back
	// up: raising toolStallHardMinutes or maxRunMinutes raises them too. 0 disables.
	const toolMaxMs = minutesToMs(settings?.toolMaxMinutes, DEFAULT_TOOL_MAX_MS);
	const maxHardRuntimeMs = minutesToMs(settings?.maxHardRunMinutes, DEFAULT_MAX_HARD_RUNTIME_MS);
	return {
		enabled: settings?.watchdogEnabled ?? defaults.enabled,
		streamSoftMs,
		streamHardMs,
		toolSoftMs,
		toolHardMs,
		maxRuntimeMs,
		toolMaxMs: toolMaxMs > 0 ? Math.max(toolMaxMs, toolHardMs) : 0,
		maxHardRuntimeMs: maxHardRuntimeMs > 0 ? Math.max(maxHardRuntimeMs, maxRuntimeMs) : 0,
		checkIntervalMs: defaults.checkIntervalMs,
		budgetRecheckMs: defaults.budgetRecheckMs,
		spawnGraceMs: Math.max(streamHardMs, MIN_SPAWN_GRACE_MS),
	};
}

/** Live inputs for one watchdog evaluation. */
export interface WatchdogState {
	startedAt: number;
	/** Process spawn timestamp; budget still uses startedAt, grace uses this when present. */
	spawnedAt?: number;
	/** Timestamp of the last parsed semantic child event. Undefined = nothing yet. */
	lastEventAt?: number;
	/** Timestamp of the first parsed semantic event, used to end spawn grace. */
	firstParsedEventAt?: number;
	/** Whether at least one tool execution is outstanding (started, not ended). */
	inTool: boolean;
	/**
	 * Start time of the longest-outstanding tool execution, if any. Judged by
	 * wall clock only: tool_execution_update traffic does not reset it.
	 */
	oldestToolStartedAt?: number;
	/** A message_parent question is waiting on its own bounded reply timeout, not wedged. */
	waitingForParent?: boolean;
	/** Whether the run is already flagged stalled (soft fires once per silence). */
	alreadyStalled: boolean;
	/** Wall-clock budget override for this run; undefined uses config, 0 disables. */
	maxRuntimeMs?: number;
	/** True only for an explicit per-task timeoutSeconds argument. */
	explicitMaxRuntimeMs?: boolean;
	/** The default budget has already been announced as soft over-budget. */
	overBudget?: boolean;
	/** Last time an over-budget run was evaluated for a possible idle kill. */
	budgetLastCheckedAt?: number;
}

export type WatchdogVerdict =
	| { kind: "ok" }
	| { kind: "soft-stall"; idleMs: number; inTool: boolean }
	| { kind: "stall-kill"; idleMs: number; inTool: boolean }
	| {
			kind: "budget-kill";
			elapsedMs: number;
			budgetMs: number;
			idleMs: number;
			inTool: boolean;
			explicit: boolean;
	  }
	| { kind: "over-budget"; elapsedMs: number; budgetMs: number }
	| {
			kind: "tool-runaway";
			/** How long the oldest outstanding tool execution has been running. */
			toolMs: number;
			toolMaxMs: number;
			elapsedMs: number;
			/** `name: detail` of that tool call; filled in by the runner. */
			tool?: string;
	  }
	| { kind: "hard-cap-kill"; elapsedMs: number; capMs: number; inTool: boolean };

/** Verdicts that terminate the child. */
export type WatchdogKillVerdict = Extract<
	WatchdogVerdict,
	{ kind: "stall-kill" | "budget-kill" | "tool-runaway" | "hard-cap-kill" }
>;

export function isKillVerdict(verdict: { kind: string }): verdict is WatchdogKillVerdict {
	return (
		verdict.kind === "stall-kill" ||
		verdict.kind === "budget-kill" ||
		verdict.kind === "tool-runaway" ||
		verdict.kind === "hard-cap-kill"
	);
}

function idleForState(config: SubagentWatchdogConfig, state: WatchdogState, now: number): number | undefined {
	if (state.firstParsedEventAt === undefined && state.lastEventAt === undefined) {
		const spawnAt = state.spawnedAt ?? state.startedAt;
		const spawnGraceMs = config.spawnGraceMs ?? Math.max(config.streamHardMs, MIN_SPAWN_GRACE_MS);
		if (now - spawnAt < spawnGraceMs) return undefined;
		return now - spawnAt;
	}
	return now - (state.lastEventAt ?? state.firstParsedEventAt ?? state.startedAt);
}

/** One evaluation of the pure policy. Timers, processes, and mutation stay in the runner. */
export function evaluateWatchdog(config: SubagentWatchdogConfig, state: WatchdogState, now: number): WatchdogVerdict {
	const budgetMs = state.maxRuntimeMs ?? config.maxRuntimeMs;
	const elapsedMs = now - state.startedAt;
	const budgetExceeded = budgetMs > 0 && elapsedMs >= budgetMs;
	const explicit = state.explicitMaxRuntimeMs === true;
	const idleMs = idleForState(config, state, now);

	// An explicit timeout is a hard wall-clock cap, even when watchdogEnabled is
	// false. The default budget is never allowed to kill a producing child.
	if (budgetExceeded && explicit) {
		return {
			kind: "budget-kill",
			elapsedMs,
			budgetMs,
			idleMs: idleMs ?? 0,
			inTool: state.inTool,
			explicit: true,
		};
	}
	if (!config.enabled) return { kind: "ok" };

	// Absolute ceiling for runs without an explicit timeout: producing or not.
	// An explicit timeoutSeconds (including 0) replaces it.
	const hardCapMs = config.maxHardRuntimeMs ?? 0;
	if (!explicit && hardCapMs > 0 && elapsedMs >= hardCapMs) {
		return { kind: "hard-cap-kill", elapsedMs, capMs: hardCapMs, inTool: state.inTool };
	}
	if (state.waitingForParent) return { kind: "ok" };

	// Per-tool-call wall clock. Update events prove the tool is printing, not
	// that it will ever finish, so they do not reset this.
	const toolMaxMs = config.toolMaxMs ?? 0;
	if (toolMaxMs > 0 && state.oldestToolStartedAt !== undefined) {
		const toolMs = now - state.oldestToolStartedAt;
		if (toolMs >= toolMaxMs) return { kind: "tool-runaway", toolMs, toolMaxMs, elapsedMs };
	}

	if (budgetExceeded && idleMs !== undefined) {
		const softMs = state.inTool ? config.toolSoftMs : config.streamSoftMs;
		const idlePastSoft = softMs <= 0 || idleMs >= softMs;
		if (idlePastSoft) {
			return {
				kind: "budget-kill",
				elapsedMs,
				budgetMs,
				idleMs,
				inTool: state.inTool,
				explicit: false,
			};
		}
		const recheckMs = config.budgetRecheckMs ?? DEFAULT_BUDGET_RECHECK_MS;
		const budgetCheckDue =
			!state.overBudget || state.budgetLastCheckedAt === undefined || now - state.budgetLastCheckedAt >= recheckMs;
		if (budgetCheckDue) return { kind: "over-budget", elapsedMs, budgetMs };
	}

	if (idleMs === undefined) return { kind: "ok" };
	const softMs = state.inTool ? config.toolSoftMs : config.streamSoftMs;
	const hardMs = state.inTool ? config.toolHardMs : config.streamHardMs;
	if (hardMs > 0 && idleMs >= hardMs) return { kind: "stall-kill", idleMs, inTool: state.inTool };
	if (softMs > 0 && idleMs >= softMs && !state.alreadyStalled) {
		return { kind: "soft-stall", idleMs, inTool: state.inTool };
	}
	return { kind: "ok" };
}

export function formatIdleMinutes(ms: number): string {
	const minutes = ms / 60_000;
	return minutes >= 10 ? `${Math.round(minutes)}m` : `${Math.round(minutes * 10) / 10}m`;
}

/** The failure text a watchdog stall kill leaves on the run. */
export function stallKillMessage(idleMs: number, inTool: boolean, lastActivity: string | undefined): string {
	const where = inTool
		? `while a tool execution was outstanding (last activity: ${lastActivity ?? "unknown"})`
		: "while awaiting model output";
	return (
		`Killed by the subagent stall watchdog: no parsed child events for ${formatIdleMinutes(idleMs)} ${where}. ` +
		"The process was wedged (dead model stream or hung tool), not doing useful work. " +
		"File edits stay in the working tree, and re-launching the same task fresh is safe."
	);
}

/** The failure text a per-tool-call runaway kill leaves on the run. */
export function toolRunawayKillMessage(tool: string | undefined, toolMs: number, toolMaxMs: number): string {
	return (
		`Killed by the subagent runaway-tool guard: the tool call "${tool ?? "unknown tool"}" had been running for ${formatIdleMinutes(toolMs)} ` +
		`(limit ${formatIdleMinutes(toolMaxMs)}, subagents.toolMaxMinutes) without finishing. Output it kept streaming does not count as progress ` +
		"(for example a command re-prompting for a password with no TTY). " +
		"File edits stay in the working tree; re-launch with a command that cannot block on input, or raise subagents.toolMaxMinutes for genuinely long tools."
	);
}

/** The failure text the absolute run ceiling leaves on the run. */
export function hardCapKillMessage(elapsedMs: number, capMs: number): string {
	return (
		`Killed at the ${formatIdleMinutes(capMs)} absolute run ceiling (subagents.maxHardRunMinutes; ran ${formatIdleMinutes(elapsedMs)}), ` +
		"which applies even while a child is producing when no explicit timeoutSeconds is set. " +
		"File edits stay in the working tree. Pass a per-task timeoutSeconds for work that legitimately needs longer."
	);
}

/** The failure text a budget or explicit-timeout kill leaves on the run. */
export function budgetKillMessage(
	elapsedMs: number,
	budgetMs: number,
	idleMs?: number,
	inTool = false,
	explicit = false,
): string {
	if (explicit) {
		return (
			`Killed at its explicit timeoutSeconds hard cap of ${formatIdleMinutes(budgetMs)} ` +
			`(ran ${formatIdleMinutes(elapsedMs)}). File edits stay in the working tree.`
		);
	}
	const idleText = idleMs === undefined ? "" : ` and was idle for ${formatIdleMinutes(idleMs)}`;
	const where = inTool ? " while a tool execution was outstanding" : " while awaiting model output";
	return (
		`Killed after exceeding its ${formatIdleMinutes(budgetMs)} wall-clock run budget (soft; ran ${formatIdleMinutes(elapsedMs)}) ` +
		`and was over budget AND idle${idleText}${where}. ` +
		"File edits stay in the working tree. Set a larger per-task timeoutSeconds or subagents.maxRunMinutes if needed."
	);
}
