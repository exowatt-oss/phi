import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildEvaluatorPrompt,
	type EvaluatorInput,
	parseEvaluatorAnswer,
	runEvaluator,
	type SideQuestionFn,
} from "../src/extensions/loop/evaluator.ts";

const input: EvaluatorInput = {
	task: "Make the service healthy",
	condition: "the service reports healthy",
	iterationIndex: 2,
	remainingLimits: { iterationsLeft: 3, wallTimeLeftMs: 1000, budgetLeftUsd: 2 },
};
const answer = JSON.stringify({ satisfied: true, confidence: 0.96, rationale: "Health confirmed", missing: [] });

const fake = (answers: string[], usage = { cost: { total: 0 } }): SideQuestionFn => {
	let index = 0;
	return async () => ({ answer: answers[Math.min(index++, answers.length - 1)], usage: usage as Usage });
};

describe("evaluator", () => {
	it("returns a satisfied high-confidence verdict", async () => {
		const result = await runEvaluator({
			input,
			sideQuestion: fake([answer]),
			confidenceThreshold: 0.85,
			model: "judge",
		});
		expect(result.verdict).toEqual(JSON.parse(answer));
		expect(result.model).toBe("judge");
	});

	it("parses prose and JSON fences", () => {
		expect(parseEvaluatorAnswer(`Here is the result:\n\n\`\`\`json\n${answer}\n\`\`\``)).toEqual(JSON.parse(answer));
	});

	it("retries malformed output", async () => {
		let calls = 0;
		const result = await runEvaluator({
			input,
			sideQuestion: async () => ({ answer: ++calls === 1 ? "nope" : answer, usage: undefined }),
			confidenceThreshold: 0.8,
		});
		expect(calls).toBe(2);
		expect(result.verdict?.satisfied).toBe(true);
	});

	it("errors after max attempts", async () => {
		let calls = 0;
		const result = await runEvaluator({
			input,
			maxAttempts: 2,
			sideQuestion: async () => ({ answer: ++calls === 1 ? "{" : "bad", usage: undefined }),
			confidenceThreshold: 0.8,
		});
		expect(calls).toBe(2);
		expect(result.error).toBeTruthy();
		expect(result.verdict).toBeUndefined();
	});

	it.each([1.5, -0.1, Number.NaN])("rejects confidence %s", (confidence) => {
		expect(
			parseEvaluatorAnswer(JSON.stringify({ satisfied: true, confidence, rationale: "x", missing: [] })),
		).toHaveProperty("error");
	});

	it("rejects wrong field types", () => {
		expect(parseEvaluatorAnswer('{"satisfied":"yes","confidence":0.5,"rationale":"x","missing":[]}')).toHaveProperty(
			"error",
		);
		expect(parseEvaluatorAnswer('{"satisfied":true,"confidence":0.5,"rationale":"x"}')).toHaveProperty("error");
	});

	it("returns provider errors and does not retry", async () => {
		let calls = 0;
		const result = await runEvaluator({
			input,
			sideQuestion: async () => {
				calls++;
				throw new Error("provider down");
			},
			confidenceThreshold: 0.8,
		});
		expect(calls).toBe(1);
		expect(result.error).toContain("provider down");
	});

	it("does not call a pre-aborted provider", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const result = await runEvaluator({
			input,
			signal: controller.signal,
			sideQuestion: async () => {
				calls++;
				return { answer, usage: undefined };
			},
			confidenceThreshold: 0.8,
		});
		expect(calls).toBe(0);
		expect(result.error).toContain("aborted");
	});

	it("accounts for evaluator cost", async () => {
		const result = await runEvaluator({
			input,
			sideQuestion: fake([answer], { cost: { total: 0.012 } }),
			confidenceThreshold: 0.8,
		});
		expect(result.costUsd).toBe(0.012);
		expect(result.usage.evaluatorCostUsd).toBe(0.012);
	});

	it("builds bounded, structured evidence", () => {
		const prompt = buildEvaluatorPrompt({
			...input,
			evidence: ["x".repeat(100_000)],
			check: {
				command: "test",
				cwd: ".",
				exitCode: 7,
				signal: null,
				timedOut: false,
				durationMs: 1,
				stdoutTail: "",
				stderrTail: "",
				truncated: false,
				verdict: "error",
			},
		});
		expect(prompt.userContent).toContain(input.condition);
		expect(prompt.userContent).toContain('"exitCode": 7');
		expect(prompt.userContent).toContain("truncated");
		expect(prompt.userContent).toContain("iterationsLeft");
		expect(prompt.userContent.length).toBeLessThan(110_000);
	});
});
