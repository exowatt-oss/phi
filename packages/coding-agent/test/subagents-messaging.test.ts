import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { pendingReplyCount, rejectAllPendingReplies, resolvePendingReply } from "../src/core/subagent-control.ts";
import { registerChildMessageTool } from "../src/extensions/subagents/child-tools.ts";
import { buildStatusText, deliverChildMessage } from "../src/extensions/subagents/index.ts";
import { buildRunRow } from "../src/extensions/subagents/render.ts";
import {
	executeRun,
	newUsage,
	PARENT_MESSAGE_GRACE_MS,
	type SubagentRunControl,
} from "../src/extensions/subagents/runner.ts";
import { newUsageTotals, type SubagentReport, type SubagentRunSnapshot } from "../src/extensions/subagents/types.ts";
import { evaluateWatchdog } from "../src/extensions/subagents/watchdog.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function makeRun(overrides: Partial<SubagentRunSnapshot> = {}): SubagentRunSnapshot {
	return {
		id: "worker-1",
		runId: "worker-1",
		handle: "worker-handle",
		name: "worker",
		agentSource: "none",
		task: "investigate",
		status: "pending",
		usage: newUsageTotals(),
		timeline: [],
		timelineDropped: 0,
		finalText: "",
		...overrides,
	};
}

function fakeChild(script: string) {
	return { command: process.execPath, args: ["-e", script, "--"] };
}

const emit = "const emit=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');";

describe("subagent JSONL control channel", () => {
	it("closes piped stdin after agent_settled and preserves a fake child that exits on its own", async () => {
		const run = makeRun();
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			groupUsage: newUsage(),
			onChange() {},
			invocation: fakeChild(
				`${emit} process.stdin.resume(); process.stdin.on('end',()=>{emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'EOF received'}]}});process.exit(0)}); emit({type:'agent_start'});emit({type:'agent_settled'});`,
			),
		});
		expect(run.status).toBe("done");
		expect(run.finalText).toBe("EOF received");
		expect(run.turnState).toBe("idle-awaiting-close");
	});

	it("preserves message_parent in restricted named-agent tool allowlists", async () => {
		const run = makeRun();
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			groupUsage: newUsage(),
			onChange() {},
			tools: ["bash"],
			invocation: fakeChild(
				`${emit}process.stdin.resume();process.stdin.on('end',()=>process.exit(0));emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(process.argv)}]}});emit({type:'agent_settled'});`,
			),
		});
		expect(run.status).toBe("done");
		expect(JSON.parse(run.finalText)).toContain("bash,message_parent");
	});

	it("sends steer/follow_up JSONL, allows a new turn while idle, then grants 2 s before EOF", async () => {
		const run = makeRun();
		let control: SubagentRunControl | undefined;
		let sentFollowUp = false;
		const started = Date.now();
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			groupUsage: newUsage(),
			onControlReady(handle) {
				control = handle;
				expect(handle.send({ type: "steer", message: "[message from your parent agent] focus" })).toBe(true);
			},
			onChange() {
				if (run.turnState === "idle-awaiting-close" && !sentFollowUp) {
					sentFollowUp = true;
					expect(
						control?.send({ type: "follow_up", message: "[message from your parent agent] then report" }),
					).toBe(true);
				}
			},
			invocation: fakeChild(`${emit}
				let lines=[];process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{lines.push(...chunk.trim().split('\\n').map(JSON.parse));if(lines.length===2){emit({type:'agent_start'});emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(lines)}]}});emit({type:'agent_settled'});}});process.stdin.on('end',()=>process.exit(0));emit({type:'agent_start'});emit({type:'agent_settled'});`),
		});
		expect(run.status).toBe("done");
		expect(JSON.parse(run.finalText)).toEqual([
			{ type: "steer", message: "[message from your parent agent] focus" },
			{ type: "follow_up", message: "[message from your parent agent] then report" },
		]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(PARENT_MESSAGE_GRACE_MS - 50);
		expect(control?.send({ type: "steer", message: "too late" })).toBe(false);
	}, 6_000);

	it("replies to a pending question by toolCallId, clears the wait, and records the last report", async () => {
		const run = makeRun();
		const reports: SubagentReport[] = [];
		let control: SubagentRunControl | undefined;
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			groupUsage: newUsage(),
			parentListening: true,
			onControlReady(handle) {
				control = handle;
			},
			onChildMessage(child, report) {
				reports.push(report);
				const question = child.pendingQuestion;
				expect(question?.toolCallId).toBe("ask-1");
				if (!question) throw new Error("missing pending question");
				expect(
					control?.send({
						type: "reply",
						toolCallId: question.toolCallId,
						text: "[message from your parent agent] yes",
					}),
				).toBe(true);
			},
			onChange() {},
			invocation: fakeChild(
				`${emit}process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{const command=JSON.parse(chunk.trim());emit({type:'tool_execution_end',toolName:'message_parent',toolCallId:'ask-1'});emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({command,control:process.env.PI_SUBAGENT_CONTROL,listening:process.env.PI_SUBAGENT_PARENT_LISTENING})}]}});emit({type:'agent_settled'});});process.stdin.on('end',()=>process.exit(0));emit({type:'tool_execution_start',toolName:'message_parent',toolCallId:'ask-1',args:{kind:'question',message:'Which path?',timeoutSeconds:600}});`,
			),
		});
		expect(run.status).toBe("done");
		expect(reports).toMatchObject([{ kind: "question", message: "Which path?" }]);
		expect(run.pendingQuestion).toBeUndefined();
		expect(run.lastReport?.message).toBe("Which path?");
		expect(JSON.parse(run.finalText)).toEqual({
			command: { type: "reply", toolCallId: "ask-1", text: "[message from your parent agent] yes" },
			control: "stdin",
			listening: "1",
		});
	}, 6_000);

	it("keeps the piped-stdin isolation wrapper path usable with a fake child", async () => {
		const run = makeRun();
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			groupUsage: newUsage(),
			onChange() {},
			parentListening: false,
			isolation: { enabled: false },
			invocation: fakeChild(
				`${emit}process.stdin.resume();process.stdin.on('end',()=>process.exit(0));emit({type:'agent_settled'});`,
			),
		});
		expect(run.status).toBe("done");
	});
});

describe("child message_parent tool", () => {
	afterEach(() => vi.unstubAllEnvs());
	type ChildTool = {
		name: string;
		promptSnippet: string;
		promptGuidelines: string[];
		execute(
			id: string,
			params: { message: string; kind?: "progress" | "question" | "blocker"; timeoutSeconds?: number },
			signal?: AbortSignal,
		): Promise<{ content: { text: string }[] }>;
	};
	function registeredTool(): ChildTool {
		const tools: ChildTool[] = [];
		vi.stubEnv("PI_SUBAGENT_ID", "child");
		vi.stubEnv("PI_SUBAGENT_CONTROL", "stdin");
		registerChildMessageTool({
			registerTool: (tool: ChildTool) => {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI);
		expect(tools).toHaveLength(1);
		return tools[0];
	}

	it("is unavailable without a child identity and the opt-in control channel", () => {
		const registered = vi.fn();
		vi.stubEnv("PI_SUBAGENT_ID", "");
		vi.stubEnv("PI_SUBAGENT_CONTROL", "stdin");
		registerChildMessageTool({ registerTool: registered } as unknown as ExtensionAPI);
		vi.stubEnv("PI_SUBAGENT_ID", "child");
		vi.stubEnv("PI_SUBAGENT_CONTROL", "");
		registerChildMessageTool({ registerTool: registered } as unknown as ExtensionAPI);
		expect(registered).not.toHaveBeenCalled();
	});

	it("reports progress immediately and a blocking-mode question proceeds without waiting", async () => {
		const tool = registeredTool();
		vi.stubEnv("PI_SUBAGENT_PARENT_LISTENING", "0");
		expect((await tool.execute("p", { message: "Milestone", kind: "progress" })).content[0].text).toBe(
			"Reported to parent.",
		);
		expect((await tool.execute("q", { message: "Which branch?" })).content[0].text).toContain(
			"Your parent is blocked waiting for your final answer and cannot reply",
		);
		expect(pendingReplyCount()).toBe(0);
		expect(tool.promptSnippet).toContain("without ending your run");
		expect(tool.promptGuidelines).toHaveLength(4);
	});

	it("resolves question replies while the tool is executing and cleans up on abort", async () => {
		const tool = registeredTool();
		vi.stubEnv("PI_SUBAGENT_PARENT_LISTENING", "1");
		const reply = tool.execute("ask-1", { message: "Which branch?" });
		expect(pendingReplyCount()).toBe(1);
		expect(resolvePendingReply("ask-1", "feature")).toBe(true);
		expect((await reply).content[0].text).toBe("Parent replied: feature");
		expect(pendingReplyCount()).toBe(0);

		const controller = new AbortController();
		const aborted = tool.execute("ask-2", { message: "Now?" }, controller.signal);
		controller.abort();
		await expect(aborted).rejects.toBeDefined();
		expect(pendingReplyCount()).toBe(0);
	});

	it("times out, and treats parent EOF as a prompt to proceed without leaking a wait", async () => {
		const tool = registeredTool();
		vi.stubEnv("PI_SUBAGENT_PARENT_LISTENING", "1");
		vi.useFakeTimers();
		try {
			const timed = tool.execute("ask-timeout", { message: "Status?", timeoutSeconds: 1 });
			await vi.advanceTimersByTimeAsync(1000);
			expect((await timed).content[0].text).toContain("No reply within 1 s");
			expect(pendingReplyCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
		const closed = tool.execute("ask-eof", { message: "Are you there?" });
		rejectAllPendingReplies("parent closed the channel");
		expect((await closed).content[0].text).toContain("Parent closed the channel");
		expect(pendingReplyCount()).toBe(0);
	});
});

describe("parent child-message presentation and liveness", () => {
	it("does not wake the parent for progress or a blocking question, but steers background questions", () => {
		const sendMessage = vi.fn();
		const pi = { sendMessage } as unknown as ExtensionAPI;
		const at = Date.now();
		const run = makeRun({
			status: "running",
			pendingQuestion: { kind: "question", message: "Which branch?", toolCallId: "ask-1", timeoutSeconds: 600, at },
		});
		deliverChildMessage(pi, run, { kind: "progress", message: "Halfway", at }, true);
		deliverChildMessage(pi, run, { kind: "question", message: "Which branch?", at }, false);
		expect(sendMessage).not.toHaveBeenCalled();
		deliverChildMessage(pi, run, { kind: "question", message: "Which branch?", at }, true);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage.mock.calls[0][0].content).toContain("Answer with subagent");
		expect(sendMessage.mock.calls[0][0].content).toContain("times out in 10 min");
		expect(sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	it("shows report, question age, idle-awaiting-close, and a compact asking badge", () => {
		const now = 1_000_000;
		const run = makeRun({
			status: "running",
			startedAt: now - 20_000,
			lastReport: { kind: "progress", message: "Rebuilt cache", at: now - 3000 },
			pendingQuestion: {
				kind: "blocker",
				message: "Need credentials",
				toolCallId: "ask-2",
				timeoutSeconds: 600,
				at: now - 2000,
			},
			turnState: "idle-awaiting-close",
		});
		const status = buildStatusText([run], now);
		expect(status).toContain("last report: progress (3s ago) Rebuilt cache");
		expect(status).toContain("pending question (2s): Need credentials");
		expect(status).toContain("idle-awaiting-close");
		initTheme("dark");
		expect(stripAnsi(buildRunRow(run, theme, now))).toContain("? asking");
	});

	it("exempts a waiting question from idle watchdog kills, not from an explicit hard timeout", () => {
		const config = {
			enabled: true,
			streamSoftMs: 10,
			streamHardMs: 20,
			toolSoftMs: 10,
			toolHardMs: 20,
			maxRuntimeMs: 0,
			checkIntervalMs: 1,
		};
		const state = {
			startedAt: 1,
			firstParsedEventAt: 1,
			lastEventAt: 1,
			inTool: true,
			waitingForParent: true,
			alreadyStalled: false,
		};
		expect(evaluateWatchdog(config, state, 100)).toEqual({ kind: "ok" });
		expect(evaluateWatchdog(config, { ...state, maxRuntimeMs: 50, explicitMaxRuntimeMs: true }, 100).kind).toBe(
			"budget-kill",
		);
	});
});
