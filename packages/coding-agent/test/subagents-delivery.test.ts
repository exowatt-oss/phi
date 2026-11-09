import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { RunProcessOptions } from "../src/extensions/subagents/runner.ts";
import {
	SUBAGENT_RESULTS_MESSAGE_TYPE,
	SUBAGENT_STALL_NOTE_MESSAGE_TYPE,
	type SubagentResultsMessageDetails,
} from "../src/extensions/subagents/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

// Each fake run parks until the test finishes it, so delivery order is observable.
const fake = vi.hoisted(() => ({
	runs: new Map<string, { options: RunProcessOptions; finish: (status: "done" | "failed", text: string) => void }>(),
}));

vi.mock("../src/extensions/subagents/runner.ts", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		async executeRun(options: RunProcessOptions) {
			options.run.status = "running";
			options.run.startedAt = Date.now();
			options.run.turnState = "mid-turn";
			options.onChange();
			await new Promise<void>((resolve) => {
				fake.runs.set(options.run.name, {
					options,
					finish(status, text) {
						options.run.status = status;
						options.run.finalText = text;
						if (status === "failed") options.run.errorMessage = text;
						options.run.endedAt = Date.now();
						resolve();
					},
				});
			});
			options.onChange();
		},
	};
});

import subagentsExtension from "../src/extensions/subagents/index.ts";

interface SentMessage {
	message: { customType: string; content: string; details?: unknown; ephemeral?: boolean };
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

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
	const sent: SentMessage[] = [];
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
		sendMessage(message: SentMessage["message"], options?: SentMessage["options"]) {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	subagentsExtension(pi);
	if (!tool) throw new Error("subagent tool did not register");
	const registered = tool;
	const execute = (params: Record<string, unknown>) =>
		registered.execute("group-1", params, undefined, undefined, ctx);
	return { execute, sent, shutdown: () => listeners.get("session_shutdown")?.({}) };
}

function fakeRun(name: string) {
	const entry = fake.runs.get(name);
	if (!entry) throw new Error(`fake run ${name} has not started`);
	return entry;
}

afterEach(() => {
	for (const entry of fake.runs.values()) entry.finish("done", "cleanup");
	fake.runs.clear();
	vi.unstubAllEnvs();
});

describe("background group delivery", () => {
	it("delivers a finished run of a background group before its sibling finishes", async () => {
		const { execute, sent, shutdown } = setup();
		try {
			await execute({
				tasks: [
					{ task: "fast work", name: "fast" },
					{ task: "slow work", name: "slow" },
				],
			});
			await vi.waitFor(() => expect(fake.runs.size).toBe(2));

			fakeRun("fast").finish("done", "FAST-RESULT-BODY");
			await vi.waitFor(() => expect(sent).toHaveLength(1));
			const early = sent[0];
			expect(early.message.customType).toBe(SUBAGENT_RESULTS_MESSAGE_TYPE);
			expect(early.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
			expect(early.message.content).toContain("fast: 1 of 2 finished; still running: slow");
			expect(early.message.content).toContain("### [fast] completed");
			expect(early.message.content).toContain("FAST-RESULT-BODY");
			const earlyDetails = early.message.details as SubagentResultsMessageDetails;
			expect(earlyDetails.runs.map((run) => run.name)).toEqual(["fast"]);
			expect(earlyDetails.group).toEqual({ size: 2, finished: 1, stillRunning: ["slow"] });
			expect(fakeRun("slow").options.run.status).toBe("running");

			fakeRun("slow").finish("done", "SLOW-RESULT-BODY");
			await vi.waitFor(() => expect(sent).toHaveLength(2));
			const closing = sent[1];
			expect(closing.message.customType).toBe(SUBAGENT_RESULTS_MESSAGE_TYPE);
			expect(closing.message.content).toContain("Parallel: 2/2 succeeded");
			expect(closing.message.content).toContain("not repeated here: fast (completed)");
			expect(closing.message.content).toContain("SLOW-RESULT-BODY");
			// Never re-deliver a full result twice.
			expect(closing.message.content).not.toContain("FAST-RESULT-BODY");
			const closingDetails = closing.message.details as SubagentResultsMessageDetails;
			expect(closingDetails.runs.map((run) => run.name)).toEqual(["slow"]);
			expect(closingDetails.group?.deliveredEarlier).toEqual(["fast"]);
		} finally {
			shutdown();
		}
	});

	it("keeps foreground groups on a single tool result", async () => {
		const { execute, sent, shutdown } = setup();
		try {
			const pending = execute({
				background: false,
				tasks: [
					{ task: "fast work", name: "fast" },
					{ task: "slow work", name: "slow" },
				],
			});
			await vi.waitFor(() => expect(fake.runs.size).toBe(2));
			fakeRun("fast").finish("done", "FAST-RESULT-BODY");
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(sent).toHaveLength(0);
			fakeRun("slow").finish("done", "SLOW-RESULT-BODY");
			const result = await pending;
			expect(result.content[0].text).toContain("FAST-RESULT-BODY");
			expect(result.content[0].text).toContain("SLOW-RESULT-BODY");
			expect(sent).toHaveLength(0);
		} finally {
			shutdown();
		}
	});
});

describe("watchdog parent wake-up", () => {
	it("wakes a background parent once per run per condition", async () => {
		const { execute, sent, shutdown } = setup();
		try {
			await execute({ task: "provision db", name: "db-setup" });
			await vi.waitFor(() => expect(fake.runs.size).toBe(1));
			const { options } = fakeRun("db-setup");
			const run = options.run;
			run.timeline.push({ kind: "tool", name: "bash", detail: "$ createdb -h localhost dbname" });
			const onStall = options.onStall;
			if (!onStall) throw new Error("onStall not wired");

			onStall(run, { kind: "soft-stall", idleMs: 21 * 60_000, inTool: true });
			onStall(run, { kind: "recovered" });
			onStall(run, { kind: "soft-stall", idleMs: 22 * 60_000, inTool: true });
			onStall(run, { kind: "over-budget", elapsedMs: 121 * 60_000, budgetMs: 120 * 60_000 });
			onStall(run, { kind: "over-budget", elapsedMs: 136 * 60_000, budgetMs: 120 * 60_000 });
			onStall(run, {
				kind: "tool-runaway",
				toolMs: 90 * 60_000,
				toolMaxMs: 90 * 60_000,
				elapsedMs: 140 * 60_000,
				tool: "bash: $ createdb -h localhost dbname",
			});

			const wakes = sent.filter((entry) => entry.message.customType === SUBAGENT_STALL_NOTE_MESSAGE_TYPE);
			expect(wakes.map((entry) => (entry.message.details as { verdict: string }).verdict)).toEqual([
				"soft-stall",
				"over-budget",
				"tool-runaway",
			]);
			for (const wake of wakes) {
				expect(wake.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
				expect(wake.message.ephemeral).toBe(true);
				expect(wake.message.content).toContain('"db-setup"');
				expect(wake.message.content).toMatch(/Elapsed \d/);
				expect(wake.message.content).toContain("last activity: bash: $ createdb -h localhost dbname");
			}
			expect(wakes[0].message.content).toContain('{"action":"status"}');
			expect(wakes[0].message.content).toContain(`{"action":"kill","target":"${run.handle}"}`);
			expect(wakes[0].message.content).toContain(`{"action":"message","target":"${run.handle}"`);
			expect(wakes[2].message.content).toContain("ran 90m without finishing");
			expect(wakes[2].message.content).toContain("File edits stay in the working tree");
		} finally {
			shutdown();
		}
	});

	it("never wakes a blocking parent; kills there only leave a note", async () => {
		const { execute, sent, shutdown } = setup();
		try {
			const pending = execute({ task: "provision db", name: "db-setup", background: false });
			await vi.waitFor(() => expect(fake.runs.size).toBe(1));
			const { options, finish } = fakeRun("db-setup");
			options.onStall?.(options.run, { kind: "soft-stall", idleMs: 21 * 60_000, inTool: true });
			options.onStall?.(options.run, { kind: "over-budget", elapsedMs: 1, budgetMs: 1 });
			expect(sent).toHaveLength(0);
			options.onStall?.(options.run, { kind: "hard-cap-kill", elapsedMs: 1, capMs: 1, inTool: false });
			expect(sent).toHaveLength(1);
			expect(sent[0].options).toBeUndefined();
			finish("failed", "killed");
			await pending;
		} finally {
			shutdown();
		}
	});
});
