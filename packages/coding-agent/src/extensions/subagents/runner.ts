/**
 * Child-process runner for the subagents extension.
 *
 * Each run spawns a fresh phi process in `--mode json -p --no-session` and
 * consumes its event stream line by line, mutating a `SubagentRunSnapshot`
 * in place: usage totals, current activity, a distilled timeline, and the
 * final assistant text. `onChange` fires after every meaningful event so the
 * caller can throttle UI updates however it likes.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { SUBAGENT_CONTROL_ENV } from "../../core/subagent-control.ts";
import { describeToolCall, subagentDiagnostics, truncateText } from "./format.ts";
import {
	type ChildIsolationConfig,
	cgroupPathForPid,
	childEnvironmentHints,
	describeIsolation,
	formatBytes,
	killScope,
	oomAdviceText,
	probeIsolation,
	readCgroupMemory,
	scopeUnitName,
	wrapInvocation,
} from "./isolation.ts";
import type {
	SubagentPendingQuestion,
	SubagentRecoveryMetadata,
	SubagentReport,
	SubagentRunSnapshot,
	SubagentTimelineItem,
} from "./types.ts";
import {
	budgetKillMessage,
	evaluateWatchdog,
	formatIdleMinutes,
	hardCapKillMessage,
	type SubagentWatchdogConfig,
	stallKillMessage,
	toolRunawayKillMessage,
	type WatchdogVerdict,
} from "./watchdog.ts";

const MAX_TIMELINE_ITEMS = 160;
const MAX_TEXT_SNIPPET_CHARS = 400;
const MAX_FINAL_TEXT_BYTES = 50 * 1024;
const MAX_STDERR_TAIL_CHARS = 2000;
// Two small sysfs reads per tick; fast enough to catch a worker OOM-kill while
// the child itself is still alive (the scope is collected the moment it empties).
const CGROUP_SAMPLE_INTERVAL_MS = 2_000;
// Tiny custom watchdog intervals must not SIGTERM a just-spawned process
// before its JS entry point can install a handler or emit its first event.
const MIN_PROCESS_STARTUP_MS = 250;
const NO_ISOLATION: ChildIsolationConfig = { enabled: false };
const MAX_IN_FLIGHT_TEXT_BYTES = 4 * 1024;
const MAX_RECOVERY_TRANSITIONS = 32;
const MAX_MODEL_METADATA_CHARS = 160;
const SAFE_MODEL_METADATA = /^[A-Za-z0-9@][A-Za-z0-9@._:+/-]*$/;
export const DEFAULT_SHUTDOWN_GRACE_MS = 20_000;
export const PARENT_MESSAGE_GRACE_MS = 2_000;

export type SubagentControlCommand =
	| { type: "steer" | "follow_up"; message: string }
	| { type: "reply"; toolCallId: string; text: string }
	| { type: "abort" };

export interface SubagentRunControl {
	/** True if the JSONL command was accepted by the pipe (not an acknowledgement from the child model). */
	send: (command: SubagentControlCommand) => boolean;
}

export interface RunProcessOptions {
	defaultCwd: string;
	/** The run to mutate. Must be in "pending" status. */
	run: SubagentRunSnapshot;
	/** `provider/modelId[:thinking]` passed to the child's --model. Undefined = child default. */
	modelArg?: string;
	/** Tool names restriction for the child (--tools). */
	tools?: string[];
	/** Appended system prompt (from a named agent definition). */
	systemPrompt?: string;
	signal?: AbortSignal;
	/** Fired after every event that changed the run. */
	onChange: () => void;
	/** Accumulates the child's raw assistant usage for parent-session accounting. */
	groupUsage: Usage;
	/** A background parent can respond to a waiting child; blocking mode cannot. */
	parentListening?: boolean;
	/** The writable handle is live only between spawn and process close. */
	onControlReady?: (control: SubagentRunControl) => void;
	/** Fired when a child calls message_parent, including non-interrupting progress. */
	onChildMessage?: (run: SubagentRunSnapshot, report: SubagentReport) => void;
	/** Every parsed record of the child's JSON stream, after the run was updated from it. */
	onEvent?: (event: Record<string, unknown>) => void;
	env?: Record<string, string>;
	/** Generic hook invoked before spawn; returned values are merged into env. */
	onSpawn?: (
		env: Record<string, string>,
	) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined;
	/** Liveness watchdog config. Undefined disables the watchdog entirely. */
	watchdog?: SubagentWatchdogConfig;
	/** Wall-clock budget for this run (ms). Overrides watchdog.maxRuntimeMs; 0 disables. */
	maxRuntimeMs?: number;
	/** Notified on watchdog verdicts for TUI/status surfacing and kill-note persistence. */
	onStall?: (run: SubagentRunSnapshot, verdict: WatchdogVerdict | { kind: "recovered" }) => void;
	/** Test seam: base command to spawn instead of re-invoking phi. Args are appended. */
	invocation?: { command: string; args: string[] };
	/**
	 * Per-child cgroup isolation (Linux/systemd). Resolved once per launch by the
	 * extension; undefined = spawn directly. Fails open when the host cannot do it.
	 */
	isolation?: ChildIsolationConfig;
	/** Grace after SIGTERM before SIGKILL. Defaults to 20 seconds. */
	shutdownGraceMs?: number;
}

export function accumulateUsage(target: Usage, source: Usage): void {
	target.input += source.input || 0;
	target.output += source.output || 0;
	target.cacheRead += source.cacheRead || 0;
	target.cacheWrite += source.cacheWrite || 0;
	target.totalTokens += source.totalTokens || 0;
	target.cost.input += source.cost?.input || 0;
	target.cost.output += source.cost?.output || 0;
	target.cost.cacheRead += source.cost?.cacheRead || 0;
	target.cost.cacheWrite += source.cost?.cacheWrite || 0;
	target.cost.total += source.cost?.total || 0;
}

export function newUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function writePromptToTempFile(name: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

/**
 * Resolve how to launch a child phi. When running from source or an installed
 * script, re-invoke the same entry point; from a compiled binary, re-invoke
 * the binary; otherwise fall back to `pi` on PATH.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function pushTimeline(run: SubagentRunSnapshot, item: SubagentTimelineItem): void {
	run.timeline.push(item);
	if (run.timeline.length > MAX_TIMELINE_ITEMS) {
		run.timeline.splice(0, run.timeline.length - MAX_TIMELINE_ITEMS);
		run.timelineDropped++;
	}
}

function capTextBytes(text: string, maxBytes: number, suffix: string): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	let truncated = text.slice(0, Math.max(0, maxBytes - suffixBytes));
	while (Buffer.byteLength(truncated, "utf8") + suffixBytes > maxBytes) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}${suffix}`;
}

function capFinalText(text: string): string {
	return capTextBytes(text, MAX_FINAL_TEXT_BYTES, "\n\n[Final output truncated at 50KB]");
}

function capInFlightText(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_IN_FLIGHT_TEXT_BYTES) return text;
	const marker = "[Earlier in-flight output truncated]\n";
	let tail = text;
	while (Buffer.byteLength(marker + tail, "utf8") > MAX_IN_FLIGHT_TEXT_BYTES) tail = tail.slice(1);
	return marker + tail;
}

function safeModelMetadata(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_MODEL_METADATA_CHARS) return undefined;
	return SAFE_MODEL_METADATA.test(value) ? value : undefined;
}

function ensureRecovery(run: SubagentRunSnapshot): SubagentRecoveryMetadata {
	if (run.recovery) return run.recovery;
	run.recovery = {
		retryCount: 0,
		retryRecovered: false,
		fallbackTransitions: [],
		fallbackRestored: false,
		fallbackExhausted: false,
	};
	return run.recovery;
}

/** Apply only bounded, non-error details from a child recovery event. */
export function recordSubagentRecoveryEvent(run: SubagentRunSnapshot, event: Record<string, unknown>): void {
	switch (event.type) {
		case "auto_retry_start":
			ensureRecovery(run).retryCount++;
			return;
		case "auto_retry_end":
			if (event.success === true) ensureRecovery(run).retryRecovered = true;
			return;
		case "error_fallback": {
			// A later successful response without responseModel must not inherit
			// attribution from the model that just failed.
			run.servedModel = undefined;
			const from = safeModelMetadata(event.from);
			const to = safeModelMetadata(event.to);
			if (!from || !to) return;
			const recovery = ensureRecovery(run);
			if (recovery.fallbackTransitions.length < MAX_RECOVERY_TRANSITIONS) {
				recovery.fallbackTransitions.push({ from, to });
			}
			return;
		}
		case "error_fallback_restored":
			ensureRecovery(run).fallbackRestored = true;
			return;
		case "error_fallback_exhausted":
			ensureRecovery(run).fallbackExhausted = true;
			return;
		default:
			return;
	}
}

function isSemanticEvent(event: Record<string, unknown>): boolean {
	return [
		"agent_start",
		"agent_end",
		"agent_settled",
		"turn_start",
		"turn_end",
		"message_start",
		"message_update",
		"message_end",
		"text_delta",
		"thinking_delta",
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
	].includes(event.type as string);
}

function textFromMessage(message: Record<string, unknown> | undefined): string {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: string; text: string } => {
			if (!part || typeof part !== "object") return false;
			const candidate = part as Record<string, unknown>;
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((part) => part.text)
		.join("");
}

/**
 * Execute one subagent run. Never throws: failures (including abort) are
 * recorded on the run snapshot.
 */
export async function executeRun(options: RunProcessOptions): Promise<void> {
	const { run, onChange, groupUsage } = options;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (options.modelArg) args.push("--model", options.modelArg);
	if (options.tools && options.tools.length > 0) {
		// Named agents may restrict tools, but every controlled child still needs
		// its own message_parent channel to report progress or ask a question.
		args.push("--tools", [...new Set([...options.tools, "message_parent"])].join(","));
	}

	let tmpPromptDir: string | null = null;

	run.status = "running";
	run.startedAt = Date.now();
	run.activity = "starting";
	run.turnState = "mid-turn";
	onChange();

	// Tool timeline items by child toolCallId, so completion events can flag errors.
	const pendingToolItems = new Map<string, Extract<SubagentTimelineItem, { kind: "tool" }>>();
	// Wall-clock start of each outstanding tool execution, for the per-tool
	// runaway ceiling. message_parent is excluded: its wait has its own timeout.
	const toolStartedAt = new Map<string, number>();
	const pendingQuestions = new Map<string, SubagentPendingQuestion>();
	let onSettled: (() => void) | undefined;
	let onTurnStart: (() => void) | undefined;
	let unknownToolActive = false;
	let unknownToolStartedAt: number | undefined;
	let unknownToolLabel: string | undefined;
	const oldestOutstandingTool = (): { startedAt: number; label: string | undefined } | undefined => {
		let oldest: { startedAt: number; label: string | undefined } | undefined;
		for (const [toolCallId, startedAt] of toolStartedAt) {
			if (oldest && oldest.startedAt <= startedAt) continue;
			const item = pendingToolItems.get(toolCallId);
			oldest = { startedAt, label: item ? `${item.name}: ${item.detail}` : undefined };
		}
		if (
			unknownToolActive &&
			unknownToolStartedAt !== undefined &&
			(!oldest || unknownToolStartedAt < oldest.startedAt)
		) {
			oldest = { startedAt: unknownToolStartedAt, label: unknownToolLabel };
		}
		return oldest;
	};
	let inFlightText = "";
	let wasAborted = false;

	// Only parsed semantic events prove liveness. A stalled flag clears the
	// moment one arrives; raw stdout/stderr bytes are intentionally excluded.
	const noteSemanticEvent = (event: Record<string, unknown>): void => {
		if (!isSemanticEvent(event)) return;
		const now = Date.now();
		run.lastEventAt = now;
		run.firstParsedEventAt ??= now;
		if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
			unknownToolActive = false;
			unknownToolStartedAt = undefined;
		}
		if (run.stalled && !run.killedBy) {
			run.stalled = false;
			options.onStall?.(run, { kind: "recovered" });
			onChange();
		}
	};

	const handleEvent = (event: Record<string, unknown>): void => {
		noteSemanticEvent(event);
		recordSubagentRecoveryEvent(run, event);
		if (
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end" ||
			event.type === "error_fallback" ||
			event.type === "error_fallback_restored" ||
			event.type === "error_fallback_exhausted"
		) {
			run.activity = `recovery: ${event.type.replaceAll("_", " ")}`;
			onChange();
		}
		switch (event.type) {
			case "agent_start":
				run.turnState = "mid-turn";
				onTurnStart?.();
				onChange();
				return;
			case "agent_settled":
				run.turnState = "idle-awaiting-close";
				onChange();
				onSettled?.();
				return;
			case "tool_execution_start": {
				const toolName = (event.toolName as string) || "tool";
				const toolArgs =
					event.args && typeof event.args === "object" && !Array.isArray(event.args)
						? (event.args as Record<string, unknown>)
						: {};
				const detail = describeToolCall(toolName, toolArgs);
				const item: Extract<SubagentTimelineItem, { kind: "tool" }> = { kind: "tool", name: toolName, detail };
				pushTimeline(run, item);
				const startedAt = Date.now();
				if (typeof event.toolCallId === "string") {
					pendingToolItems.set(event.toolCallId, item);
					if (toolName !== "message_parent") toolStartedAt.set(event.toolCallId, startedAt);
				} else {
					unknownToolActive = true;
					unknownToolStartedAt ??= startedAt;
					unknownToolLabel = `${toolName}: ${detail}`;
				}
				run.usage.toolCalls++;
				run.activity = detail;
				if (toolName === "message_parent" && typeof event.toolCallId === "string") {
					const message = toolArgs.message;
					const kind = toolArgs.kind ?? "question";
					if (
						typeof message === "string" &&
						message.trim() &&
						(kind === "progress" || kind === "question" || kind === "blocker")
					) {
						const report: SubagentReport = { kind, message: message.slice(0, 8192), at: Date.now() };
						run.lastReport = report;
						if (kind !== "progress") {
							const timeoutSeconds =
								typeof toolArgs.timeoutSeconds === "number" && Number.isFinite(toolArgs.timeoutSeconds)
									? Math.min(1800, Math.max(1, toolArgs.timeoutSeconds))
									: 600;
							const pending: SubagentPendingQuestion = {
								...report,
								kind,
								toolCallId: event.toolCallId,
								timeoutSeconds,
							};
							pendingQuestions.set(pending.toolCallId, pending);
							run.pendingQuestion = pending;
						}
						try {
							options.onChildMessage?.(run, report);
						} catch {
							// Parent session may be shutting down; still track the child's state.
						}
					}
				}
				onChange();
				return;
			}
			case "tool_execution_end": {
				if (event.isError === true && typeof event.toolCallId === "string") {
					const item = pendingToolItems.get(event.toolCallId);
					if (item) item.isError = true;
				}
				if (typeof event.toolCallId === "string") {
					pendingToolItems.delete(event.toolCallId);
					toolStartedAt.delete(event.toolCallId);
					pendingQuestions.delete(event.toolCallId);
					run.pendingQuestion = [...pendingQuestions.values()].at(-1);
				} else unknownToolActive = false;
				if (unknownToolActive && typeof event.toolCallId === "string" && !pendingToolItems.has(event.toolCallId)) {
					unknownToolActive = false;
				}
				if (!unknownToolActive) unknownToolStartedAt = undefined;
				onChange();
				return;
			}
			case "message_update": {
				const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
				const delta =
					assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string"
						? assistantEvent.delta
						: typeof event.delta === "string"
							? event.delta
							: undefined;
				if (delta !== undefined) {
					inFlightText = capInFlightText(`${inFlightText}${delta}`);
				} else {
					const snapshot = textFromMessage(event.message as Record<string, unknown> | undefined);
					if (snapshot) {
						inFlightText = capInFlightText(
							snapshot.startsWith(inFlightText)
								? snapshot
								: inFlightText.endsWith(snapshot)
									? inFlightText
									: `${inFlightText}${snapshot}`,
						);
					}
				}
				if (inFlightText) run.inFlightText = inFlightText;
				run.activity = "responding";
				onChange();
				return;
			}
			case "message_end": {
				const message = event.message as Message | undefined;
				if (!message || message.role !== "assistant") return;
				run.usage.turns++;
				const usage = message.usage;
				if (usage) {
					run.usage.input += usage.input || 0;
					run.usage.output += usage.output || 0;
					run.usage.cacheRead += usage.cacheRead || 0;
					run.usage.cacheWrite += usage.cacheWrite || 0;
					run.usage.cost += usage.cost?.total || 0;
					run.usage.contextTokens = usage.totalTokens || run.usage.contextTokens;
					accumulateUsage(groupUsage, usage);
				}
				if (!run.model && message.model) run.model = message.model;
				if (!message.errorMessage && message.stopReason !== "error" && message.stopReason !== "aborted") {
					const servedModel = safeModelMetadata(message.responseModel);
					if (servedModel) run.servedModel = servedModel;
				}
				if (message.stopReason) run.stopReason = message.stopReason;
				if (message.errorMessage) run.errorMessage = message.errorMessage;
				for (const part of message.content) {
					if (part.type === "text" && part.text.trim()) {
						pushTimeline(run, { kind: "text", text: truncateText(part.text.trim(), MAX_TEXT_SNIPPET_CHARS) });
						run.finalText = capFinalText(part.text.trim());
					}
				}
				inFlightText = "";
				run.inFlightText = undefined;
				run.activity = "thinking";
				onChange();
				return;
			}
			default:
				return;
		}
	};

	try {
		if (options.systemPrompt?.trim()) {
			const tmp = await writePromptToTempFile(run.name, options.systemPrompt);
			tmpPromptDir = tmp.dir;
			args.push("--append-system-prompt", tmp.filePath);
		}

		args.push(`Task: ${run.task}`);

		const directInvocation = options.invocation
			? { command: options.invocation.command, args: [...options.invocation.args, ...args] }
			: getPiInvocation(args);
		const spawnEnv: Record<string, string> = { ...process.env, ...options.env } as Record<string, string>;
		const contributedEnv = await options.onSpawn?.(spawnEnv);
		if (contributedEnv) Object.assign(spawnEnv, contributedEnv);
		spawnEnv[SUBAGENT_CONTROL_ENV] = "stdin";
		spawnEnv.PI_SUBAGENT_PARENT_LISTENING = options.parentListening ? "1" : "0";

		// Cgroup isolation: the child gets its own systemd scope with a memory
		// ceiling and CPU quota so a fan-out inside it can never OOM the parent's
		// pane. Worker-cap hints are exported either way (they help on hosts
		// without systemd too), and the parent pid lets the child notice if we die.
		const isolationConfig = options.isolation ?? NO_ISOLATION;
		Object.assign(spawnEnv, childEnvironmentHints(isolationConfig, process.pid, spawnEnv));
		const isolated = isolationConfig.enabled && probeIsolation(isolationConfig, spawnEnv);
		const unitName = isolated ? scopeUnitName(run.runId ?? run.id) : undefined;
		const invocation = unitName
			? wrapInvocation(
					directInvocation,
					isolationConfig,
					unitName,
					`phi subagent ${run.name} (parent pid ${process.pid})`,
				)
			: directInvocation;
		if (unitName) run.isolation = { unit: unitName, summary: describeIsolation(isolationConfig) };

		let exitSignal: NodeJS.Signals | null = null;
		let weKilledIt = false;
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.run.cwd ?? options.defaultCwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: spawnEnv,
			});
			run.pid = proc.pid;
			const spawnedAt = Date.now();
			let buffer = "";
			let closed = false;
			let shuttingDown = false;
			let closeTimer: ReturnType<typeof setTimeout> | undefined;
			const clearCloseTimer = () => {
				if (closeTimer) clearTimeout(closeTimer);
				closeTimer = undefined;
			};
			const closeIfSettled = () => {
				clearCloseTimer();
				if (closed || run.turnState !== "idle-awaiting-close" || run.pendingQuestion) return;
				const remaining = PARENT_MESSAGE_GRACE_MS - (Date.now() - (run.lastParentMessageAt ?? 0));
				if (remaining > 0) {
					closeTimer = setTimeout(closeIfSettled, remaining);
					return;
				}
				if (!proc.stdin.destroyed && !proc.stdin.writableEnded) proc.stdin.end();
			};
			onSettled = closeIfSettled;
			onTurnStart = clearCloseTimer;
			// EPIPE/ERR_STREAM_DESTROYED after a quick child exit is expected, not
			// an unhandled stream error or a failure of an otherwise finished run.
			proc.stdin.on("error", () => {});
			options.onControlReady?.({
				send(command) {
					if (
						closed ||
						proc.exitCode !== null ||
						proc.signalCode !== null ||
						proc.stdin.destroyed ||
						proc.stdin.writableEnded
					) {
						return false;
					}
					try {
						proc.stdin.write(`${JSON.stringify(command)}\n`);
						run.lastParentMessageAt = Date.now();
						if (command.type === "steer" || command.type === "follow_up") {
							if (run.turnState === "idle-awaiting-close") run.turnState = "mid-turn";
							clearCloseTimer();
						}
						onChange();
						return true;
					} catch {
						return false;
					}
				},
			});
			let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
			const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

			// In an isolated scope the SIGKILL also sweeps the whole cgroup, so jest
			// workers / headless browsers the child left behind die with it instead
			// of lingering in the pane.
			const killProcEscalating = (): void => {
				if (closed || shuttingDown) return;
				shuttingDown = true;
				weKilledIt = true;
				proc.kill("SIGTERM");
				shutdownTimer = setTimeout(() => {
					if (!closed) proc.kill("SIGKILL");
					if (unitName) killScope(unitName, "SIGKILL", spawnEnv);
				}, shutdownGraceMs);
				shutdownTimer.unref?.();
			};

			// Memory telemetry: sample the child's own cgroup so a ceiling hit is
			// reported to the model as what it is, not as a mysterious exit code.
			let cgroupDir: string | undefined;
			let cgroupTimer: ReturnType<typeof setInterval> | undefined;
			const sampleCgroup = (): void => {
				if (!unitName || proc.pid === undefined) return;
				if (!cgroupDir) {
					const dir = cgroupPathForPid(proc.pid);
					// Only trust a path that is really our scope (not the pane's cgroup
					// before systemd-run moved the process, or after it was collected).
					if (!dir || !dir.includes(unitName)) return;
					cgroupDir = dir;
				}
				const sample = readCgroupMemory(cgroupDir);
				if (!sample) return;
				if (sample.peakBytes !== undefined && sample.peakBytes > (run.memoryPeakBytes ?? 0)) {
					run.memoryPeakBytes = sample.peakBytes;
				}
				if (sample.oomKills !== undefined && sample.oomKills > (run.oomKills ?? 0)) {
					const first = (run.oomKills ?? 0) === 0;
					run.oomKills = sample.oomKills;
					if (first) {
						pushTimeline(run, {
							kind: "text",
							text: `memory ceiling hit: kernel OOM-killed a process inside this subagent's cgroup (${run.isolation?.summary ?? "capped scope"})`,
						});
					}
					onChange();
				}
			};
			if (unitName) {
				cgroupTimer = setInterval(sampleCgroup, CGROUP_SAMPLE_INTERVAL_MS);
				cgroupTimer.unref?.();
			}

			// Watchdog tick: semantic silence and the soft/hard budget policy share
			// one interval, which is cleared as soon as the process closes.
			let watchdogTimer: ReturnType<typeof setInterval> | undefined;
			if (
				options.watchdog &&
				(options.watchdog.enabled || (options.maxRuntimeMs !== undefined && options.maxRuntimeMs > 0))
			) {
				const config = options.watchdog;
				watchdogTimer = setInterval(() => {
					if (run.status !== "running" || run.killedBy || wasAborted) return;
					const now = Date.now();
					if (
						options.maxRuntimeMs === undefined &&
						run.firstParsedEventAt === undefined &&
						now - spawnedAt < MIN_PROCESS_STARTUP_MS
					)
						return;
					const oldestTool = oldestOutstandingTool();
					const evaluated = evaluateWatchdog(
						config,
						{
							startedAt: run.startedAt ?? now,
							spawnedAt,
							lastEventAt: run.lastEventAt,
							firstParsedEventAt: run.firstParsedEventAt,
							inTool: pendingToolItems.size > 0 || unknownToolActive,
							oldestToolStartedAt: oldestTool?.startedAt,
							waitingForParent: pendingQuestions.size > 0,
							alreadyStalled: run.stalled === true,
							maxRuntimeMs: options.maxRuntimeMs,
							explicitMaxRuntimeMs: options.maxRuntimeMs !== undefined,
							overBudget: run.overBudget === true,
							budgetLastCheckedAt: run.budgetLastCheckedAt,
						},
						now,
					);
					const verdict: WatchdogVerdict =
						evaluated.kind === "tool-runaway" ? { ...evaluated, tool: oldestTool?.label } : evaluated;
					if (verdict.kind === "ok") return;
					if (verdict.kind === "soft-stall") {
						run.stalled = true;
						run.activity = `stalled — no parsed events for ${formatIdleMinutes(verdict.idleMs)}`;
						options.onStall?.(run, verdict);
						onChange();
						return;
					}
					if (verdict.kind === "over-budget") {
						const firstNotice = run.overBudget !== true;
						run.overBudget = true;
						run.overBudgetAt ??= now;
						run.budgetLastCheckedAt = now;
						run.activity = "over budget — still producing";
						if (firstNotice) options.onStall?.(run, verdict);
						onChange();
						return;
					}
					if (verdict.kind === "stall-kill") {
						run.killedBy = "watchdog";
						const lastTool = [...run.timeline].reverse().find((item) => item.kind === "tool");
						run.errorMessage = stallKillMessage(
							verdict.idleMs,
							verdict.inTool,
							lastTool && lastTool.kind === "tool" ? `${lastTool.name}: ${lastTool.detail}` : run.activity,
						);
						run.activity = "killed: stalled";
					} else if (verdict.kind === "tool-runaway") {
						run.killedBy = "watchdog";
						run.errorMessage = toolRunawayKillMessage(verdict.tool, verdict.toolMs, verdict.toolMaxMs);
						run.activity = `killed: tool ran ${formatIdleMinutes(verdict.toolMs)}`;
					} else if (verdict.kind === "hard-cap-kill") {
						run.killedBy = "budget";
						run.budgetLastCheckedAt = now;
						run.errorMessage = hardCapKillMessage(verdict.elapsedMs, verdict.capMs);
						run.activity = "killed: absolute run ceiling";
					} else {
						run.killedBy = "budget";
						run.budgetLastCheckedAt = now;
						run.errorMessage = budgetKillMessage(
							verdict.elapsedMs,
							verdict.budgetMs,
							verdict.idleMs,
							verdict.inTool,
							verdict.explicit,
						);
						run.activity = verdict.explicit ? "killed: timeoutSeconds cap" : "killed: over budget and idle";
					}
					options.onStall?.(run, verdict);
					onChange();
					killProcEscalating();
				}, config.checkIntervalMs);
				watchdogTimer.unref?.();
			}

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					return;
				}
				if (!event || typeof event !== "object" || Array.isArray(event)) return;
				handleEvent(event);
				if (options.onEvent) {
					try {
						options.onEvent(event);
					} catch {
						// Observers never affect the run.
					}
				}
			};

			proc.stdout.on("data", (data) => {
				// Raw bytes are not liveness. Parsed semantic lines update lastEventAt
				// in handleEvent; this prevents stderr retry storms from looking healthy.
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				run.stderrTail = ((run.stderrTail ?? "") + data.toString()).slice(-MAX_STDERR_TAIL_CHARS);
			});

			proc.on("close", (code, signal) => {
				closed = true;
				clearCloseTimer();
				onSettled = undefined;
				onTurnStart = undefined;
				exitSignal = signal;
				if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
				if (watchdogTimer !== undefined) clearInterval(watchdogTimer);
				if (cgroupTimer !== undefined) clearInterval(cgroupTimer);
				// Last look before systemd collects the (now empty) scope. Best effort.
				sampleCgroup();
				if (buffer.trim()) processLine(buffer);
				// A signal-terminated child reports a null code; map it to the
				// conventional 128+signal so kills never masquerade as success.
				const signalExitCode = signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1;
				resolve(code ?? (signal ? signalExitCode : 0));
			});
			proc.on("error", (error) => {
				run.errorMessage = run.errorMessage ?? `Failed to spawn subagent process: ${error.message}`;
				resolve(1);
			});

			if (options.signal) {
				const killProc = () => {
					wasAborted = true;
					killProcEscalating();
				};
				if (options.signal.aborted) killProc();
				else options.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		run.exitCode = exitCode;
		if (wasAborted) {
			run.status = "aborted";
			run.activity = "aborted";
		} else if (run.killedBy || exitCode !== 0 || run.stopReason === "error" || run.stopReason === "aborted") {
			run.status = "failed";
			if (!run.killedBy) run.activity = "failed";
			// A child that died with OOM kills in its cgroup and no other explanation
			// was almost certainly the victim of its own fan-out — say so. When the
			// child itself was the victim there is no cgroup left to read, but an
			// isolated child SIGKILLed by something other than us is the same story.
			if (run.isolation && exitSignal === "SIGKILL" && !weKilledIt && !run.killedBy && (run.oomKills ?? 0) === 0) {
				run.suspectedOomKill = true;
			}
			if (((run.oomKills ?? 0) > 0 || run.suspectedOomKill) && !run.errorMessage) {
				const peak = run.memoryPeakBytes !== undefined ? `, peak ${formatBytes(run.memoryPeakBytes)}` : "";
				const kills =
					(run.oomKills ?? 0) > 0
						? `after ${run.oomKills} kernel OOM kill${run.oomKills === 1 ? "" : "s"} inside`
						: "SIGKILLed by something other than phi while running inside";
				run.errorMessage = `process exited with code ${exitCode} ${kills} its memory-capped cgroup (${run.isolation?.summary ?? ""}${peak}) — almost certainly the kernel OOM killer at the ceiling`;
			}
		} else {
			run.status = "done";
			run.activity = "done";
		}
	} catch (error) {
		run.status = "failed";
		run.activity = "failed";
		run.errorMessage = error instanceof Error ? error.message : String(error);
	} finally {
		run.endedAt = Date.now();
		if (tmpPromptDir) {
			try {
				fs.rmSync(tmpPromptDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
		onChange();
	}
}

/** The text a failed or finished run contributes back to the parent LLM. */
export function runOutputForModel(run: SubagentRunSnapshot): string {
	const diagnostics = subagentDiagnostics(run);
	const oomNote =
		(run.oomKills ?? 0) > 0 || run.suspectedOomKill
			? oomAdviceText(run.oomKills ?? 0, run.memoryPeakBytes, run.isolation?.summary)
			: undefined;
	if (run.status !== "failed" && run.status !== "aborted") {
		let output = run.finalText || "(no output)";
		if (diagnostics) output = `${output}\n\n[Subagent diagnostics: ${diagnostics}]`;
		if (oomNote)
			output = capTextBytes(`${output}\n\n${oomNote}`, MAX_FINAL_TEXT_BYTES, "\n\n[Output truncated at 50KB]");
		return output;
	}

	const error =
		run.errorMessage ||
		run.stderrTail ||
		(run.exitCode !== undefined ? `process exited with code ${run.exitCode}` : "run ended without an error message");
	const sections = [`## Run failed: ${error}`];
	if (run.finalText) {
		sections.push("## Partial output before failure (preserved — the run did real work before dying)", run.finalText);
	}
	if (run.inFlightText) {
		sections.push("## In-flight partial output (turn was killed)", run.inFlightText);
	}
	if (run.timeline.length > 0) {
		const trail = run.timeline.slice(-20).map((item) => {
			if (item.kind === "tool") return `- tool ${item.name}${item.isError ? " [error]" : ""}: ${item.detail}`;
			return `- text: ${item.text}`;
		});
		sections.push("## Recent activity before failure", trail.join("\n"));
	}
	if (diagnostics) sections.push("## Recovery diagnostics", diagnostics);
	if (oomNote) sections.push(oomNote);
	return capTextBytes(sections.join("\n\n"), MAX_FINAL_TEXT_BYTES, "\n\n[Failure report truncated at 50KB]");
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
