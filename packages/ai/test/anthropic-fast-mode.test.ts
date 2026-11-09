import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resetAnthropicFastModeCooldowns,
	stream as streamAnthropic,
	streamSimple as streamSimpleAnthropic,
} from "../src/api/anthropic-messages.ts";
import { supportsFastMode } from "../src/models.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface CreateCall {
	params: Record<string, unknown>;
	betaHeader: string;
}

type CreateBehavior =
	| { status: 200; usageSpeed?: "fast" | "standard"; message?: undefined; headers?: undefined }
	| { status: number; message: string; headers?: Record<string, string>; usageSpeed?: undefined };

const mockState = vi.hoisted(() => ({
	calls: [] as CreateCall[],
	behaviors: [] as CreateBehavior[],
}));

function sse(events: Array<[string, unknown]>): string {
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n");
}

function completionSse(usageSpeed?: "fast" | "standard"): string {
	const startUsage: Record<string, unknown> = { input_tokens: 1000, output_tokens: 0 };
	if (usageSpeed) startUsage.speed = usageSpeed;
	return sse([
		[
			"message_start",
			{ type: "message_start", message: { id: "msg_test", model: "claude-test", usage: startUsage } },
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } }],
		["message_stop", { type: "message_stop" }],
	]);
}

vi.mock("@anthropic-ai/sdk", () => {
	class FakeApiError extends Error {
		status: number;
		headers: Headers;
		constructor(status: number, message: string, headers?: Record<string, string>) {
			super(message);
			this.status = status;
			this.headers = new Headers(headers);
		}
	}
	class FakeAnthropic {
		private betaHeader: string;
		constructor(opts: { defaultHeaders?: Record<string, string> }) {
			this.betaHeader = opts.defaultHeaders?.["anthropic-beta"] ?? "";
		}
		// Betas travel as the `betas` request parameter on the beta Messages API
		// (the SDK turns them into the anthropic-beta header).
		beta = {
			messages: {
				create: (params: Record<string, unknown>) => this.create(params),
			},
		};
		private create(params: Record<string, unknown>) {
			const betas = Array.isArray(params.betas) ? (params.betas as string[]).join(",") : this.betaHeader;
			mockState.calls.push({ params: { ...params }, betaHeader: betas });
			const behavior = mockState.behaviors.shift() ?? { status: 200 as const };
			return {
				asResponse: async () => {
					if (behavior.message !== undefined) {
						throw new FakeApiError(behavior.status, behavior.message, behavior.headers);
					}
					return new Response(completionSse(behavior.usageSpeed), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				},
			};
		}
	}
	return { default: FakeAnthropic };
});

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

function model(id: string, overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		// Opus 5.5 list prices; fast mode doubles every rate.
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		contextWindow: 1_000_000,
		maxTokens: 4096,
		...overrides,
	};
}

const opus55 = model("claude-opus-5-5");

async function drain(events: ReturnType<typeof streamAnthropic>): Promise<AssistantMessage> {
	let final: AssistantMessage | undefined;
	for await (const event of events) {
		if (event.type === "done") final = event.message;
		if (event.type === "error") final = event.error;
	}
	if (!final) throw new Error("stream produced no terminal event");
	return final;
}

function lastCall(): CreateCall {
	const call = mockState.calls.at(-1);
	if (!call) throw new Error("no create call recorded");
	return call;
}

function queue(...behaviors: CreateBehavior[]): void {
	mockState.behaviors.push(...behaviors);
}

afterEach(() => {
	mockState.calls.length = 0;
	mockState.behaviors.length = 0;
	resetAnthropicFastModeCooldowns();
});

describe("supportsFastMode", () => {
	it("is on for first-party Opus 5.5, Opus 5, and Opus 4.8, with or without a date suffix", () => {
		for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-5-20260501"]) {
			expect(supportsFastMode(model(id)), id).toBe(true);
		}
	});

	it("is off for Opus 4.7, Opus 4.6, Sonnet, Haiku, Fable, and non-anthropic hosts", () => {
		for (const id of [
			"claude-opus-4-7",
			"claude-opus-4-6",
			"claude-sonnet-5",
			"claude-haiku-4-5",
			"claude-fable-5-1",
		]) {
			expect(supportsFastMode(model(id)), id).toBe(false);
		}
		expect(supportsFastMode(model("claude-opus-5-5", { provider: "some-proxy" }))).toBe(false);
		expect(supportsFastMode({ ...model("claude-opus-5-5"), api: "bedrock-converse-stream" } as Model<any>)).toBe(
			false,
		);
	});

	it("honors an explicit compat override in both directions", () => {
		expect(
			supportsFastMode(model("claude-opus-5-5", { provider: "some-proxy", compat: { supportsFastMode: true } })),
		).toBe(true);
		expect(supportsFastMode(model("claude-opus-5-5", { compat: { supportsFastMode: false } }))).toBe(false);
	});
});

describe("Anthropic fast mode", () => {
	it("serviceTier fast sends speed: fast with the fast-mode beta on a supported model and bills 2x", async () => {
		queue({ status: 200, usageSpeed: "fast" });
		const message = await drain(
			streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
		);

		expect(lastCall().params.speed).toBe("fast");
		expect(lastCall().betaHeader).toContain("fast-mode-2026-02-01");
		expect(message.stopReason).toBe("stop");
		expect(message.speed).toBe("fast");
		// 1000 input @ $8/M + 500 output @ $40/M
		expect(message.usage.cost.input).toBeCloseTo(0.008, 9);
		expect(message.usage.cost.output).toBeCloseTo(0.02, 9);
		expect(message.usage.cost.total).toBeCloseTo(0.028, 9);
	});

	it("bills a successful fast request as fast even when the response omits usage.speed", async () => {
		queue({ status: 200 });
		const message = await drain(
			streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
		);

		expect(message.speed).toBe("fast");
		expect(message.usage.cost.total).toBeCloseTo(0.028, 9);
	});

	it("bills at standard rates when the response reports usage.speed: standard", async () => {
		queue({ status: 200, usageSpeed: "standard" });
		const message = await drain(
			streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
		);

		expect(message.speed).toBe("standard");
		expect(message.usage.cost.total).toBeCloseTo(0.014, 9);
	});

	it("honors compat.fastModeCostMultiplier", async () => {
		queue({ status: 200, usageSpeed: "fast" });
		const message = await drain(
			streamSimpleAnthropic(model("claude-opus-5-5", { compat: { fastModeCostMultiplier: 3 } }), context, {
				apiKey: "sk-ant-test",
				serviceTier: "fast",
			}),
		);

		expect(message.usage.cost.total).toBeCloseTo(0.042, 9);
	});

	it("leaves the request alone without a fast tier", async () => {
		const message = await drain(streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test" }));

		expect(lastCall().params.speed).toBeUndefined();
		expect(lastCall().betaHeader).not.toContain("fast-mode");
		expect(message.speed).toBeUndefined();
		expect(message.usage.cost.total).toBeCloseTo(0.014, 9);
	});

	it("ignores the fast tier for models without fast mode instead of erroring", async () => {
		for (const id of ["claude-sonnet-5", "claude-opus-4-7", "claude-opus-4-6"]) {
			const message = await drain(
				streamSimpleAnthropic(model(id), context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
			);
			expect(lastCall().params.speed, id).toBeUndefined();
			expect(lastCall().betaHeader, id).not.toContain("fast-mode");
			expect(message.speed, id).toBeUndefined();
		}
	});

	it("ignores the fast tier for other providers on the messages API unless compat opts in", async () => {
		await drain(
			streamSimpleAnthropic(model("claude-opus-5-5", { provider: "some-proxy" }), context, {
				apiKey: "sk-other",
				serviceTier: "fast",
			}),
		);
		expect(lastCall().params.speed).toBeUndefined();

		await drain(
			streamSimpleAnthropic(
				model("claude-opus-5-5", { provider: "some-proxy", compat: { supportsFastMode: true } }),
				context,
				{
					apiKey: "sk-other",
					serviceTier: "fast",
				},
			),
		);
		expect(lastCall().params.speed).toBe("fast");
		expect(lastCall().betaHeader).toContain("fast-mode-2026-02-01");
	});

	it("adds the fast-mode beta next to the Claude Code betas for OAuth tokens", async () => {
		queue({ status: 200, usageSpeed: "fast" });
		await drain(streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-oat-test", serviceTier: "fast" }));

		expect(lastCall().params.speed).toBe("fast");
		expect(lastCall().betaHeader).toContain("claude-code-20250219");
		expect(lastCall().betaHeader).toContain("oauth-2025-04-20");
		expect(lastCall().betaHeader).toContain("fast-mode-2026-02-01");
	});

	it("the low-level stream() takes speed directly", async () => {
		queue({ status: 200, usageSpeed: "fast" });
		const message = await drain(streamAnthropic(opus55, context, { apiKey: "sk-ant-test", speed: "fast" }));

		expect(lastCall().params.speed).toBe("fast");
		expect(message.speed).toBe("fast");
	});

	it("retries once at standard speed when fast mode is rate limited, records the fallback, and cools down", async () => {
		queue({ status: 429, message: "fast mode rate limit exceeded", headers: { "retry-after": "30" } });
		queue({ status: 200, usageSpeed: "standard" });
		const message = await drain(
			streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast", maxRetries: 3 }),
		);

		expect(mockState.calls).toHaveLength(2);
		expect(mockState.calls[0].params.speed).toBe("fast");
		expect(mockState.calls[1].params.speed).toBeUndefined();
		expect(message.stopReason).toBe("stop");
		expect(message.speed).toBe("standard");
		expect(message.usage.cost.total).toBeCloseTo(0.014, 9);
		expect(message.diagnostics?.map((d) => d.type)).toEqual(["anthropic_fast_mode_fallback"]);
		expect(message.diagnostics?.[0].details).toMatchObject({ reason: "capacity", status: 429, cooldownMs: 30_000 });

		// Cooldown: the next request skips fast mode without another rejected round trip.
		mockState.calls.length = 0;
		queue({ status: 200, usageSpeed: "standard" });
		const cooled = await drain(
			streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
		);
		expect(mockState.calls).toHaveLength(1);
		expect(mockState.calls[0].params.speed).toBeUndefined();
		expect(mockState.calls[0].betaHeader).toContain("fast-mode-2026-02-01");
		expect(cooled.speed).toBe("standard");
		expect(cooled.diagnostics).toBeUndefined();

		// The cooldown is shared across Opus models on the same provider (one fast-mode pool).
		mockState.calls.length = 0;
		await drain(
			streamSimpleAnthropic(model("claude-opus-5"), context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
		);
		expect(mockState.calls[0].params.speed).toBeUndefined();

		// And it clears.
		resetAnthropicFastModeCooldowns();
		mockState.calls.length = 0;
		await drain(streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast" }));
		expect(mockState.calls[0].params.speed).toBe("fast");
	});

	it("falls back on 529 overloaded with the default cooldown", async () => {
		queue({ status: 529, message: "Overloaded" });
		const message = await drain(
			streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
		);

		expect(mockState.calls).toHaveLength(2);
		expect(message.stopReason).toBe("stop");
		expect(message.diagnostics?.[0].details).toMatchObject({ reason: "capacity", status: 529, cooldownMs: 60_000 });
	});

	it("falls back when the API rejects speed for the model and cools down only that model", async () => {
		const flagged = model("claude-opus-4-7", { compat: { supportsFastMode: true } });
		queue({ status: 400, message: "speed: fast is not supported for this model" });
		const message = await drain(
			streamSimpleAnthropic(flagged, context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
		);

		expect(mockState.calls).toHaveLength(2);
		expect(mockState.calls[1].params.speed).toBeUndefined();
		expect(message.stopReason).toBe("stop");
		expect(message.speed).toBe("standard");
		expect(message.diagnostics?.[0].details).toMatchObject({ reason: "unsupported", status: 400 });

		mockState.calls.length = 0;
		await drain(streamSimpleAnthropic(flagged, context, { apiKey: "sk-ant-test", serviceTier: "fast" }));
		expect(mockState.calls[0].params.speed).toBeUndefined();

		// A different model on the same provider is unaffected.
		mockState.calls.length = 0;
		await drain(streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast" }));
		expect(mockState.calls[0].params.speed).toBe("fast");
	});

	it("falls back when the organization has fast mode disabled, provider-wide, with the API's own message", async () => {
		// Verbatim from the live API on an org without fast mode enabled.
		const body =
			'{"type":"error","error":{"type":"invalid_request_error","message":"Fast mode is not enabled for your organization. An organization admin must enable this feature."},"request_id":"req_test"}';
		queue({ status: 400, message: `400 ${body}` });
		const message = await drain(
			streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
		);

		expect(mockState.calls).toHaveLength(2);
		expect(mockState.calls[1].params.speed).toBeUndefined();
		expect(message.stopReason).toBe("stop");
		expect(message.speed).toBe("standard");
		expect(message.usage.cost.total).toBeCloseTo(0.014, 9);
		expect(message.diagnostics?.[0].details).toMatchObject({
			reason: "disabled",
			status: 400,
			cooldownMs: 5 * 60_000,
			message: "Fast mode is not enabled for your organization. An organization admin must enable this feature.",
		});

		// Org policy covers every Opus model on the provider.
		mockState.calls.length = 0;
		await drain(
			streamSimpleAnthropic(model("claude-opus-5"), context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
		);
		expect(mockState.calls).toHaveLength(1);
		expect(mockState.calls[0].params.speed).toBeUndefined();
	});

	it("does not treat unrelated failures as fast-mode rejections", async () => {
		queue({ status: 401, message: "invalid x-api-key" });
		const message = await drain(
			streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast" }),
		);

		expect(mockState.calls).toHaveLength(1);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("invalid x-api-key");

		queue({ status: 200, usageSpeed: "fast" });
		mockState.calls.length = 0;
		await drain(streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast" }));
		expect(mockState.calls[0].params.speed).toBe("fast");
	});

	it("still applies the generic retry policy to a fast request that hits a transient 500", async () => {
		queue({ status: 500, message: "internal error" });
		queue({ status: 200, usageSpeed: "fast" });
		const message = await drain(
			streamSimpleAnthropic(opus55, context, { apiKey: "sk-ant-test", serviceTier: "fast", maxRetries: 2 }),
		);

		expect(mockState.calls).toHaveLength(2);
		expect(mockState.calls[1].params.speed).toBe("fast");
		expect(message.speed).toBe("fast");
		expect(message.diagnostics).toBeUndefined();
	});
});
