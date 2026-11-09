import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import { normalizeContext, streamSimple } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

// With thinking off, phi used to send `reasoning_effort: <thinkingLevelMap.off>`
// unconditionally. That value is provider-specific vocabulary ("none", in
// practice) and a gateway model group that re-maps onto an upstream which does
// not share it answers `400 invalid_request_error: Invalid effort level`. The
// field is now omitted unless `compat.sendReasoningEffortOff` opts in.

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
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

function modelWithOffLevel(compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
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
		thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high" },
		compat: { supportsReasoningEffort: true, ...compat },
	};
}

async function payloadFor(model: Model<"openai-completions">, reasoning?: "off" | "high"): Promise<any> {
	let payload: unknown;
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
		{
			apiKey: "test",
			...(reasoning && reasoning !== "off" ? { reasoning } : {}),
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();
	return payload;
}

describe("openai-completions reasoning_effort with thinking off", () => {
	it("omits reasoning_effort by default", async () => {
		expect(await payloadFor(modelWithOffLevel())).not.toHaveProperty("reasoning_effort");
	});

	it("sends the off value when compat.sendReasoningEffortOff is set", async () => {
		const payload = await payloadFor(modelWithOffLevel({ sendReasoningEffortOff: true }));

		expect(payload).toHaveProperty("reasoning_effort", "none");
	});

	it("still sends an explicit thinking level", async () => {
		const payload = await payloadFor(modelWithOffLevel(), "high");

		expect(payload).toHaveProperty("reasoning_effort", "high");
	});
});

// `streamSimple` clamps the level to what the model supports before mapping it,
// so an unsupported level never reaches `buildParams` on that path. `stream()`
// takes the effort verbatim — SDK callers and any future caller that skips the
// clamp land here, and this is where an explicit `null` used to leak the raw pi
// level name onto the wire.
async function rawPayloadFor(
	model: Model<"openai-completions">,
	reasoningEffort: "medium",
): Promise<Record<string, unknown>> {
	let payload: unknown;
	await stream(model, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] }), {
		apiKey: "test",
		reasoningEffort,
		onPayload: (params: unknown) => {
			payload = params;
		},
	}).result();
	return payload as Record<string, unknown>;
}

describe("openai-completions reasoning_effort for an unsupported level", () => {
	it("omits reasoning_effort when the catalog maps the level to null", async () => {
		const model = modelWithOffLevel();
		const payload = await rawPayloadFor(
			{ ...model, thinkingLevelMap: { ...model.thinkingLevelMap, medium: null } },
			"medium",
		);

		// `?? level` used to fire on the explicit null too, sending the raw pi level
		// name to a model the catalog had just declared does not accept it.
		expect(payload).not.toHaveProperty("reasoning_effort");
	});

	it("passes an unmapped level through unchanged", async () => {
		const model = modelWithOffLevel();
		const payload = await rawPayloadFor({ ...model, thinkingLevelMap: { off: "none" } }, "medium");

		expect(payload).toHaveProperty("reasoning_effort", "medium");
	});
});
