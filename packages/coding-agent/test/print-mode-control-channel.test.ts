import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pendingReplyCount, registerPendingReply, rejectAllPendingReplies } from "../src/core/subagent-control.ts";
import { shouldReadPipedStdin } from "../src/main.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

const output = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => output.lines.push(line),
}));

type FakeEvent = { type: string; [key: string]: unknown };

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function createRuntime() {
	let listener: (event: FakeEvent) => void = () => {};
	const turns: Array<ReturnType<typeof deferred>> = [];
	const session = {
		isStreaming: false,
		sessionManager: { getHeader: () => ({ type: "session" }) },
		// JSON print mode subscribes to the agent for stdout backpressure (upstream v1.x).
		agent: { subscribe: vi.fn(() => () => {}) },
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn((callback: (event: FakeEvent) => void) => {
			listener = callback;
			return () => {};
		}),
		prompt: vi.fn(() => {
			const turn = deferred();
			turns.push(turn);
			session.isStreaming = true;
			listener({ type: "agent_start" });
			return turn.promise;
		}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		waitForIdle: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};
	const runtime = {
		session,
		setRebindSession: vi.fn(),
		dispose: vi.fn(async () => {}),
	};
	const settle = (index: number, error?: Error) => {
		session.isStreaming = false;
		listener({ type: "agent_settled" });
		if (error) turns[index].reject(error);
		else turns[index].resolve();
	};
	return { session, runtime, settle };
}

function start(input: PassThrough, runtime: ReturnType<typeof createRuntime>["runtime"], enabled = true) {
	vi.stubEnv("PI_SUBAGENT_CONTROL", enabled ? "stdin" : undefined);
	vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
	return runPrintMode(runtime as unknown as Parameters<typeof runPrintMode>[0], {
		mode: "json",
		initialMessage: "Task: initial",
	});
}

afterEach(() => {
	rejectAllPendingReplies("test cleanup");
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	output.lines = [];
});

describe("JSON print-mode child control channel", () => {
	it("reserves stdin only for opted-in JSON children; ordinary piped stdin remains prompt content", () => {
		expect(shouldReadPipedStdin("json", { PI_SUBAGENT_CONTROL: "stdin" })).toBe(false);
		expect(shouldReadPipedStdin("json", {})).toBe(true);
		expect(shouldReadPipedStdin("print", { PI_SUBAGENT_CONTROL: "stdin" })).toBe(true);
		expect(shouldReadPipedStdin("rpc", {})).toBe(false);
	});

	it("queues steer/follow_up while streaming; an idle command starts a new JSON turn", async () => {
		const input = new PassThrough();
		const { runtime, session, settle } = createRuntime();
		const result = start(input, runtime);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		input.write('{"type":"steer","message":"redirect"}\n');
		input.write('{"type":"follow_up","message":"afterward"}\n');
		await vi.waitFor(() => {
			expect(session.steer).toHaveBeenCalledWith("redirect");
			expect(session.followUp).toHaveBeenCalledWith("afterward");
		});
		expect(session.prompt).toHaveBeenCalledTimes(1);
		settle(0);
		await vi.waitFor(() => expect(output.lines.filter((line) => line.includes("agent_settled"))).toHaveLength(1));
		// Let the initial runPrintMode await/finally finish before testing the idle boundary.
		await new Promise((resolve) => setImmediate(resolve));
		expect(runtime.dispose).not.toHaveBeenCalled();
		input.write('{"type":"steer","message":"another task"}\n');
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
		expect(session.prompt).toHaveBeenLastCalledWith("another task");
		settle(1);
		input.end();
		expect(await result).toBe(0);
		expect(output.lines.filter((line) => line.includes('"type":"session"'))).toHaveLength(1);
		expect(output.lines.filter((line) => line.includes("agent_start"))).toHaveLength(2);
		expect(output.lines.filter((line) => line.includes("agent_settled"))).toHaveLength(2);
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it("resolves a waiting message_parent reply without ending the active tool", async () => {
		const input = new PassThrough();
		const { runtime, session, settle } = createRuntime();
		const result = start(input, runtime);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		const reply = registerPendingReply("tool-1");
		input.write('{"type":"reply","toolCallId":"tool-1","text":"parent says yes"}\n');
		await expect(reply).resolves.toBe("parent says yes");
		expect(pendingReplyCount()).toBe(0);
		settle(0);
		input.end();
		expect(await result).toBe(0);
	});

	it("logs malformed commands and unknown reply ids without injecting a prompt", async () => {
		const input = new PassThrough();
		const { runtime, session, settle } = createRuntime();
		const warning = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = start(input, runtime);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		input.write('not json\n{"type":"steer","message":5}\n{"type":"reply","toolCallId":"missing","text":"x"}\n');
		await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(3));
		expect(warning).toHaveBeenCalledWith("Unknown subagent reply id: missing");
		expect(session.steer).not.toHaveBeenCalled();
		settle(0);
		input.end();
		expect(await result).toBe(0);
	});

	it("on idle EOF exits after disposal; on mid-turn EOF waits and rejects outstanding replies", async () => {
		const input = new PassThrough();
		const { runtime, session, settle } = createRuntime();
		const result = start(input, runtime);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		const reply = registerPendingReply("tool-2");
		input.end();
		await expect(reply).rejects.toThrow("parent closed the channel");
		await expect(registerPendingReply("late-tool")).rejects.toThrow("parent closed the channel");
		expect(runtime.dispose).not.toHaveBeenCalled();
		settle(0);
		expect(await result).toBe(0);
		expect(runtime.dispose).toHaveBeenCalledOnce();

		const idleInput = new PassThrough();
		const idle = createRuntime();
		const idleRun = start(idleInput, idle.runtime);
		await vi.waitFor(() => expect(idle.session.prompt).toHaveBeenCalledTimes(1));
		idle.settle(0);
		await new Promise((resolve) => setImmediate(resolve));
		expect(idle.runtime.dispose).not.toHaveBeenCalled();
		idleInput.end();
		expect(await idleRun).toBe(0);
		expect(idle.runtime.dispose).toHaveBeenCalledOnce();
	});

	it("uses prompt for an idle follow-up and forwards abort while streaming", async () => {
		const input = new PassThrough();
		const { runtime, session, settle } = createRuntime();
		const result = start(input, runtime);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		input.write('{"type":"abort"}\n');
		await vi.waitFor(() => expect(session.abort).toHaveBeenCalledOnce());
		settle(0);
		await new Promise((resolve) => setImmediate(resolve));
		input.write('{"type":"follow_up","message":"new turn"}\n');
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
		expect(session.prompt).toHaveBeenLastCalledWith("new turn");
		expect(session.followUp).not.toHaveBeenCalled();
		input.end();
		settle(1);
		expect(await result).toBe(0);
	});

	it("does not exit on a failed initial prompt while stdin is still open", async () => {
		const input = new PassThrough();
		const { runtime, session, settle } = createRuntime();
		const warning = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = start(input, runtime);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		settle(0, new Error("first prompt failed"));
		await vi.waitFor(() => expect(warning).toHaveBeenCalledWith("first prompt failed"));
		expect(runtime.dispose).not.toHaveBeenCalled();
		input.write('{"type":"steer","message":"recover"}\n');
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
		settle(1);
		input.end();
		expect(await result).toBe(1);
	});

	it("when disabled, does not parse stdin commands or hold open after the initial prompt", async () => {
		const input = new PassThrough();
		const { runtime, session, settle } = createRuntime();
		const result = start(input, runtime, false);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		input.write('{"type":"steer","message":"ignored"}\n');
		settle(0);
		expect(await result).toBe(0);
		expect(session.steer).not.toHaveBeenCalled();
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(runtime.dispose).toHaveBeenCalledOnce();
		input.end();
	});
});
