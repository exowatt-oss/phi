import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
	headers: {} as Record<string, string>,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: {
							status: 200,
							headers: {
								entries: () => Object.entries(mockState.headers)[Symbol.iterator](),
							} as unknown as Headers,
						},
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function gatewayAuto(): Model<"openai-completions"> {
	return {
		id: "auto",
		name: "Gateway Model",
		api: "openai-completions",
		provider: "gateway",
		baseUrl: "http://127.0.0.1:8787",
		reasoning: true,
		input: ["text"],
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
const successfulChunks = [
	{ id: "chatcmpl-1", model: "auto", choices: [{ index: 0, delta: { content: "hi" } }] },
	{
		id: "chatcmpl-1",
		model: "auto",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: {
			prompt_tokens: 10,
			completion_tokens: 5,
			prompt_tokens_details: { cached_tokens: 0 },
			completion_tokens_details: { reasoning_tokens: 0 },
		},
	},
];

async function completeWithHeaders(model: Model<"openai-completions">, headers: Record<string, string>) {
	mockState.chunks = successfulChunks;
	mockState.headers = headers;
	return complete(model, context, { apiKey: "test" });
}

describe("openai-completions gateway routing", () => {
	beforeEach(() => {
		mockState.chunks = [];
		mockState.headers = {};
	});

	it("captures the served model and gateway metadata for gateway/auto", async () => {
		const message = await completeWithHeaders(gatewayAuto(), {
			"x-litellm-model-group": "example-medium",
			"x-litellm-model-name": "provider/example-model",
			"x-litellm-call-id": "call-1",
			"x-litellm-response-cost": "9.46e-06",
		});

		expect(message.model).toBe("auto");
		expect(message.routing).toEqual({
			requestedModel: "auto",
			servedModel: "example-medium",
			upstreamModel: "provider/example-model",
			callId: "call-1",
			costUsd: 9.46e-6,
			costSource: "gateway",
		});
	});

	it("captures routing without a cost when streaming headers omit response cost", async () => {
		const message = await completeWithHeaders(gatewayAuto(), {
			"x-litellm-model-group": "example-medium",
			"x-litellm-response-cost-original": "0.0",
		});

		expect(message.routing).toEqual({ requestedModel: "auto", servedModel: "example-medium" });
		expect(message.routing?.costUsd).toBeUndefined();
		expect(message.routing?.costSource).toBeUndefined();
	});

	it("captures Jev tier metadata and confidence", async () => {
		const message = await completeWithHeaders(gatewayAuto(), {
			"x-litellm-model-group": "example-medium",
			"x-auto-tier": "mid",
			"x-auto-intent": "code_edit",
			"x-auto-confidence": "0.91",
		});

		expect(message.routing).toEqual({
			requestedModel: "auto",
			servedModel: "example-medium",
			tier: "mid",
			intent: "code_edit",
			confidence: 0.91,
		});
	});

	it("ignores out-of-range Jev confidence", async () => {
		const message = await completeWithHeaders(gatewayAuto(), {
			"x-litellm-model-group": "example-medium",
			"x-auto-confidence": "1.7",
		});

		expect(message.routing).toEqual({ requestedModel: "auto", servedModel: "example-medium" });
	});

	it("does not capture routing for gateway/example-medium", async () => {
		const message = await completeWithHeaders(
			{ ...gatewayAuto(), id: "example-medium", name: "Gateway Model" },
			{
				"x-litellm-model-group": "example-medium",
				"x-litellm-model-name": "provider/example-model",
				"x-litellm-call-id": "call-1",
				"x-litellm-response-cost": "9.46e-06",
			},
		);

		expect(message.routing).toBeUndefined();
	});

	it("does not capture routing for openrouter/auto", async () => {
		const message = await completeWithHeaders(
			{ ...gatewayAuto(), provider: "openrouter", name: "OpenRouter Auto" },
			{
				"x-litellm-model-group": "example-medium",
				"x-litellm-model-name": "provider/example-model",
				"x-litellm-call-id": "call-1",
				"x-litellm-response-cost": "9.46e-06",
			},
		);

		expect(message.routing).toBeUndefined();
	});

	it("does not capture routing without a model group", async () => {
		const message = await completeWithHeaders(gatewayAuto(), {
			"x-litellm-model-name": "provider/example-model",
			"x-litellm-call-id": "call-1",
			"x-litellm-response-cost": "9.46e-06",
		});

		expect(message.routing).toBeUndefined();
	});

	it("does not capture routing without LiteLLM headers", async () => {
		const message = await completeWithHeaders(gatewayAuto(), {});

		expect(message.routing).toBeUndefined();
	});

	it("matches gateway headers case-insensitively", async () => {
		const message = await completeWithHeaders(gatewayAuto(), {
			"X-LiteLLM-Model-Group": " example-medium ",
			"X-LiteLLM-Model-Name": " upstream-model ",
			"X-LiteLLM-Call-ID": " call-2 ",
			"X-LiteLLM-Response-Cost": "0.5",
		});

		expect(message.routing).toEqual({
			requestedModel: "auto",
			servedModel: "example-medium",
			upstreamModel: "upstream-model",
			callId: "call-2",
			costUsd: 0.5,
			costSource: "gateway",
		});
	});
});
