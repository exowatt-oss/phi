/**
 * phi remote, session side, in isolation: the bridge against a fake link (fake timers for the
 * coalescing rules), the hub link against a bare socket server, and the transcript mapping.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	ITEM_INTERVAL_MS,
	SessionBridge,
	STATE_INTERVAL_MS,
	SUMMARY_INTERVAL_MS,
} from "../src/extensions/remote/bridge.ts";
import { phiInvocation } from "../src/extensions/remote/control.ts";
import { HubLink, type LinkLike } from "../src/extensions/remote/link.ts";
import { clampArgs, headTail, toolSummary, walkBranch } from "../src/extensions/remote/transcript.ts";
import { showPairing } from "../src/extensions/remote/ui.ts";
import type { SessionToHub } from "../src/remote/protocol.ts";

type Frame = any;

function fakeLink(): LinkLike & { sent: { frame: Frame; at: number }[] } {
	const sent: { frame: Frame; at: number }[] = [];
	return {
		connected: true,
		sent,
		send(frame: SessionToHub) {
			sent.push({ frame: JSON.parse(JSON.stringify(frame)), at: Date.now() });
		},
	};
}

function makeBridge(options: { idle?: () => boolean; spawnId?: string } = {}) {
	const link = fakeLink();
	const pi = {
		sendUserMessage: vi.fn(),
		setModel: vi.fn(async () => true),
		setThinkingLevel: vi.fn(),
		getThinkingLevel: () => "off" as const,
		getSessionName: () => undefined,
	};
	const ctx = {
		mode: "tui",
		cwd: "/tmp/project",
		model: { provider: "faux", id: "faux-1", name: "Faux", reasoning: false },
		sessionManager: {
			getSessionId: () => "session-1",
			getLeafId: () => null,
			getBranch: () => [],
			getEntries: () => [],
			getEntry: () => undefined,
		},
		isIdle: options.idle ?? (() => true),
		abort: vi.fn(),
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 12.345 }),
		modelRegistry: { getAvailable: () => [], find: () => undefined },
	} as unknown as ExtensionContext;
	const shutdown = vi.fn();
	const bridge = new SessionBridge({ pi, ctx, link, host: "box", spawnId: options.spawnId, shutdown });
	return { bridge, link, pi, ctx, shutdown };
}

function upsertsFor(link: ReturnType<typeof fakeLink>, id: string) {
	return link.sent.filter(
		(s) => s.frame.t === "event" && s.frame.event.type === "item.upsert" && s.frame.event.item.id === id,
	);
}

function stateEvents(link: ReturnType<typeof fakeLink>) {
	return link.sent.filter((s) => s.frame.t === "event" && s.frame.event.type === "state");
}

async function request(bridge: SessionBridge, link: ReturnType<typeof fakeLink>, op: string, args: unknown = {}) {
	const id = `q${Math.random()}`;
	bridge.onFrame({ t: "req", id, op, args } as never);
	await vi.waitFor(() => {
		if (!link.sent.some((s) => s.frame.t === "reply" && s.frame.re === id)) throw new Error("no reply yet");
	});
	return link.sent.find((s) => s.frame.t === "reply" && s.frame.re === id)!.frame;
}

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp: 5000,
	model: "faux-1",
	provider: "faux",
	api: "anthropic-messages",
	stopReason: "pending",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0.01 } },
	...extra,
});

describe("session bridge", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers with a full summary", () => {
		const { bridge, link } = makeBridge({ spawnId: "spawn-7" });
		bridge.onConnected();
		expect(link.sent[0].frame).toMatchObject({
			t: "register",
			v: 1,
			spawnId: "spawn-7",
			session: {
				sessionId: "session-1",
				name: "project",
				cwd: "/tmp/project",
				host: "box",
				kind: "headless",
				status: "idle",
				model: { provider: "faux", id: "faux-1", name: "Faux" },
				thinkingLevel: "off",
				usage: { costUsd: 0, contextPercent: 12.3 },
			},
		});
	});

	it("coalesces streaming text to at most 8 upserts per second and sends the final at once", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		bridge.onMessageStart(assistant(""));
		for (let index = 1; index <= 100; index++) {
			vi.advanceTimersByTime(10);
			bridge.onMessageUpdate(assistant("x".repeat(index)));
		}
		const streamed = upsertsFor(link, "a:5000");
		expect(streamed.length).toBeGreaterThanOrEqual(8);
		expect(streamed.length).toBeLessThanOrEqual(10);
		for (let index = 1; index < streamed.length; index++) {
			expect(streamed[index].at - streamed[index - 1].at).toBeGreaterThanOrEqual(ITEM_INTERVAL_MS);
		}
		expect(streamed.every((s) => s.frame.event.item.streaming === true)).toBe(true);

		bridge.onMessageEnd(assistant("x".repeat(100), { stopReason: "stop" }));
		const final = upsertsFor(link, "a:5000").at(-1)!.frame.event.item;
		expect(final).toEqual({ id: "a:5000", ts: 5000, kind: "assistant", text: "x".repeat(100), model: "faux-1" });
		const count = upsertsFor(link, "a:5000").length;
		vi.advanceTimersByTime(2000);
		expect(upsertsFor(link, "a:5000")).toHaveLength(count);
	});

	it("coalesces partial tool output the same way", () => {
		vi.useFakeTimers({ now: 2_000_000 });
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		bridge.onMessageEnd({
			...assistant("", { stopReason: "toolUse" }),
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } }],
		});
		bridge.onToolStart("c1", "bash", { command: "make" });
		for (let index = 1; index <= 50; index++) {
			vi.advanceTimersByTime(10);
			bridge.onToolUpdate("c1", { content: [{ type: "text", text: `line ${index}` }] });
		}
		const updates = upsertsFor(link, "t:5000:c1");
		expect(updates.length).toBeLessThanOrEqual(6);
		bridge.onToolEnd("c1", { content: [{ type: "text", text: "done" }] }, false);
		expect(upsertsFor(link, "t:5000:c1").at(-1)!.frame.event.item).toMatchObject({
			status: "ok",
			output: "done",
			summary: "bash  make",
		});
	});

	it("throttles state events to 4/s and always delivers the final state", () => {
		vi.useFakeTimers({ now: 3_000_000 });
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		bridge.onAgentStart();
		for (let index = 0; index < 20; index++) {
			bridge.onToolStart(`c${index}`, "read", { path: `f${index}` });
			vi.advanceTimersByTime(5);
			bridge.onToolEnd(`c${index}`, { content: [] }, false);
		}
		bridge.onAgentSettled();
		vi.advanceTimersByTime(STATE_INTERVAL_MS + SUMMARY_INTERVAL_MS);
		const states = stateEvents(link);
		for (let index = 1; index < states.length; index++) {
			expect(states[index].at - states[index - 1].at).toBeGreaterThanOrEqual(STATE_INTERVAL_MS);
		}
		expect(states.length).toBeLessThanOrEqual(3);
		expect(states.at(-1)!.frame.event.state).toEqual({ status: "idle" });
		const summaries = link.sent.filter((s) => s.frame.t === "upsert");
		expect(summaries.at(-1)!.frame.session.status).toBe("idle");
	});

	it("routes prompts: auto/steer steer a busy run (and start an idle one), followUp queues", async () => {
		const { bridge, link, pi } = makeBridge();
		bridge.onConnected();
		expect(await request(bridge, link, "prompt", { text: "hi" })).toMatchObject({ ok: true });
		expect(pi.sendUserMessage).toHaveBeenLastCalledWith("hi", { deliverAs: "steer" });
		await request(bridge, link, "prompt", { text: "later", mode: "followUp" });
		expect(pi.sendUserMessage).toHaveBeenLastCalledWith("later", { deliverAs: "followUp" });
		await request(bridge, link, "prompt", { text: "see", images: [{ mimeType: "image/png", data: "AAAA" }] });
		expect(pi.sendUserMessage).toHaveBeenLastCalledWith(
			[
				{ type: "text", text: "see" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			{ deliverAs: "steer" },
		);
		expect(await request(bridge, link, "prompt", { text: "  " })).toMatchObject({ ok: false });
	});

	it("aborts only a working session and closes only a headless one", async () => {
		let idle = true;
		const interactive = makeBridge({ idle: () => idle });
		interactive.bridge.onConnected();
		await request(interactive.bridge, interactive.link, "abort");
		expect(interactive.ctx.abort).not.toHaveBeenCalled();
		idle = false;
		interactive.bridge.onAgentStart();
		await request(interactive.bridge, interactive.link, "abort");
		expect(interactive.ctx.abort).toHaveBeenCalledOnce();
		expect(await request(interactive.bridge, interactive.link, "close")).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});

		const headless = makeBridge({ spawnId: "s" });
		headless.bridge.onConnected();
		expect(await request(headless.bridge, headless.link, "close")).toMatchObject({ ok: true });
		await vi.waitFor(() => expect(headless.shutdown).toHaveBeenCalledOnce());
	});

	it("marks a message cut off by the end of the run as aborted and running tools as error", () => {
		const { bridge, link } = makeBridge();
		bridge.onConnected();
		bridge.onAgentStart();
		bridge.onMessageEnd({
			...assistant("", { stopReason: "toolUse", timestamp: 7000 }),
			content: [{ type: "toolCall", id: "c9", name: "read", arguments: { path: "x" } }],
		});
		bridge.onMessageStart(assistant("half", { timestamp: 8000 }));
		bridge.onAgentSettled();
		expect(upsertsFor(link, "a:8000").at(-1)!.frame.event.item).toMatchObject({ error: "aborted" });
		expect(upsertsFor(link, "a:8000").at(-1)!.frame.event.item).not.toHaveProperty("streaming");
		expect(upsertsFor(link, "t:7000:c9").at(-1)!.frame.event.item).toMatchObject({ status: "error" });
	});

	it("emits nothing while disconnected", () => {
		const { bridge, link } = makeBridge();
		(link as { connected: boolean }).connected = false;
		bridge.onAgentStart();
		bridge.onMessageStart(assistant("x"));
		bridge.onMessageEnd(assistant("x", { stopReason: "stop" }));
		bridge.onAgentSettled();
		expect(link.sent).toHaveLength(0);
	});
});

describe("hub link", () => {
	const cleanups: (() => void | Promise<void>)[] = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function server(path: string, onSocket: (socket: Socket) => void): Promise<Server> {
		const open: Socket[] = [];
		const created = createServer((socket) => {
			open.push(socket);
			socket.on("error", () => undefined);
			onSocket(socket);
		});
		await new Promise<void>((resolve) => created.listen(path, resolve));
		cleanups.push(() => {
			for (const socket of open) socket.destroy();
			return new Promise<void>((resolve) => created.close(() => resolve()));
		});
		return created;
	}

	function makeDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "phl-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		return dir;
	}

	it("stays away after bye until a new hub replaces the socket", async () => {
		const dir = makeDir();
		const path = join(dir, "hub.sock");
		const sockets: Socket[] = [];
		const first = await server(path, (socket) => {
			sockets.push(socket);
			socket.write('{"t":"bye","reason":"shutting down"}\n');
		});
		const link = new HubLink({ socketPath: () => path, watchIntervalMs: 30, minBackoffMs: 20, maxBackoffMs: 40 });
		cleanups.push(() => link.stop());
		let connects = 0;
		link.setHandlers({
			onConnect: () => connects++,
			onFrame: () => undefined,
			onDisconnect: () => undefined,
			onDropped: () => undefined,
		});
		link.start();
		await vi.waitFor(() => expect(connects).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(connects).toBe(1);
		// A new hub: the old socket file goes away and a new one appears.
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => first.close(() => resolve()));
		await server(path, () => undefined);
		await vi.waitFor(() => expect(connects).toBe(2), { timeout: 2000 });
	});

	it("reconnects with backoff after the hub drops the connection", async () => {
		const dir = makeDir();
		const path = join(dir, "hub.sock");
		let accepted = 0;
		await server(path, (socket) => {
			accepted++;
			if (accepted === 1) socket.destroy();
		});
		const link = new HubLink({ socketPath: () => path, watchIntervalMs: 30, minBackoffMs: 20, maxBackoffMs: 40 });
		cleanups.push(() => link.stop());
		link.start();
		await vi.waitFor(() => expect(accepted).toBe(2), { timeout: 2000 });
		await vi.waitFor(() => expect(link.connected).toBe(true));
	});

	it("drops the oldest droppable frames beyond the queue cap and asks for a reset once drained", async () => {
		const dir = makeDir();
		const path = join(dir, "hub.sock");
		let peer: Socket | undefined;
		let received = 0;
		await server(path, (socket) => {
			peer = socket;
			socket.pause();
			socket.on("data", (chunk) => {
				received += chunk.length;
			});
		});
		const link = new HubLink({ socketPath: () => path, maxQueueBytes: 64 * 1024 });
		cleanups.push(() => link.stop());
		let dropped = 0;
		link.setHandlers({
			onConnect: () => undefined,
			onFrame: () => undefined,
			onDisconnect: () => undefined,
			onDropped: () => dropped++,
		});
		link.start();
		await vi.waitFor(() => expect(link.connected && peer).toBeTruthy());
		const text = "x".repeat(16 * 1024);
		for (let index = 0; index < 400; index++) {
			link.send({ t: "event", sessionId: "s", event: { type: "reset" } } as SessionToHub, { droppable: true });
			link.send({ t: "upsert", session: { name: text } } as never, { droppable: true });
		}
		link.send({ t: "reply", re: "keep", ok: true, data: {} } as SessionToHub);
		peer!.resume();
		await vi.waitFor(() => expect(dropped).toBe(1), { timeout: 5000 });
		// Far less than the ~6.5 MB offered went over the wire.
		expect(received).toBeLessThan(2 * 1024 * 1024);
	});
});

describe("transcript mapping", () => {
	it("summarizes tool calls on one line", () => {
		expect(toolSummary("bash", { command: "ls -la\n  | wc -l" })).toBe("bash  ls -la | wc -l");
		expect(toolSummary("edit", { path: "src/a.ts", oldText: "x", newText: "y" })).toBe("edit  src/a.ts");
		expect(toolSummary("mcp_search", { limit: 3, query: "phi" })).toBe("mcp_search  phi");
		expect(toolSummary("todo", { items: [] })).toBe("todo");
	});

	it("caps args at ~4 KB and output head+tail", () => {
		const args = clampArgs({ content: "y".repeat(20_000), path: "a" }) as { content: string; path: string };
		expect(JSON.stringify(args).length).toBeLessThanOrEqual(4096);
		expect(args.path).toBe("a");
		const cut = headTail(`${"a".repeat(10_000)}END`, 8192);
		expect(cut.truncated).toBe(true);
		expect(cut.text.length).toBeLessThanOrEqual(8192);
		expect(cut.text.endsWith("END")).toBe(true);
	});

	it("pairs reused tool-call ids with the right turn and pages by id", () => {
		const entry = (id: string, message: unknown): SessionEntry =>
			({ type: "message", id, parentId: null, timestamp: new Date(1000).toISOString(), message }) as SessionEntry;
		const call = (ts: number, text: string) => ({
			role: "assistant",
			content: [
				{ type: "text", text },
				{ type: "toolCall", id: "call_0", name: "read", arguments: { path: text } },
			],
			timestamp: ts,
			stopReason: "toolUse",
		});
		const result = (text: string) => ({
			role: "toolResult",
			toolCallId: "call_0",
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 1,
		});
		const branch = [
			entry("e1", { role: "user", content: "go", timestamp: 100 }),
			entry("e2", call(200, "one")),
			entry("e3", result("first result")),
			entry("e4", call(300, "two")),
			entry("e5", result("second result")),
			entry("e6", { role: "bashExecution", command: "pwd", output: "/x\n", exitCode: 0, timestamp: 400 }),
			{
				type: "custom_message",
				id: "e7",
				parentId: null,
				timestamp: new Date(2000).toISOString(),
				customType: "mail",
				content: "hello",
				display: true,
			} as SessionEntry,
			{
				type: "custom_message",
				id: "e8",
				parentId: null,
				timestamp: new Date(2000).toISOString(),
				customType: "hidden",
				content: "no",
				display: false,
			} as SessionEntry,
		];
		const walk = walkBranch(branch, { limit: 100, orphanStatus: "error" });
		expect(walk.items.map((item) => item.id)).toEqual([
			"u:100",
			"a:200",
			"t:200:call_0",
			"a:300",
			"t:300:call_0",
			"b:400",
			"e:e7",
		]);
		const tools = walk.items.filter((item) => item.kind === "tool");
		expect(tools.map((item) => (item.kind === "tool" ? item.output : ""))).toEqual(["first result", "second result"]);
		expect(walk.items.at(-2)).toMatchObject({ kind: "note", label: "bash", text: "$ pwd\n/x" });
		expect(walk.items.at(-1)).toMatchObject({ kind: "note", label: "mail", text: "hello" });

		const page = walkBranch(branch, { limit: 2, before: "a:300", orphanStatus: "error" });
		expect(page.items.map((item) => item.id)).toEqual(["a:200", "t:200:call_0"]);
		expect(page.hasMore).toBe(true);
		expect(walkBranch(branch, { limit: 2, before: "nope", orphanStatus: "error" }).found).toBe(false);
	});
});

describe("/remote pairing card", () => {
	it("shows the QR code, code, expiry and URLs, and closes on any key", async () => {
		let rendered: string[] = [];
		let closed = false;
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const ctx = {
			mode: "tui",
			ui: {
				custom: async (
					factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void },
				) => {
					const component = factory({}, theme, {}, () => {
						closed = true;
					});
					rendered = component.render(120);
					component.handleInput("x");
				},
			},
		} as never;
		await showPairing(ctx, {
			code: "K7Q2M9XD",
			expiresAt: Date.now() + 10 * 60_000,
			hubId: "hub-1",
			name: "demo-laptop",
			urls: ["http://192.0.2.52:7717", "http://example.invalid:7717"],
			link: "phiremote://pair?v=1&code=K7Q2M9XD&name=demo-laptop&hubId=hub-1&url=http%3A%2F%2F192.0.2.52%3A7717",
		});
		const text = rendered.join("\n");
		expect(text).toContain("K7Q2M9XD");
		expect(text).toContain("http://example.invalid:7717");
		expect(rendered.filter((line) => /[▀▄█]/.test(line)).length).toBeGreaterThan(10);
		expect(closed).toBe(true);
	});
});

describe("hub invocation", () => {
	it("re-runs the same entry point, never a compiled binary's virtual script", () => {
		expect(phiInvocation(["node", "/opt/phi/dist/cli.js"], "/usr/bin/node")).toEqual([
			"/usr/bin/node",
			"/opt/phi/dist/cli.js",
		]);
		expect(phiInvocation(["node", "/src/cli.ts"], "/usr/bin/node")).toEqual(["/usr/bin/node", "/src/cli.ts"]);
		expect(phiInvocation(["bun", "/$bunfs/root/cli.js"], "/usr/local/bin/phi")).toEqual(["/usr/local/bin/phi"]);
		expect(phiInvocation(["/usr/local/bin/phi"], "/usr/local/bin/phi")).toEqual(["/usr/local/bin/phi"]);
	});
});
