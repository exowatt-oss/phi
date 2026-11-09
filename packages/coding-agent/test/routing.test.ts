import {
	type Api,
	type AssistantMessage,
	calculateCost,
	type Model,
	type RoutingInfo,
	type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	applyRoutedCost,
	formatRoutingTrailer,
	formatUsd,
	getRoutingBreakdown,
	isAutoRouted,
} from "../src/core/routing.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { getUsageCostBreakdown } from "../src/core/usage-totals.ts";

const prices = {
	auto: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"example-medium": { input: 0.5, output: 2.5, cacheRead: 0.1, cacheWrite: 0.4 },
	sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"example-large": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

function createModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "gateway",
		baseUrl: "http://127.0.0.1:8787",
		reasoning: false,
		input: ["text"],
		cost: prices[id as keyof typeof prices],
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

const models = new Map(Object.keys(prices).map((id) => [id, createModel(id)]));
const findModel = (_provider: string, id: string): Model<Api> | undefined => models.get(id);

function createUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost?: Usage["cost"]): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	model: string,
	usage: Usage,
	routing?: RoutingInfo,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: "openai-completions",
		provider: "gateway",
		model,
		routing,
		usage,
		stopReason,
		timestamp: 1,
	};
}

function routed(servedModel: string): RoutingInfo {
	return { requestedModel: "auto", servedModel };
}

function messageEntry(message: AssistantMessage, id: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message };
}

describe("routed assistant cost", () => {
	it("estimates cost from the served model and mutates the message in place", () => {
		const message = createAssistant("auto", createUsage(100, 50, 20, 10), routed("example-medium"));
		const expected = (100 * 0.5 + 50 * 2.5 + 20 * 0.1 + 10 * 0.4) / 1_000_000;

		expect(applyRoutedCost(message, findModel)).toBe(true);
		expect(message.routing?.costSource).toBe("estimate");
		expect(message.routing?.costUsd).toBeCloseTo(expected, 12);
		expect(message.usage.cost.total).toBeCloseTo(expected, 12);
		expect(message.usage.cost.input).toBeCloseTo((100 * 0.5) / 1_000_000, 12);
	});

	it("scales existing cost components to the gateway charge", () => {
		const message = createAssistant(
			"auto",
			createUsage(100, 50, 20, 10, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }),
			{ ...routed("example-medium"), costSource: "gateway", costUsd: 0.12345 },
		);

		expect(applyRoutedCost(message, findModel)).toBe(true);
		expect(message.usage.cost).toEqual({
			input: 0.012345,
			output: 0.02469,
			cacheRead: 0.037035,
			cacheWrite: 0.04938,
			total: 0.12345,
		});
		expect(message.routing?.costSource).toBe("gateway");

		const zeroTotal = createAssistant(
			"auto",
			createUsage(1, 1, 0, 0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
			{ ...routed("example-medium"), costSource: "gateway", costUsd: 0.01 },
		);
		applyRoutedCost(zeroTotal, findModel);
		expect(zeroTotal.usage.cost).toEqual({ input: 0, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.01 });
	});

	it("leaves unknown served models and non-auto messages untouched", () => {
		const unknown = createAssistant(
			"auto",
			createUsage(10, 5, 0, 0, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }),
			routed("missing"),
		);
		const unknownBefore = structuredClone(unknown);
		expect(applyRoutedCost(unknown, findModel)).toBe(false);
		expect(unknown).toEqual(unknownBefore);

		const direct = createAssistant("example-medium", createUsage(10, 5), routed("example-medium"));
		const directBefore = structuredClone(direct);
		expect(isAutoRouted(direct)).toBe(false);
		expect(applyRoutedCost(direct, findModel)).toBe(false);
		expect(direct).toEqual(directBefore);

		const unannotated = createAssistant("auto", createUsage(10, 5));
		expect(isAutoRouted(unannotated)).toBe(false);
		expect(applyRoutedCost(unannotated, findModel)).toBe(false);
	});

	it("does not price empty error or aborted turns", () => {
		for (const stopReason of ["error", "aborted"] as const) {
			const message = createAssistant("auto", createUsage(0, 0), routed("example-medium"), stopReason);
			expect(applyRoutedCost(message, findModel)).toBe(false);
		}
	});
});

describe("routing breakdown", () => {
	it("groups routed usage and computes available counterfactuals", () => {
		const mediumOne = createAssistant("auto", createUsage(100, 50), routed("example-medium"));
		const mediumTwo = createAssistant("auto", createUsage(200, 20), routed("example-medium"));
		const sonnet = createAssistant("auto", createUsage(100, 100), routed("sonnet"));
		for (const message of [mediumOne, mediumTwo, sonnet]) applyRoutedCost(message, findModel);
		const direct = createAssistant("sonnet", createUsage(1, 1));
		const error = createAssistant("auto", createUsage(100, 100), routed("example-large"), "error");

		const result = getRoutingBreakdown(
			[
				messageEntry(mediumOne, "example-medium-one"),
				messageEntry(mediumTwo, "example-medium-two"),
				messageEntry(sonnet, "sonnet"),
				messageEntry(direct, "direct"),
				messageEntry(error, "error"),
			],
			findModel,
			["example-large", "sonnet"],
		);

		expect(result.requests).toBe(3);
		expect(result.unpriced).toBe(0);
		expect(result.buckets.map((bucket) => [bucket.servedModel, bucket.count])).toEqual([
			["sonnet", 1],
			["example-medium", 2],
		]);
		expect(result.buckets[0]).toMatchObject({ input: 100, output: 100, tokens: 200 });
		expect(result.buckets[1]).toMatchObject({ input: 300, output: 70, tokens: 370 });
		expect(result.totalCostUsd).toBeCloseTo(
			(mediumOne.routing?.costUsd ?? 0) + (mediumTwo.routing?.costUsd ?? 0) + (sonnet.routing?.costUsd ?? 0),
			12,
		);

		for (const model of ["example-large", "sonnet"] as const) {
			const expected = [mediumOne, mediumTwo, sonnet].reduce(
				(total, message) => total + calculateCost(models.get(model)!, structuredClone(message.usage)).total,
				0,
			);
			const counterfactual = result.counterfactuals.find((entry) => entry.model === model)!;
			expect(counterfactual.available).toBe(true);
			expect(counterfactual.costUsd).toBeCloseTo(expected, 12);
			expect(counterfactual.savedUsd).toBeCloseTo(expected - result.totalCostUsd, 12);
		}

		const unavailable = getRoutingBreakdown(
			[mediumOne, mediumTwo, sonnet].map((message, index) => messageEntry(message, `entry-${index}`)),
			(_provider, id) => (id === "example-medium" || id === "sonnet" ? models.get(id) : undefined),
			["example-large", "sonnet"],
		);
		expect(unavailable.counterfactuals).toContainEqual({
			model: "example-large",
			costUsd: 0,
			savedUsd: 0,
			available: false,
		});
	});
});

describe("routing formatting", () => {
	it("formats the routing trailer examples", () => {
		expect(
			formatRoutingTrailer({
				requestedModel: "auto",
				servedModel: "example-medium",
				tier: "mid",
				intent: "code_edit",
				confidence: 0.91,
				costUsd: 0.000018,
				costSource: "estimate",
			}),
		).toBe("auto routed to example-medium (mid · code_edit · 0.91) · ~$0.00002");
		expect(
			formatRoutingTrailer({
				requestedModel: "auto",
				servedModel: "sonnet",
				costUsd: 0.00311,
				costSource: "gateway",
			}),
		).toBe("auto routed to sonnet · $0.00311");
		expect(formatRoutingTrailer({ requestedModel: "auto", servedModel: "example-other" })).toBe(
			"auto routed to example-other",
		);
	});

	it("formats USD without scientific notation", () => {
		expect(formatUsd(0)).toBe("$0");
		expect(formatUsd(0.00002)).toBe("$0.00002");
		expect(formatUsd(0.0009)).toBe("$0.0009");
		expect(formatUsd(0.031)).toBe("$0.031");
		expect(formatUsd(1.25)).toBe("$1.250");
		expect(formatUsd(0.000001)).not.toContain("e-");
	});
});

describe("usage cost breakdown routing keys", () => {
	it("keys routed and direct assistant usage separately", () => {
		const routedMessage = createAssistant(
			"auto",
			createUsage(10, 20, 0, 0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 }),
			routed("example-medium"),
		);
		const directMessage = createAssistant(
			"example-medium",
			createUsage(10, 20, 0, 0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 }),
		);
		const result = getUsageCostBreakdown([
			messageEntry(routedMessage, "routed"),
			messageEntry(directMessage, "direct"),
		]);

		expect(result).toEqual([
			{ key: "gateway/example-medium", cost: 0.2, tokens: 30 },
			{ key: "gateway/auto → example-medium", cost: 0.1, tokens: 30 },
		]);
	});
});
