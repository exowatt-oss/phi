/**
 * phi remote, session side, end to end: a real AgentSession (faux model, fake tools) with the
 * built-in `remote` extension, talking to a fake hub on a temp PI_REMOTE_DIR socket.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import remoteExtension, { resetRemoteState } from "../src/extensions/remote/index.ts";
import { readStoredTranscript } from "../src/remote/hub/history.ts";
import type { TranscriptItem } from "../src/remote/protocol.ts";
import {
	createHarnessWithExtensions,
	type FauxResponseInput,
	type Harness,
	type HarnessOptions,
} from "./test-harness.ts";

type Frame = any;

class FakeHub {
	readonly connections: { socket: Socket; frames: Frame[] }[] = [];
	private server!: Server;
	private nextId = 0;
	readonly path: string;
	/** Called with every frame a session sends, after it is recorded. */
	onFrame?: (frame: Frame) => void;

	constructor(dir: string) {
		this.path = join(dir, "hub.sock");
	}

	async listen(): Promise<void> {
		this.server = createServer((socket) => {
			const connection = { socket, frames: [] as Frame[] };
			this.connections.push(connection);
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					const frame = JSON.parse(line);
					connection.frames.push(frame);
					this.onFrame?.(frame);
					if (frame.t === "register") socket.write(`${JSON.stringify({ t: "registered", hubId: "hub-test" })}\n`);
				}
			});
			socket.on("error", () => undefined);
		});
		await new Promise<void>((resolve) => this.server.listen(this.path, resolve));
	}

	get frames(): Frame[] {
		return this.connections.flatMap((connection) => connection.frames);
	}

	write(raw: string, index = 0): void {
		this.connections[index].socket.write(raw);
	}

	async request(op: string, args: Record<string, unknown> = {}, index = 0): Promise<Frame> {
		const id = `r${++this.nextId}`;
		this.write(`${JSON.stringify({ t: "req", id, op, args })}\n`, index);
		return waitFor(() => this.connections[index].frames.find((frame) => frame.t === "reply" && frame.re === id));
	}

	upserts(): TranscriptItem[] {
		return this.frames.filter((f) => f.t === "event" && f.event.type === "item.upsert").map((f) => f.event.item);
	}

	async close(): Promise<void> {
		for (const connection of this.connections) connection.socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const readTool: AgentTool = {
	name: "read",
	label: "Read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: `contents of ${(params as { path: string }).path}` }],
		details: {},
	}),
};

const bashTool: AgentTool = {
	name: "bash",
	label: "Bash",
	description: "Run a command",
	parameters: Type.Object({ command: Type.String() }),
	execute: async (_id, _params, _signal, onUpdate) => {
		onUpdate?.({ content: [{ type: "text", text: "total 0" }], details: {} });
		return { content: [{ type: "text", text: "total 0\n-rw-r--r-- app.ts" }], details: {} };
	},
};

async function startSession(
	responses: FauxResponseInput[],
	mode: "rpc" | "print" | "tui" = "rpc",
	options: Pick<HarnessOptions, "settings" | "extensionFactories" | "sessionManager"> = {},
): Promise<Harness> {
	const harness = await createHarnessWithExtensions({
		responses,
		tools: [readTool, bashTool],
		baseToolsOverride: { read: readTool, bash: bashTool },
		...(options.settings ? { settings: options.settings } : {}),
		...(options.sessionManager ? { sessionManager: options.sessionManager } : {}),
		extensionFactories: [{ name: "remote", factory: remoteExtension }, ...(options.extensionFactories ?? [])],
	});
	await harness.session.bindExtensions({ mode });
	return harness;
}

describe("phi remote session extension", () => {
	let dir: string;
	let hub: FakeHub;
	let harness: Harness | undefined;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "phr-"));
		vi.stubEnv("PI_REMOTE_DIR", dir);
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		vi.stubEnv("PHI_REMOTE", undefined);
		vi.stubEnv("PHI_REMOTE_SPAWN_ID", undefined);
		hub = new FakeHub(dir);
	});

	afterEach(async () => {
		if (harness) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
			harness = undefined;
		}
		resetRemoteState();
		await hub.close().catch(() => undefined);
		rmSync(dir, { recursive: true, force: true });
	});

	it("is a hidden built-in", () => {
		expect(builtInExtensions).toContainEqual({ name: "remote", factory: remoteExtension, hidden: true });
	});

	it("streams a realistic turn with ids identical between live upserts and the snapshot", async () => {
		await hub.listen();
		harness = await startSession([
			{
				thinking: "Let me look at the file and the directory.",
				text: "Checking two things.",
				toolCalls: [
					{ id: "call_read", name: "read", args: { path: "src/app.ts" } },
					{ id: "call_bash", name: "bash", args: { command: "ls -la" } },
				],
			},
			"All done: app.ts exists.",
		]);
		const register = await waitFor(() => hub.frames.find((frame) => frame.t === "register"));
		expect(register.v).toBe(1);
		expect(register.session).toMatchObject({
			sessionId: harness.session.sessionId,
			kind: "interactive",
			status: "idle",
			pid: process.pid,
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});

		// A prompt from the phone on an idle session starts a turn.
		const reply = await hub.request("prompt", { text: "Look at app.ts", mode: "auto" });
		expect(reply).toMatchObject({ ok: true });
		await waitFor(() => hub.upserts().some((item) => item.kind === "assistant" && item.text.startsWith("All done")));
		await waitFor(() =>
			hub.frames.some(
				(frame) => frame.t === "event" && frame.event.type === "state" && frame.event.state.status === "idle",
			),
		);

		const snapshot = await hub.request("snapshot", {});
		expect(snapshot.ok).toBe(true);
		const items: TranscriptItem[] = snapshot.data.items;
		expect(snapshot.data.hasMore).toBe(false);
		expect(snapshot.data.state).toEqual({ status: "idle" });
		expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);

		const [user, first, read, bash, last] = items;
		expect(user).toMatchObject({ kind: "user", text: "Look at app.ts" });
		expect(user.id).toMatch(/^u:\d+$/);
		expect(first).toMatchObject({
			kind: "assistant",
			text: "Checking two things.",
			thinking: "Let me look at the file and the directory.",
			model: "faux-1",
		});
		expect(first).not.toHaveProperty("streaming");
		expect(first.id).toMatch(/^a:\d+$/);
		expect(read).toMatchObject({
			kind: "tool",
			toolCallId: "call_read",
			name: "read",
			summary: "read  src/app.ts",
			args: { path: "src/app.ts" },
			status: "ok",
			output: "contents of src/app.ts",
		});
		expect(read.id).toBe(`t:${first.ts}:call_read`);
		expect(bash).toMatchObject({ summary: "bash  ls -la", status: "ok", output: "total 0\n-rw-r--r-- app.ts" });
		expect(last).toMatchObject({ kind: "assistant", text: "All done: app.ts exists." });

		// Every snapshot item is exactly the last live upsert for its id.
		const live = new Map<string, TranscriptItem>();
		for (const item of hub.upserts()) live.set(item.id, item);
		for (const item of items) expect(live.get(item.id)).toEqual(item);
		// The assistant streamed: its first upsert carried streaming:true.
		expect(hub.upserts().find((item) => item.id === first.id)).toMatchObject({ streaming: true });
		// A tool went through running before ok.
		expect(hub.upserts().find((item) => item.id === bash.id)).toMatchObject({ status: "running" });

		// Summary upserts are trailing-edge: the settled one arrives within the throttle window.
		const summary = await waitFor(
			() =>
				hub.frames
					.filter((frame) => frame.t === "upsert" && frame.session.status === "idle" && frame.session.lastText)
					.at(-1)?.session,
		);
		expect(summary).toMatchObject({ status: "idle", name: "Look at app.ts", lastText: "All done: app.ts exists." });
		// No redundant re-sends: consecutive upserts of one item always differ.
		const byId = new Map<string, string[]>();
		for (const item of hub.upserts()) byId.set(item.id, [...(byId.get(item.id) ?? []), JSON.stringify(item)]);
		for (const versions of byId.values()) {
			for (let index = 1; index < versions.length; index++) expect(versions[index]).not.toBe(versions[index - 1]);
		}

		// History pages older items with the same ids.
		const history = await hub.request("history", { before: read.id, limit: 2 });
		expect(history.data).toEqual({ items: [user, first], hasMore: false });
		const page = await hub.request("snapshot", { limit: 2 });
		expect(page.data.items).toEqual([bash, last]);
		expect(page.data.hasMore).toBe(true);
		expect(await hub.request("history", { before: "u:1" })).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});

	it("a stored transcript (hub) has the ids and shapes the resumed session's snapshot has", async () => {
		await hub.listen();
		const sessionDir = join(dir, "sessions");
		const first = SessionManager.create(join(dir, "work"), sessionDir);
		harness = await startSession(
			[
				{
					thinking: "Look first.",
					text: "Checking two things.",
					toolCalls: [
						{ id: "call_read", name: "read", args: { path: "src/app.ts" } },
						{ id: "call_bash", name: "bash", args: { command: "ls -la" } },
					],
				},
				"The code word is PELICAN.",
				"Second answer.",
			],
			"rpc",
			{ sessionManager: first },
		);
		const sessionId = harness.session.sessionId;
		const idle = async (index: number) =>
			waitFor(() =>
				hub.connections[index]?.frames.some(
					(frame) => frame.t === "event" && frame.event.type === "state" && frame.event.state.status === "idle",
				),
			);
		await waitFor(() => hub.frames.find((frame) => frame.t === "register"));
		expect(await hub.request("prompt", { text: "Look at app.ts", mode: "auto" })).toMatchObject({ ok: true });
		await waitFor(() => hub.upserts().some((item) => item.kind === "assistant" && item.text.includes("PELICAN")));
		await idle(0);
		const original = (await hub.request("snapshot", {})).data.items as TranscriptItem[];
		const file = first.getSessionFile() as string;

		// The process ends; the phone reads the stored file through the hub.
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		harness = undefined;
		resetRemoteState();
		const stored = await readStoredTranscript(file, { limit: 120 });
		expect(stored.hasMore).toBe(false);
		expect(stored.items.map((item) => item.id)).toEqual(original.map((item) => item.id));
		expect(stored.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);

		// Resumed from that file: same session id, and its snapshot is the stored transcript exactly.
		harness = await startSession(["Second answer."], "rpc", {
			sessionManager: SessionManager.open(file, sessionDir),
		});
		const register = await waitFor(() => hub.connections[1]?.frames.find((frame) => frame.t === "register"));
		expect(register.session.sessionId).toBe(sessionId);
		const resumed = await hub.request("snapshot", {}, 1);
		expect(resumed.data.items).toEqual(stored.items);
		const older = await readStoredTranscript(file, { limit: 2, before: stored.items[3].id });
		expect((await hub.request("history", { before: stored.items[3].id, limit: 2 }, 1)).data).toEqual(older);

		// A new turn continues the same file: the stored items stay the snapshot's prefix.
		expect(await hub.request("prompt", { text: "And now?", mode: "auto" }, 1)).toMatchObject({ ok: true });
		await waitFor(() =>
			hub.connections[1].frames.some(
				(frame) =>
					frame.t === "event" && frame.event.type === "item.upsert" && frame.event.item.text === "Second answer.",
			),
		);
		for (let tries = 0; (await readStoredTranscript(file, { limit: 120 })).items.length < 7; tries++) {
			if (tries > 200) throw new Error("the new turn was not persisted");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const after = (await hub.request("snapshot", {}, 1)).data.items as TranscriptItem[];
		expect(after.slice(0, stored.items.length)).toEqual(stored.items);
		expect(after.slice(stored.items.length).map((item) => item.kind)).toEqual(["user", "assistant"]);
		expect((await readStoredTranscript(file, { limit: 120 })).items).toEqual(after);
		expect(harness.session.sessionManager.getSessionFile()).toBe(file);
	});

	it("keeps the final reply of a run that compacted mid-run and then answered a follow-up", async () => {
		// Session 01a19e0c: tool work, a threshold compaction before the next model call, the final
		// reply, then a displayed custom message (subagent results) that triggered one more reply.
		await hub.listen();
		const resyncs = new Set<string>();
		let resets = 0;
		hub.onFrame = (frame) => {
			if (frame.t !== "event" || frame.event.type !== "reset") return;
			resets++;
			void hub.request("snapshot", {}).then((reply) => resyncs.add(reply.re));
		};
		let sentFollowUp = false;
		harness = await startSession(
			[
				{
					text: "It worked. Doing the second image.",
					toolCalls: [{ id: "call_bash", name: "bash", args: { command: "ls" } }],
					usage: { input: 125_000 },
				},
				"Breakdown: Sarah Jr. is fine.",
				"That message is just the screenshot helper.",
			],
			"rpc",
			{
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: "## Goal\nInvestigate Sarah's errors.",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
						pi.on("message_end", (event) => {
							const message = event.message as { role?: string; stopReason?: string };
							if (sentFollowUp || message.role !== "assistant" || message.stopReason !== "stop") return;
							sentFollowUp = true;
							pi.sendMessage(
								{ customType: "subagent-results", content: "[subagent results]", display: true },
								{ deliverAs: "followUp", triggerTurn: true },
							);
						});
					},
				],
			},
		);
		await waitFor(() => hub.frames.find((frame) => frame.t === "register"));
		await harness.session.prompt("Look at Sarah's errors");
		await harness.session.waitForIdle();
		await waitFor(() =>
			hub.frames.some(
				(frame) => frame.t === "event" && frame.event.type === "state" && frame.event.state.status === "idle",
			),
		);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		expect(harness.faux.callCount).toBe(3);
		// The compaction rewrote the transcript: subscribers were told to resubscribe.
		expect(hub.frames.some((frame) => frame.t === "event" && frame.event.type === "reset")).toBe(true);

		const shape = (items: TranscriptItem[]) =>
			items.map(
				(item) => `${item.kind}:${item.kind === "note" ? item.label : "text" in item ? item.text : item.name}`,
			);
		const expected = [
			"user:Look at Sarah's errors",
			"assistant:It worked. Doing the second image.",
			"tool:bash",
			"note:compaction",
			"assistant:Breakdown: Sarah Jr. is fine.",
			"note:subagent-results",
			"assistant:That message is just the screenshot helper.",
		];
		const snapshot = await hub.request("snapshot", {});
		const items: TranscriptItem[] = snapshot.data.items;
		expect(shape(items)).toEqual(expected);
		expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
		// Live, as the app sees it: upserts keyed by id (unknown ids append), and a fresh snapshot
		// for every reset (the compaction note itself arrives with that snapshot).
		await waitFor(() => resyncs.size === resets);
		const view = new Map<string, TranscriptItem>();
		for (const frame of hub.frames) {
			if (frame.t === "reply" && resyncs.has(frame.re)) {
				view.clear();
				for (const item of frame.data.items) view.set(item.id, item);
			} else if (frame.t === "event" && frame.event.type === "item.upsert") {
				view.set(frame.event.item.id, frame.event.item);
			}
		}
		expect([...view.values()]).toEqual(items);
	});

	it("steers a working session and routes followUp", async () => {
		await hub.listen();
		harness = await startSession([{ text: "working on it", delayMs: 300 }, "steered reply"]);
		await waitFor(() => hub.frames.find((frame) => frame.t === "register"));
		const run = harness.session.prompt("start");
		await waitFor(() =>
			hub.frames.some((f) => f.t === "event" && f.event.type === "state" && f.event.state.status === "working"),
		);
		expect(await hub.request("prompt", { text: "also check the tests" })).toMatchObject({ ok: true });
		await run;
		await harness.session.waitForIdle();
		await waitFor(() => hub.upserts().some((item) => item.kind === "assistant" && item.text === "steered reply"));
		const snapshot = await hub.request("snapshot");
		expect(snapshot.data.items.map((item: TranscriptItem) => [item.kind, "text" in item ? item.text : ""])).toEqual([
			["user", "start"],
			["assistant", "working on it"],
			["user", "also check the tests"],
			["assistant", "steered reply"],
		]);
		expect(harness.faux.callCount).toBe(2);
	});

	it("answers models / setModel / setThinking / abort / close and rejects bad requests", async () => {
		await hub.listen();
		harness = await startSession(["ok"]);
		await waitFor(() => hub.frames.find((frame) => frame.t === "register"));

		const models = await hub.request("models");
		expect(models.ok).toBe(true);
		expect(models.data.current).toEqual({ provider: "faux", id: "faux-1" });
		expect(models.data.models).toContainEqual({
			provider: "faux",
			id: "faux-1",
			name: "Faux Model",
			reasoning: false,
		});
		expect(models.data.thinkingLevels).toEqual(["off"]);
		expect(models.data.thinkingLevel).toBe("off");

		expect(await hub.request("setModel", { provider: "nope", modelId: "nothing" })).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect(await hub.request("setModel", { provider: "faux", modelId: "faux-1" })).toMatchObject({ ok: true });
		expect(await hub.request("setThinking", { level: "sideways" })).toMatchObject({
			ok: false,
			error: { code: "bad_request" },
		});
		expect(await hub.request("setThinking", { level: "high" })).toMatchObject({ ok: true });
		expect(await hub.request("abort")).toMatchObject({ ok: true });
		expect(await hub.request("close")).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await hub.request("teleport")).toMatchObject({ ok: false, error: { code: "bad_request" } });
		expect(await hub.request("prompt", { text: "x", mode: "sometimes" })).toMatchObject({
			ok: false,
			error: { code: "bad_request" },
		});
		expect(
			await hub.request("prompt", { text: "x", images: [{ mimeType: "image/tiff", data: "AAAA" }] }),
		).toMatchObject({ ok: false, error: { code: "bad_request" } });
	});

	it("re-registers on the same connection when the session id changes", async () => {
		await hub.listen();
		const runtime = createExtensionRuntime();
		runtime.getSessionName = () => undefined;
		runtime.getThinkingLevel = () => "off";
		const context = (sessionId: string) =>
			({
				mode: "tui",
				cwd: "/tmp/project",
				model: undefined,
				sessionManager: {
					getSessionId: () => sessionId,
					getLeafId: () => null,
					getBranch: () => [],
					getEntries: () => [],
					getEntry: () => undefined,
				},
				isIdle: () => true,
				getContextUsage: () => undefined,
			}) as never;
		const load = () =>
			loadExtensionFromFactory(remoteExtension, process.cwd(), createEventBus(), runtime, "<inline:remote>");
		const invoke = async (
			extension: Awaited<ReturnType<typeof load>>,
			name: string,
			event: unknown,
			ctx: unknown,
		) => {
			for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
		};

		const first = await load();
		await invoke(first, "session_start", { type: "session_start", reason: "startup" }, context("session-one"));
		await waitFor(() =>
			hub.frames.find((frame) => frame.t === "register" && frame.session.sessionId === "session-one"),
		);
		// /new: the old instance shuts down, a fresh one starts with a new session id.
		await invoke(first, "session_shutdown", { type: "session_shutdown", reason: "new" }, context("session-one"));
		const second = await load();
		await invoke(second, "session_start", { type: "session_start", reason: "new" }, context("session-two"));
		await waitFor(() =>
			hub.frames.find((frame) => frame.t === "register" && frame.session.sessionId === "session-two"),
		);
		expect(hub.connections).toHaveLength(1);
		expect(hub.connections[0].frames.filter((frame) => frame.t === "register")).toHaveLength(2);

		await invoke(second, "session_shutdown", { type: "session_shutdown", reason: "quit" }, context("session-two"));
		await waitFor(() => hub.connections[0].socket.destroyed || hub.connections[0].socket.readableEnded);
	});

	it("stays quiet without a hub and shrugs off garbage from one", async () => {
		// No socket at all: the session works and nothing connects.
		harness = await startSession(["fine"]);
		await harness.session.prompt("hello");
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();

		await hub.listen();
		harness = await startSession(["still fine"]);
		await waitFor(() => hub.frames.find((frame) => frame.t === "register"));
		hub.write('not json\n{"t":42}\n[1,2]\n{"t":"req"}\n{"t":"req","id":"g1","op":"snapshot","args":7}\n');
		const reply = await waitFor(() => hub.frames.find((frame) => frame.t === "reply" && frame.re === "g1"));
		expect(reply.ok).toBe(true);
		await harness.session.prompt("hello again");
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
		expect((await hub.request("snapshot")).data.items.map((item: TranscriptItem) => item.kind)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("does not connect in print mode", async () => {
		await hub.listen();
		harness = await startSession(["ok"], "print");
		await harness.session.prompt("hi");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(hub.connections).toHaveLength(0);
	});

	it("loads nothing in nested subagents or with PHI_REMOTE=0", async () => {
		for (const [name, value] of [
			["PI_SUBAGENT_ID", "child-run"],
			["PHI_REMOTE", "0"],
		] as const) {
			vi.stubEnv(name, value);
			const extension = await loadExtensionFromFactory(
				remoteExtension,
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"<inline:remote>",
			);
			expect(extension.handlers.size).toBe(0);
			expect(extension.commands.size).toBe(0);
			vi.unstubAllEnvs();
		}
	});
});
