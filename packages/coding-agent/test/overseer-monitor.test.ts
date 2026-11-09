import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubConnection } from "../src/extensions/overseer/ctl.ts";
import { COALESCE_MS, POLL_MS, ThreadMonitor } from "../src/extensions/overseer/monitor.ts";
import { registryPath, ThreadRegistry } from "../src/extensions/overseer/registry.ts";
import { DEFAULT_WATCH, type OverseerEvent, type ThreadRecord } from "../src/extensions/overseer/types.ts";
import { FakeHub, summary } from "./overseer-helpers.ts";

const OVERSEER = "0190aaaa-0000-7000-8000-00000000beef";
const MIN = 60_000;

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "phi-overseer-monitor-"));
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(agentDir, { recursive: true, force: true });
});

function thread(name: string, sessionId: string, extra: Partial<ThreadRecord> = {}): ThreadRecord {
	return {
		name,
		sessionId,
		backend: "headless",
		cwd: "/tmp",
		createdAt: 0,
		watch: { ...DEFAULT_WATCH },
		state: "running",
		registered: true,
		...extra,
	};
}

describe("overseer registry persistence", () => {
	it("writes 0600 in a 0700 directory atomically and restores", () => {
		const registry = new ThreadRegistry(agentDir, OVERSEER);
		registry.threads = [
			thread("api", "s-1", { terminal: "term_1", model: "gateway/example-medium", thinking: "max" }),
		];
		registry.save();
		const file = registryPath(agentDir, OVERSEER);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(join(agentDir, "overseer")).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, overseerSessionId: OVERSEER });

		const restored = new ThreadRegistry(agentDir, OVERSEER);
		restored.load();
		expect(restored.threads).toEqual(registry.threads);
	});

	it("skips invalid records and survives a corrupt file", () => {
		const file = registryPath(agentDir, OVERSEER);
		new ThreadRegistry(agentDir, OVERSEER).save();
		writeFileSync(
			file,
			JSON.stringify({
				threads: [
					thread("ok", "s-1", { watch: { onIdle: false } as never }),
					{ name: 3 },
					{ ...thread("bad", "s-2"), state: "zombie" },
				],
			}),
		);
		const registry = new ThreadRegistry(agentDir, OVERSEER);
		registry.load();
		expect(registry.threads.map((t) => t.name)).toEqual(["ok"]);
		expect(registry.threads[0].watch).toEqual({ onIdle: false, stallMinutes: 15, heartbeatMinutes: 0 });
		writeFileSync(file, "{nope");
		registry.load();
		expect(registry.threads).toEqual([]);
	});

	it("re-matches live threads that name this overseer and that the file lost", () => {
		const registry = new ThreadRegistry(agentDir, OVERSEER);
		registry.threads = [thread("api", "s-1")];
		const added = registry.rematch(
			[
				summary({ sessionId: "s-1", overseer: { sessionId: OVERSEER, thread: "api" } }),
				summary({
					sessionId: "s-2",
					overseer: { sessionId: OVERSEER, thread: "api" },
					tmux: { session: "phi-api" },
				}),
				summary({
					sessionId: "s-3",
					kind: "headless",
					overseer: { sessionId: OVERSEER },
					name: "docs",
					lastError: "boom",
				}),
				summary({ sessionId: "s-4", overseer: { sessionId: "someone-else", thread: "x" } }),
				summary({ sessionId: "s-5" }),
			],
			5,
		);
		expect(added.map((r) => [r.name, r.sessionId, r.backend, r.tmuxSession])).toEqual([
			["api-2", "s-2", "tmux", "phi-api"],
			["docs", "s-3", "headless", undefined],
		]);
		expect(added[1].notifiedError).toBe("boom");
		expect(registry.threads).toHaveLength(3);
	});
});

interface Harness {
	hub: FakeHub;
	registry: ThreadRegistry;
	monitor: ThreadMonitor;
	woken: OverseerEvent[][];
	statuses: Array<string | undefined>;
	clock: { now: number };
	alive: Set<number>;
	observe(): Promise<OverseerEvent[]>;
}

function harness(records: ThreadRecord[]): Harness {
	const hub = new FakeHub();
	const registry = new ThreadRegistry(agentDir, OVERSEER);
	registry.threads = records;
	const woken: OverseerEvent[][] = [];
	const statuses: Array<string | undefined> = [];
	const clock = { now: 100 * MIN };
	const alive = new Set<number>();
	const monitor = new ThreadMonitor({
		registry: () => registry,
		hub: new HubConnection({ connect: hub.connect, startHub: async () => "failed", hubLog: () => "/hub.log" }),
		now: () => clock.now,
		pidAlive: (pid) => alive.has(pid),
		wake: (events) => woken.push(events),
		status: (text) => statuses.push(text),
	});
	return {
		hub,
		registry,
		monitor,
		woken,
		statuses,
		clock,
		alive,
		observe: () => monitor.observe(registry, hub.sessions),
	};
}

describe("overseer monitor transitions", () => {
	it("reports working → idle with the last reply, clipped to 1,500 chars", async () => {
		const h = harness([thread("api", "s-1", { lastStatus: "working" })]);
		const reply = `${"x".repeat(1600)}END`;
		h.hub.sessions = [
			summary({
				sessionId: "s-1",
				status: "idle",
				lastText: "short",
				model: { provider: "gateway", id: "example-medium" },
				thinkingLevel: "max",
			}),
		];
		h.hub.handlers["session.snapshot"] = () => ({
			items: [
				{ id: "1", ts: 1, kind: "assistant", text: "older" },
				{ id: "2", ts: 2, kind: "assistant", text: reply },
			],
			hasMore: false,
			state: { status: "idle" },
		});
		const events = await h.observe();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: "idle",
			thread: "api",
			summary: "turn finished · gateway/example-medium:max",
		});
		expect(events[0].text).toBe(`${"x".repeat(1500)}… [1603 chars; overseer read api for the rest]`);
		expect(h.hub.ops("session.snapshot")[0]).toMatchObject({ sessionId: "s-1", limit: 8 });
		// Nothing new on the next poll.
		expect(await h.observe()).toEqual([]);
	});

	it("labels a finished turn with the model it ran on, not the thread's model now", async () => {
		const h = harness([
			thread("b", "s-1", { lastStatus: "idle" }),
			thread("fast", "s-2", { lastStatus: "idle", lastText: "old", lastActivityAt: 10 }),
		]);
		const sonnet = { provider: "anthropic", id: "claude-sonnet-5" };
		// b is seen working on :medium, then switched to :low mid-turn (the live e2e case).
		h.hub.sessions = [
			summary({
				sessionId: "s-1",
				status: "working",
				model: sonnet,
				thinkingLevel: "medium",
				lastActivityAt: 100 * MIN,
			}),
			summary({ sessionId: "s-2", status: "idle", lastText: "old", lastActivityAt: 10, model: sonnet }),
		];
		expect(await h.observe()).toEqual([]);
		expect(h.registry.threads[0].turnModel).toBe("anthropic/claude-sonnet-5:medium");
		// s-2 finished a turn between polls on example-medium; it runs sonnet now (switched since): the stored
		// reply's model id wins, without a thinking level that cannot be known.
		h.hub.handlers["session.snapshot"] = (op) => ({
			items: [
				{
					id: "1",
					ts: 1,
					kind: "assistant",
					text: "reply",
					model: op.sessionId === "s-2" ? "example-medium" : "claude-sonnet-5",
				},
			],
			hasMore: false,
		});
		h.hub.sessions = [
			summary({
				sessionId: "s-1",
				status: "idle",
				model: sonnet,
				thinkingLevel: "low",
				lastActivityAt: 100 * MIN + 5,
			}),
			summary({ sessionId: "s-2", status: "idle", lastText: "new", lastActivityAt: 20, model: sonnet }),
		];
		const events = await h.observe();
		expect(events.map((e) => [e.thread, e.summary])).toEqual([
			["b", "turn finished · anthropic/claude-sonnet-5:medium"],
			["fast", "turn finished · example-medium"],
		]);
		expect(h.registry.threads[0].turnModel).toBeUndefined();
		// The next turn is labelled with the model it started on (:low).
		h.hub.sessions[0] = summary({
			sessionId: "s-1",
			status: "working",
			model: sonnet,
			thinkingLevel: "low",
			lastActivityAt: 100 * MIN + 10,
		});
		await h.observe();
		h.hub.sessions[0] = summary({ sessionId: "s-1", status: "idle", model: sonnet, thinkingLevel: "low" });
		expect((await h.observe()).map((e) => e.summary)).toEqual(["turn finished · anthropic/claude-sonnet-5:low"]);
	});

	it("honors watch.onIdle, abort suppression and turns finished between polls", async () => {
		const h = harness([
			thread("quiet", "s-1", { lastStatus: "working", watch: { ...DEFAULT_WATCH, onIdle: false } }),
			thread("aborted", "s-2", { lastStatus: "working" }),
			thread("fast", "s-3", { lastStatus: "idle", lastText: "old", lastActivityAt: 10 }),
			thread("awaited", "s-4", {
				lastStatus: "idle",
				lastText: "same",
				lastActivityAt: 10,
				awaitingReplySince: 100 * MIN - 10_000,
			}),
		]);
		h.monitor.expectIdleOf("s-2");
		h.hub.sessions = [
			summary({ sessionId: "s-1", status: "idle", lastText: "done" }),
			summary({ sessionId: "s-2", status: "idle" }),
			summary({ sessionId: "s-3", status: "idle", lastText: "new reply", lastActivityAt: 20 }),
			summary({ sessionId: "s-4", status: "idle", lastText: "same", lastActivityAt: 100 * MIN - 5_000 }),
		];
		const events = await h.observe();
		expect(events.map((e) => [e.kind, e.thread, e.text])).toEqual([
			["idle", "fast", "new reply"],
			["idle", "awaited", "same"],
		]);
		expect(h.registry.threads[3].awaitingReplySince).toBeUndefined();
	});

	it("does not report the error of a turn the overseer aborted, but reports later errors", async () => {
		const h = harness([thread("sleeper", "s-1", { lastStatus: "working" })]);
		h.monitor.expectIdleOf("s-1");
		h.hub.sessions = [summary({ sessionId: "s-1", status: "idle", lastError: "Command aborted mid-request" })];
		expect(await h.observe()).toEqual([]);
		expect(h.registry.threads[0].notifiedError).toBe("Command aborted mid-request");
		h.hub.sessions = [
			summary({ sessionId: "s-1", status: "working", lastError: undefined, lastActivityAt: 100 * MIN }),
		];
		expect(await h.observe()).toEqual([]);
		h.hub.sessions = [summary({ sessionId: "s-1", status: "idle", lastError: "invalid api key" })];
		expect((await h.observe()).map((e) => [e.kind, e.text])).toEqual([["error", "invalid api key"]]);
	});

	it("does not mistake a message the thread has not started on for a finished turn", async () => {
		const h = harness([
			thread("api", "s-1", { lastStatus: "idle", lastText: "x", lastActivityAt: 10, awaitingReplySince: 100 * MIN }),
		]);
		h.hub.sessions = [summary({ sessionId: "s-1", status: "idle", lastText: "x", lastActivityAt: 10 })];
		expect(await h.observe()).toEqual([]);
		h.hub.sessions = [summary({ sessionId: "s-1", status: "working", lastText: "x", lastActivityAt: 100 * MIN + 1 })];
		expect(await h.observe()).toEqual([]);
		expect(h.registry.threads[0].awaitingReplySince).toBeUndefined();
		h.hub.sessions = [summary({ sessionId: "s-1", status: "idle", lastText: "x", lastActivityAt: 100 * MIN + 9 })];
		expect((await h.observe()).map((e) => e.kind)).toEqual(["idle"]);
	});

	it("reports each distinct error once, ahead of idle", async () => {
		const h = harness([thread("api", "s-1", { lastStatus: "working" })]);
		h.hub.sessions = [summary({ sessionId: "s-1", status: "idle", lastError: "429 rate limited" })];
		const first = await h.observe();
		expect(first.map((e) => [e.kind, e.text])).toEqual([["error", "429 rate limited"]]);
		expect(await h.observe()).toEqual([]);
		h.hub.sessions = [summary({ sessionId: "s-1", status: "idle" })];
		expect(await h.observe()).toEqual([]);
		h.hub.sessions = [summary({ sessionId: "s-1", status: "idle", lastError: "429 rate limited" })];
		expect((await h.observe()).map((e) => e.kind)).toEqual(["error"]);
	});

	it("reports a stall once per stall", async () => {
		const h = harness([thread("api", "s-1", { lastStatus: "working" })]);
		const working = (lastActivityAt: number) => [
			summary({
				sessionId: "s-1",
				status: "working",
				lastActivityAt,
				activity: { tool: "bash", summary: "npm test" },
			}),
		];
		h.hub.sessions = working(h.clock.now - 14 * MIN);
		expect(await h.observe()).toEqual([]);
		h.clock.now += 2 * MIN;
		const stalled = await h.observe();
		expect(stalled.map((e) => [e.kind, e.summary])).toEqual([
			["stalled", "working with no activity for 16m (bash npm test)"],
		]);
		h.clock.now += 10 * MIN;
		expect(await h.observe()).toEqual([]);
		h.hub.sessions = working(h.clock.now);
		expect(await h.observe()).toEqual([]);
		h.clock.now += 15 * MIN;
		expect((await h.observe()).map((e) => e.kind)).toEqual(["stalled"]);
	});

	it("reports exit only for registered threads whose process is gone", async () => {
		const h = harness([
			thread("gone", "s-1", { pid: 11, terminal: "term_1" }),
			thread("restarting", "s-2", { pid: 12 }),
			thread("starting", "s-3", { registered: false }),
		]);
		h.alive.add(12);
		h.hub.sessions = [];
		const events = await h.observe();
		expect(events.map((e) => [e.kind, e.thread])).toEqual([["exited", "gone"]]);
		expect(events[0].text).toContain("forca terminal read --terminal term_1 --screen");
		expect(h.registry.threads.map((t) => t.state)).toEqual(["exited", "running", "running"]);
		expect(await h.observe()).toEqual([]);
		// A thread that registers late is picked up without an event.
		h.hub.sessions = [summary({ sessionId: "s-3", status: "working", lastActivityAt: h.clock.now })];
		expect(await h.observe()).toEqual([]);
		expect(h.registry.threads[2].registered).toBe(true);
	});

	it("sends a heartbeat digest every heartbeatMinutes while a thread works", async () => {
		const h = harness([
			thread("api", "s-1", { watch: { ...DEFAULT_WATCH, heartbeatMinutes: 5, stallMinutes: 0 } }),
			thread("docs", "s-2"),
		]);
		h.hub.sessions = [
			summary({ sessionId: "s-1", status: "working", lastActivityAt: h.clock.now }),
			summary({ sessionId: "s-2" }),
		];
		expect(await h.observe()).toEqual([]);
		h.clock.now += 4 * MIN;
		expect(await h.observe()).toEqual([]);
		h.clock.now += MIN;
		const events = await h.observe();
		expect(events.map((e) => [e.kind, e.summary])).toEqual([["heartbeat", "2 threads (1 working)"]]);
		expect(events[0].text).toMatch(/^NAME +ID +BACKEND +STATUS +HEALTH/);
		expect(events[0].text).toContain("api");
		h.clock.now += MIN;
		expect(await h.observe()).toEqual([]);
	});
});

describe("overseer monitor scheduling", () => {
	it("polls every 15 s while threads exist and coalesces a window into one message", async () => {
		vi.useFakeTimers();
		const h = harness([
			thread("api", "s-1", { lastStatus: "working" }),
			thread("docs", "s-2", { lastStatus: "working" }),
		]);
		h.hub.sessions = [
			summary({ sessionId: "s-1", status: "idle", lastText: "api done" }),
			summary({ sessionId: "s-2", status: "working", lastActivityAt: h.clock.now }),
		];
		h.monitor.sync();
		expect(h.monitor.running).toBe(true);
		expect(h.statuses.at(-1)).toBe("threads 2 working");
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(h.hub.ops("sessions.list")).toHaveLength(1);
		expect(h.statuses.at(-1)).toBe("threads 1 working · 1 idle");
		expect(h.woken).toEqual([]);
		// The second thread finishes within the coalescing window of the first event.
		h.hub.sessions = [
			summary({ sessionId: "s-1", status: "idle", lastText: "api done" }),
			summary({ sessionId: "s-2", status: "idle", lastText: "docs done" }),
		];
		await h.monitor.poll();
		await vi.advanceTimersByTimeAsync(COALESCE_MS);
		expect(h.woken).toHaveLength(1);
		expect(h.woken[0].map((e) => `${e.kind}:${e.thread}`)).toEqual(["idle:api", "idle:docs"]);
		// Persisted after each poll.
		const restored = new ThreadRegistry(agentDir, OVERSEER);
		restored.load();
		expect(restored.threads.map((t) => t.lastStatus)).toEqual(["idle", "idle"]);

		h.registry.threads.forEach((t) => {
			t.state = "closed";
		});
		h.monitor.sync();
		expect(h.monitor.running).toBe(false);
		expect(h.statuses.at(-1)).toBeUndefined();
		h.monitor.dispose();
	});

	it("survives a hub that is down and shows it in the footer", async () => {
		const h = harness([thread("api", "s-1")]);
		h.hub.down = true;
		await h.monitor.poll();
		expect(h.monitor.hubDown).toBe(true);
		expect(h.statuses.at(-1)).toBe("threads 1 · hub offline");
		expect(h.registry.threads[0].state).toBe("running");
		h.hub.down = false;
		h.hub.sessions = [summary({ sessionId: "s-1" })];
		await h.monitor.poll();
		expect(h.monitor.hubDown).toBe(false);
		h.monitor.dispose();
	});

	it("re-opens a dropped shared connection once for reads", async () => {
		const hub = new FakeHub();
		let first = true;
		const connection = new HubConnection({
			connect: async () => {
				const client = await hub.connect();
				if (first) {
					first = false;
					const { HubControlError } = await import("../src/remote/hub/control.ts");
					return {
						request: async () => {
							throw new HubControlError("session_offline", "hub connection closed");
						},
						close: client.close,
					};
				}
				return client;
			},
			startHub: async () => "failed",
			hubLog: () => "/hub.log",
		});
		hub.sessions = [summary({ sessionId: "x" })];
		const data = await connection.read<{ sessions: unknown[] }>({ op: "sessions.list" });
		expect(data.sessions).toHaveLength(1);
		expect(hub.connects).toBe(2);
		await connection.read({ op: "sessions.list" });
		expect(hub.connects).toBe(2);
		connection.close();
	});
});
