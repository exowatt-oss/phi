import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { SubagentRunSnapshot } from "../src/extensions/subagents/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const fake = vi.hoisted(() => ({
	commands: [] as unknown[],
	finish: undefined as (() => void) | undefined,
	run: undefined as SubagentRunSnapshot | undefined,
}));

vi.mock("../src/extensions/subagents/runner.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/extensions/subagents/runner.ts")>();
	return {
		...actual,
		async executeRun(options: Parameters<typeof actual.executeRun>[0]) {
			fake.run = options.run;
			options.run.status = "running";
			options.run.turnState = "mid-turn";
			options.onControlReady?.({
				send(command) {
					fake.commands.push(command);
					return true;
				},
			});
			options.onChange();
			await new Promise<void>((resolve) => {
				fake.finish = resolve;
			});
			options.run.status = "done";
			options.run.turnState = "idle-awaiting-close";
			options.onChange();
		},
	};
});

import subagentsExtension from "../src/extensions/subagents/index.ts";

function setup() {
	vi.stubEnv("PI_SUBAGENT_ID", "");
	initTheme("dark");
	let tool:
		| {
				execute(
					id: string,
					params: Record<string, unknown>,
					signal: undefined,
					onUpdate: undefined,
					ctx: unknown,
				): Promise<{ content: { text: string }[] }>;
		  }
		| undefined;
	const listeners = new Map<string, (_event: unknown, ctx?: unknown) => void>();
	const ui = {
		theme,
		onTerminalInput: () => () => {},
		getEditorText: () => "",
		setWidget() {},
		setStatus() {},
	};
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		ui,
		model: undefined,
		thinkingLevel: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
	};
	const pi = {
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
	return { tool, ctx, shutdown: () => listeners.get("session_shutdown")?.({}) };
}

describe("subagent action:message", () => {
	afterEach(() => {
		fake.finish?.();
		fake.finish = undefined;
		fake.run = undefined;
		fake.commands.length = 0;
		vi.unstubAllEnvs();
	});

	it("delivers a steer, answers a pending question, and rejects a finished run", async () => {
		const { tool, ctx, shutdown } = setup();
		const execute = (params: Record<string, unknown>) => tool.execute("group-1", params, undefined, undefined, ctx);
		try {
			const launch = await execute({ task: "work", name: "worker", background: true });
			expect(launch.content[0].text).toContain("Launched 1 subagent");
			const delivered = await execute({ action: "message", target: "worker", message: "Focus on tests" });
			expect(delivered.content[0].text).toBe("delivered to worker (lands after its current tool call)");
			expect(fake.commands[0]).toEqual({
				type: "steer",
				message: "[message from your parent agent] Focus on tests",
			});

			if (!fake.run) throw new Error("mock run missing");
			fake.run.pendingQuestion = {
				kind: "blocker",
				toolCallId: "ask-1",
				message: "Which branch?",
				timeoutSeconds: 600,
				at: Date.now(),
			};
			const answered = await execute({ action: "message", target: fake.run.handle, message: "main" });
			expect(answered.content[0].text).toBe("answered worker's question");
			expect(fake.commands[1]).toEqual({
				type: "reply",
				toolCallId: "ask-1",
				text: "[message from your parent agent] main",
			});

			fake.finish?.();
			await vi.waitFor(async () => {
				const status = await execute({ action: "status" });
				expect(status.content[0].text).toContain("worker [done]");
			});
			const finished = await execute({ action: "message", target: "worker", message: "late" });
			expect(finished.content[0].text).toContain("is not running. Live runs: none. Launch a new run");
		} finally {
			shutdown();
		}
	});

	it("starts a new turn when idle and respects follow_up mode", async () => {
		const { tool, ctx, shutdown } = setup();
		const execute = (params: Record<string, unknown>) => tool.execute("group-2", params, undefined, undefined, ctx);
		try {
			await execute({ task: "work", name: "worker", background: true });
			if (!fake.run) throw new Error("mock run missing");
			fake.run.turnState = "idle-awaiting-close";
			const delivered = await execute({ action: "message", target: "worker", message: "Extra", mode: "follow_up" });
			expect(delivered.content[0].text).toBe("delivered to worker (starts a new turn — it was idle)");
			expect(fake.commands[0]).toEqual({ type: "follow_up", message: "[message from your parent agent] Extra" });
		} finally {
			shutdown();
		}
	});
});
