/**
 * The subagents extension publishes each run on the extension event bus (subagents/feed.ts) for
 * phi remote: start (with the tool call, position, task name and a control handle), every child
 * JSON record, and the end.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { SUBAGENT_FEED_CHANNEL, type SubagentFeedEvent } from "../src/extensions/subagents/feed.ts";
import type { RunProcessOptions, SubagentControlCommand } from "../src/extensions/subagents/runner.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const fake = vi.hoisted(() => ({
	runs: new Map<string, { options: RunProcessOptions; finish: (status: "done" | "failed") => void }>(),
	controlSent: [] as unknown[],
}));

vi.mock("../src/extensions/subagents/runner.ts", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		async executeRun(options: RunProcessOptions) {
			options.run.status = "running";
			options.run.startedAt = Date.now();
			options.onControlReady?.({
				send: (command: unknown) => {
					fake.controlSent.push({ run: options.run.name, command });
					return true;
				},
			});
			options.onEvent?.({ type: "agent_start" });
			options.onEvent?.({ type: "message_start", message: { role: "user", content: `Task: ${options.run.task}` } });
			await new Promise<void>((resolve) => {
				const finish = (status: "done" | "failed") => {
					options.run.status = status;
					options.run.endedAt = Date.now();
					resolve();
				};
				options.signal?.addEventListener("abort", () => {
					options.run.status = "aborted";
					options.run.endedAt = Date.now();
					resolve();
				});
				fake.runs.set(options.run.name, { options, finish });
			});
			options.onChange();
		},
	};
});

import subagentsExtension from "../src/extensions/subagents/index.ts";

function setup() {
	vi.stubEnv("PI_SUBAGENT_ID", "");
	initTheme("dark");
	let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
	const listeners = new Map<string, (_event: unknown, ctx?: unknown) => void>();
	const events = createEventBus();
	const feed: SubagentFeedEvent[] = [];
	events.on(SUBAGENT_FEED_CHANNEL, (data) => feed.push(data as SubagentFeedEvent));
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		ui: { theme, onTerminalInput: () => () => {}, getEditorText: () => "", setWidget() {}, setStatus() {} },
		model: undefined,
		thinkingLevel: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
	};
	const pi = {
		events,
		registerTool: (definition: typeof tool) => {
			tool = definition;
		},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		registerCommand() {},
		on: (event: string, callback: (_event: unknown, ctx?: unknown) => void) => {
			listeners.set(event, callback);
		},
		emitSubagentSpawn: async () => ({}),
		sendMessage() {},
	} as unknown as ExtensionAPI;
	subagentsExtension(pi);
	if (!tool) throw new Error("subagent tool did not register");
	const registered = tool;
	return {
		feed,
		execute: (params: Record<string, unknown>) => registered.execute("toolu_42", params, undefined, undefined, ctx),
		shutdown: () => listeners.get("session_shutdown")?.({}),
	};
}

afterEach(() => {
	for (const entry of fake.runs.values()) entry.finish("done");
	fake.runs.clear();
	fake.controlSent.length = 0;
	vi.unstubAllEnvs();
});

describe("subagent feed for phi remote", () => {
	it("publishes start/event/end per run with the tool call, position, name and a control handle", async () => {
		const { feed, execute, shutdown } = setup();
		try {
			await execute({
				tasks: [{ task: "reply with exactly A", name: "ws-a" }, { task: "reply with exactly B" }],
			});
			await vi.waitFor(() => expect(fake.runs.size).toBe(2));
			const starts = feed.filter((event) => event.type === "start");
			expect(starts).toHaveLength(2);
			expect(starts[0]).toMatchObject({
				toolCallId: "toolu_42",
				index: 0,
				mode: "parallel",
				background: true,
				taskName: "ws-a",
			});
			expect(starts[1]).toMatchObject({ toolCallId: "toolu_42", index: 1, mode: "parallel" });
			expect(starts[1]).not.toHaveProperty("taskName");
			const events = feed.filter((event) => event.type === "event");
			expect(events.map((event) => event.type === "event" && event.event.type)).toEqual([
				"agent_start",
				"message_start",
				"agent_start",
				"message_start",
			]);
			expect(events[0].run).toBe(starts[0].run);

			// Control: steer through the stdin channel; kill aborts that run only.
			const first = starts[0];
			const second = starts[1];
			if (first.type !== "start" || second.type !== "start") throw new Error("unreachable");
			const steer: SubagentControlCommand = { type: "steer", message: "hurry" };
			expect(first.control.send(steer)).toBe(true);
			expect(fake.controlSent).toEqual([{ run: "ws-a", command: steer }]);
			expect(second.control.kill("Killed from phi remote")).toBe(true);
			await vi.waitFor(() => expect(feed.filter((event) => event.type === "end")).toHaveLength(1));
			expect(second.run).toMatchObject({ status: "aborted", killedBy: "kill-action" });
			expect(second.control.kill("again")).toBe(false);
			expect(second.control.send(steer)).toBe(false);

			fake.runs.get("ws-a")?.finish("done");
			await vi.waitFor(() => expect(feed.filter((event) => event.type === "end")).toHaveLength(2));
			expect(feed.at(-1)).toMatchObject({ type: "end", run: { name: "ws-a", status: "done" } });
		} finally {
			shutdown();
		}
	});

	it("stops publishing once the session shuts down", async () => {
		const { feed, execute, shutdown } = setup();
		await execute({ task: "long one", name: "slow" });
		await vi.waitFor(() => expect(fake.runs.size).toBe(1));
		const count = feed.length;
		shutdown();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(feed.slice(count).filter((event) => event.type === "end")).toEqual([]);
	});
});
