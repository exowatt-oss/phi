import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// `message_start.message.model` is who answered. It is recorded on
// `responseModel` even when it equals the requested id: behind a gateway that
// is the confirmation a host needs, and an absent value has to keep meaning
// "the server never said".

const mockState = vi.hoisted(() => ({
	sseBody: undefined as string | undefined,
}));

function sse(events: Array<[string, unknown]>): string {
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n");
}

function completionSse(model: string | undefined): string {
	return sse([
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_test",
					...(model === undefined ? {} : { model }),
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
		],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
		["message_stop", { type: "message_stop" }],
	]);
}

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		// The adapter sends through the beta Messages API since the v0.85.0 merge.
		beta = {
			messages: {
				create: () => ({
					asResponse: async () =>
						new Response(mockState.sseBody ?? completionSse("claude-test"), {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						}),
				}),
			},
		};
	}
	return { default: FakeAnthropic };
});

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

const gatewayModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "gateway",
	baseUrl: "https://gateway.example/anthropic",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

async function drain() {
	let final: unknown;
	for await (const event of streamAnthropic(gatewayModel, context, { apiKey: "test" })) {
		if (event.type === "done") final = event.message;
		if (event.type === "error") final = event.error;
	}
	return final as { model: string; responseModel?: string; stopReason: string };
}

afterEach(() => {
	mockState.sseBody = undefined;
});

describe("anthropic-messages responseModel", () => {
	it("records the served model even when it equals the requested id", async () => {
		mockState.sseBody = completionSse("claude-test");

		const message = await drain();

		expect(message.stopReason).toBe("stop");
		expect(message.model).toBe("claude-test");
		expect(message.responseModel).toBe("claude-test");
	});

	it("records a different served model without touching model", async () => {
		mockState.sseBody = completionSse("claude-opus-4-8");

		const message = await drain();

		expect(message.model).toBe("claude-test");
		expect(message.responseModel).toBe("claude-opus-4-8");
	});

	it("leaves responseModel absent when message_start names no model", async () => {
		mockState.sseBody = completionSse(undefined);

		const message = await drain();

		expect(message.responseModel).toBeUndefined();
	});
});
