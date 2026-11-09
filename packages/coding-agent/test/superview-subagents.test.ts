import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeadsPresencePublisher } from "../src/extensions/feads-agent/presence-publisher.ts";
import { SubagentStatusPublisher } from "../src/extensions/subagents/publisher.ts";
import type { SubagentRunSnapshot } from "../src/extensions/subagents/types.ts";
import { newUsageTotals } from "../src/extensions/subagents/types.ts";
import { SuperviewTransport } from "../src/extensions/superview-transport.ts";
import { isolateFeadsAgentDir } from "./feads-test-env.ts";

beforeEach(() => {
	isolateFeadsAgentDir();
});

function run(): SubagentRunSnapshot {
	return {
		id: "run-1",
		runId: "run-1",
		handle: "worker-1",
		name: "Worker",
		agentSource: "none",
		task: "test",
		status: "running",
		usage: newUsageTotals(),
		timeline: [],
		timelineDropped: 0,
		finalText: "",
	};
}

describe("Superview subagent presence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses one Feads publisher for the main and child transport paths", () => {
		vi.stubEnv("FEADS_AGENT_TOKEN", undefined);
		const instances = new Set<FeadsPresencePublisher>();
		vi.spyOn(FeadsPresencePublisher.prototype, "publish").mockImplementation(function (this: FeadsPresencePublisher) {
			instances.add(this);
		});
		const dispose = vi.spyOn(FeadsPresencePublisher.prototype, "dispose");
		const parentSessionId = "shared-parent-session";
		const mainTransport = new SuperviewTransport({
			parentSessionId,
			socketPath: "/dev/null/phi-superview.sock",
			spoolPath: "/dev/null/phi-superview-feed.jsonl",
		});
		const childPublisher = new SubagentStatusPublisher({ parentSessionId, cwd: "/tmp" });

		mainTransport.publish({ event: "main" });
		childPublisher.update([run()]);
		expect(instances.size).toBe(1);

		mainTransport.dispose();
		expect(dispose).not.toHaveBeenCalled();
		childPublisher.dispose();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("deduplicates unchanged snapshots while preserving heartbeats and terminal events", () => {
		const events: unknown[] = [];
		const publisher = new SubagentStatusPublisher({ cwd: "/tmp", parentSessionId: "dedup-parent" }, {
			publish: (event: unknown) => events.push(event),
			dispose: () => {},
		} as never);
		const child = run();

		publisher.update([child]);
		publisher.update([child]);
		const agentEvents = () => events.filter((event) => (event as { agent?: unknown }).agent !== undefined);
		expect(agentEvents()).toHaveLength(1);
		expect(events.filter((event) => (event as { event?: string }).event === "heartbeat")).toHaveLength(2);

		child.activity = "read";
		publisher.update([child]);
		expect(agentEvents()).toHaveLength(2);

		publisher.complete([child]);
		publisher.complete([child]);
		expect(agentEvents()).toHaveLength(3);
		expect((agentEvents()[2] as { event: string }).event).toBe("subagent_end");
		publisher.dispose();
	});
});
