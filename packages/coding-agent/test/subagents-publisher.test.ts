import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentStatusPublisher } from "../src/extensions/subagents/publisher.ts";
import type { SubagentRunSnapshot } from "../src/extensions/subagents/types.ts";
import { newUsageTotals } from "../src/extensions/subagents/types.ts";

function makeRun(overrides: Partial<SubagentRunSnapshot> = {}): SubagentRunSnapshot {
	return {
		id: "legacy",
		runId: "run-1",
		handle: "worker-a",
		pid: 42,
		name: "Worker A",
		agentSource: "none",
		task: "x",
		status: "running",
		activity: "bash",
		model: "child-model",
		cwd: "/work",
		startedAt: 100,
		usage: { ...newUsageTotals(), input: 10, output: 20, contextTokens: 50, turns: 2, cost: 0.3 },
		timeline: [{ kind: "tool", name: "bash", detail: "bash" }],
		timelineDropped: 0,
		finalText: "",
		contextWindow: 200,
		...overrides,
	};
}

describe("SubagentStatusPublisher", () => {
	const publishers: SubagentStatusPublisher[] = [];
	afterEach(() => {
		for (const publisher of publishers.splice(0)) publisher.dispose();
		vi.useRealTimers();
	});

	it("uses the same durable identity for a row and its heartbeat", () => {
		const events: unknown[] = [];
		const transport = { publish: (event: unknown) => events.push(event), dispose: () => {} };
		const publisher = new SubagentStatusPublisher(
			{ cwd: "/tmp", parentSessionId: "parent", model: "m" },
			transport as never,
		);
		publishers.push(publisher);
		const run = makeRun();

		publisher.update([run]);
		const update = events[0] as { v: number; event: string; agent: Record<string, unknown> };
		const heartbeat = events[1] as { event: string; agents: string[] };
		expect(update.agent.agentKey).toBe(heartbeat.agents[0]);
		expect(update.v).toBe(1);
		expect(update.event).toBe("subagent_update");
		expect(update.agent).toMatchObject({
			agentKey: "run-1",
			runId: "run-1",
			handle: "worker-a",
			pid: 42,
			kind: "subagent",
			status: "working",
			parentSessionId: "parent",
			startedAt: 100,
			tokens: { input: 10, output: 20 },
			costUsd: 0.3,
			ctxPct: 25,
			safeActivity: { kind: "tool", name: "bash" },
		});
		expect(update.agent.activity).toEqual({ tool: "bash" });
	});

	it("keeps distinct rows when runs share a display handle", () => {
		const events: unknown[] = [];
		const publisher = new SubagentStatusPublisher({ cwd: "/tmp" }, {
			publish: (event: unknown) => events.push(event),
			dispose: () => {},
		} as never);
		publishers.push(publisher);

		publisher.update([
			makeRun({ id: "legacy-a", runId: "run-a", name: "Worker A", handle: "shared-handle" }),
			makeRun({ id: "legacy-b", runId: "run-b", name: "Worker B", handle: "shared-handle" }),
		]);

		const rows = events
			.filter(
				(event): event is { agent: Record<string, unknown> } => (event as { agent?: unknown }).agent !== undefined,
			)
			.map((event) => event.agent);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.agentKey))).toEqual(new Set(["run-a", "run-b"]));
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ agentKey: "run-a", handle: "shared-handle" }),
				expect.objectContaining({ agentKey: "run-b", handle: "shared-handle" }),
			]),
		);
	});

	it("emits a terminal event once and releases completed runs from retained state", () => {
		vi.useFakeTimers();
		const events: unknown[] = [];
		const publisher = new SubagentStatusPublisher({ cwd: "/tmp" }, {
			publish: (event: unknown) => events.push(event),
			dispose: () => {},
		} as never);
		publishers.push(publisher);
		const run = makeRun();

		publisher.update([run]);
		run.status = "done";
		run.endedAt = 200;
		publisher.complete([run]);
		publisher.complete([run]);
		// A stale terminal snapshot must not resurrect the settled run.
		publisher.update([run]);

		const terminalEvents = events.filter((event) => (event as { event?: string }).event === "subagent_end");
		expect(terminalEvents).toHaveLength(1);
		const state = publisher as unknown as {
			latest: Map<string, unknown>;
			emitted: Map<string, unknown>;
		};
		expect(state.latest.has("run-1")).toBe(false);
		expect(state.emitted.has("run-1")).toBe(false);

		vi.advanceTimersByTime(30_000);
		const heartbeats = events.filter((event) => (event as { event?: string }).event === "heartbeat");
		expect(heartbeats).toHaveLength(2);
		expect(heartbeats[1]).toMatchObject({ agents: [] });
	});

	it("emits periodic heartbeats using the latest keys", () => {
		vi.useFakeTimers();
		const events: unknown[] = [];
		const publisher = new SubagentStatusPublisher({ cwd: "/tmp" }, {
			publish: (e: unknown) => events.push(e),
			dispose: () => {},
		} as never);
		publishers.push(publisher);
		publisher.update([]);
		vi.advanceTimersByTime(30_000);
		expect(events).toEqual([expect.objectContaining({ event: "heartbeat", agents: [] })]);
	});
});
