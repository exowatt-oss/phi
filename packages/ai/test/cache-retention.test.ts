import type { ResponseInput, ResponseInputContent } from "openai/resources/responses/responses.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { type OpenAIResponsesOptions, stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext, stream } from "../src/compat.ts";
import { MODELS } from "../src/models.generated.ts";
import type { Context, Model } from "../src/types.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

interface OpenAICompletionsCachePayload {
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
}

type OpenAIResponsesCacheContent = ResponseInputContent & {
	prompt_cache_breakpoint?: { mode: "explicit" };
};

interface OpenAIResponsesCachePayload extends OpenAICompletionsCachePayload {
	input?: ResponseInput;
	prompt_cache_options?: { mode?: "explicit"; ttl?: "30m" };
}

type InstructionMessage = {
	role: "system" | "developer";
	content: string | OpenAIResponsesCacheContent[];
};

function stopAfterPayload<TPayload>(capture: (payload: TPayload) => void): (payload: unknown) => never {
	return (payload: unknown): never => {
		capture(payload as TPayload);
		throw new PayloadCaptured();
	};
}

async function captureOpenAIResponsesPayload(
	model: Model<"openai-responses">,
	context: Context,
	options?: Omit<OpenAIResponsesOptions, "apiKey" | "onPayload">,
): Promise<OpenAIResponsesCachePayload> {
	let capturedPayload: OpenAIResponsesCachePayload | undefined;
	const s = streamOpenAIResponses(model, normalizeContext(context), {
		...options,
		apiKey: "sk-fake-key",
		onPayload: stopAfterPayload<OpenAIResponsesCachePayload>((payload) => {
			capturedPayload = payload;
		}),
	});

	for await (const event of s) {
		if (event.type === "error") break;
	}

	if (!capturedPayload) throw new Error("Expected OpenAI Responses payload to be captured");
	return capturedPayload;
}

function getInstructionMessage(payload: OpenAIResponsesCachePayload): InstructionMessage {
	const item = payload.input?.[0];
	if (!item || !("role" in item) || !("content" in item) || (item.role !== "system" && item.role !== "developer")) {
		throw new Error("Expected an instruction message at the start of the input");
	}
	return item as InstructionMessage;
}

describe("Cache Retention (PI_CACHE_RETENTION)", () => {
	const originalEnv = process.env.PI_CACHE_RETENTION;

	beforeEach(() => {
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.PI_CACHE_RETENTION = originalEnv;
		} else {
			delete process.env.PI_CACHE_RETENTION;
		}
	});

	const context = normalizeContext({
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	});

	describe("Anthropic Provider", () => {
		it.skipIf(!process.env.ANTHROPIC_API_KEY)(
			"should use default cache TTL (no ttl field) when PI_CACHE_RETENTION is not set",
			async () => {
				const model = getModel("anthropic", "claude-haiku-4-5");
				let capturedPayload: any = null;

				const s = stream(model, context, {
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				// System prompt should have cache_control without ttl
				expect(capturedPayload.system).toBeDefined();
				expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
			},
		);

		it.skipIf(!process.env.ANTHROPIC_API_KEY)("should use 1h cache TTL when PI_CACHE_RETENTION=long", async () => {
			process.env.PI_CACHE_RETENTION = "long";
			const model = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			const s = stream(model, context, {
				onPayload: stopAfterPayload((payload) => {
					capturedPayload = payload;
				}),
			});

			// Consume the stream to trigger the request
			for await (const _ of s) {
				// Just consume
			}

			expect(capturedPayload).not.toBeNull();
			// System prompt should have cache_control with ttl: "1h"
			expect(capturedPayload.system).toBeDefined();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});

		it("should add ttl for non-api.anthropic.com baseUrl by default", async () => {
			process.env.PI_CACHE_RETENTION = "long";

			// Create a model with a different baseUrl (simulating a proxy)
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
			};

			let capturedPayload: any = null;

			// We can't actually make the request (no proxy), but we can verify the payload
			// by using a mock or checking the logic directly
			// For this test, we'll import the helper directly

			// Since we can't easily test this without mocking, we'll skip the actual API call
			// and just verify the helper logic works correctly

			try {
				const s = streamAnthropic(proxyModel, context, {
					apiKey: "sk-fake-key",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// This will fail since we're using a fake key and fake proxy, but the payload should be captured
				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});

		it("should omit ttl when supportsLongCacheRetention is false", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
				compat: { supportsLongCacheRetention: false },
			};
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(proxyModel, context, {
					apiKey: "sk-fake-key",
					cacheRetention: "long",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
		});

		it("should omit cache_control when cacheRetention is none", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "sk-fake-key",
					cacheRetention: "none",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toBeUndefined();
		});

		it("should add cache_control to string user messages", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "sk-fake-key",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			const lastMessage = capturedPayload.messages[capturedPayload.messages.length - 1];
			expect(Array.isArray(lastMessage.content)).toBe(true);
			const lastBlock = lastMessage.content[lastMessage.content.length - 1];
			expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
		});

		it("should set 1h cache TTL when cacheRetention is long", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "sk-fake-key",
					cacheRetention: "long",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});
	});

	describe("OpenAI Responses Provider", () => {
		it.each(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"] as const)(
			"does not enable cache warming from the documented TTL alone for %s",
			(modelId) => {
				expect(getModel("openai", modelId).promptCache).toBeUndefined();
			},
		);

		it.skipIf(!process.env.OPENAI_API_KEY)(
			"should not set prompt_cache_retention when PI_CACHE_RETENTION is not set",
			async () => {
				const model = getModel("openai", "gpt-4o-mini");
				let capturedPayload: any = null;

				const s = stream(model, context, {
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				expect(capturedPayload.prompt_cache_retention).toBeUndefined();
			},
		);

		it.skipIf(!process.env.OPENAI_API_KEY)(
			"should set prompt_cache_retention to 24h when PI_CACHE_RETENTION=long",
			async () => {
				process.env.PI_CACHE_RETENTION = "long";
				const model = getModel("openai", "gpt-4o-mini");
				let capturedPayload: any = null;

				const s = stream(model, context, {
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				expect(capturedPayload.prompt_cache_retention).toBe("24h");
			},
		);

		it("should set prompt_cache_retention for non-api.openai.com baseUrl by default", async () => {
			process.env.PI_CACHE_RETENTION = "long";

			// Create a model with a different baseUrl (simulating a proxy)
			const baseModel = getModel("openai", "gpt-4o-mini");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
			};

			let capturedPayload: any = null;

			try {
				const s = streamOpenAIResponses(proxyModel, context, {
					apiKey: "sk-fake-key",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// This will fail since we're using a fake key and fake proxy, but the payload should be captured
				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_retention).toBe("24h");
		});

		it("should omit prompt_cache_retention when supportsLongCacheRetention is false", async () => {
			const model = {
				...getModel("openai", "gpt-4o-mini"),
				compat: { supportsLongCacheRetention: false },
			};
			let capturedPayload: any = null;

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "sk-fake-key",
					cacheRetention: "long",
					sessionId: "session-compat-false",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_retention).toBeUndefined();
		});

		it("should omit prompt_cache_key and disable implicit writes when cacheRetention is none", async () => {
			const model = getModel("openai", "gpt-5.6-sol");
			let capturedPayload: OpenAIResponsesCachePayload | undefined;

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "sk-fake-key",
					cacheRetention: "none",
					sessionId: "session-1",
					onPayload: stopAfterPayload<OpenAIResponsesCachePayload>((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).toBeDefined();
			expect(capturedPayload?.prompt_cache_key).toBeUndefined();
			expect(capturedPayload?.prompt_cache_retention).toBeUndefined();
			expect(capturedPayload?.prompt_cache_options).toEqual({ mode: "explicit" });
			expect(JSON.stringify(capturedPayload?.input)).not.toContain("prompt_cache_breakpoint");
		});

		it("keeps legacy cache fields and input shape for models without explicit caching", async () => {
			const payload = await captureOpenAIResponsesPayload(getModel("openai", "gpt-4o-mini"), context, {
				sessionId: "session-legacy",
				cacheRetention: "short",
			});

			expect(payload.prompt_cache_key).toBe("session-legacy");
			expect(payload.prompt_cache_retention).toBeUndefined();
			expect(payload.prompt_cache_options).toBeUndefined();
			expect(JSON.stringify(payload.input)).not.toContain("prompt_cache_breakpoint");
		});

		it("should omit prompt_cache_options for models that reject it", async () => {
			const model = getModel("openai", "gpt-4o-mini");
			let capturedPayload: OpenAIResponsesCachePayload | undefined;

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "sk-fake-key",
					cacheRetention: "none",
					sessionId: "session-1",
					onPayload: stopAfterPayload<OpenAIResponsesCachePayload>((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).toBeDefined();
			expect(capturedPayload?.prompt_cache_key).toBeUndefined();
			expect(capturedPayload?.prompt_cache_options).toBeUndefined();
		});

		it("should use explicit GPT-5.6 caching for the stable instruction prefix", async () => {
			const model = getModel("openai", "gpt-5.6-sol");
			const payload = await captureOpenAIResponsesPayload(model, context, {
				sessionId: "session-explicit",
				cacheRetention: "long",
			});
			const instruction = getInstructionMessage(payload);

			expect(instruction.role).toBe("developer");
			expect(payload.prompt_cache_key).toBe("session-explicit");
			expect(payload.prompt_cache_retention).toBeUndefined();
			expect(payload.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
			expect(instruction.content).toEqual([
				expect.objectContaining({
					type: "input_text",
					text: "You are a helpful assistant.",
					prompt_cache_breakpoint: { mode: "explicit" },
				}),
			]);

			const userMessage = payload.input?.find((item) => "role" in item && item.role === "user");
			expect(userMessage).not.toMatchObject({
				content: [expect.objectContaining({ prompt_cache_breakpoint: expect.anything() })],
			});
		});

		it("does not add an explicit breakpoint without a stable instruction prefix", async () => {
			const payload = await captureOpenAIResponsesPayload(
				getModel("openai", "gpt-5.6-sol"),
				{
					messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
				},
				{ sessionId: "session-no-prefix" },
			);

			expect(payload.prompt_cache_key).toBe("session-no-prefix");
			expect(payload.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
			expect(payload.input?.some((item) => JSON.stringify(item).includes("prompt_cache_breakpoint"))).toBe(false);
		});

		it("marks the last cacheable block in a multi-block instruction prefix", async () => {
			const payload = await captureOpenAIResponsesPayload(
				getModel("openai", "gpt-5.6-sol"),
				{
					systemPrompt: "Use the attached reference.",
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "Question" }],
							timestamp: Date.now(),
						},
					],
				},
				{ sessionId: "session-multi-block" },
			);
			const instruction = getInstructionMessage(payload);
			if (typeof instruction.content === "string") throw new Error("Expected structured instruction content");
			expect(instruction.content).toEqual([
				expect.objectContaining({ type: "input_text", prompt_cache_breakpoint: { mode: "explicit" } }),
			]);
		});

		it("does not mutate the context while adding an explicit breakpoint", async () => {
			const immutableContext: Context = {
				systemPrompt: "Stable instructions",
				messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }],
			};
			const before = structuredClone(immutableContext);

			await captureOpenAIResponsesPayload(getModel("openai", "gpt-5.6-sol"), immutableContext, {
				sessionId: "session-immutable",
			});

			expect(immutableContext).toEqual(before);
		});

		it.each([
			["gpt-4o-mini", "24h", undefined],
			// phi keeps GPT-5.6+ in explicit mode (stable-instruction breakpoint), so the
			// long tier is explicit mode with the 30-minute TTL, not upstream's implicit TTL.
			["gpt-6-astra", undefined, { mode: "explicit", ttl: "30m" }],
			["gpt-6-sol", undefined, { mode: "explicit", ttl: "30m" }],
			["gpt-6-luna", undefined, { mode: "explicit", ttl: "30m" }],
		] as const)("should use the supported long cache field for %s", async (modelId, retention, cacheOptions) => {
			const model = getModel("openai", modelId);
			let capturedPayload: OpenAIResponsesCachePayload | undefined;

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "sk-fake-key",
					cacheRetention: "long",
					sessionId: "session-2",
					onPayload: stopAfterPayload<OpenAIResponsesCachePayload>((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload?.prompt_cache_key).toBe("session-2");
			expect(capturedPayload?.prompt_cache_retention).toBe(retention);
			expect(capturedPayload?.prompt_cache_options).toEqual(cacheOptions);
		});
	});

	describe("OpenAI Completions Provider", () => {
		function createCompletionsModel(compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
			return {
				id: "test-model",
				name: "Test Model",
				api: "openai-completions",
				provider: "test-openai-completions",
				baseUrl: "https://my-proxy.example.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
				compat,
			};
		}

		it("should set prompt_cache_retention for non-api.openai.com baseUrl by default", async () => {
			let capturedPayload: any = null;

			try {
				const s = streamOpenAICompletions(createCompletionsModel(), context, {
					apiKey: "sk-fake-key",
					cacheRetention: "long",
					sessionId: "session-completions",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_key).toBe("session-completions");
			expect(capturedPayload.prompt_cache_retention).toBe("24h");
		});

		it("should omit prompt_cache_retention when supportsLongCacheRetention is false", async () => {
			let capturedPayload: any = null;

			try {
				const s = streamOpenAICompletions(createCompletionsModel({ supportsLongCacheRetention: false }), context, {
					apiKey: "sk-fake-key",
					cacheRetention: "long",
					sessionId: "session-completions-false",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_key).toBeUndefined();
			expect(capturedPayload.prompt_cache_retention).toBeUndefined();
		});

		it.each([
			MODELS.opencode["deepseek-v4-pro"],
			MODELS.opencode["kimi-k2.5"],
			MODELS.opencode["kimi-k2.6"],
			MODELS.opencode["minimax-m2.7"],
		] as const)("should omit long cache retention for $provider/$id", async (metadata) => {
			const model = metadata as Model<"openai-completions">;
			let capturedPayload: OpenAICompletionsCachePayload | undefined;

			try {
				const s = streamOpenAICompletions(model, context, {
					apiKey: "sk-fake-key",
					cacheRetention: "long",
					sessionId: "session-opencode-long-cache-unsupported",
					onPayload: stopAfterPayload<OpenAICompletionsCachePayload>((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(model.compat?.supportsLongCacheRetention).toBe(false);
			expect(capturedPayload).toBeDefined();
			expect(capturedPayload?.prompt_cache_key).toBeUndefined();
			expect(capturedPayload?.prompt_cache_retention).toBeUndefined();
		});

		it.each([MODELS.cerebras["gpt-oss-120b"], MODELS.cerebras["qwen-3.8-27b"]] as const)(
			"should omit strict field on tools for cerebras/$id",
			async (metadata) => {
				const model = metadata as Model<"openai-completions">;

				const contextWithTools = {
					messages: [
						{
							role: "system" as const,
							content: "test",
							toolsAdded: [
								{
									name: "t1",
									description: "strict tool",
									parameters: {
										type: "object" as const,
										properties: { x: { type: "string" } },
										required: ["x"],
									},
									constrainedSampling: { type: "json_schema" as const },
								},
								{
									name: "t2",
									description: "non-strict tool",
									parameters: {
										type: "object" as const,
										properties: { y: { type: "string" } },
										required: ["y"],
									},
								},
							],
							timestamp: 0,
						},
						{ role: "user" as const, content: "hello", timestamp: 1 },
					],
				};

				let capturedPayload: any;

				try {
					const s = streamOpenAICompletions(model, contextWithTools as any, {
						apiKey: "sk-fake-key",
						sessionId: "test",
						onPayload: stopAfterPayload((payload: any) => {
							capturedPayload = payload;
						}),
					});

					for await (const event of s) {
						if (event.type === "error") break;
					}
				} catch {
					// Expected to fail
				}

				expect(model.compat?.supportsStrictMode).toBeUndefined();
				expect(capturedPayload).toBeDefined();
				const tools = capturedPayload?.tools as any[] | undefined;
				expect(tools).toBeDefined();
				for (const tool of tools!) {
					expect(tool.function).not.toHaveProperty("strict");
				}
			},
		);
	});
});
