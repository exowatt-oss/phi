import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { Extension, ToolDefinition } from "../src/core/extensions/types.ts";
import contextBudgetExtension from "../src/extensions/context-budget/index.ts";

async function loadCheckpoint(): Promise<ToolDefinition> {
	const extension: Extension = await loadExtensionFromFactory(
		contextBudgetExtension,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<inline:context-budget>",
	);
	return extension.tools.get("checkpoint")?.definition as ToolDefinition;
}

let previousTuiMode: string | undefined;
let previousContextBudget: string | undefined;

beforeEach(() => {
	previousTuiMode = process.env.PI_TUI_MODE;
	previousContextBudget = process.env.PI_CONTEXT_BUDGET;
	process.env.PI_TUI_MODE = "1";
	delete process.env.PI_CONTEXT_BUDGET;
});

afterEach(() => {
	if (previousTuiMode === undefined) delete process.env.PI_TUI_MODE;
	else process.env.PI_TUI_MODE = previousTuiMode;
	if (previousContextBudget === undefined) delete process.env.PI_CONTEXT_BUDGET;
	else process.env.PI_CONTEXT_BUDGET = previousContextBudget;
});

describe("checkpoint tool", () => {
	it("returns a summarize compaction payload by default", async () => {
		const tool = await loadCheckpoint();
		const result = await tool.execute(
			"call-1",
			{ notes: "The tests are green; continue with the release." },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content).toEqual([{ type: "text", text: "Checkpoint recorded." }]);
		expect(result.compaction).toEqual({
			notes: "The tests are green; continue with the release.",
			mode: "summarize",
		});
	});

	it("respects fresh mode and carries keep paths", async () => {
		const tool = await loadCheckpoint();
		const result = await tool.execute(
			"call-2",
			{
				notes: "Start the next context from this handoff.",
				keep: ["src/index.ts", "Do not change the API"],
				mode: "fresh",
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(result.compaction).toEqual({
			notes: "Start the next context from this handoff.",
			keep: ["src/index.ts", "Do not change the API"],
			mode: "fresh",
		});
	});

	it("enforces the eight-thousand-character notes limit in the schema", async () => {
		const tool = await loadCheckpoint();
		const tooLong = "x".repeat(8001);
		expect(Value.Check(tool.parameters, { notes: "x".repeat(8000) })).toBe(true);
		expect(Value.Check(tool.parameters, { notes: tooLong })).toBe(false);
	});
});
