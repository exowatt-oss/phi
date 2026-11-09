import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";

// Empty tools arrays must NOT be serialized as `tools: []` — some OpenAI-compatible
// backends (e.g. DashScope / Aliyun Qwen via compatible-mode) reject the request with
// `"[] is too short - 'tools'"` (HTTP 400) when `--no-tools` produces an empty array.
// Regression for https://github.com/earendil-works/pi/issues/3649

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	lastClientOptions: undefined as unknown,
	responseServiceTier: undefined as "default" | "flex" | "priority" | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}

		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								service_tier: mockState.responseServiceTier,
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
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
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-completions empty tools handling", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastClientOptions = undefined;
		mockState.responseServiceTier = undefined;
	});

	it("omits tools field when context.tools is an empty array", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { tools?: unknown };
		expect("tools" in (params as object)).toBe(false);
	});

	it("omits tools field when context.tools is undefined", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { tools?: unknown };
		expect("tools" in (params as object)).toBe(false);
	});

	it("sends default maxTokens", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { max_tokens?: number; max_completion_tokens?: number };
		expect(params.max_tokens).toBeUndefined();
		expect(params.max_completion_tokens).toBe(model.maxTokens);
	});

	it.each(["fast", "default", "flex", "ultrafast"] as const)("serializes the %s service tier", async (serviceTier) => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", serviceTier },
		).result();

		expect((mockState.lastParams as { service_tier?: string }).service_tier).toBe(serviceTier);
	});

	it("omits service_tier for github-copilot models", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = {
			...baseModel,
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
		} as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", serviceTier: "fast" },
		).result();

		expect("service_tier" in (mockState.lastParams as object)).toBe(false);
	});

	it("refuses fast on an Amazon Bedrock OpenAI endpoint without a fast tier instead of sending it", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = {
			...baseModel,
			id: "openai.gpt-6-sol",
			api: "openai-completions",
			provider: "bedrock-mantle",
			baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
		} as const;
		mockState.lastParams = undefined;

		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", serviceTier: "fast" },
		).result();

		expect(mockState.lastParams).toBeUndefined();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Fast mode is not supported for Amazon Bedrock model openai.gpt-6-sol");
	});

	it("uses the actual returned tier for local cost accounting", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const standardInputCost = model.cost.input / 1_000_000;

		mockState.responseServiceTier = "default";
		const result = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", serviceTier: "fast" },
		).result();

		expect(result.usage.cost.input).toBe(standardInputCost);
	});

	it("sends explicit maxTokens", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", maxTokens: 1234 },
		).result();

		const params = mockState.lastParams as { max_tokens?: number; max_completion_tokens?: number };
		expect(params.max_tokens).toBeUndefined();
		expect(params.max_completion_tokens).toBe(1234);
	});

	it("clamps default maxTokens to remaining context", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions", contextWindow: 10000, maxTokens: 8000 } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "x".repeat(8000), timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { max_tokens?: number; max_completion_tokens?: number };
		expect(params.max_tokens).toBeUndefined();
		expect(params.max_completion_tokens).toBe(3618);
	});

	it("clamps explicit maxTokens to remaining context", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions", contextWindow: 10000, maxTokens: 8000 } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "x".repeat(8000), timestamp: Date.now() }],
			},
			{ apiKey: "test", maxTokens: 7000 },
		).result();

		const params = mockState.lastParams as { max_tokens?: number; max_completion_tokens?: number };
		expect(params.max_tokens).toBeUndefined();
		expect(params.max_completion_tokens).toBe(3618);
	});

	it("uses conservative OpenAI-compatible fields for Cloudflare AI Gateway /compat models", async () => {
		process.env.CLOUDFLARE_API_KEY = "cf-token";
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";
		const model = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6")!;

		await streamSimple(
			model,
			{
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ maxTokens: 1234, reasoning: "high" },
		).result();

		const params = mockState.lastParams as {
			messages: Array<{ role: string }>;
			max_tokens?: number;
			max_completion_tokens?: number;
			reasoning_effort?: string;
			store?: boolean;
		};
		expect(params.messages[0].role).toBe("system");
		expect(params.max_tokens).toBe(1234);
		expect(params.max_completion_tokens).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.store).toBeUndefined();

		const clientOptions = mockState.lastClientOptions as {
			baseURL?: string;
			defaultHeaders?: Record<string, unknown>;
		};
		expect(clientOptions.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/compat");
		expect(clientOptions.defaultHeaders?.Authorization).toBeNull();
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer cf-token");
	});

	it("resolves Cloudflare AI Gateway base URL through provider auth", async () => {
		process.env.CLOUDFLARE_API_KEY = "cf-token";
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";
		const model = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6")!;

		await streamSimple(model, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		}).result();

		const clientOptions = mockState.lastClientOptions as { baseURL?: string };
		expect(clientOptions.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/compat");
	});

	it("preserves inline upstream Authorization for Cloudflare AI Gateway BYOK requests", async () => {
		process.env.CLOUDFLARE_API_KEY = "cf-token";
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";
		const model = getModel("cloudflare-ai-gateway", "gpt-5.1")!;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ headers: { Authorization: "Bearer upstream-token" } },
		).result();

		const clientOptions = mockState.lastClientOptions as { defaultHeaders?: Record<string, unknown> };
		expect(clientOptions.defaultHeaders?.Authorization).toBe("Bearer upstream-token");
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer cf-token");
	});

	it("sends session affinity headers for Workers AI through Cloudflare AI Gateway", async () => {
		process.env.CLOUDFLARE_API_KEY = "cf-token";
		process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
		process.env.CLOUDFLARE_GATEWAY_ID = "gateway-id";
		const workersModel = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6")!;

		await streamSimple(
			workersModel,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ sessionId: "session-1" },
		).result();

		const clientOptions = mockState.lastClientOptions as { defaultHeaders?: Record<string, string> };
		expect(clientOptions.defaultHeaders?.session_id).toBe("session-1");
		expect(clientOptions.defaultHeaders?.["x-client-request-id"]).toBe("session-1");
		expect(clientOptions.defaultHeaders?.["x-session-affinity"]).toBe("session-1");
	});

	it("still emits tools: [] for Anthropic/LiteLLM proxy when conversation has tool history", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "use the tool", timestamp: Date.now() },
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "t1",
								name: "noop",
								arguments: {},
							},
						],
						stopReason: "toolUse",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						api: "openai-completions",
						provider: "openai",
						model: "gpt-4o-mini",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "t1",
						toolName: "noop",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { tools?: unknown[] };
		expect(Array.isArray(params.tools)).toBe(true);
		expect(params.tools).toEqual([]);
	});
});
