/**
 * phi remote, session side: the built-in extension must stay cheap in every phi session.
 *
 * Measures, on a real AgentSession (faux model) with a 2,000-entry transcript:
 *  - snapshot / history latency through a fake hub;
 *  - streaming a 50 KB reply (~12k text deltas) with no extension, with the extension and no hub,
 *    and with the extension connected to a hub, plus the frames that reached the hub.
 * Prints the numbers (`PHI_REMOTE_PERF=1` shows them under the dot reporter) and asserts generous
 * ceilings so a regression to per-delta serialization or sync I/O fails loudly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import remoteExtension, { resetRemoteState } from "../src/extensions/remote/index.ts";
import { HubLink } from "../src/extensions/remote/link.ts";
import type { SessionToHub } from "../src/remote/protocol.ts";
import { createHarness, createHarnessWithExtensions, type Harness } from "./test-harness.ts";

const report: string[] = [];
const note = (line: string) => {
	report.push(line);
	if (process.env.PHI_REMOTE_PERF) process.stderr.write(`[perf] ${line}\n`);
};

class FakeHub {
	readonly frames: any[] = [];
	bytes = 0;
	private server!: Server;
	private socket: Socket | undefined;
	private nextId = 0;
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	async listen(): Promise<void> {
		this.server = createServer((socket) => {
			this.socket = socket;
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				this.bytes += Buffer.byteLength(chunk);
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				let start = 0;
				while (newline !== -1) {
					const frame = JSON.parse(buffer.slice(start, newline));
					start = newline + 1;
					this.frames.push(frame);
					if (frame.t === "register") socket.write(`${JSON.stringify({ t: "registered", hubId: "perf" })}\n`);
					newline = buffer.indexOf("\n", start);
				}
				buffer = buffer.slice(start);
			});
			socket.on("error", () => undefined);
		});
		await new Promise<void>((resolve) => this.server.listen(this.path, resolve));
	}

	async request(op: string, args: Record<string, unknown> = {}): Promise<any> {
		const id = `r${++this.nextId}`;
		this.socket!.write(`${JSON.stringify({ t: "req", id, op, args })}\n`);
		return waitFor(() => this.frames.find((frame) => frame.t === "reply" && frame.re === id), 10_000);
	}

	async close(): Promise<void> {
		this.socket?.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const usage = {
	input: 10,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 2,000 persisted entries: 500 rounds of user, assistant tool call, tool result, assistant reply. */
function seedTranscript(harness: Harness, rounds = 500): void {
	const sm = harness.sessionManager;
	let ts = Date.now() - rounds * 4 * 1000;
	for (let round = 0; round < rounds; round++) {
		const user: UserMessage = { role: "user", content: `question ${round}: ${"why ".repeat(20)}`, timestamp: ts++ };
		const call: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: `Let me look (${round}).` },
				{ type: "toolCall", id: `call_${round}`, name: "read", arguments: { path: `src/file-${round}.ts` } },
			],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage,
			stopReason: "toolUse",
			timestamp: ts++,
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: `call_${round}`,
			toolName: "read",
			content: [{ type: "text", text: `export const x${round} = ${round};\n`.repeat(40) }],
			isError: false,
			timestamp: ts++,
		};
		const reply: AssistantMessage = {
			...call,
			content: [{ type: "text", text: `Answer ${round}. ${"ok ".repeat(60)}` }],
			stopReason: "stop",
			timestamp: ts++,
		};
		sm.appendMessage(user);
		sm.appendMessage(call);
		sm.appendMessage(result);
		sm.appendMessage(reply);
	}
}

/** ~50 KB of prose. */
const LONG_REPLY = Array.from(
	{ length: 800 },
	(_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog.`,
).join("\n");

describe("phi remote session extension cost", () => {
	let dir: string;
	let harness: Harness | undefined;
	let hub: FakeHub | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "phr-perf-"));
		vi.stubEnv("PI_REMOTE_DIR", dir);
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		vi.stubEnv("PHI_REMOTE", undefined);
		vi.stubEnv("PHI_REMOTE_SPAWN_ID", undefined);
	});

	afterEach(async () => {
		if (harness) {
			await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
			harness = undefined;
		}
		resetRemoteState();
		await hub?.close().catch(() => undefined);
		hub = undefined;
		rmSync(dir, { recursive: true, force: true });
		if (report.length > 0 && process.env.PHI_REMOTE_PERF) process.stderr.write("\n");
	});

	async function session(withExtension: boolean): Promise<Harness> {
		const created = withExtension
			? await createHarnessWithExtensions({
					responses: [LONG_REPLY],
					extensionFactories: [{ name: "remote", factory: remoteExtension }],
				})
			: await createHarness({ responses: [LONG_REPLY] });
		seedTranscript(created);
		if (withExtension) await created.session.bindExtensions({ mode: "rpc" });
		return created;
	}

	/** The faux provider emits every delta in one burst, so this is the CPU cost of the turn. */
	async function streamLongReply(h: Harness): Promise<{ ms: number; deltas: number }> {
		const started = performance.now();
		await h.session.prompt("write it all");
		const ms = performance.now() - started;
		const deltas = h.events.filter((event) => event.type === "message_update").length;
		return { ms, deltas };
	}

	it("snapshot and history of a 2,000-entry transcript stay fast", async () => {
		hub = new FakeHub(join(dir, "hub.sock"));
		await hub.listen();
		harness = await session(true);
		const register = await waitFor(() => hub!.frames.find((frame) => frame.t === "register"));
		const sessionId = register.session.sessionId;
		expect(harness.sessionManager.getEntries().length).toBeGreaterThanOrEqual(2000);

		const timed = async (op: string, args: Record<string, unknown>) => {
			const started = performance.now();
			const reply = await hub!.request(op, args);
			return { reply, ms: performance.now() - started };
		};
		const first = await timed("snapshot", {});
		const def = await timed("snapshot", {});
		const max = await timed("snapshot", { limit: 500 });
		expect(def.reply.ok).toBe(true);
		expect(def.reply.data.items).toHaveLength(120);
		expect(def.reply.data.hasMore).toBe(true);
		expect(max.reply.data.items).toHaveLength(500);

		// Page all the way back with history (default page size).
		let before = def.reply.data.items[0].id as string;
		let total = def.reply.data.items.length;
		let pages = 0;
		const pagingStarted = performance.now();
		for (;;) {
			const page = await hub.request("history", { before });
			expect(page.ok).toBe(true);
			pages++;
			total += page.data.items.length;
			if (!page.data.hasMore) break;
			before = page.data.items[0].id;
		}
		const pagingMs = performance.now() - pagingStarted;
		note(
			`2000-entry transcript (${total} items): first snapshot ${first.ms.toFixed(1)} ms, snapshot(120) ${def.ms.toFixed(1)} ms, ` +
				`snapshot(500) ${max.ms.toFixed(1)} ms, full history in ${pages} pages ${pagingMs.toFixed(0)} ms ` +
				`(${(pagingMs / pages).toFixed(1)} ms/page)`,
		);
		expect(total).toBe(2000); // per round: user, assistant, tool (result merged in), assistant
		expect(sessionId).toBeTruthy();
		expect(def.ms).toBeLessThan(250);
		expect(max.ms).toBeLessThan(500);
		expect(pagingMs / pages).toBeLessThan(250);
	});

	it("streaming a 50 KB reply costs little on top of the session, with or without a hub", async () => {
		// Warm up module caches so the first measured run is not penalized.
		harness = await session(false);
		await streamLongReply(harness);
		harness.cleanup();

		harness = await session(false);
		const bare = await streamLongReply(harness);
		harness.cleanup();
		harness = undefined;

		harness = await session(true);
		const noHub = await streamLongReply(harness);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		harness = undefined;
		resetRemoteState();

		hub = new FakeHub(join(dir, "hub.sock"));
		await hub.listen();
		harness = await session(true);
		const register = await waitFor(() => hub!.frames.find((frame) => frame.t === "register"));
		const sessionId = register.session.sessionId;
		const before = hub.frames.length;
		const bytesBefore = hub.bytes;
		const connected = await streamLongReply(harness);
		await waitFor(() =>
			hub!.frames.find(
				(frame) => frame.t === "event" && frame.event.type === "state" && frame.event.state.status === "idle",
			),
		);
		const frames = hub.frames.slice(before);
		const upserts = frames.filter((frame) => frame.t === "event" && frame.event.type === "item.upsert");
		const assistantUpserts = upserts.filter((frame) => frame.event.item.kind === "assistant");
		const final = assistantUpserts.at(-1)!.event.item;
		const kib = (hub.bytes - bytesBefore) / 1024;
		note(
			`50 KB reply (${connected.deltas} deltas): bare ${bare.ms.toFixed(0)} ms, ext no hub ${noHub.ms.toFixed(0)} ms, ` +
				`ext + hub ${connected.ms.toFixed(0)} ms; ` +
				`hub got ${frames.length} frames (${assistantUpserts.length} assistant upserts, ${kib.toFixed(0)} KiB)`,
		);
		expect(final.text).toBe(LONG_REPLY);
		expect(final.streaming).toBeFalsy();
		expect(sessionId).toBeTruthy();
		expect(connected.deltas).toBeGreaterThan(5000);
		// Coalesced: a handful of upserts per second, never one per delta.
		expect(assistantUpserts.length).toBeLessThan(Math.max(10, (connected.ms / 1000) * 8 + 4));
		// Overhead ceilings are generous (CI noise); per-delta serialization of the growing text
		// alone would take seconds here (12k x 25 KB average).
		expect(noHub.ms).toBeLessThan(bare.ms * 1.5 + 200);
		expect(connected.ms).toBeLessThan(bare.ms * 2 + 400);
	});

	it("bounds the outbound queue even when only undroppable replies pile up", async () => {
		hub = new FakeHub(join(dir, "hub.sock"));
		const path = join(dir, "wedged.sock");
		let peer: Socket | undefined;
		const server = createServer((socket) => {
			peer = socket;
			socket.pause(); // a wedged hub: never reads
			socket.on("error", () => undefined);
		});
		await new Promise<void>((resolve) => server.listen(path, resolve));
		const link = new HubLink({ socketPath: () => path, maxQueueBytes: 64 * 1024, minBackoffMs: 10_000 });
		let disconnects = 0;
		link.setHandlers({
			onConnect: () => undefined,
			onFrame: () => undefined,
			onDisconnect: () => disconnects++,
			onDropped: () => undefined,
		});
		link.start();
		await waitFor(() => link.connected && peer);
		const reply = { t: "reply", re: "x", ok: true, data: { pad: "y".repeat(32 * 1024) } } as unknown as SessionToHub;
		for (let n = 0; n < 2000 && link.connected; n++) link.send(reply);
		await waitFor(() => disconnects === 1);
		expect(link.connected).toBe(false);
		link.stop();
		peer?.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
});
