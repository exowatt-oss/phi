/**
 * phi remote: subagent runs as child sessions of the session that launched them (session side),
 * and tmux session names. The bridge runs against a fake link; runs are fed through the same
 * feed events the subagents extension publishes, with synthetic `--mode json` streams.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionBridge } from "../src/extensions/remote/bridge.ts";
import type { LinkLike } from "../src/extensions/remote/link.ts";
import {
	MAX_CHILD_ITEMS,
	MAX_CHILDREN,
	REMOTE_MESSAGE_PREFIX,
	TASK_ITEM_ID,
} from "../src/extensions/remote/subagents.ts";
import {
	type ExecRunner,
	queryTmux,
	sessionDisplayName,
	stripDevboxPrefix,
	TMUX_REFRESH_MS,
	TmuxNamer,
	tmuxDisplayName,
	tmuxTarget,
} from "../src/extensions/remote/tmux.ts";
import { clampSubagentArgs, subagentToolSummary, toolSummary } from "../src/extensions/remote/transcript.ts";
import type { SubagentFeedControl, SubagentFeedEvent } from "../src/extensions/subagents/feed.ts";
import type { SubagentControlCommand } from "../src/extensions/subagents/runner.ts";
import { newUsageTotals, type SubagentRunSnapshot } from "../src/extensions/subagents/types.ts";
import type { SessionToHub } from "../src/remote/protocol.ts";

type Frame = any;

function fakeLink(): LinkLike & { sent: Frame[]; connected: boolean } {
	const sent: Frame[] = [];
	return {
		connected: true,
		sent,
		send(frame: SessionToHub) {
			sent.push(JSON.parse(JSON.stringify(frame)));
		},
	};
}

interface BridgeSetup {
	connected?: boolean;
	sessionName?: string;
	env?: NodeJS.ProcessEnv;
	execRunner?: ExecRunner;
	sessionId?: () => string;
}

function makeBridge(setup: BridgeSetup = {}) {
	const link = fakeLink();
	link.connected = setup.connected ?? true;
	let sessionName = setup.sessionName;
	const pi = {
		sendUserMessage: vi.fn(),
		setModel: vi.fn(async () => true),
		setThinkingLevel: vi.fn(),
		getThinkingLevel: () => "off" as const,
		getSessionName: () => sessionName,
	};
	const ctx = {
		mode: "rpc",
		cwd: "/tmp/project",
		model: { provider: "faux", id: "faux-1", name: "Faux", reasoning: false },
		sessionManager: {
			getSessionId: setup.sessionId ?? (() => "parent-1"),
			getLeafId: () => null,
			getBranch: () => [],
			getEntries: () => [],
			getEntry: () => undefined,
		},
		isIdle: () => true,
		abort: vi.fn(),
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		modelRegistry: { getAvailable: () => [], find: () => undefined },
	} as unknown as ExtensionContext;
	const bridge = new SessionBridge({
		pi,
		ctx,
		link,
		host: "box",
		shutdown: vi.fn(),
		env: setup.env ?? {},
		execRunner: setup.execRunner,
	});
	return {
		bridge,
		link,
		setName: (name: string | undefined) => {
			sessionName = name;
		},
	};
}

let runSeq = 0;
function makeRun(overrides: Partial<SubagentRunSnapshot> = {}): SubagentRunSnapshot {
	runSeq++;
	return {
		id: `task-${runSeq}`,
		runId: `run${runSeq}`,
		name: `task-${runSeq}`,
		agentSource: "none",
		task: "reply with exactly A",
		model: "anthropic/claude-haiku-4-5",
		status: "running",
		startedAt: 1_000,
		usage: newUsageTotals(),
		timeline: [],
		timelineDropped: 0,
		finalText: "",
		...overrides,
	};
}

function fakeControl() {
	const sent: SubagentControlCommand[] = [];
	const kills: string[] = [];
	let open = true;
	const control: SubagentFeedControl = {
		send: (command) => {
			if (!open) return false;
			sent.push(command);
			return true;
		},
		kill: (reason) => {
			kills.push(reason);
			return true;
		},
	};
	return {
		control,
		sent,
		kills,
		close: () => {
			open = false;
		},
	};
}

function start(
	bridge: SessionBridge,
	run: SubagentRunSnapshot,
	extra: Partial<Extract<SubagentFeedEvent, { type: "start" }>> = {},
) {
	const control = fakeControl();
	bridge.onSubagentFeed({
		type: "start",
		run,
		toolCallId: "toolu_1",
		index: 0,
		mode: "parallel",
		background: true,
		control: control.control,
		...extra,
	});
	return control;
}

function emit(bridge: SessionBridge, run: SubagentRunSnapshot, ...events: Record<string, unknown>[]) {
	for (const event of events) bridge.onSubagentFeed({ type: "event", run, event });
}

const childId = (run: SubagentRunSnapshot) => `parent-1~sa~${run.runId}`;

function childUpserts(link: ReturnType<typeof fakeLink>, sessionId?: string) {
	return link.sent.filter((f) => f.t === "child.upsert" && (!sessionId || f.session.sessionId === sessionId));
}

function itemUpserts(link: ReturnType<typeof fakeLink>, sessionId: string, itemId?: string) {
	return link.sent.filter(
		(f) =>
			f.t === "event" &&
			f.sessionId === sessionId &&
			f.event.type === "item.upsert" &&
			(!itemId || f.event.item.id === itemId),
	);
}

async function request(
	bridge: SessionBridge,
	link: ReturnType<typeof fakeLink>,
	sessionId: string,
	op: string,
	args: unknown = {},
) {
	const id = `q${Math.random()}`;
	bridge.onFrame({ t: "req", id, sessionId, op, args } as never);
	await vi.waitFor(() => {
		if (!link.sent.some((f) => f.t === "reply" && f.re === id)) throw new Error("no reply yet");
	});
	return link.sent.find((f) => f.t === "reply" && f.re === id);
}

/** A tiny child run: its user prompt, a streamed answer with one tool call, the tool, the final answer. */
function childStream(text: string): Record<string, unknown>[] {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
	const base = {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		usage,
	};
	return [
		{ type: "session", version: 3, id: "child-session", cwd: "/tmp/project" },
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "user", content: `Task: ${text}\nmore`, timestamp: 2_000 } },
		{ type: "message_end", message: { role: "user", content: `Task: ${text}\nmore`, timestamp: 2_000 } },
		{ type: "message_start", message: { ...base, content: [], stopReason: "pending", timestamp: 3_000 } },
		{ type: "message_update", usage, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		{ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Look" } },
		{ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ing" } },
		{
			type: "message_end",
			message: {
				...base,
				content: [
					{ type: "text", text: "Looking" },
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
				],
				stopReason: "toolUse",
				timestamp: 3_000,
			},
		},
		{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
		{
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			args: { command: "ls" },
			partialResult: { content: [{ type: "text", text: "a" }] },
		},
		{
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "a.txt" }] },
			isError: false,
		},
		{ type: "message_start", message: { ...base, content: [], stopReason: "pending", timestamp: 4_000 } },
		{ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "A" } },
		{
			type: "message_end",
			message: { ...base, content: [{ type: "text", text: "A" }], stopReason: "stop", timestamp: 4_000 },
		},
		{ type: "agent_settled", aborted: false },
	];
}

afterEach(() => {
	vi.useRealTimers();
});

describe("subagent child sessions (session side)", () => {
	it("registers a child under the parent and counts it on the parent's summary", () => {
		vi.useFakeTimers({ now: 10_000 });
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		const run = makeRun({ name: "ws-a", agentName: "scout", task: "reply with exactly A\nthen stop" });
		start(bridge, run, { taskName: "ws-a", index: 1 });
		const [upsert] = childUpserts(link);
		expect(upsert.session).toMatchObject({
			sessionId: childId(run),
			name: "ws-a",
			cwd: "/tmp/project",
			host: "box",
			kind: "subagent",
			parentSessionId: "parent-1",
			status: "working",
			model: { provider: "anthropic", id: "claude-haiku-4-5" },
			subagent: {
				runId: run.runId,
				toolCallId: "toolu_1",
				index: 1,
				name: "ws-a",
				agent: "scout",
				task: "reply with exactly A then stop",
				status: "running",
				startedAt: 1_000,
				turns: 0,
				toolCalls: 0,
				background: true,
			},
		});
		vi.advanceTimersByTime(1_000);
		const parent = link.sent.filter((f) => f.t === "upsert").at(-1);
		expect(parent.session.subagents).toEqual({ running: 1, total: 1 });

		// Name: the task's name, else its agent, else the first task line.
		const byAgent = makeRun({ agentName: "reviewer" });
		start(bridge, byAgent);
		expect(childUpserts(link, childId(byAgent))[0].session.name).toBe("reviewer");
		const byTask = makeRun({ task: "\n  check the build\nthoroughly" });
		start(bridge, byTask);
		expect(childUpserts(link, childId(byTask))[0].session.name).toBe("check the build");
		expect(childUpserts(link, childId(byTask))[0].session.subagent).not.toHaveProperty("name");
	});

	it("rebuilds the child transcript from its JSON stream: live upserts, snapshot and history agree", async () => {
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		const run = makeRun();
		start(bridge, run);
		const id = childId(run);
		emit(bridge, run, ...childStream("reply with exactly A"));
		const final = (itemId: string) => itemUpserts(link, id, itemId).at(-1)?.event.item;
		expect(final(TASK_ITEM_ID)).toEqual({
			id: TASK_ITEM_ID,
			ts: 1_000,
			kind: "user",
			text: "reply with exactly A\nmore",
		});
		expect(final("a:3000")).toMatchObject({ kind: "assistant", text: "Looking", model: "claude-haiku-4-5" });
		expect(final("a:3000")).not.toHaveProperty("streaming");
		expect(itemUpserts(link, id, "a:3000")[0].event.item).toMatchObject({ streaming: true });
		expect(final("t:3000:c1")).toMatchObject({
			kind: "tool",
			name: "bash",
			status: "ok",
			output: "a.txt",
			summary: "bash  ls",
		});
		expect(final("a:4000")).toMatchObject({ kind: "assistant", text: "A" });
		const states = link.sent.filter((f) => f.t === "event" && f.sessionId === id && f.event.type === "state");
		expect(states.length).toBeGreaterThan(0);

		const snapshot = await request(bridge, link, id, "snapshot", { limit: 50 });
		expect(snapshot.ok).toBe(true);
		expect(snapshot.data.items.map((item: any) => item.id)).toEqual([TASK_ITEM_ID, "a:3000", "t:3000:c1", "a:4000"]);
		expect(snapshot.data.items[3]).toEqual(final("a:4000"));
		expect(snapshot.data.state).toEqual({ status: "working" });
		const page = await request(bridge, link, id, "snapshot", { limit: 2 });
		expect(page.data).toMatchObject({ hasMore: true });
		expect(page.data.items.map((item: any) => item.id)).toEqual(["t:3000:c1", "a:4000"]);
		const history = await request(bridge, link, id, "history", { before: "t:3000:c1", limit: 1 });
		expect(history.data).toEqual({ items: [expect.objectContaining({ id: "a:3000" })], hasMore: true });

		// The run ends: status done, idle state, summary says so.
		run.status = "done";
		run.endedAt = 9_000;
		run.usage.turns = 2;
		run.usage.toolCalls = 1;
		bridge.onSubagentFeed({ type: "end", run });
		const last = childUpserts(link, id).at(-1).session;
		expect(last).toMatchObject({
			status: "idle",
			lastText: "A",
			subagent: { status: "done", endedAt: 9_000, turns: 2, toolCalls: 1 },
		});
		const done = await request(bridge, link, id, "snapshot", {});
		expect(done.data.state).toEqual({ status: "idle" });
	});

	it("streams a long reply in coalesced upserts and keeps a running tool's activity", () => {
		vi.useFakeTimers({ now: 50_000 });
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		const run = makeRun();
		start(bridge, run);
		const id = childId(run);
		emit(bridge, run, {
			type: "message_start",
			message: { role: "assistant", content: [], stopReason: "pending", timestamp: 7_000 },
		});
		for (let index = 0; index < 100; index++) {
			vi.advanceTimersByTime(10);
			emit(bridge, run, {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
			});
		}
		const streamed = itemUpserts(link, id, "a:7000");
		expect(streamed.length).toBeGreaterThanOrEqual(8);
		expect(streamed.length).toBeLessThanOrEqual(10);
		vi.advanceTimersByTime(200);
		expect(itemUpserts(link, id, "a:7000").at(-1).event.item.text).toBe("x".repeat(100));
		emit(bridge, run, { type: "tool_execution_start", toolCallId: "c9", toolName: "read", args: { path: "a.ts" } });
		vi.advanceTimersByTime(1_000);
		const summary = childUpserts(link, id).at(-1).session;
		expect(summary.activity).toEqual({ tool: "read", summary: "read  a.ts" });
	});

	it("routes a prompt to the run's control channel (steer / follow_up / question reply)", async () => {
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		const run = makeRun();
		const control = start(bridge, run);
		const id = childId(run);
		expect(await request(bridge, link, id, "prompt", { text: "focus on tests", mode: "auto" })).toMatchObject({
			ok: true,
		});
		await request(bridge, link, id, "prompt", { text: "and lint", mode: "steer" });
		await request(bridge, link, id, "prompt", { text: "then summarize", mode: "followUp" });
		expect(control.sent).toEqual([
			{ type: "steer", message: `${REMOTE_MESSAGE_PREFIX}focus on tests` },
			{ type: "steer", message: `${REMOTE_MESSAGE_PREFIX}and lint` },
			{ type: "follow_up", message: `${REMOTE_MESSAGE_PREFIX}then summarize` },
		]);
		run.pendingQuestion = { kind: "question", message: "which db?", at: 1, toolCallId: "mp1" } as never;
		await request(bridge, link, id, "prompt", { text: "postgres" });
		expect(control.sent.at(-1)).toEqual({
			type: "reply",
			toolCallId: "mp1",
			text: `${REMOTE_MESSAGE_PREFIX}postgres`,
		});
		run.pendingQuestion = undefined;

		// The steer comes back as a user message in the child's stream, shown without the prefix.
		emit(bridge, run, {
			type: "message_start",
			message: { role: "user", content: `${REMOTE_MESSAGE_PREFIX}focus on tests`, timestamp: 5_000 },
		});
		expect(itemUpserts(link, id, "u:5000").at(-1).event.item).toMatchObject({ kind: "user", text: "focus on tests" });

		expect(
			await request(bridge, link, id, "prompt", { text: "look", images: [{ mimeType: "image/png", data: "AAAA" }] }),
		).toMatchObject({ ok: false, error: { code: "bad_request" } });
		expect(await request(bridge, link, id, "prompt", { text: "  " })).toMatchObject({ ok: false });
		control.close();
		expect(await request(bridge, link, id, "prompt", { text: "still there?" })).toMatchObject({
			ok: false,
			error: { code: "bad_request" },
		});
	});

	it("aborts by killing the run; a finished run takes no prompt; other ops are bad_request", async () => {
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		const run = makeRun();
		const control = start(bridge, run);
		const id = childId(run);
		expect(await request(bridge, link, id, "abort")).toMatchObject({ ok: true });
		expect(control.kills).toHaveLength(1);
		run.status = "aborted";
		run.killedBy = "kill-action";
		bridge.onSubagentFeed({ type: "end", run });
		expect(childUpserts(link, id).at(-1).session.subagent.status).toBe("killed");
		expect(await request(bridge, link, id, "prompt", { text: "more" })).toEqual({
			t: "reply",
			re: expect.any(String),
			ok: false,
			error: { code: "bad_request", message: "subagent finished" },
		});
		expect(await request(bridge, link, id, "abort")).toMatchObject({ ok: true });
		expect(control.kills).toHaveLength(1);
		for (const op of ["close", "models", "setModel", "setThinking", "commands"]) {
			expect(await request(bridge, link, id, op)).toMatchObject({ ok: false, error: { code: "bad_request" } });
		}
		expect(await request(bridge, link, "parent-1~sa~nope", "snapshot")).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		const failed = makeRun();
		start(bridge, failed);
		failed.status = "failed";
		bridge.onSubagentFeed({ type: "end", run: failed });
		expect(childUpserts(link, childId(failed)).at(-1).session.subagent.status).toBe("failed");
	});

	it("keeps at most MAX_CHILDREN children, evicting the oldest finished one first", () => {
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		const runs: SubagentRunSnapshot[] = [];
		for (let index = 0; index < MAX_CHILDREN; index++) {
			const run = makeRun();
			runs.push(run);
			start(bridge, run);
		}
		// Finish the 3rd and the 10th: the 3rd (older) goes first, then the 10th, then the oldest running.
		for (const run of [runs[2], runs[9]]) {
			run.status = "done";
			bridge.onSubagentFeed({ type: "end", run });
		}
		const extra = [makeRun(), makeRun(), makeRun()];
		for (const run of extra) start(bridge, run);
		const removed = link.sent.filter((f) => f.t === "child.remove").map((f) => f.sessionId);
		expect(removed).toEqual([childId(runs[2]), childId(runs[9]), childId(runs[0])]);
		const listed = new Set(childUpserts(link).map((f) => f.session.sessionId));
		expect(listed.has(childId(extra[2]))).toBe(true);
		// Events of an evicted run are ignored.
		const before = link.sent.length;
		emit(bridge, runs[0], { type: "agent_start" });
		expect(link.sent.length).toBe(before);
	});

	it("caps each child's transcript and says how much was dropped", async () => {
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		const run = makeRun();
		start(bridge, run);
		const id = childId(run);
		for (let index = 0; index < MAX_CHILD_ITEMS + 20; index++) {
			emit(bridge, run, {
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `step ${index}` }],
					stopReason: "stop",
					timestamp: 100_000 + index,
				},
			});
		}
		const snapshot = await request(bridge, link, id, "snapshot", { limit: 500 });
		const ids = snapshot.data.items.map((item: any) => item.id);
		expect(ids).toHaveLength(500);
		expect(ids.at(-1)).toBe(`a:${100_000 + MAX_CHILD_ITEMS + 19}`);
		const all = await request(bridge, link, id, "history", { before: ids[0], limit: 500 });
		expect(all.data.items[0]).toMatchObject({ kind: "note", text: "21 earlier items are no longer kept." });
	});

	it("removes every child when the parent session ends or is replaced", () => {
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		const runs = [makeRun(), makeRun()];
		for (const run of runs) start(bridge, run);
		bridge.dispose();
		expect(link.sent.filter((f) => f.t === "child.remove").map((f) => f.sessionId)).toEqual(runs.map(childId));
		const count = link.sent.length;
		bridge.onSubagentFeed({
			type: "start",
			run: makeRun(),
			toolCallId: "x",
			index: 0,
			mode: "single",
			background: false,
			control: fakeControl().control,
		});
		emit(bridge, runs[0], { type: "agent_start" });
		expect(link.sent.length).toBe(count);
	});

	it("drops children silently when the same connection registers a new session id", () => {
		let sessionId = "parent-1";
		const { bridge, link } = makeBridge({ sessionId: () => sessionId });
		bridge.onConnected();
		start(bridge, makeRun());
		sessionId = "parent-2";
		bridge.onConnected(true);
		const register = link.sent.filter((f) => f.t === "register").at(-1);
		expect(register.session.sessionId).toBe("parent-2");
		expect(register.session).not.toHaveProperty("subagents");
		expect(childUpserts(link).filter((f) => f.session.parentSessionId === "parent-2")).toHaveLength(0);
	});

	it("keeps nothing for a session that never met a hub, and re-announces children after a reconnect", () => {
		const offline = makeBridge({ connected: false });
		offline.bridge.onSubagentFeed({
			type: "start",
			run: makeRun(),
			toolCallId: "x",
			index: 0,
			mode: "single",
			background: false,
			control: fakeControl().control,
		});
		offline.link.connected = true;
		offline.bridge.onConnected();
		expect(childUpserts(offline.link)).toHaveLength(0);
		expect(offline.link.sent.find((f) => f.t === "register").session).not.toHaveProperty("subagents");

		const { bridge, link } = makeBridge();
		bridge.onConnected();
		const run = makeRun();
		start(bridge, run);
		link.connected = false;
		bridge.onDisconnected();
		emit(bridge, run, ...childStream("A"));
		link.connected = true;
		link.sent.length = 0;
		bridge.onConnected();
		expect(link.sent[0]).toMatchObject({ t: "register", session: { subagents: { running: 1, total: 1 } } });
		expect(link.sent.find((f) => f.t === "child.upsert")).toMatchObject({ session: { sessionId: childId(run) } });
		expect(link.sent.findIndex((f) => f.t === "child.upsert")).toBeGreaterThan(0);
	});
});

describe("subagent tool item in the parent transcript", () => {
	it("summarizes launches and management actions on one line", () => {
		expect(
			subagentToolSummary({
				tasks: [
					{ task: "a", name: "ws-a" },
					{ task: "b", name: "ws-b" },
					{ task: "c", agent: "scout" },
				],
			}),
		).toBe("3 subagents: ws-a, ws-b, scout");
		expect(subagentToolSummary({ chain: [{ task: "plan it" }, { task: "do it\nnow" }] })).toBe(
			"2 subagents (chain): plan it → do it",
		);
		expect(subagentToolSummary({ task: "reply with exactly A" })).toBe("1 subagent: reply with exactly A");
		expect(subagentToolSummary({ action: "status" })).toBe("subagent  status");
		expect(subagentToolSummary({ action: "kill", target: "ws-a" })).toBe("subagent  kill ws-a");
		expect(subagentToolSummary({ action: "message", target: "ws-a", message: "hurry" })).toBe(
			"subagent  message ws-a  hurry",
		);
		expect(toolSummary("subagent", { tasks: [{ task: "x" }] })).toBe("1 subagent: x");
	});

	it("keeps large subagent args an object with every task's name, agent and model", () => {
		const tasks = Array.from({ length: 6 }, (_, index) => ({
			name: `ws-${index}`,
			agent: "worker",
			model: "anthropic/claude-haiku-4-5",
			task: "y".repeat(5_000),
		}));
		const clamped = clampSubagentArgs({ tasks, concurrency: 6 }) as any;
		expect(JSON.stringify(clamped).length).toBeLessThanOrEqual(4096);
		expect(clamped.concurrency).toBe(6);
		expect(clamped.tasks.map((task: any) => task.name)).toEqual(tasks.map((task) => task.name));
		expect(clamped.tasks[0]).toMatchObject({ agent: "worker", model: "anthropic/claude-haiku-4-5" });
		expect(clamped.tasks[0].task.startsWith("yyyy")).toBe(true);
		expect(clampSubagentArgs({ task: "small" })).toEqual({ task: "small" });
	});
});

describe("tmux session names", () => {
	const env = { TMUX: "/tmp/tmux-1001/devbox-2ff8ddd61f5e,2545596,47", TMUX_PANE: "%47" };

	it("reads the socket and pane from the environment", () => {
		expect(tmuxTarget(env)).toEqual({ socket: "/tmp/tmux-1001/devbox-2ff8ddd61f5e", pane: "%47" });
		expect(tmuxTarget({ TMUX: env.TMUX })).toBeUndefined();
		expect(tmuxTarget({ TMUX_PANE: "%1" })).toBeUndefined();
		expect(tmuxTarget({ TMUX: env.TMUX, TMUX_PANE: "47; rm" })).toBeUndefined();
	});

	it("asks tmux without a shell, with a timeout, and never throws", async () => {
		const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
		const run: ExecRunner = async (file, args, options) => {
			calls.push({ file, args, timeoutMs: options.timeoutMs });
			return "devbox-devbox-1-emsposhchanges\u001fphi\n";
		};
		expect(await queryTmux(env, run)).toEqual({ session: "devbox-devbox-1-emsposhchanges", window: "phi" });
		expect(calls).toEqual([
			{
				file: "tmux",
				args: [
					"-S",
					"/tmp/tmux-1001/devbox-2ff8ddd61f5e",
					"display-message",
					"-p",
					"-t",
					"%47",
					"#{session_name}\u001f#{window_name}",
				],
				timeoutMs: 1000,
			},
		]);
		expect(await queryTmux(env, async () => Promise.reject(new Error("no server")))).toBeUndefined();
		expect(await queryTmux(env, async () => "\n")).toBeUndefined();
		expect(await queryTmux({}, run)).toBeUndefined();
	});

	it("strips the devbox tab prefix and ignores tmux's numeric default names", () => {
		expect(stripDevboxPrefix("devbox-devbox-1-emsposhchanges")).toBe("emsposhchanges");
		expect(stripDevboxPrefix("devbox-gpu-box-12-my-tab")).toBe("my-tab");
		expect(stripDevboxPrefix("devbox-devbox-1")).toBe("devbox-devbox-1");
		expect(stripDevboxPrefix("my-smoke-name")).toBe("my-smoke-name");
		expect(tmuxDisplayName({ session: "devbox-devbox-9-omegastarexotree", window: "phi" })).toBe("omegastarexotree");
		expect(tmuxDisplayName({ session: "3" })).toBeUndefined();
		expect(tmuxDisplayName(undefined)).toBeUndefined();
	});

	it("name precedence: explicit name, then tmux, then first prompt, then cwd", () => {
		const tmux = { session: "devbox-devbox-1-emsposhchanges" };
		expect(sessionDisplayName({ explicit: "mine", tmux, firstPrompt: "fix it", cwdName: "repo" })).toBe("mine");
		expect(sessionDisplayName({ tmux, firstPrompt: "fix it", cwdName: "repo" })).toBe("emsposhchanges");
		expect(sessionDisplayName({ tmux: { session: "0" }, firstPrompt: "fix it", cwdName: "repo" })).toBe("fix it");
		expect(sessionDisplayName({ cwdName: "repo" })).toBe("repo");
	});

	it("refreshes at most every 30 s and reports changes only", async () => {
		let now = 0;
		let name = "first";
		const run = vi.fn(async () => `${name}\u001fwin\n`);
		const onChange = vi.fn();
		const namer = new TmuxNamer({ env, run, now: () => now, onChange });
		namer.refresh(true);
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		expect(namer.current).toEqual({ session: "first", window: "win" });
		now = TMUX_REFRESH_MS - 1;
		namer.refresh();
		expect(run).toHaveBeenCalledTimes(1);
		now = TMUX_REFRESH_MS;
		namer.refresh();
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
		await new Promise((resolve) => setTimeout(resolve, 5)); // let that query settle
		expect(onChange).toHaveBeenCalledTimes(1);
		name = "renamed";
		now = 2 * TMUX_REFRESH_MS;
		namer.refresh();
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
		expect(namer.current?.session).toBe("renamed");
		const outside = vi.fn(async () => "x");
		new TmuxNamer({ env: {}, run: outside }).refresh(true);
		expect(outside).not.toHaveBeenCalled();
	});

	it("names the session after its tmux session unless it has an explicit name", async () => {
		const run: ExecRunner = async () => "devbox-devbox-1-emsposhchanges\u001fphi\n";
		const { bridge, link, setName } = makeBridge({ env, execRunner: run });
		await vi.waitFor(() => {
			bridge.onConnected();
			const last = link.sent.filter((f) => f.t === "register" || f.t === "upsert").at(-1);
			expect(last.session.name).toBe("emsposhchanges");
		});
		const registered = link.sent.filter((f) => f.t === "register" || f.t === "upsert").at(-1).session;
		expect(registered.tmux).toEqual({ session: "devbox-devbox-1-emsposhchanges", window: "phi" });
		setName("my explicit name");
		bridge.onConnected();
		const renamed = link.sent.filter((f) => f.t === "register" || f.t === "upsert").at(-1).session;
		expect(renamed.name).toBe("my explicit name");
		expect(renamed.tmux).toEqual({ session: "devbox-devbox-1-emsposhchanges", window: "phi" });

		const outside = makeBridge({ execRunner: run });
		outside.bridge.onConnected();
		const plain = outside.link.sent.find((f) => f.t === "register").session;
		expect(plain.name).toBe("project");
		expect(plain).not.toHaveProperty("tmux");
	});
});
