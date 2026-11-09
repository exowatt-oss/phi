/**
 * Built-in `subagents` extension: first-class, high-visibility subagents.
 *
 * Registers the `subagent` tool (single / parallel / chain execution of child
 * phi processes with isolated context), a live dashboard widget + footer
 * status while any subagent is running, rich transcript rendering with
 * per-agent model / tokens / cost / context tracking, and a `/subagents`
 * command that opens an interactive viewer (select an agent thread, watch it
 * live, kill it, pin a board snapshot into the transcript).
 *
 * In interactive sessions the tool runs in the background by default: it
 * returns a launch receipt immediately so the main thread stays usable, and
 * the results arrive later as `subagent-results` messages that trigger a
 * follow-up turn — per run for a parallel group (a finished run is never held
 * back by a slow sibling), once for single and chain launches. Non-interactive
 * modes (json/print) block as before.
 *
 * Background runs live and die with this process. At session start the
 * extension reconciles the transcript: a launch receipt whose results never
 * arrived means those runs died with a previous process (restart, crash,
 * reboot), and a `subagent-lost` message is appended so the model re-launches
 * instead of waiting forever on the receipt's "results will be delivered".
 *
 * Tasks can name a discovered agent (`~/.pi/agent/agents/*.md` or
 * `.pi/agents/*.md`), name a model directly (`gateway/example-medium:max`), or inherit
 * the parent session's model.
 */

import { StringEnum, type Usage, uuidv7 } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { resolveModelReference } from "../../core/model-resolver.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { isSubagentControlEnabled } from "../../core/subagent-control.ts";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { registerChildMessageTool } from "./child-tools.ts";
import { SubagentDashboard } from "./dashboard.ts";
import { SUBAGENT_FEED_CHANNEL, type SubagentFeedControl, type SubagentFeedEvent } from "./feed.ts";
import {
	aggregateUsage,
	formatDuration,
	formatUsageSummary,
	shortModelLabel,
	subagentDiagnostics,
	truncateText,
} from "./format.ts";
import {
	type ChildIsolationConfig,
	hostFacts,
	installParentLivenessGuard,
	resolveChildIsolation,
} from "./isolation.ts";
import {
	checkModelPolicy,
	describeModelPolicy,
	modelPolicyEnv,
	resolveSubagentModelPolicy,
	type SubagentModelPolicy,
	type SubagentModelSource,
} from "./model-policy.ts";
import { SubagentStatusPublisher } from "./publisher.ts";
import {
	buildBoardLines,
	buildTotalsRow,
	renderSettledRuns,
	renderSubagentCall,
	renderSubagentResult,
} from "./render.ts";
import { executeRun, mapWithConcurrencyLimit, newUsage, runOutputForModel, type SubagentRunControl } from "./runner.ts";
import {
	type AgentScope,
	isRunActive,
	isRunFailed,
	newUsageTotals,
	SUBAGENT_COMPACTION_NOTE_MESSAGE_TYPE,
	SUBAGENT_LOST_MESSAGE_TYPE,
	SUBAGENT_MESSAGE_TYPE,
	SUBAGENT_RESULTS_MESSAGE_TYPE,
	SUBAGENT_STALL_NOTE_MESSAGE_TYPE,
	type SubagentLostMessageDetails,
	type SubagentMessageDetails,
	type SubagentMode,
	type SubagentReport,
	type SubagentResultsMessageDetails,
	type SubagentRunSnapshot,
	type SubagentStallNoteDetails,
	type SubagentToolDetails,
} from "./types.ts";
import { SubagentViewer } from "./viewer.ts";
import {
	formatIdleMinutes,
	isKillVerdict,
	resolveWatchdogConfig,
	type SubagentWatchdogConfig,
	type WatchdogVerdict,
} from "./watchdog.ts";

const MAX_PARALLEL_TASKS = 24;
const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 12;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const UPDATE_THROTTLE_MS = 100;

const TaskItem = Type.Object({
	task: Type.String({ description: "Task to delegate to the subagent" }),
	name: Type.Optional(Type.String({ description: "Short display name for this subagent (e.g. 'ws-a')" })),
	agent: Type.Optional(Type.String({ description: "Named agent definition to use" })),
	model: Type.Optional(
		Type.String({ description: 'Model override as "provider/modelId" with optional ":thinkingLevel" suffix' }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process" })),
	timeoutSeconds: Type.Optional(
		Type.Number({
			minimum: 0,
			description:
				"Explicit hard wall-clock cap for this subagent in seconds (0 disables). Without it, the default subagents.maxRunMinutes budget is soft (only kills an idle child) and subagents.maxHardRunMinutes (default 360) is an absolute cap.",
		}),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories named agents come from. Default: "user".',
	default: "user",
});

const SubagentParams = Type.Object({
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	name: Type.Optional(Type.String({ description: "Display name for the subagent (single mode)" })),
	agent: Type.Optional(Type.String({ description: "Named agent to invoke (single mode)" })),
	model: Type.Optional(
		Type.String({
			description: 'Model as "provider/modelId[:thinkingLevel]" (single mode). Omit to inherit the session model.',
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: `Tasks to run in parallel (max ${MAX_PARALLEL_TASKS})` })),
	chain: Type.Optional(
		Type.Array(TaskItem, {
			description: "Tasks to run sequentially; {previous} in a task is replaced with the prior step's output",
		}),
	),
	concurrency: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_CONCURRENCY,
			description: `Max parallel processes for tasks mode (default ${DEFAULT_CONCURRENCY})`,
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run in the background (default in interactive sessions): the tool returns immediately and results are delivered as a message when the subagents finish. Set false to block until they are done.",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			minimum: 0,
			description:
				"Explicit hard wall-clock cap in seconds (0 disables; without it the budget is soft at 120 minutes with a 360-minute absolute cap).",
		}),
	),
	action: Type.Optional(
		StringEnum(["run", "status", "kill", "message"] as const, {
			description:
				'Manage subagents: "status" shows liveness and reports; "message" redirects a running child or answers its question; "kill" terminates one run. Default: "run".',
		}),
	),
	target: Type.Optional(
		Type.String({ description: 'For action:"kill" or "message" — the run, by name, handle, or runId.' }),
	),
	message: Type.Optional(Type.String({ description: 'For action:"message" — text to send to the running child.' })),
	mode: Type.Optional(
		StringEnum(["steer", "follow_up"] as const, {
			description: "Message delivery: steer after the current tool call (default), or follow_up after its turn.",
		}),
	),
});

interface TaskInput {
	task: string;
	name?: string;
	agent?: string;
	model?: string;
	cwd?: string;
	timeoutSeconds?: number;
}

interface PreparedRun {
	run: SubagentRunSnapshot;
	env?: Record<string, string>;
	modelArg?: string;
	tools?: string[];
	systemPrompt?: string;
	/** Wall-clock budget for this run (ms). Undefined = use the watchdog config default. */
	maxRuntimeMs?: number;
	/** Where the run's model came from (for the model policy check). */
	modelSource?: SubagentModelSource;
}

/** Human/model-facing text for a watchdog verdict on a live run. Exported for tests. */
export function stallNoteText(name: string, verdict: WatchdogVerdict | { kind: "recovered" }): string | undefined {
	switch (verdict.kind) {
		case "soft-stall":
			return (
				`[subagent watchdog] "${name}" looks stalled: no parsed child events for ${Math.round(verdict.idleMs / 60_000)}m` +
				`${verdict.inTool ? " (a tool execution is still outstanding)" : " while awaiting model output"}. ` +
				`It will be auto-killed if the silence continues. To act now: {"action":"kill","target":"${name}"} on the subagent tool.`
			);
		case "recovered":
			return `[subagent watchdog] "${name}" resumed activity and is no longer considered stalled.`;
		case "stall-kill":
			return (
				`[subagent watchdog] "${name}" was auto-killed after ${Math.round(verdict.idleMs / 60_000)}m of total silence — ` +
				"it was wedged, not working. Its failure report comes back with its result; re-launching the task fresh is safe."
			);
		case "over-budget":
			return (
				`[subagent watchdog] "${name}" is over its ${Math.round(verdict.budgetMs / 60_000)}m soft run budget but is still producing; ` +
				"the soft budget only kills it if it becomes idle (the per-tool and absolute ceilings still apply)."
			);
		case "budget-kill":
			return verdict.explicit
				? `[subagent watchdog] "${name}" hit its explicit timeoutSeconds hard cap; its failure report comes back with its result.`
				: `[subagent watchdog] "${name}" was auto-killed because it was over budget and idle; its failure report comes back with its result.`;
		case "tool-runaway":
			return (
				`[subagent watchdog] "${name}" was auto-killed: one tool call ran ${formatIdleMinutes(verdict.toolMs)} without finishing` +
				`${verdict.tool ? ` (${truncateText(verdict.tool, 80)})` : ""}. Its failure report comes back with its result.`
			);
		case "hard-cap-kill":
			return `[subagent watchdog] "${name}" was auto-killed at the ${formatIdleMinutes(verdict.capMs)} absolute run ceiling; its failure report comes back with its result.`;
		default:
			return undefined;
	}
}

/** A parent wake-up is sent at most once per run for each of these conditions. */
export type ParentWakeCondition = "soft-stall" | "over-budget" | "killed";

export function parentWakeCondition(verdict: WatchdogVerdict | { kind: "recovered" }): ParentWakeCondition | undefined {
	if (verdict.kind === "soft-stall" || verdict.kind === "over-budget") return verdict.kind;
	return isKillVerdict(verdict) ? "killed" : undefined;
}

function stallNoteVerdict(
	verdict: WatchdogVerdict | { kind: "recovered" },
): SubagentStallNoteDetails["verdict"] | undefined {
	return verdict.kind === "ok" || verdict.kind === "recovered" ? undefined : verdict.kind;
}

/** The most recent concrete thing the run did (the activity line is overwritten by watchdog states). */
function lastActivityText(run: SubagentRunSnapshot): string {
	const last = run.timeline.at(-1);
	if (last?.kind === "tool") return `${last.name}: ${last.detail}`;
	if (last?.kind === "text") return `said "${last.text.replace(/\s+/g, " ")}"`;
	return run.activity ?? "unknown";
}

/**
 * One concise, turn-triggering note for the parent model when a background
 * run soft-stalls, goes over its soft budget, or is killed. Undefined for
 * verdicts that never wake the parent. Exported for tests.
 */
export function parentWakeText(
	run: SubagentRunSnapshot,
	verdict: WatchdogVerdict | { kind: "recovered" },
	now: number = Date.now(),
): string | undefined {
	let what: string;
	let live = true;
	switch (verdict.kind) {
		case "soft-stall":
			what =
				`looks stalled: no parsed child events for ${formatIdleMinutes(verdict.idleMs)} ` +
				`${verdict.inTool ? "while a tool execution is outstanding" : "while awaiting model output"}; it is auto-killed if the silence continues`;
			break;
		case "over-budget":
			what = `is over its ${formatIdleMinutes(verdict.budgetMs)} soft run budget and still producing`;
			break;
		case "stall-kill":
			what = `was killed by the stall watchdog after ${formatIdleMinutes(verdict.idleMs)} of silence`;
			live = false;
			break;
		case "tool-runaway":
			what =
				`was killed: the tool call ${verdict.tool ? `"${truncateText(verdict.tool, 120)}" ` : ""}ran ` +
				`${formatIdleMinutes(verdict.toolMs)} without finishing (limit ${formatIdleMinutes(verdict.toolMaxMs)}, subagents.toolMaxMinutes)`;
			live = false;
			break;
		case "hard-cap-kill":
			what = `was killed at the ${formatIdleMinutes(verdict.capMs)} absolute run ceiling (subagents.maxHardRunMinutes)`;
			live = false;
			break;
		case "budget-kill":
			what = verdict.explicit
				? `was killed at its explicit timeoutSeconds cap of ${formatIdleMinutes(verdict.budgetMs)}`
				: `was killed: over its ${formatIdleMinutes(verdict.budgetMs)} budget and idle for ${formatIdleMinutes(verdict.idleMs)}`;
			live = false;
			break;
		default:
			return undefined;
	}
	const target = run.handle ?? run.name;
	const elapsed = run.startedAt !== undefined ? formatDuration(now - run.startedAt) : "unknown";
	const lastEvent = run.lastEventAt !== undefined ? `, last event ${formatDuration(now - run.lastEventAt)} ago` : "";
	const facts = `Elapsed ${elapsed}${lastEvent}; last activity: ${truncateText(lastActivityText(run), 160)}.`;
	const actions = live
		? `It is still running. Options: subagent {"action":"status"} for the board; {"action":"message","target":"${target}","message":"..."} to redirect it; {"action":"kill","target":"${target}"} if its work is no longer worth waiting for.`
		: `File edits stay in the working tree; its failure report with partial output follows as a result message. Re-launch the task if its work is still needed; subagent {"action":"status"} shows the rest of the board.`;
	return `[subagent watchdog] "${run.name}" ${what}. ${facts} ${actions}`;
}

/** Plain-text live board for action:"status" (goes to the model, not the TUI). Exported for tests. */
export function buildStatusText(runs: SubagentRunSnapshot[], now: number = Date.now()): string {
	if (runs.length === 0) return "No subagents have run in this session.";
	const lines = runs.map((run) => {
		const elapsed = run.startedAt ? formatDuration((run.endedAt ?? now) - run.startedAt) : "-";
		const idle =
			isRunActive(run) && (run.lastEventAt ?? run.startedAt)
				? `idle ${formatDuration(now - (run.lastEventAt ?? run.startedAt ?? now))}`
				: undefined;
		const bits = [
			`- ${run.name} [${run.status}${run.stalled ? ", STALLED" : ""}]`,
			run.modelLabel ?? run.model,
			`up ${elapsed}`,
			idle,
			`${run.usage.turns} turns · ${run.usage.toolCalls} tools`,
			subagentDiagnostics(run),
			run.activity ? `now: ${truncateText(run.activity, 80)}` : undefined,
			run.lastReport
				? `last report: ${run.lastReport.kind} (${formatDuration(now - run.lastReport.at)} ago) ${truncateText(run.lastReport.message.replace(/\s+/g, " "), 200)}`
				: undefined,
			run.pendingQuestion
				? `pending question (${formatDuration(now - run.pendingQuestion.at)}): ${truncateText(run.pendingQuestion.message.replace(/\s+/g, " "), 200)}`
				: undefined,
			isRunActive(run) ? (run.turnState ?? "mid-turn") : undefined,
			run.killedBy ? `killedBy: ${run.killedBy}` : undefined,
		];
		return bits.filter(Boolean).join(" · ");
	});
	const active = runs.filter(isRunActive).length;
	return [`Subagents (${active} active of ${runs.length}):`, ...lines].join("\n");
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
function crockfordSuffix(): string {
	let value = Math.floor(Math.random() * 32 ** 4);
	let suffix = "";
	for (let i = 0; i < 4; i++) {
		suffix = CROCKFORD[value % 32] + suffix;
		value = Math.floor(value / 32);
	}
	return suffix;
}

function uniquifyNames(runs: SubagentRunSnapshot[]): void {
	const seen = new Map<string, number>();
	for (const run of runs) {
		const count = (seen.get(run.name) ?? 0) + 1;
		seen.set(run.name, count);
		if (count > 1) run.name = `${run.name} #${count}`;
	}
}

/** Resolve one task input into a launchable run, or an error string. */
function prepareRun(
	item: TaskInput,
	index: number,
	step: number | undefined,
	agents: AgentConfig[],
	ctx: ExtensionContext,
	policyDefault?: string,
): PreparedRun | string {
	let agent: AgentConfig | undefined;
	if (item.agent) {
		agent = agents.find((a) => a.name === item.agent);
		if (!agent) {
			const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
			return `Unknown agent "${item.agent}". Available agents: ${available}. Tasks can also set "model" directly instead of naming an agent.`;
		}
	}

	const runId = uuidv7();
	const handle = `${(item.name ?? agent?.name ?? `task-${index + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${crockfordSuffix()}`;
	const run: SubagentRunSnapshot = {
		runId,
		handle,
		id: runId,
		name: item.name ?? agent?.name ?? `task-${index + 1}`,
		agentName: agent?.name,
		agentSource: agent?.source ?? "none",
		task: item.task,
		cwd: item.cwd,
		step,
		status: "pending",
		usage: newUsageTotals(),
		timeline: [],
		timelineDropped: 0,
		finalText: "",
	};

	// Precedence: task model, then the agent definition's, then the pinned policy default, then inherit.
	const taskModel = item.model?.trim();
	const agentModel = agent?.model?.trim();
	const modelSource: SubagentModelSource | undefined = taskModel
		? "task"
		: agentModel
			? "agent"
			: policyDefault
				? "default"
				: undefined;
	const modelSpec = taskModel || agentModel || policyDefault;
	if (modelSpec) {
		const available = ctx.modelRegistry.getAvailable();
		// Strict suffix handling: an unknown `:suffix` stays part of the id and fails instead of
		// silently resolving to a different model.
		const resolved = resolveModelReference(
			{ text: modelSpec, thinkingSuffix: "strict", fuzzy: false },
			available,
			() => true,
		);
		const parsed =
			resolved.status === "resolved"
				? { model: resolved.model, thinkingLevel: resolved.thinkingLevel }
				: { model: undefined, thinkingLevel: undefined };
		if (!parsed.model) {
			if (modelSource === "default") {
				return `Unknown model "${modelSpec}" (the pinned subagent default from subagents.models.default or PHI_SUBAGENT_MODEL_DEFAULT). Set "model" on the task or fix the default.`;
			}
			return `Unknown model "${modelSpec}". Use "provider/modelId" with an optional ":thinkingLevel" suffix (off, minimal, low, medium, high, xhigh, max).`;
		}
		const suffix = parsed.thinkingLevel ? `:${parsed.thinkingLevel}` : "";
		run.model = `${parsed.model.provider}/${parsed.model.id}`;
		run.thinkingLevel = parsed.thinkingLevel;
		run.contextWindow = parsed.model.contextWindow;
		run.modelLabel = shortModelLabel(run.model, parsed.thinkingLevel);
		if (!item.name && !agent) run.name = run.modelLabel ?? run.name;
		return {
			run,
			modelArg: `${run.model}${suffix}`,
			tools: agent?.tools,
			systemPrompt: agent?.systemPrompt,
			modelSource,
		};
	}

	// No explicit model: inherit the parent session's current model.
	if (ctx.model) {
		const level = ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ctx.thinkingLevel : undefined;
		run.model = `${ctx.model.provider}/${ctx.model.id}`;
		run.thinkingLevel = level;
		run.contextWindow = ctx.model.contextWindow;
		run.modelLabel = shortModelLabel(run.model, level);
		return {
			run,
			modelArg: `${run.model}${level ? `:${level}` : ""}`,
			tools: agent?.tools,
			systemPrompt: agent?.systemPrompt,
			modelSource: "inherited",
		};
	}

	return { run, tools: agent?.tools, systemPrompt: agent?.systemPrompt };
}

interface GroupExecutionOptions {
	mode: SubagentMode;
	prepared: PreparedRun[];
	runs: SubagentRunSnapshot[];
	concurrency: number;
	defaultCwd: string;
	parentSessionId?: string;
	groupId: string;
	signalFor: (run: SubagentRunSnapshot) => AbortSignal | undefined;
	onChange: () => void;
	groupUsage: Usage;
	onSpawn: (run: SubagentRunSnapshot) => Promise<Record<string, string>>;
	watchdog: SubagentWatchdogConfig;
	/** Per-child cgroup isolation, resolved once per launch (see isolation.ts). */
	isolation: ChildIsolationConfig;
	onStall: (run: SubagentRunSnapshot, verdict: WatchdogVerdict | { kind: "recovered" }) => void;
	parentListening: boolean;
	onControlReady: (run: SubagentRunSnapshot, control: SubagentRunControl) => void;
	onRunFinished: (run: SubagentRunSnapshot) => void;
	onChildMessage: (run: SubagentRunSnapshot, report: SubagentReport) => void;
	/** A run is about to start (`index`: its position in `prepared`). */
	onRunStart?: (run: SubagentRunSnapshot, index: number) => void;
	/** Every parsed record of a run's child JSON stream. */
	onChildEvent?: (run: SubagentRunSnapshot, event: Record<string, unknown>) => void;
	/** Parallel runs whose results already reached the parent; the group text omits them. */
	delivered?: ReadonlySet<SubagentRunSnapshot>;
}

/** Run a whole group (chain/parallel/single) to completion, mutating the runs. Returns the text for the model. */
async function executeGroup(options: GroupExecutionOptions): Promise<string> {
	const { mode, prepared, runs, onChange, groupUsage } = options;
	const runStep = async (step: PreparedRun) => {
		try {
			options.onRunStart?.(step.run, prepared.indexOf(step));
			const onChildEvent = options.onChildEvent;
			await executeRun({
				defaultCwd: options.defaultCwd,
				run: step.run,
				modelArg: step.modelArg,
				tools: step.tools,
				systemPrompt: step.systemPrompt,
				signal: options.signalFor(step.run),
				watchdog: options.watchdog,
				isolation: options.isolation,
				maxRuntimeMs: step.maxRuntimeMs,
				onStall: options.onStall,
				onChange,
				groupUsage,
				parentListening: options.parentListening,
				onControlReady: (control) => options.onControlReady(step.run, control),
				onChildMessage: options.onChildMessage,
				onEvent: onChildEvent ? (event) => onChildEvent(step.run, event) : undefined,
				env: {
					PI_SUBAGENT_ID: step.run.runId ?? step.run.id,
					PI_SUBAGENT_NAME: step.run.name,
					PI_SUBAGENT_HANDLE: step.run.handle ?? step.run.name,
					PI_SUBAGENT_PARENT_SESSION: options.parentSessionId ?? "",
					PI_SUBAGENT_GROUP: options.groupId,
					...step.env,
				},
				onSpawn: () => options.onSpawn(step.run),
			});
		} finally {
			options.onRunFinished(step.run);
		}
	};

	if (mode === "chain") {
		let previousOutput = "";
		for (let i = 0; i < prepared.length; i++) {
			const step = prepared[i];
			step.run.task = step.run.task.replace(/\{previous\}/g, previousOutput);
			await runStep(step);
			if (isRunFailed(step.run)) {
				for (let j = i + 1; j < prepared.length; j++) {
					prepared[j].run.status = "aborted";
					prepared[j].run.activity = "skipped: previous step failed";
				}
				onChange();
				return `Chain stopped at step ${i + 1} (${step.run.name}): ${runOutputForModel(step.run)}`;
			}
			previousOutput = step.run.finalText;
		}
		return runOutputForModel(prepared[prepared.length - 1].run);
	}

	if (mode === "parallel") {
		await mapWithConcurrencyLimit(prepared, options.concurrency, runStep);
		return parallelGroupText(runs, options.delivered);
	}

	const single = prepared[0];
	await runStep(single);
	if (isRunFailed(single.run)) {
		return `Subagent ${single.run.status}: ${runOutputForModel(single.run)}`;
	}
	return runOutputForModel(single.run);
}

function runStatusLabel(run: SubagentRunSnapshot): string {
	return isRunFailed(run)
		? `failed${run.stopReason && run.stopReason !== "stop" ? ` (${run.stopReason})` : ""}`
		: "completed";
}

function runSectionText(run: SubagentRunSnapshot): string {
	return `### [${run.name}] ${runStatusLabel(run)}\n\n${capTaskOutput(runOutputForModel(run))}`;
}

/**
 * Model-facing text for a settled parallel group. Runs in `delivered` already
 * reached the parent as their own result messages; they are listed by name
 * and status only, never repeated. Exported for tests.
 */
export function parallelGroupText(
	runs: SubagentRunSnapshot[],
	delivered: ReadonlySet<SubagentRunSnapshot> = new Set(),
): string {
	const succeeded = runs.filter((run) => !isRunFailed(run)).length;
	const earlier = runs.filter((run) => delivered.has(run));
	const sections = runs.filter((run) => !delivered.has(run)).map(runSectionText);
	let summary = `Parallel: ${succeeded}/${runs.length} succeeded`;
	if (earlier.length > 0) {
		summary +=
			` (all ${runs.length} finished). Already delivered as each finished, not repeated here: ` +
			`${earlier.map((run) => `${run.name} (${runStatusLabel(run)})`).join(", ")}.`;
	}
	return sections.length > 0 ? `${summary}\n\n${sections.join("\n\n---\n\n")}` : summary;
}

/**
 * Model-facing text for one run of a background parallel group that finished
 * while siblings are still running. Same shape as the group delivery, marked
 * with progress. Exported for tests.
 */
export function finishedRunResultText(
	run: SubagentRunSnapshot,
	finished: number,
	size: number,
	stillRunning: string[],
): string {
	const summary = formatUsageSummary(aggregateUsage([run]));
	const header =
		`[subagent results — parallel, ${run.name}: ${finished} of ${size} finished; still running: ${stillRunning.join(", ")}` +
		`${summary ? ` · ${summary}` : ""}]`;
	return `${header}\n\n${runSectionText(run)}\n\nThe other results arrive as their runs finish.`;
}

function capTaskOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Details are preserved in the tool result.]`;
}

export function isNestedSubagent(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.PI_SUBAGENT_ID);
}

/**
 * Text of the continuity note injected after a compaction while background
 * subagents are still running. Undefined when there is nothing in flight.
 */
export function compactionNoteText(names: string[]): string | undefined {
	if (names.length === 0) return undefined;
	return (
		`[context checkpoint] ${names.length} background subagent${names.length === 1 ? " is" : "s are"} still running: ${names.join(", ")}. ` +
		"Their results will be delivered automatically as a follow-up message when they finish — do not re-launch or poll for them."
	);
}

/**
 * Text of the recovery note appended at session start for background runs
 * whose results can never arrive. It must outweigh the launch receipt's
 * "results will be delivered automatically — do not poll or wait for them",
 * or the model keeps promising the user that dead work is still running.
 * Undefined when nothing was lost.
 */
export function lostSubagentsNoteText(names: string[]): string | undefined {
	if (names.length === 0) return undefined;
	return (
		`[subagent recovery] ${names.length} background subagent${names.length === 1 ? "" : "s"} did NOT survive a phi restart and ${names.length === 1 ? "is" : "are"} no longer running: ${names.join(", ")}. ` +
		"The phi process that launched them exited (restart, crash, or reboot) before their results were delivered, so their results will never arrive — any earlier claim that they are still running is stale. " +
		"If their work is still needed, start it again now: re-launch the subagent or do the work directly. Do not wait for them."
	);
}

/**
 * Scan a session branch for background subagent launches whose results never
 * came back. Background runs are child processes of the phi that launched
 * them, and every path out of that process — clean shutdown, session switch,
 * crash, machine reboot — either kills them or orphans their delivery, so a
 * launch receipt without a matching `subagent-results` message means those
 * runs are dead. Runs already reported lost by a previous reconciliation
 * (`subagent-lost` message) are not reported again.
 */
export function findOrphanedBackgroundRuns(entries: SessionEntry[]): SubagentLostMessageDetails {
	const launched = new Map<string, string>();
	const settled = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "subagent") continue;
			const details = message.details as SubagentToolDetails | undefined;
			if (details?.background !== true || !Array.isArray(details.runs)) continue;
			for (const run of details.runs) {
				const key = run.runId ?? run.id;
				if (key) launched.set(key, run.name ?? key);
			}
		} else if (entry.type === "custom_message") {
			if (entry.customType === SUBAGENT_RESULTS_MESSAGE_TYPE) {
				const details = entry.details as SubagentResultsMessageDetails | undefined;
				for (const run of details?.runs ?? []) {
					const key = run.runId ?? run.id;
					if (key) settled.add(key);
				}
			} else if (entry.customType === SUBAGENT_LOST_MESSAGE_TYPE) {
				const details = entry.details as SubagentLostMessageDetails | undefined;
				for (const runId of details?.runIds ?? []) settled.add(runId);
			}
		}
	}
	const runIds: string[] = [];
	const names: string[] = [];
	for (const [runId, name] of launched) {
		if (settled.has(runId)) continue;
		runIds.push(runId);
		names.push(name);
	}
	return { runIds, names };
}

export function deliverChildMessage(
	pi: Pick<ExtensionAPI, "sendMessage">,
	run: SubagentRunSnapshot,
	report: SubagentReport,
	parentListening: boolean,
): void {
	// Progress is available via status and the dashboard, not another model turn.
	// A blocking parent's tool call cannot answer a question until it finishes.
	if (report.kind === "progress" || !parentListening) return;
	const question = run.pendingQuestion;
	if (!question) return;
	const reply = JSON.stringify({ action: "message", target: run.handle ?? run.name, message: "..." });
	const minutes = question.timeoutSeconds / 60;
	const wait = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
	pi.sendMessage<SubagentMessageDetails>(
		{
			customType: SUBAGENT_MESSAGE_TYPE,
			content: `[subagent ${run.name} asks] ${report.message}\nAnswer with subagent ${reply}. It is waiting (times out in ${wait} min).`,
			display: true,
			details: { ...question, name: run.name, runId: run.runId ?? run.id },
		},
		{ deliverAs: "steer", triggerTurn: true },
	);
}

const SUBAGENT_TOOL_DESCRIPTION = [
	"Delegate tasks to subagents running in isolated child processes with fresh context.",
	"Modes: single (task at top level), parallel (tasks array), chain (sequential; {previous} placeholder carries the prior step's output).",
	'Each task can use a named agent definition ("agent"), a direct model reference ("model": "provider/modelId[:thinkingLevel]"), or neither to inherit the session model.',
	"Give every task a short descriptive name so the live dashboard is readable.",
	"Progress, per-agent token/cost/context usage and a step timeline are shown live and preserved in the result.",
	"Runs are supervised by a liveness watchdog: a child that goes silent is flagged and killed only if it stays idle; the default run budget kills only idle children; a single tool call running past subagents.toolMaxMinutes (90) is killed even if it keeps printing; runs without timeoutSeconds have an absolute subagents.maxHardRunMinutes (360) cap; an explicit timeoutSeconds is a hard cap; a killed run's partial output is returned.",
	"A background run that stalls, goes over budget, or is killed wakes you once with a short watchdog note; each run of a background parallel group delivers its result as soon as it finishes.",
	"On Linux each child runs in its own memory- and CPU-capped cgroup; a child whose process group hits its memory ceiling reports that in its result. Tasks that run tests or builds should still pin explicit worker caps (jest --maxWorkers=4, vitest --maxWorkers=4, pytest -n 4, make -j4) rather than the repo's bare `npm test`.",
	'Manage in-flight runs with action:"status" (live board), action:"message" + target + message, and action:"kill" + target — never hunt subagent PIDs with ps/kill.',
].join(" ");

export default function subagentsExtension(pi: ExtensionAPI): void {
	// A subagent is already an isolated child process. Letting it register this
	// tool again permits unbounded recursive spawning: each descendant also
	// starts its configured MCP servers, which can multiply processes and OAuth
	// browser prompts until the machine is exhausted. The runner sets
	// PI_SUBAGENT_ID on every child, so omit the entire extension surface there.
	if (isNestedSubagent()) {
		if (isSubagentControlEnabled()) registerChildMessageTool(pi);
		// Children run in their own systemd scope (isolation.ts), so the parent's
		// cgroup no longer takes them down when it dies. Watch the parent instead:
		// a subagent with nobody to deliver to must not keep running and spending.
		installParentLivenessGuard();
		return;
	}

	const dashboard = new SubagentDashboard();
	let publisher: SubagentStatusPublisher | undefined;
	// Cwd of the live session, for reading the model policy outside a tool call.
	let policyCwd: string | undefined;
	// Kill handles for every launched run (background or blocking), so the
	// /subagents viewer can abort an individual agent and shutdown kills all.
	const killRegistry = new Map<SubagentRunSnapshot, AbortController>();
	const controlRegistry = new Map<SubagentRunSnapshot, SubagentRunControl>();
	// Bumped on session_shutdown. Background runs aborted by a shutdown must not
	// send per-run results or watchdog wake-ups into whatever session comes next.
	let sessionGeneration = 0;

	const currentRuns = () => {
		const active = dashboard.activeRuns();
		return active.length > 0 ? active : dashboard.lastRuns();
	};
	const pin = () => {
		const runs = currentRuns();
		if (runs.length === 0) return;
		pi.appendEntry("subagents-board", { runs: structuredClone(runs), capturedAt: Date.now() });
	};
	const openViewer = async (ctx: ExtensionContext, initialRun?: SubagentRunSnapshot) => {
		if (ctx.mode !== "tui") return;
		await ctx.ui.custom<undefined>(
			(tui, theme, _keybindings, done) =>
				new SubagentViewer(
					tui,
					theme,
					{
						runs: currentRuns,
						kill: (run) => {
							const controller = killRegistry.get(run);
							if (!controller || !isRunActive(run)) return false;
							run.killedBy = "kill-action";
							run.errorMessage = `Killed from the /subagents viewer (last activity: ${run.activity ?? "unknown"}).`;
							controller.abort();
							return true;
						},
						pin,
					},
					() => done(undefined),
					initialRun?.id,
				),
		);
	};

	pi.on("session_start", (_event, ctx) => {
		policyCwd = ctx.cwd;
		dashboard.attach(ctx.ui, (run) => openViewer(ctx, run));
		publisher?.dispose();
		publisher = new SubagentStatusPublisher({
			parentSessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			model: ctx.model?.id,
		});
		dashboard.setOnChange((runs) => publisher?.update(runs));

		// Session start means no background run from a previous process can be
		// alive (session_shutdown aborts them; a crash or reboot never even got
		// that far), yet the transcript still ends with a launch receipt telling
		// the model results are on their way. Left alone, a resumed session
		// answers every "keep going" with "still running" forever. Say what died.
		const lost = findOrphanedBackgroundRuns(ctx.sessionManager.getBranch());
		const content = lostSubagentsNoteText(lost.names);
		if (!content) return;
		pi.sendMessage<SubagentLostMessageDetails>({
			customType: SUBAGENT_LOST_MESSAGE_TYPE,
			content,
			display: true,
			details: lost,
		});
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
		for (const controller of killRegistry.values()) controller.abort();
		killRegistry.clear();
		controlRegistry.clear();
		dashboard.dispose();
		publisher?.dispose();
		publisher = undefined;
	});

	// Compaction never touches the child processes — they are independent — but it
	// can summarize away the launch receipts the model needs to remember that
	// results are still on their way. Re-anchor that expectation in fresh context:
	// steered into the next LLM call mid-run, or appended directly when idle.
	pi.on("session_compact", (_event, _ctx) => {
		const names = dashboard
			.activeRuns()
			.filter(isRunActive)
			.map((run) => run.name);
		const content = compactionNoteText(names);
		if (!content) return;
		pi.sendMessage(
			{
				customType: SUBAGENT_COMPACTION_NOTE_MESSAGE_TYPE,
				content,
				display: true,
				details: { names },
			},
			{ deliverAs: "steer" },
		);
	});

	const currentModelPolicy = (): SubagentModelPolicy | undefined => {
		try {
			const settings = SettingsManager.create(policyCwd ?? process.cwd(), getAgentDir());
			return resolveSubagentModelPolicy(settings.getSubagentsSettings(), process.env);
		} catch {
			return undefined;
		}
	};

	pi.registerTool<typeof SubagentParams, SubagentToolDetails>({
		name: "subagent",
		label: "Subagent",
		description: SUBAGENT_TOOL_DESCRIPTION,
		// Only when a model policy is set, tell the model the pinned models up front so it
		// picks allowed ones instead of learning them from a refusal.
		prepareLoadout: () => {
			const policy = currentModelPolicy();
			const line = policy ? describeModelPolicy(policy) : undefined;
			return line ? { descriptions: { subagent: `${SUBAGENT_TOOL_DESCRIPTION} ${line}` } } : undefined;
		},
		promptSnippet: "Delegate independent tasks to parallel subagents with isolated context",
		promptGuidelines: [
			"Use subagent with a tasks array to parallelize independent chunks of work, or a single task to isolate large exploration from this context. Give each task a short name and a self-contained prompt; results come back as each agent's final answer.",
			"Do not use subagent for small edits or questions you can handle directly — the child process has none of this conversation's context.",
			"Running subagents can be messaged: subagent {action:'message', target, message} lands after the child's current tool call. Use it to redirect, add context, ask for status, or answer its questions.",
			"Never kill a subagent just because it is slow or quiet. First check {action:'status'} (last report, idle time), then message it. Kill only when the watchdog flags it wedged, it ignores messages for a long time, or its work is no longer needed.",
			"When a subagent asks you a question ([subagent <name> asks]), answer promptly with action:'message' — it is waiting.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			dashboard.attach(ctx.ui, (run) => openViewer(ctx, run));

			// Management verbs: inspect, message, or terminate running subagents without
			// launching anything. Session-scoped and PID-free by design — models
			// must never resort to ps/kill for a run this extension owns.
			const action = params.action ?? "run";
			const managementDetails = (runs: SubagentRunSnapshot[] = []): SubagentToolDetails => ({
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				runs,
			});
			if (action === "status") {
				return {
					content: [{ type: "text", text: buildStatusText(currentRuns()) }],
					details: managementDetails(),
				};
			}
			if (action === "kill" || action === "message") {
				const targetKey = params.target?.trim().toLowerCase();
				if (!targetKey) {
					return {
						content: [
							{ type: "text", text: `action:"${action}" requires "target": the run name, handle, or runId.` },
						],
						details: managementDetails(),
					};
				}
				const active = dashboard.activeRuns().filter(isRunActive);
				const matches = active.filter((run) =>
					[run.name, run.handle, run.runId, run.id].some((key) => key?.toLowerCase() === targetKey),
				);
				const names =
					active.map((run) => `${run.name} (${run.handle ?? run.runId ?? run.id})`).join(", ") || "none";
				if (matches.length !== 1) {
					const text =
						matches.length > 1
							? `Ambiguous subagent "${params.target}". Live runs: ${names}. Use a handle or runId.`
							: `Subagent "${params.target}" is not running. Live runs: ${names}. Launch a new run if its work is still needed.`;
					return { content: [{ type: "text", text }], details: managementDetails() };
				}
				const match = matches[0];
				if (action === "message") {
					const message = params.message?.trim();
					if (!message)
						return {
							content: [{ type: "text", text: 'action:"message" requires a nonempty "message".' }],
							details: managementDetails(),
						};
					const control = controlRegistry.get(match);
					if (!control)
						return {
							content: [
								{
									type: "text",
									text: `Subagent "${match.name}" is not running yet or is already exiting. Live runs: ${names}. Launch a new run if needed.`,
								},
							],
							details: managementDetails(),
						};
					const wrapped = `[message from your parent agent] ${message}`;
					const question = match.pendingQuestion;
					const wasIdle = match.turnState === "idle-awaiting-close";
					const sent = question
						? control.send({ type: "reply", toolCallId: question.toolCallId, text: wrapped })
						: control.send({ type: params.mode ?? "steer", message: wrapped });
					let text: string;
					if (!sent)
						text = `Subagent "${match.name}" is no longer running (channel closed). Live runs: ${names}. Launch a new run if needed.`;
					else if (question) text = `answered ${match.name}'s question`;
					else if (wasIdle) text = `delivered to ${match.name} (starts a new turn — it was idle)`;
					else if (params.mode === "follow_up") text = `delivered to ${match.name} (lands after its current turn)`;
					else text = `delivered to ${match.name} (lands after its current tool call)`;
					return {
						content: [{ type: "text", text }],
						details: managementDetails(sent ? [structuredClone(match)] : []),
					};
				}
				const controller = killRegistry.get(match);
				if (!controller) {
					return {
						content: [
							{ type: "text", text: `Subagent "${match.name}" is no longer killable (already settling).` },
						],
						details: managementDetails(),
					};
				}
				match.killedBy = "kill-action";
				match.errorMessage = `Killed on request via the subagent kill action (last activity: ${match.activity ?? "unknown"}).`;
				controller.abort();
				return {
					content: [
						{
							type: "text",
							text: `Killed subagent "${match.name}". Its (aborted) report follows as a result message; re-launch the task if its work is still needed.`,
						},
					],
					details: managementDetails([structuredClone(match)]),
				};
			}

			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const mode: SubagentMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const makeDetails = (runs: SubagentRunSnapshot[]): SubagentToolDetails => ({
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				runs,
			});

			const fail = (text: string): AgentToolResult<SubagentToolDetails> => ({
				content: [{ type: "text", text }],
				details: makeDetails([]),
			});

			if (modeCount !== 1) {
				const available = discovery.agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return fail(
					`Provide exactly one mode: "task" (single), "tasks" (parallel), or "chain" (sequential). Available agents: ${available}`,
				);
			}

			const items: TaskInput[] = hasChain
				? (params.chain as TaskInput[])
				: hasTasks
					? (params.tasks as TaskInput[])
					: [
							{
								task: params.task as string,
								name: params.name,
								agent: params.agent,
								model: params.model,
								cwd: params.cwd,
								timeoutSeconds: params.timeoutSeconds,
							},
						];

			if (items.length > MAX_PARALLEL_TASKS) {
				return fail(`Too many tasks (${items.length}). Max is ${MAX_PARALLEL_TASKS}.`);
			}

			// Settings are read fresh per launch so settings.json edits apply without a restart.
			const settings = SettingsManager.create(ctx.cwd, getAgentDir());
			const modelPolicy = resolveSubagentModelPolicy(settings.getSubagentsSettings(), process.env);

			// Prepare all runs up front so a bad agent/model fails before anything spawns.
			const prepared: PreparedRun[] = [];
			for (let i = 0; i < items.length; i++) {
				const result = prepareRun(
					items[i],
					i,
					hasChain ? i + 1 : undefined,
					discovery.agents,
					ctx,
					modelPolicy.default,
				);
				if (typeof result === "string") return fail(`Task ${i + 1}: ${result}`);
				prepared.push(result);
			}
			const runs = prepared.map((p) => p.run);
			uniquifyNames(runs);

			// Model policy: every task's effective model must be allowed, or nothing launches.
			const refusal = checkModelPolicy(
				modelPolicy,
				prepared.map((p) => ({
					name: p.run.name,
					model: p.run.model,
					thinkingLevel: p.run.thinkingLevel,
					source: p.modelSource,
				})),
			);
			if (refusal) throw new Error(refusal);
			// This process enforces the pin; children cannot call subagent. The env also
			// carries it to any phi process started with those variables.
			const policyEnv = modelPolicyEnv(modelPolicy);
			if (Object.keys(policyEnv).length > 0) {
				for (const p of prepared) p.env = { ...p.env, ...policyEnv };
			}

			// Liveness watchdog + budgets: thresholds come from settings; per-task
			// timeoutSeconds overrides the budget for that run only.
			const watchdog = resolveWatchdogConfig(settings.getSubagentsSettings(), settings.getStreamIdleTimeoutMs());
			const isolation = resolveChildIsolation(settings.getSubagentsSettings(), process.env, hostFacts());
			for (let i = 0; i < prepared.length; i++) {
				const timeoutSeconds = items[i]?.timeoutSeconds;
				if (timeoutSeconds !== undefined) prepared[i].maxRuntimeMs = timeoutSeconds * 1000;
			}

			// Backgrounding needs a session loop that outlives this tool call (TUI
			// and RPC). In json/print mode the process would exit before the
			// children finish, so those always block.
			const canBackground = ctx.hasUI;
			const background = canBackground && (params.background ?? true);
			const launchGeneration = sessionGeneration;

			const parentNotified = new Map<SubagentRunSnapshot, Set<ParentWakeCondition>>();
			const onStall = (run: SubagentRunSnapshot, verdict: WatchdogVerdict | { kind: "recovered" }): void => {
				if (verdict.kind === "ok") return;
				const content = stallNoteText(run.name, verdict);
				const statusKey = `subagents:${run.name}`;
				const killed = isKillVerdict(verdict);
				if (ctx.hasUI && content) {
					ctx.ui.setStatus(statusKey, content);
					const clearAfterMs = verdict.kind === "recovered" ? 10_000 : killed ? 30_000 : undefined;
					if (clearAfterMs !== undefined) {
						setTimeout(() => ctx.ui.setStatus(statusKey, undefined), clearAfterMs).unref?.();
					}
				}
				const noteVerdict = stallNoteVerdict(verdict);
				if (!noteVerdict) return;

				// Liveness used to stay out of the parent model's context entirely, so a
				// background run spinning on a hung tool went unnoticed for hours once the
				// parent's turn had ended. The rule now: a background run wakes the parent
				// (followUp + triggerTurn) at most once per condition — soft stall, over
				// budget, killed — with one short, ephemeral note. Recovery and repeat
				// flags stay in the TUI. A blocking parent is still inside this tool call
				// and gets the outcome in its result, so it is never woken.
				const condition = parentWakeCondition(verdict);
				if (background && condition) {
					if (launchGeneration !== sessionGeneration) return;
					const seen = parentNotified.get(run) ?? new Set<ParentWakeCondition>();
					parentNotified.set(run, seen);
					if (seen.has(condition)) return;
					const wake = parentWakeText(run, verdict);
					if (!wake) return;
					seen.add(condition);
					try {
						pi.sendMessage<SubagentStallNoteDetails>(
							{
								customType: SUBAGENT_STALL_NOTE_MESSAGE_TYPE,
								content: wake,
								display: true,
								ephemeral: true,
								details: { name: run.name, verdict: noteVerdict, runId: run.runId ?? run.id },
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					} catch {
						// Session tearing down; the flag/kill still happened.
					}
					return;
				}
				if (!killed || !content) return;
				try {
					// Blocking mode: persist the kill note only; the failure report comes
					// back in this tool call's result.
					pi.sendMessage<SubagentStallNoteDetails>({
						customType: SUBAGENT_STALL_NOTE_MESSAGE_TYPE,
						content,
						display: true,
						ephemeral: true,
						details: { name: run.name, verdict: noteVerdict },
					});
				} catch {
					// Session tearing down; the kill still happened.
				}
			};

			// Project agents are repo-controlled code paths: confirm before running them.
			if (
				(agentScope === "project" || agentScope === "both") &&
				(params.confirmProjectAgents ?? true) &&
				ctx.hasUI
			) {
				const projectAgents = runs
					.filter((run) => run.agentSource === "project")
					.map((run) => run.agentName)
					.filter((name, i, arr): name is string => name !== undefined && arr.indexOf(name) === i);
				if (projectAgents.length > 0) {
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${projectAgents.join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) return fail("Canceled: project-local agents not approved.");
				}
			}

			const groupUsage = newUsage();
			const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;

			// Per-run kill handles: the /subagents viewer can abort one agent
			// without touching the rest; blocking mode also honors the turn signal.
			const controllers = new Map<SubagentRunSnapshot, AbortController>();
			for (const step of prepared) {
				const controller = new AbortController();
				controllers.set(step.run, controller);
				killRegistry.set(step.run, controller);
			}
			const signalFor = (run: SubagentRunSnapshot): AbortSignal => {
				const own = (controllers.get(run) as AbortController).signal;
				return background || !signal ? own : AbortSignal.any([signal, own]);
			};
			const releaseKillHandles = () => {
				for (const step of prepared) {
					killRegistry.delete(step.run);
					controlRegistry.delete(step.run);
				}
			};
			const onControlReady = (run: SubagentRunSnapshot, control: SubagentRunControl) => {
				controlRegistry.set(run, control);
			};
			const onChildMessage = (run: SubagentRunSnapshot, report: SubagentReport) => {
				deliverChildMessage(pi, run, report, background);
			};

			// Live feed for other built-ins (phi remote shows each run as a child thread).
			const emitFeed = (event: SubagentFeedEvent): void => {
				if (launchGeneration !== sessionGeneration) return;
				try {
					pi.events.emit(SUBAGENT_FEED_CHANNEL, event);
				} catch {
					// Stale session (replaced or shut down): nobody is listening any more.
				}
			};
			const feedControl = (run: SubagentRunSnapshot): SubagentFeedControl => ({
				send: (command) => controlRegistry.get(run)?.send(command) ?? false,
				kill: (reason) => {
					const controller = killRegistry.get(run);
					if (!controller || !isRunActive(run)) return false;
					run.killedBy = "kill-action";
					run.errorMessage = `${reason} (last activity: ${run.activity ?? "unknown"}).`;
					controller.abort();
					return true;
				},
			});
			const onRunStart = (run: SubagentRunSnapshot, index: number): void =>
				emitFeed({
					type: "start",
					run,
					toolCallId,
					index,
					mode,
					background,
					...(items[index]?.name ? { taskName: items[index].name } : {}),
					control: feedControl(run),
				});
			const onChildEvent = (run: SubagentRunSnapshot, event: Record<string, unknown>): void =>
				emitFeed({ type: "event", run, event });

			dashboard.register(toolCallId, mode, runs);

			if (background) {
				// Fire-and-forget: the group keeps running after this tool returns.
				// Results come back as subagent-results messages (follow-up turns). In
				// a parallel group each run is delivered the moment it finishes while
				// siblings are still running, so one straggler never withholds the
				// rest; the closing message carries only what was not delivered yet.
				const deliveredEarly = new Set<SubagentRunSnapshot>();
				const deliverFinishedRun = (run: SubagentRunSnapshot): void => {
					if (mode !== "parallel" || runs.length < 2 || launchGeneration !== sessionGeneration) return;
					const stillRunning = runs.filter((other) => other !== run && isRunActive(other)).map((r) => r.name);
					if (stillRunning.length === 0) return; // the closing group message carries it
					const finished = runs.length - stillRunning.length;
					try {
						pi.sendMessage<SubagentResultsMessageDetails>(
							{
								customType: SUBAGENT_RESULTS_MESSAGE_TYPE,
								content: finishedRunResultText(run, finished, runs.length, stillRunning),
								display: true,
								details: {
									mode,
									runs: [structuredClone(run)],
									group: { size: runs.length, finished, stillRunning },
								},
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
						deliveredEarly.add(run);
					} catch {
						// Session tearing down; the closing message still includes this run.
					}
				};
				void (async () => {
					let text: string;
					try {
						text = await executeGroup({
							mode,
							prepared,
							runs,
							concurrency,
							defaultCwd: ctx.cwd,
							parentSessionId: ctx.sessionManager.getSessionId(),
							groupId: toolCallId,
							parentListening: background,
							onControlReady,
							onRunStart,
							onChildEvent,
							onRunFinished: (run) => {
								controlRegistry.delete(run);
								emitFeed({ type: "end", run });
								deliverFinishedRun(run);
							},
							delivered: deliveredEarly,
							onChildMessage,
							watchdog,
							isolation,
							onStall,
							onSpawn: (run) =>
								pi.emitSubagentSpawn({
									type: "subagent_spawn",
									runId: run.runId ?? run.id,
									handle: run.handle ?? run.name,
									name: run.name,
									toolCallId,
									env: {},
								}) ?? Promise.resolve({}),
							signalFor,
							onChange: () => dashboard.update(),
							groupUsage,
						});
					} catch (error) {
						text = `Subagent group failed: ${error instanceof Error ? error.message : String(error)}`;
					} finally {
						releaseKillHandles();
						dashboard.complete(toolCallId);
					}
					const summary = formatUsageSummary(aggregateUsage(runs));
					const header = `[subagent results — ${mode}, ${runs.length} agent${runs.length === 1 ? "" : "s"}${summary ? ` · ${summary}` : ""}]`;
					const deliveredEarlier = runs.filter((run) => deliveredEarly.has(run)).map((run) => run.name);
					const details: SubagentResultsMessageDetails =
						deliveredEarlier.length === 0
							? { mode, runs }
							: {
									mode,
									runs: runs.filter((run) => !deliveredEarly.has(run)),
									group: { size: runs.length, finished: runs.length, stillRunning: [], deliveredEarlier },
								};
					try {
						pi.sendMessage<SubagentResultsMessageDetails>(
							{
								customType: SUBAGENT_RESULTS_MESSAGE_TYPE,
								content: `${header}\n\n${text}`,
								display: true,
								details,
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					} catch {
						// Session already torn down (shutdown killed the group); nothing to deliver to.
					}
				})();

				const names = runs
					.map((run) =>
						run.modelLabel && run.modelLabel !== run.name ? `${run.name} (${run.modelLabel})` : run.name,
					)
					.join(", ");
				return {
					content: [
						{
							type: "text",
							text: [
								`Launched ${runs.length} subagent${runs.length === 1 ? "" : "s"} in the background (${mode} mode): ${names}.`,
								mode === "parallel" && runs.length > 1
									? "Each result is delivered automatically as a follow-up message the moment that subagent finishes — do not poll or wait for them."
									: "Their results will be delivered automatically as a follow-up message when they finish — do not poll or wait for them.",
								"Continue with other work or end your turn; the user can keep interacting and watch progress with /subagents.",
							].join(" "),
						},
					],
					// Snapshot, not the live objects: this entry durably shows the launch.
					details: { ...makeDetails(structuredClone(runs)), background: true },
				};
			}

			// Blocking mode: throttled live updates — dashboard immediately,
			// transcript at most every 100ms.
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let lastUpdateAt = 0;
			const emitTranscriptUpdate = () => {
				if (!onUpdate) return;
				lastUpdateAt = Date.now();
				const running = runs.filter(isRunActive).length;
				const done = runs.length - running;
				onUpdate({
					content: [{ type: "text", text: `Subagents: ${done}/${runs.length} done, ${running} running` }],
					details: makeDetails(runs),
				});
			};
			const onChange = () => {
				dashboard.update();
				if (!onUpdate) return;
				const elapsed = Date.now() - lastUpdateAt;
				if (elapsed >= UPDATE_THROTTLE_MS) {
					emitTranscriptUpdate();
				} else if (!updateTimer) {
					updateTimer = setTimeout(() => {
						updateTimer = undefined;
						emitTranscriptUpdate();
					}, UPDATE_THROTTLE_MS - elapsed);
				}
			};

			try {
				const text = await executeGroup({
					mode,
					prepared,
					runs,
					concurrency,
					defaultCwd: ctx.cwd,
					parentSessionId: ctx.sessionManager.getSessionId(),
					groupId: toolCallId,
					parentListening: background,
					onControlReady,
					onRunStart,
					onChildEvent,
					onRunFinished: (run) => {
						controlRegistry.delete(run);
						emitFeed({ type: "end", run });
					},
					onChildMessage,
					watchdog,
					isolation,
					onStall,
					onSpawn: (run) =>
						pi.emitSubagentSpawn({
							type: "subagent_spawn",
							runId: run.runId ?? run.id,
							handle: run.handle ?? run.name,
							name: run.name,
							toolCallId,
							env: {},
						}),
					signalFor,
					onChange,
					groupUsage,
				});
				return {
					content: [{ type: "text", text }],
					details: makeDetails(runs),
					usage: groupUsage,
				};
			} finally {
				if (updateTimer) clearTimeout(updateTimer);
				releaseKillHandles();
				dashboard.complete(toolCallId);
			}
		},

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme);
		},
	});

	// Watchdog verdicts render as a single warning line (the details carry the verdict).
	pi.registerMessageRenderer<SubagentStallNoteDetails>(
		SUBAGENT_STALL_NOTE_MESSAGE_TYPE,
		(message, _options, theme) => {
			const text =
				typeof message.content === "string"
					? message.content
					: `subagent watchdog: ${message.details?.verdict ?? "note"}`;
			const color = "warning";
			return new Text(theme.fg(color, truncateText(text, 220)), 0, 0);
		},
	);

	// Post-compaction continuity notes render as a single muted line.
	pi.registerMessageRenderer<{ names: string[] }>(
		SUBAGENT_COMPACTION_NOTE_MESSAGE_TYPE,
		(message, _options, theme) => {
			const names = message.details?.names?.join(", ");
			const text = names
				? `subagents still running after compaction: ${names}`
				: typeof message.content === "string"
					? message.content
					: "subagents still running after compaction";
			return new Text(theme.fg("muted", truncateText(text, 200)), 0, 0);
		},
	);

	// Lost-run recovery notes render as a single warning line.
	pi.registerMessageRenderer<SubagentLostMessageDetails>(SUBAGENT_LOST_MESSAGE_TYPE, (message, _options, theme) => {
		const names = message.details?.names?.join(", ");
		const text = names
			? `background subagents lost to a phi restart (not running, will be re-launched if needed): ${names}`
			: typeof message.content === "string"
				? message.content
				: "background subagents lost to a phi restart";
		return new Text(theme.fg("warning", truncateText(text, 200)), 0, 0);
	});

	pi.registerMessageRenderer<SubagentMessageDetails>(SUBAGENT_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details;
		const prefix = details ? `${details.name} asks (${details.kind})` : "subagent asks";
		return new Text(
			theme.fg("warning", `? ${prefix}: `) +
				theme.fg("text", truncateText((details?.message ?? String(message.content)).replace(/\s+/g, " "), 180)),
			0,
			0,
		);
	});

	// Background results arrive as a custom message; render them like a settled
	// tool result (board + totals collapsed, full per-run sections expanded).
	pi.registerMessageRenderer<SubagentResultsMessageDetails>(
		SUBAGENT_RESULTS_MESSAGE_TYPE,
		(message, options, theme) => {
			const details = message.details;
			if (!details || details.runs.length === 0) {
				const content = typeof message.content === "string" ? message.content : "(subagent results)";
				return new Text(theme.fg("muted", truncateText(content, 200)), 0, 0);
			}
			return renderSettledRuns(details.runs, theme, { expanded: options.expanded, title: "subagent results" });
		},
	);

	// Durable board snapshots: /subagents pins the current (or last) board into
	// the transcript so a swarm's state is inspectable after the widget clears.
	pi.registerEntryRenderer("subagents-board", (entry, _options, theme) => {
		const data = entry.data as { runs: SubagentRunSnapshot[]; capturedAt: number } | undefined;
		if (!data || data.runs.length === 0) return new Text(theme.fg("muted", "No subagent runs recorded."), 0, 0);
		const lines = buildBoardLines(data.runs, theme, data.capturedAt, { title: "subagents (snapshot)" });
		lines.push(buildTotalsRow(data.runs, theme));
		for (const run of data.runs) {
			if (isRunFailed(run) && run.errorMessage) {
				lines.push(theme.fg("error", `  ${run.name}: ${truncateText(run.errorMessage, 120)}`));
			}
		}
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerCommand("subagents", {
		description: "Inspect subagents: live board, per-agent threads, kill runs, pin snapshots",
		acceptsArgs: false,
		handler: async (_args, ctx) => {
			dashboard.attach(ctx.ui, (run) => openViewer(ctx, run));

			if (currentRuns().length === 0) {
				ctx.ui.notify("No subagents have run in this session. The subagent tool starts them.", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				pin();
				return;
			}

			// Interactive viewer: select an agent thread, watch it live, kill it.
			await openViewer(ctx);
		},
	});
}
