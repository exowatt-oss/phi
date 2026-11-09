import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model, TextContent, ThinkingContent } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
	createParams: undefined as Record<string, unknown> | undefined,
	sseBody: undefined as string | undefined,
}));

function sse(events: Array<[string, unknown]>): string {
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n");
}

function plainCompletionSse(): string {
	return sse([
		[
			"message_start",
			{
				type: "message_start",
				message: { id: "msg_test", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
			},
		],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
		["message_stop", { type: "message_stop" }],
	]);
}

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		// Requests go through the beta Messages API, which carries betas as a `betas` parameter.
		beta = {
			messages: {
				create: (params: Record<string, unknown>) => {
					mockState.createParams = params;
					return {
						asResponse: async () =>
							new Response(mockState.sseBody ?? plainCompletionSse(), {
								status: 200,
								headers: { "content-type": "text/event-stream" },
							}),
					};
				},
			},
		};
	}
	return { default: FakeAnthropic };
});

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

/** The betas the request asked for (the SDK sends them as the anthropic-beta header). */
function constructorBetaHeader(): string {
	const betas = mockState.createParams?.betas;
	if (Array.isArray(betas)) return betas.join(",");
	const headers = (mockState.constructorOpts?.defaultHeaders ?? {}) as Record<string, string>;
	return headers["anthropic-beta"] ?? "";
}

async function drain(model: Model<"anthropic-messages">, options: Record<string, unknown>) {
	const events = streamAnthropic(model, context, options);
	let final: unknown;
	for await (const event of events) {
		if (event.type === "done") final = event.message;
		if (event.type === "error") final = event.error;
	}
	return final as {
		model: string;
		responseModel?: string;
		stopReason: string;
		errorMessage?: string;
		refusal?: { category?: string | null; explanation?: string };
		content: Array<TextContent | ThinkingContent>;
	};
}

afterEach(() => {
	mockState.constructorOpts = undefined;
	mockState.createParams = undefined;
	mockState.sseBody = undefined;
	vi.unstubAllEnvs();
});

describe("Anthropic server-side refusal fallback", () => {
	it("defaults to fallbacks=default with the beta header for first-party API-key requests", async () => {
		await drain(anthropicModel, { apiKey: "sk-ant-test" });

		expect(mockState.createParams?.fallbacks).toBe("default");
		expect(constructorBetaHeader()).toContain("server-side-fallback-2026-07-01");
	});

	it("PI_ANTHROPIC_FALLBACKS=off disables the parameter and the beta header", async () => {
		await drain(anthropicModel, { apiKey: "sk-ant-test", env: { PI_ANTHROPIC_FALLBACKS: "off" } });

		expect(mockState.createParams?.fallbacks).toBeUndefined();
		expect(constructorBetaHeader()).not.toContain("server-side-fallback");
	});

	it("PI_ANTHROPIC_FALLBACKS model list becomes an explicit fallback chain", async () => {
		await drain(anthropicModel, {
			apiKey: "sk-ant-test",
			env: { PI_ANTHROPIC_FALLBACKS: "claude-opus-4-8, claude-opus-5" },
		});

		expect(mockState.createParams?.fallbacks).toEqual([{ model: "claude-opus-4-8" }, { model: "claude-opus-5" }]);
		expect(constructorBetaHeader()).toContain("server-side-fallback-2026-07-01");
	});

	it("options.fallbacks overrides the env", async () => {
		await drain(anthropicModel, {
			apiKey: "sk-ant-test",
			env: { PI_ANTHROPIC_FALLBACKS: "claude-opus-4-8" },
			fallbacks: "off",
		});

		expect(mockState.createParams?.fallbacks).toBeUndefined();
	});

	it("stays off for OAuth (Claude Code) tokens", async () => {
		await drain(anthropicModel, { apiKey: "sk-ant-oat-test" });

		expect(mockState.createParams?.fallbacks).toBeUndefined();
		expect(constructorBetaHeader()).not.toContain("server-side-fallback");
	});

	it("stays off for non-anthropic providers sharing the messages API", async () => {
		await drain({ ...anthropicModel, provider: "some-proxy" }, { apiKey: "sk-other" });

		expect(mockState.createParams?.fallbacks).toBeUndefined();
		expect(constructorBetaHeader()).not.toContain("server-side-fallback");
	});

	it("records the serving model from message_start on a pre-output fallback", async () => {
		mockState.sseBody = sse([
			[
				"message_start",
				{
					type: "message_start",
					message: { id: "msg_fb", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 0 } },
				},
			],
			["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "fallback" } }],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
			["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } }],
			["content_block_stop", { type: "content_block_stop", index: 1 }],
			["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
			["message_stop", { type: "message_stop" }],
		]);

		const message = await drain(anthropicModel, { apiKey: "sk-ant-test" });

		expect(message.stopReason).toBe("stop");
		// `model` is who was asked, `responseModel` is who answered — the same split
		// the OpenAI-compatible path uses. Collapsing them here hid the fallback from
		// everything downstream.
		expect(message.model).toBe("claude-test");
		expect(message.responseModel).toBe("claude-opus-4-8");
		expect(message.content).toEqual([{ type: "text", text: "Hi" }]);
	});

	it("attributes a mid-stream failure to the requested model and the serving one", async () => {
		mockState.sseBody = sse([
			[
				"message_start",
				{
					type: "message_start",
					message: { id: "msg_fb", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 0 } },
				},
			],
			["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
		]);

		const message = await drain(anthropicModel, { apiKey: "sk-ant-test" });

		expect(message.stopReason).toBe("error");
		expect(message.responseModel).toBe("claude-opus-4-8");
		expect(message.errorMessage).toMatch(/^anthropic\/claude-test \(gateway served claude-opus-4-8\): /);
		// The provider's own wording is preserved after the attribution prefix.
		expect(message.errorMessage).toContain("Overloaded");
	});

	it("prunes the declining model's thinking before a mid-stream fallback boundary, keeps its text", async () => {
		mockState.sseBody = sse([
			[
				"message_start",
				{
					type: "message_start",
					message: { id: "msg_mid", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
				},
			],
			[
				"content_block_start",
				{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			],
			[
				"content_block_delta",
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "declined-model thinking" },
				},
			],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
			[
				"content_block_delta",
				{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "partial " } },
			],
			["content_block_stop", { type: "content_block_stop", index: 1 }],
			[
				"content_block_start",
				{
					type: "content_block_start",
					index: 2,
					content_block: { type: "fallback", from: { model: "claude-test" }, to: { model: "claude-opus-4-8" } },
				},
			],
			["content_block_stop", { type: "content_block_stop", index: 2 }],
			["content_block_start", { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } }],
			[
				"content_block_delta",
				{ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "continued" } },
			],
			["content_block_stop", { type: "content_block_stop", index: 3 }],
			["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
			["message_stop", { type: "message_stop" }],
		]);

		const message = await drain(anthropicModel, { apiKey: "sk-ant-test" });

		expect(message.stopReason).toBe("stop");
		expect(message.model).toBe("claude-test");
		expect(message.responseModel).toBe("claude-opus-4-8");
		expect(message.content).toEqual([
			{ type: "text", text: "partial " },
			{ type: "text", text: "continued" },
		]);
	});

	it("a terminal refusal surfaces the category and a retry hint", async () => {
		mockState.sseBody = sse([
			[
				"message_start",
				{
					type: "message_start",
					message: { id: "msg_ref", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
				},
			],
			[
				"message_delta",
				{
					type: "message_delta",
					delta: {
						stop_reason: "refusal",
						stop_details: { type: "refusal", category: "cyber", explanation: "Declined." },
					},
					usage: { output_tokens: 0 },
				},
			],
			["message_stop", { type: "message_stop" }],
		]);

		const message = await drain(anthropicModel, { apiKey: "sk-ant-test" });

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("category: cyber");
		expect(message.errorMessage).toContain("Declined.");
		expect(message.errorMessage).toContain("different model");
		// Structured too, so the harness can escalate without reading the sentence.
		expect(message.refusal).toEqual({ category: "cyber", explanation: "Declined." });
	});

	it("a refusal with no named category still reports structurally", async () => {
		mockState.sseBody = sse([
			[
				"message_start",
				{
					type: "message_start",
					message: { id: "msg_ref2", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
				},
			],
			[
				"message_delta",
				{
					type: "message_delta",
					delta: { stop_reason: "refusal", stop_details: null },
					usage: { output_tokens: 0 },
				},
			],
			["message_stop", { type: "message_stop" }],
		]);

		const message = await drain(anthropicModel, { apiKey: "sk-ant-test" });

		expect(message.stopReason).toBe("error");
		expect(message.refusal).toEqual({ category: null });
	});
});
