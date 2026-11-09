import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	complete,
	isContextOverflow,
	isProviderUnavailableAssistantError,
	isRetryableAssistantError,
} from "../src/compat.ts";
import type { Model } from "../src/types.ts";

// A provider error body names whichever model the serving side decided to talk
// about, which behind a gateway is routinely NOT the model phi asked for. These
// cover the requested `provider/modelId` being surfaced on the error path, and
// the serving model being named alongside it when the two differ.

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
	failWith: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const { chunks, failWith } = mockState;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
							if (failWith !== undefined) throw failWith;
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

function gatewayModel(): Model<"openai-completions"> {
	return {
		id: "example-small",
		name: "Example Small",
		api: "openai-completions",
		provider: "gateway",
		baseUrl: "https://llm.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };

describe("openai-completions error attribution", () => {
	beforeEach(() => {
		mockState.chunks = [];
		mockState.failWith = undefined;
	});

	it("names the requested provider/model on a failure with no serving model", async () => {
		mockState.failWith = Object.assign(new Error("connection error"), { status: 503 });

		const message = await complete(gatewayModel(), context, { apiKey: "test" });

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("gateway/example-small: connection error");
		expect(message.responseModel).toBeUndefined();
	});

	it("names the serving model too when the error body names a different one", async () => {
		// The P3 Code failure verbatim: the session had selected gateway/example-small, the
		// gateway served an upstream model, and the 400 named only the upstream — so
		// the message read as though a model the user never picked had failed.
		mockState.failWith = Object.assign(new Error("400 Invalid effort level"), {
			status: 400,
			error: { type: "invalid_request_error", message: "Invalid effort level", model: "claude-fable-5" },
		});

		const message = await complete(gatewayModel(), context, { apiKey: "test" });

		expect(message.stopReason).toBe("error");
		expect(message.responseModel).toBe("claude-fable-5");
		expect(message.errorMessage).toMatch(/^gateway\/example-small \(gateway served claude-fable-5\): /);
		// The provider's own body survives the prefix untouched.
		expect(message.errorMessage).toContain('"message":"Invalid effort level"');
	});

	it("uses a serving model already seen on the stream when the failure comes later", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-1", model: "claude-fable-5", choices: [{ index: 0, delta: { content: "hi" } }] },
		];
		mockState.failWith = Object.assign(new Error("stream failed"), { status: 502 });

		const message = await complete(gatewayModel(), context, { apiKey: "test" });

		expect(message.responseModel).toBe("claude-fable-5");
		expect(message.errorMessage).toBe("gateway/example-small (gateway served claude-fable-5): stream failed");
	});
});

describe("error attribution and the text classifiers", () => {
	beforeEach(() => {
		mockState.chunks = [];
		mockState.failWith = undefined;
	});

	it("keeps the provider's own text alongside the attributed message", async () => {
		mockState.failWith = Object.assign(new Error("connection error"), { status: 503 });

		const message = await complete(gatewayModel(), context, { apiKey: "test" });

		expect(message.errorMessage).toBe("gateway/example-small: connection error");
		expect(message.providerErrorMessage).toBe("connection error");
	});

	it("classifies a prompt-too-long error as overflow through the prefix", async () => {
		mockState.failWith = Object.assign(new Error("prompt is too long: 213462 tokens > 200000 maximum"), {
			status: 400,
		});

		const message = await complete(gatewayModel(), context, { apiKey: "test" });

		expect(isContextOverflow(message)).toBe(true);
	});

	it("classifies a no-body Cerebras error as overflow through the prefix", async () => {
		// The pattern used to be anchored at ^, so attribution silently stopped it
		// matching and an overflow turned into a hard failure instead of a compaction.
		mockState.failWith = Object.assign(new Error("400 status code (no body)"), { status: 400 });

		const message = await complete(gatewayModel(), context, { apiKey: "test" });

		expect(message.errorMessage).toBe("gateway/example-small: 400 status code (no body)");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("does not let a model id containing a status code fake a provider outage", async () => {
		// `us.mistral.pixtral-large-2502-v1:0` is a real catalog id, and `502` is a
		// bare substring in both the retryable and unavailable patterns. Classifying
		// the attributed string would turn every error from that model into a reroute.
		const model = { ...gatewayModel(), id: "us.mistral.pixtral-large-2502-v1:0" };
		mockState.failWith = Object.assign(new Error("Invalid effort level"), { status: 400 });

		const message = await complete(model, context, { apiKey: "test" });

		expect(message.errorMessage).toContain("2502");
		expect(isProviderUnavailableAssistantError(message)).toBe(false);
		expect(isRetryableAssistantError(message)).toBe(false);
	});

	it("still classifies a genuine 502 from that model as unavailable", async () => {
		const model = { ...gatewayModel(), id: "us.mistral.pixtral-large-2502-v1:0" };
		mockState.failWith = Object.assign(new Error("502 Bad Gateway"), { status: 502 });

		const message = await complete(model, context, { apiKey: "test" });

		expect(isProviderUnavailableAssistantError(message)).toBe(true);
	});
});
