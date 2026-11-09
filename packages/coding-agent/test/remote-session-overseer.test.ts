/**
 * phi remote, session side, for overseer threads: `summary.overseer` from the environment,
 * `summary.lastError` from the last assistant message, and `close` from the thread's own overseer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { overseerFromEnv, SessionBridge } from "../src/extensions/remote/bridge.ts";
import type { LinkLike } from "../src/extensions/remote/link.ts";
import { assistantError, storedTranscript } from "../src/extensions/remote/transcript.ts";
import type { SessionToHub } from "../src/remote/protocol.ts";

type Frame = any;

function fakeLink(): LinkLike & { sent: Frame[] } {
	const sent: Frame[] = [];
	return {
		connected: true,
		sent,
		send(frame: SessionToHub) {
			sent.push(JSON.parse(JSON.stringify(frame)));
		},
	};
}

const OVERSEER_ENV = { PHI_OVERSEER_SESSION_ID: "ov-1", PHI_OVERSEER_NAME: "boss", PHI_OVERSEER_THREAD: "fix-tests" };

function makeBridge(
	options: { env?: NodeJS.ProcessEnv; spawnId?: string; idle?: () => boolean; branch?: unknown[] } = {},
) {
	const link = fakeLink();
	const pi = {
		sendUserMessage: vi.fn(),
		setModel: vi.fn(async () => true),
		setThinkingLevel: vi.fn(),
		getThinkingLevel: () => "off" as const,
		getSessionName: () => undefined,
	};
	const branch = options.branch ?? [];
	const ctx = {
		mode: "tui",
		cwd: "/tmp/project",
		model: { provider: "faux", id: "faux-1", name: "Faux", reasoning: false },
		sessionManager: {
			getSessionId: () => "thread-1",
			getLeafId: () => null,
			getBranch: () => branch,
			getEntries: () => branch,
			getEntry: () => undefined,
		},
		isIdle: options.idle ?? (() => true),
		abort: vi.fn(),
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		modelRegistry: { getAvailable: () => [], find: () => undefined },
	} as unknown as ExtensionContext;
	const shutdown = vi.fn();
	const bridge = new SessionBridge({
		pi,
		ctx,
		link,
		host: "box",
		spawnId: options.spawnId,
		shutdown,
		// No tmux: the summary must not depend on the machine running the test.
		env: { ...(options.env ?? {}) },
		execRunner: async () => "",
	});
	return { bridge, link, ctx, shutdown };
}

async function request(bridge: SessionBridge, link: ReturnType<typeof fakeLink>, op: string, args: unknown = {}) {
	const id = `q${Math.random()}`;
	bridge.onFrame({ t: "req", id, op, args } as never);
	await vi.waitFor(() => {
		if (!link.sent.some((f) => f.t === "reply" && f.re === id)) throw new Error("no reply yet");
	});
	return link.sent.find((f) => f.t === "reply" && f.re === id)!;
}

/** The last summary the bridge sent (register or upsert). */
function lastSummary(link: ReturnType<typeof fakeLink>): Frame {
	const frames = link.sent.filter((f) => f.t === "register" || f.t === "upsert");
	return frames.at(-1)!.session;
}

let ts = 10_000;
const nextTs = (): number => {
	ts += 1000;
	return ts;
};
const assistant = (extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content: [{ type: "text", text: "reply" }],
	timestamp: nextTs(),
	model: "faux-1",
	provider: "faux",
	api: "anthropic-messages",
	stopReason: "stop",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	...extra,
});

describe("overseer link", () => {
	it("reads the overseer from the environment", () => {
		expect(overseerFromEnv(OVERSEER_ENV)).toEqual({ sessionId: "ov-1", name: "boss", thread: "fix-tests" });
		expect(overseerFromEnv({ PHI_OVERSEER_SESSION_ID: " ov-2 " })).toEqual({ sessionId: "ov-2" });
		expect(overseerFromEnv({ PHI_OVERSEER_SESSION_ID: "  ", PHI_OVERSEER_NAME: "boss" })).toBeUndefined();
		expect(overseerFromEnv({})).toBeUndefined();
	});

	it("puts it in the summary of a thread, and nowhere else", () => {
		const thread = makeBridge({ env: OVERSEER_ENV });
		thread.bridge.onConnected();
		expect(lastSummary(thread.link)).toMatchObject({
			sessionId: "thread-1",
			kind: "interactive",
			overseer: { sessionId: "ov-1", name: "boss", thread: "fix-tests" },
		});
		const plain = makeBridge();
		plain.bridge.onConnected();
		expect(lastSummary(plain.link)).not.toHaveProperty("overseer");
	});
});

describe("last error", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("is the last assistant message's error, one line of at most 200 chars, cleared by the next reply", () => {
		vi.useFakeTimers({ now: 5_000_000 });
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		expect(lastSummary(link)).not.toHaveProperty("lastError");
		bridge.onMessageEnd(
			assistant({ stopReason: "error", errorMessage: `529 overloaded\n\n${"detail ".repeat(60)}`, content: [] }),
		);
		vi.advanceTimersByTime(2000);
		const failed = lastSummary(link).lastError as string;
		expect(failed.startsWith("529 overloaded detail detail")).toBe(true);
		expect(failed.length).toBeLessThanOrEqual(200);
		expect(failed).not.toContain("\n");

		// An abort is not an error, and replaces the previous one.
		bridge.onMessageEnd(assistant({ stopReason: "aborted" }));
		vi.advanceTimersByTime(2000);
		expect(lastSummary(link)).not.toHaveProperty("lastError");

		bridge.onMessageEnd(assistant({ stopReason: "error", errorMessage: "" }));
		vi.advanceTimersByTime(2000);
		expect(lastSummary(link).lastError).toBe("Error");
		bridge.onMessageEnd(assistant({ stopReason: "toolUse" }));
		vi.advanceTimersByTime(2000);
		expect(lastSummary(link)).not.toHaveProperty("lastError");
	});

	it("comes from the stored branch when the session starts after a failed turn", () => {
		const message = (m: Record<string, unknown>) => ({ type: "message", id: `e${ts}`, parentId: null, message: m });
		const failed = makeBridge({
			branch: [
				message({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }),
				message(assistant({ stopReason: "error", errorMessage: "invalid api key" })),
			],
		});
		failed.bridge.onConnected();
		expect(lastSummary(failed.link).lastError).toBe("invalid api key");

		const recovered = makeBridge({
			branch: [message(assistant({ stopReason: "error", errorMessage: "boom" })), message(assistant())],
		});
		recovered.bridge.onConnected();
		expect(lastSummary(recovered.link)).not.toHaveProperty("lastError");
	});

	it("assistantError ignores everything but stopReason error", () => {
		expect(assistantError(assistant({ stopReason: "error", errorMessage: "x" }) as never)).toBe("x");
		for (const stopReason of ["stop", "length", "toolUse", "aborted"]) {
			expect(assistantError(assistant({ stopReason, errorMessage: "x" }) as never)).toBeUndefined();
		}
	});

	it("assistantError treats an AbortError's message as an abort, not an error", () => {
		for (const errorMessage of [
			"The operation was aborted.",
			"The operation was aborted",
			"This operation was aborted",
			"AbortError: The operation was aborted.",
			"Request was aborted",
		]) {
			expect(assistantError(assistant({ stopReason: "error", errorMessage }) as never)).toBeUndefined();
		}
		expect(
			assistantError(
				assistant({ stopReason: "error", errorMessage: "upstream: the operation was aborted by peer" }) as never,
			),
		).toBe("upstream: the operation was aborted by peer");
	});
});

describe("/threads over the phone and ctl", () => {
	it("shows the overseer board entry as a note and keeps other custom entries hidden", () => {
		const base = { parentId: null, timestamp: "2026-11-04T23:46:00.000Z" };
		const branch = [
			{ ...base, type: "custom", id: "e1", customType: "workspace-state", data: { text: "hidden" } },
			{ ...base, type: "custom", id: "e2", customType: "overseer-board", data: { text: "NAME  ID\nt-a   01a1" } },
			{ ...base, type: "custom", id: "e3", customType: "overseer-board", data: { text: "  " } },
		];
		const { items } = storedTranscript(branch as never, { limit: 10 });
		expect(items).toEqual([
			expect.objectContaining({ kind: "note", label: "threads", text: "NAME  ID\nt-a   01a1" }),
		]);
	});
});

describe("close from an overseer", () => {
	it("closes an interactive thread for its own overseer only, then shuts it down", async () => {
		const thread = makeBridge({ env: OVERSEER_ENV });
		thread.bridge.onConnected();
		for (const args of [{}, { overseer: "ov-2" }, { overseer: "" }, { overseer: 1 }]) {
			expect(await request(thread.bridge, thread.link, "close", args)).toMatchObject({
				ok: false,
				error: { code: "forbidden" },
			});
		}
		expect(await request(thread.bridge, thread.link, "close", { overseer: "ov-1" })).toEqual({
			t: "reply",
			re: expect.any(String),
			ok: true,
			data: {},
		});
		await vi.waitFor(() => expect(thread.shutdown).toHaveBeenCalledOnce());
		expect(thread.ctx.abort).not.toHaveBeenCalled();
	});

	it("aborts a working thread before shutting it down", async () => {
		const thread = makeBridge({ env: OVERSEER_ENV, idle: () => false });
		thread.bridge.onConnected();
		expect(await request(thread.bridge, thread.link, "close", { overseer: "ov-1" })).toMatchObject({ ok: true });
		await vi.waitFor(() => expect(thread.shutdown).toHaveBeenCalledOnce());
		expect(thread.ctx.abort).toHaveBeenCalledOnce();
	});

	it("refuses an overseer id on a session no overseer started, and still closes headless sessions for anyone", async () => {
		const plain = makeBridge();
		plain.bridge.onConnected();
		expect(await request(plain.bridge, plain.link, "close", { overseer: "ov-1" })).toMatchObject({
			ok: false,
			error: { code: "forbidden", message: "only headless sessions can be closed remotely" },
		});
		expect(plain.shutdown).not.toHaveBeenCalled();

		const headless = makeBridge({ spawnId: "spawn-1", env: OVERSEER_ENV });
		headless.bridge.onConnected();
		expect(await request(headless.bridge, headless.link, "close", {})).toMatchObject({ ok: true });
		await vi.waitFor(() => expect(headless.shutdown).toHaveBeenCalledOnce());
	});
});
