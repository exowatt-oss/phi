import { describe, expect, it } from "vitest";
import { interpretLoopRequest } from "../src/extensions/loop/interpret.ts";
import { buildContinuationPrompt, buildInitialLoopPrompt } from "../src/extensions/loop/prompt.ts";
import type { LoopConfig } from "../src/extensions/loop/types.ts";

const base = {
	checkTimeoutMs: 1000,
	everyMs: 0,
	timeoutMs: 120000,
	budgetUsd: 10,
	evaluatorConfidence: 0.85,
	cwd: "/tmp",
	startedAt: new Date(0).toISOString(),
} satisfies Omit<LoopConfig, "task" | "maxIterations">;

function asker(...answers: string[]) {
	let calls = 0;
	return {
		get calls() {
			return calls;
		},
		fn: async () => ({ answer: answers[Math.min(calls++, answers.length - 1)], usage: undefined }),
	};
}

describe("freeform loop interpreter", () => {
	it("extracts a natural schedule", async () => {
		const q = asker('{"task":"echo the time and date","everySeconds":30,"rationale":"The request says 30 seconds."}');
		const result = await interpretLoopRequest({ raw: "30s echo the time and date", sideQuestion: q.fn });
		expect(result).toMatchObject({ task: "echo the time and date", everyMs: 30000 });
	});

	it("leaves unspecified limits omitted", async () => {
		const q = asker('{"task":"check the service","rationale":"No schedule or limit was stated."}');
		const result = await interpretLoopRequest({ raw: "check the service", sideQuestion: q.fn });
		expect(result).toMatchObject({ task: "check the service" });
		expect(result).not.toHaveProperty("maxIterations");
		expect(result).not.toHaveProperty("checkCommand");
	});

	it("parses fenced JSON and retries once", async () => {
		const q = asker(
			'```json\n{"task":"poll status","rationale":"poll is periodic"}\n```',
			"not json",
			'{"task":"unused","rationale":"unused"}',
		);
		const result = await interpretLoopRequest({ raw: "poll status", sideQuestion: q.fn });
		expect(result).toMatchObject({ task: "poll status" });
		const retry = asker("bad", '{"task":"poll status","rationale":"retry"}');
		expect(await interpretLoopRequest({ raw: "poll status", sideQuestion: retry.fn })).toMatchObject({
			task: "poll status",
		});
		expect(retry.calls).toBe(2);
	});

	it("returns an error after two malformed answers", async () => {
		const q = asker("bad", "still bad");
		const result = await interpretLoopRequest({ raw: "do it", sideQuestion: q.fn });
		expect(result).toHaveProperty("error");
		expect(q.calls).toBe(2);
	});

	it("clamps hard ceilings and does not fabricate checks", async () => {
		const q = asker('{"task":"work","maxIterations":5000,"rationale":"bounded"}');
		const result = await interpretLoopRequest({ raw: "work", sideQuestion: q.fn });
		expect(result).toMatchObject({ maxIterations: 100 });
		expect(result).not.toHaveProperty("checkCommand");
	});
});

describe("loop prompts", () => {
	const config = { ...base, task: "poll", maxIterations: 3, budgetUsd: undefined } as unknown as LoopConfig;
	const snapshot = { config, iterationIndex: 1 } as any;
	it("shows unlimited budget and discourages pausing doable periodic work", () => {
		const initial = buildInitialLoopPrompt(config, snapshot);
		const continuation = buildContinuationPrompt({
			config,
			snapshot,
			remaining: { iterations: 2, wallTimeMs: 1000 },
		});
		for (const prompt of [initial, continuation]) {
			expect(prompt).toContain("unlimited");
			expect(prompt).toContain("vague-but-doable task must be done, not paused");
			expect(prompt).toContain("DO the task each iteration");
		}
	});
});
