import { describe, expect, test } from "vitest";
import { DEFAULT_LOOP_CONFIG, formatResolvedConfig, parseLoopCommand } from "../src/extensions/loop/parser.ts";
import { isLegalTransition } from "../src/extensions/loop/types.ts";

const defaults = { ...DEFAULT_LOOP_CONFIG };
const parse = (command: string) => parseLoopCommand(command, defaults);

function error(command: string): string {
	const result = parse(command);
	expect(result.kind).toBe("error");
	if (result.kind !== "error") throw new Error("expected error");
	return result.message;
}

describe("parseLoopCommand", () => {
	test.each(["", "status", "pause", "resume", "stop", "verify"])("recognizes %j", (command) => {
		expect(parse(command).kind).toBe(command === "" ? "dashboard" : command);
	});

	test("parses plain tasks and applies defaults", () => {
		const result = parse("fix the failing tests");
		expect(result).toMatchObject({
			kind: "start",
			config: { task: "fix the failing tests", ...defaults, cwd: "", startedAt: "" },
		});
	});

	test("parses options and quoted values", () => {
		const result = parse('--max 4 --check "npm test -- --runInBand" --every 10s --task');
		expect(result.kind).toBe("error");
		const start = parse('--max 4 --check "npm test -- --runInBand" --every 10s -- fix   the tests');
		expect(start).toMatchObject({
			kind: "start",
			config: {
				maxIterations: 4,
				checkCommand: "npm test -- --runInBand",
				everyMs: 10_000,
				task: "fix   the tests",
			},
		});
	});

	test("parses positional intervals", () => {
		expect(parse("30s echo the time and date")).toMatchObject({
			kind: "start",
			config: { everyMs: 30_000, task: "echo the time and date" },
		});
		expect(parse("30s --max 3 -- task")).toMatchObject({
			kind: "start",
			config: { everyMs: 30_000, maxIterations: 3, task: "task" },
		});
		expect(parse("echo 30s later")).toMatchObject({ kind: "start", config: { task: "echo 30s later" } });
		expect(error("30s --every 1m task")).toContain("duplicate");
		expect(error("30s")).toContain("task");
	});

	test("accepts quoted option values that begin with dashes", () => {
		expect(parse('--check "--watch" task')).toMatchObject({ kind: "start", config: { checkCommand: "--watch" } });
		expect(error("--check --watch task")).toContain("missing value");
	});

	test("handles quote and escape errors", () => {
		expect(parse("--until 'condition with spaces' task")).toMatchObject({
			kind: "start",
			config: { untilCondition: "condition with spaces" },
		});
		expect(parse('--check "echo \\"quoted\\"" task')).toMatchObject({
			kind: "start",
			config: { checkCommand: 'echo "quoted"' },
		});
		expect(error('--check "unfinished task')).toContain("quote");
		expect(error("task\\")).toContain("escape");
	});

	test("supports task delimiters and preserves task text", () => {
		expect(parse("-- fix the task")).toMatchObject({ kind: "start", config: { task: "fix the task" } });
		expect(parse("fix  --  the  task")).toMatchObject({ kind: "start", config: { task: "fix  --  the  task" } });
		expect(parse("status extra words")).toMatchObject({ kind: "start", config: { task: "status extra words" } });
	});

	test("requires -- for a task beginning with a flag", () => {
		expect(error("--fix the task")).toContain("unknown option '--fix'");
		expect(parse("-- --fix the task")).toMatchObject({ kind: "start", config: { task: "--fix the task" } });
	});

	test.each(["1s", "2m", "3h"])("accepts duration %s", (duration) => {
		expect(parse(`--every ${duration} --timeout 24h task`).kind).toBe("start");
	});
	test.each(["-1s", "1.5s", "10", "10x", "1h30m"])("rejects duration %s", (duration) => {
		expect(error(`--every ${duration} task`)).toContain("duration");
	});

	test.each(["0", "101", "1.5"])("rejects invalid max %s", (max) => {
		expect(error(`--max ${max} task`)).toContain("--max");
	});
	test("accepts numeric ceilings and rejects non-positive budgets", () => {
		expect(parse("--budget $100 task")).toMatchObject({ kind: "start", config: { budgetUsd: 100 } });
		expect(parse("--max 100 task")).toMatchObject({ kind: "start", config: { maxIterations: 100 } });
		expect(parse("--timeout 24h task")).toMatchObject({ kind: "start", config: { timeoutMs: 24 * 60 * 60 * 1000 } });
		expect(error("--budget 0 task")).toContain("--budget");
		expect(error("--budget -5 task")).toContain("--budget");
	});
	test("requires every not to exceed timeout", () => {
		expect(parse("--every 1h --timeout 2h task").kind).toBe("start");
		expect(error("--every 2h --timeout 1h task")).toContain("--every cannot exceed --timeout");
	});
	test.each(["gpt-4", "/model", "provider/", "provider/model:"])("rejects invalid %s model", (model) => {
		expect(error(`--model ${model} task`)).toContain("provider/model");
	});
	test("accepts provider/model names and validates evaluator too", () => {
		expect(parse("--model openai/gpt-4:high --evaluator anthropic/claude task").kind).toBe("start");
		expect(error("--evaluator claude task")).toContain("--evaluator");
	});
	test("accepts uncapped dollar budgets and decimals", () => {
		expect(parse("--budget $8.50 task")).toMatchObject({ kind: "start", config: { budgetUsd: 8.5 } });
		expect(parse("--budget 500 task")).toMatchObject({ kind: "start", config: { budgetUsd: 500 } });
	});
	test("rejects duplicate, unknown, missing, and empty options", () => {
		expect(error("--max 2 --max 3 task")).toContain("duplicate");
		expect(error("--wat task")).toContain("unknown");
		expect(error("--max task")).toContain("missing");
		expect(error("--check x")).toContain("task");
	});
	test("enforces check timeout and timeout ceilings", () => {
		expect(error("--timeout 25h task")).toContain("24h");
		expect(error("--timeout 1h --check-timeout 2h task")).toContain("exceed");
	});
	test("format displays every effective limit and configured values", () => {
		const result = parse('--until "done condition" --check "npm test" --model openai/gpt-4 task');
		if (result.kind !== "start") throw new Error("expected start");
		const formatted = formatResolvedConfig(result.config);
		for (const value of [
			"max iterations",
			"timeout",
			"budget",
			"check timeout",
			"every",
			"evaluator confidence",
			"until: done condition",
			"check: npm test",
			"model: openai/gpt-4",
		])
			expect(formatted).toContain(value);
	});
});

describe("legal loop transitions", () => {
	test("accepts and rejects representative transitions", () => {
		expect(isLegalTransition("idle", "dispatching")).toBe(true);
		expect(isLegalTransition("idle", "running")).toBe(false);
		expect(isLegalTransition("paused", "dispatching")).toBe(true);
		expect(isLegalTransition("terminal", "idle")).toBe(false);
	});
});
