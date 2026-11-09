import { describe, expect, it } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"lazy-abort-test"> = {
	id: "model",
	name: "Model",
	api: "lazy-abort-test",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function abortError(): Error {
	// What `AbortSignal.prototype.throwIfAborted()` throws: a DOMException named AbortError.
	const controller = new AbortController();
	controller.abort();
	try {
		controller.signal.throwIfAborted();
	} catch (error) {
		return error as Error;
	}
	throw new Error("unreachable");
}

async function terminal(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const received: AssistantMessageEvent[] = [];
	for await (const event of stream) received.push(event);
	return received;
}

describe("lazyStream setup aborts", () => {
	it("reports an AbortError thrown during setup as aborted, not as an error", async () => {
		const stream = lazyStream(model, async () => {
			throw abortError();
		});
		const events = await terminal(stream);
		expect(events.map((event) => (event.type === "error" ? event.reason : event.type))).toEqual(["aborted"]);
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
	});

	it("reports any setup failure as aborted when the caller's signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const stream = lazyStream(
			model,
			async () => {
				throw new Error("fetch failed");
			},
			undefined,
			controller.signal,
		);
		expect((await stream.result()).stopReason).toBe("aborted");
	});

	it("keeps other setup failures as errors", async () => {
		const stream = lazyStream(
			model,
			async () => {
				throw new Error("Provider is not configured: test");
			},
			undefined,
			new AbortController().signal,
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider is not configured: test");
	});

	it.each(["stream", "streamSimple"] as const)(
		"ModelsApi.%s with an already-aborted signal ends aborted when auth resolution throws",
		async (method) => {
			const models = createModels();
			models.setProvider(
				createProvider({
					id: model.provider,
					models: [model],
					auth: {
						apiKey: {
							name: "Test",
							resolve: async (context: { signal?: AbortSignal }) => {
								context?.signal?.throwIfAborted();
								return { auth: {} };
							},
						},
					},
					api: {
						stream: () => new AssistantMessageEventStream(),
						streamSimple: () => new AssistantMessageEventStream(),
					},
				}),
			);
			const controller = new AbortController();
			controller.abort();
			const result = await models[method](model, { messages: [] }, { signal: controller.signal }).result();
			expect(result.stopReason).toBe("aborted");
		},
	);
});
