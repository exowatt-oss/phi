import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

interface CapturedResponsesPayload {
	prompt_cache_key?: string;
	session_id?: string;
	tools?: Array<{ name?: string; strict?: boolean }>;
}

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

async function captureOpenAIResponseHeaders(
	options: Parameters<typeof streamOpenAIResponses>[2],
	model: Model<"openai-responses"> = getModel("openai", "gpt-5.4"),
): Promise<{
	sessionId: string | null;
	clientRequestId: string | null;
	xSessionId: string | null;
}> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		xSessionId: null as string | null,
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		captured.xSessionId = getHeader(init?.headers, "x-session-id");
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(
		model,
		normalizeContext({
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		}),
		{ apiKey: "sk-test-key", ...options },
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// #2567: Copilot rejected reasoning.effort "none". gpt-6-sol has off: "none", so this exercises the Copilot exception.
	it("omits reasoning when no reasoning is requested", async () => {
		const model = getModel("github-copilot", "gpt-6-sol");
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			}),
			{
				apiKey: "sk-test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
	});

	it("forwards required tool choice", async () => {
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			normalizeContext({
				messages: [
					{
						role: "user",
						content: "Do not call ping. Respond with text instead.",
						timestamp: Date.now(),
					},
				],
				tools: [
					{
						name: "ping",
						description: "Ping",
						parameters: Type.Object({ value: Type.String() }),
					},
				],
			}),
			{
				apiKey: "sk-test-key",
				toolChoice: "required",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		// gpt-5.4 declares its tools in additional_tools items; tool_choice applies to them.
		expect(capturedPayload).toMatchObject({
			tool_choice: "required",
			input: [{ type: "additional_tools", tools: [expect.objectContaining({ name: "ping" })] }, expect.anything()],
		});
	});

	it("sets strict mode explicitly for Cloudflare OpenAI Responses tools", async () => {
		const model = getModel("cloudflare-ai-gateway", "gpt-5.6-sol");
		let capturedPayload: CapturedResponsesPayload | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			normalizeContext({
				messages: [{ role: "user", content: "Use a tool.", timestamp: Date.now() }],
				tools: [
					{
						name: "ordinary",
						description: "An ordinary tool",
						parameters: Type.Object({
							path: Type.String(),
							offset: Type.Optional(Type.Number()),
						}),
					},
					{
						name: "constrained",
						description: "A constrained tool",
						parameters: Type.Object({ value: Type.String() }),
						constrainedSampling: { type: "json_schema", strict: "prefer" },
					},
				],
			}),
			{
				apiKey: "sk-test-key",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(model.compat?.supportsStrictMode).toBe(true);
		expect(capturedPayload?.tools).toEqual([
			expect.objectContaining({ name: "ordinary", strict: false }),
			expect.objectContaining({ name: "constrained", strict: true }),
		]);
	});

	it.each([
		"gpt-5.1",
		"gpt-5.2",
		"gpt-5.3-codex",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.4-nano",
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-6-sol",
		"gpt-6-luna",
	] as const)("sends none reasoning effort for OpenAI %s when no reasoning is requested", async (modelId) => {
		const model = getModel("openai", modelId);
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			}),
			{
				apiKey: "sk-test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			reasoning: { effort: "none" },
		});
	});

	it.each(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const)(
		"omits reasoning effort for OpenAI %s when off is unsupported",
		async (modelId) => {
			const model = getModel("openai", modelId);
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				normalizeContext({
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				}),
				{
					apiKey: "sk-test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			expect(capturedPayload).not.toMatchObject({
				reasoning: expect.anything(),
			});
		},
	);

	it("sets cache-affinity headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const sessionId = "x".repeat(67);
		let capturedPayload: Pick<CapturedResponsesPayload, "prompt_cache_key"> | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			}),
			{
				apiKey: "sk-test-key",
				sessionId,
				onPayload: (payload) => {
					capturedPayload = payload as Pick<CapturedResponsesPayload, "prompt_cache_key">;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("sets cache-affinity headers for proxy OpenAI Responses requests with a sessionId", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("uses OpenRouter session-affinity header when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openrouter" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-proxy");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("auto-detects OpenRouter session-affinity header for OpenRouter Responses endpoints", async () => {
		const openRouterModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-openrouter",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			openRouterModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-openrouter");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-openrouter");
	});

	it("uses OpenAI no-session format when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-proxy");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("uses OpenAI no-session format for OpenCode Responses models", async () => {
		const model = getModel("opencode", "gpt-5.4");
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-opencode",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			model,
		);

		expect(model.compat?.sessionAffinityFormat).toBe("openai-nosession");
		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-opencode");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.prompt_cache_key).toBe("session-opencode");
	});

	it("can omit OpenAI session_id header while preserving other affinity data", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-123",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-123");
		expect(capturedPayload?.prompt_cache_key).toBe("session-123");
	});

	it("lets explicit headers override the default OpenAI cache-affinity headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured.sessionId).toBe("override-session");
		expect(captured.clientRequestId).toBe("override-request");
	});

	it("omits OpenAI cache-affinity headers when cacheRetention is none", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it("serializes the renamed fast service tier through streamSimple", async () => {
		let capturedPayload: unknown;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			normalizeContext({
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			}),
			{
				apiKey: "test-key",
				serviceTier: "fast",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({ service_tier: "fast" });
	});

	it("omits service_tier for github-copilot models", async () => {
		let capturedPayload: unknown;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const model = {
			...getModel("openai", "gpt-5.4"),
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
		} as Model<"openai-responses">;

		const stream = streamOpenAIResponses(
			model,
			normalizeContext({
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			}),
			{
				apiKey: "test-key",
				serviceTier: "fast",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect("service_tier" in (capturedPayload as object)).toBe(false);
	});

	it.each([
		["gpt-5.4", "priority", "priority", 2],
		["gpt-5.5", "priority", "priority", 2.5],
		["gpt-5.5", "flex", "flex", 0.5],
		// GPT-6 models report Fast mode as "fast" even when "priority" is requested (#10034)
		["gpt-6-luna", "priority", "fast", 2],
		["gpt-6-luna", "fast", "fast", 2],
	] as const)(
		"applies %s cost multiplier for requested %s and returned %s service tier",
		async (modelId, serviceTier, responseServiceTier, multiplier) => {
			const model = getModel("openai", modelId);
			const tokenCount = 100_000;
			const tokenScale = tokenCount / 1_000_000;
			const sse = `${[
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						service_tier: responseServiceTier,
						usage: {
							input_tokens: tokenCount,
							output_tokens: tokenCount,
							total_tokens: tokenCount * 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n")}\n\n`;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				normalizeContext({
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				}),
				{ apiKey: "sk-test-key", serviceTier },
			);

			const result = await stream.result();

			expect(result.usage.cost.input).toBeCloseTo(model.cost.input * multiplier * tokenScale, 12);
			expect(result.usage.cost.output).toBeCloseTo(model.cost.output * multiplier * tokenScale, 12);
			expect(result.usage.cost.total).toBeCloseTo(
				(model.cost.input + model.cost.output) * multiplier * tokenScale,
				12,
			);
		},
	);

	describe("Amazon Bedrock GPT-6 Astra", () => {
		const bedrockAstra = (): Model<"openai-responses"> => ({
			id: "openai.gpt-6-astra",
			name: "GPT-6 Astra (Bedrock)",
			api: "openai-responses",
			provider: "bedrock-astra",
			baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 11, output: 55, cacheRead: 1.1, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});

		function completedSse(serviceTier: string | undefined, tokens: number): string {
			return `data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					...(serviceTier ? { service_tier: serviceTier } : {}),
					usage: {
						input_tokens: tokens,
						output_tokens: tokens,
						total_tokens: tokens * 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}\n\n`;
		}

		it("sends fast as service_tier ultrafast and bills the served tier at 6x", async () => {
			let capturedPayload: unknown;
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(completedSse("ultrafast", 1_000_000), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);
			const model = bedrockAstra();
			const result = await streamOpenAIResponses(
				model,
				normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
				{
					apiKey: "test-key",
					serviceTier: "fast",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			).result();

			expect(capturedPayload).toMatchObject({ service_tier: "ultrafast" });
			expect(result.speed).toBe("fast");
			expect(result.usage.cost.input).toBeCloseTo(model.cost.input * 6);
			expect(result.usage.cost.output).toBeCloseTo(model.cost.output * 6);
		});

		it("reports standard speed and price when Bedrock serves the default tier", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(completedSse("default", 1_000_000), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);
			const model = bedrockAstra();
			const result = await streamOpenAIResponses(
				model,
				normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
				{ apiKey: "test-key", serviceTier: "fast" },
			).result();

			expect(result.speed).toBe("standard");
			expect(result.usage.cost.input).toBeCloseTo(model.cost.input);
		});

		it("sorts tool schema keys recursively so the cached prefix is stable", async () => {
			let capturedPayload: { tools?: Array<{ parameters?: unknown }> } | undefined;
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
			);
			const stream = streamOpenAIResponses(
				bedrockAstra(),
				normalizeContext({
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
					tools: [
						{
							name: "edit",
							description: "Edit a file",
							parameters: Type.Object({
								path: Type.String({ description: "Path" }),
								edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
							}),
						},
					],
				}),
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload as typeof capturedPayload;
					},
				},
			);
			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			const parameters = capturedPayload?.tools?.[0]?.parameters as Record<string, any>;
			expect(Object.keys(parameters)).toEqual([...Object.keys(parameters)].sort());
			expect(Object.keys(parameters.properties)).toEqual(["edits", "path"]);
			expect(Object.keys(parameters.properties.edits.items.properties)).toEqual(["newText", "oldText"]);
			expect(parameters.required).toEqual(["path", "edits"]);
		});

		it("leaves tool schema key order alone for OpenAI itself", async () => {
			let capturedPayload:
				| { input?: Array<{ type?: string; tools?: Array<{ name?: string; parameters?: unknown }> }> }
				| undefined;
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
			);
			const stream = streamOpenAIResponses(
				getModel("openai", "gpt-5.4"),
				normalizeContext({
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
					tools: [
						{
							name: "edit",
							description: "Edit a file",
							parameters: Type.Object({ path: Type.String(), edits: Type.String() }),
						},
					],
				}),
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload as typeof capturedPayload;
					},
				},
			);
			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}
			// gpt-5.4 declares its tools in additional_tools input items, not top-level `tools`.
			const declared = capturedPayload?.input?.find((item) => item.type === "additional_tools")?.tools?.[0];
			expect(declared?.name).toBe("edit");
			const parameters = declared?.parameters as Record<string, any>;
			expect(Object.keys(parameters.properties)).toEqual(["path", "edits"]);
		});

		it("sends an explicit ultrafast tier verbatim and bills it like Astra's fast tier", async () => {
			let capturedPayload: unknown;
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(completedSse("ultrafast", 1_000_000), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);
			const model = bedrockAstra();
			const result = await streamOpenAIResponses(
				model,
				normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
				{
					apiKey: "test-key",
					serviceTier: "ultrafast",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			).result();

			expect(capturedPayload).toMatchObject({ service_tier: "ultrafast" });
			expect(result.speed).toBe("fast");
			expect(result.usage.cost.input).toBeCloseTo(model.cost.input * 6);
			expect(result.usage.cost.output).toBeCloseTo(model.cost.output * 6);
		});

		it("maps fast to ultrafast and bills GPT-6.1 Sol at 6x like Astra", async () => {
			let capturedPayload: unknown;
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(completedSse("ultrafast", 1_000_000), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);
			const model: Model<"openai-responses"> = {
				...bedrockAstra(),
				id: "openai.gpt-6.1-sol",
				name: "GPT-6.1 Sol (Bedrock)",
				cost: { input: 2.2, output: 11, cacheRead: 0.11, cacheWrite: 0 },
			};
			const result = await streamOpenAIResponses(
				model,
				normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
				{
					apiKey: "test-key",
					serviceTier: "fast",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			).result();

			expect(capturedPayload).toMatchObject({ service_tier: "ultrafast" });
			expect(result.speed).toBe("fast");
			expect(result.usage.cost.input).toBeCloseTo(model.cost.input * 6);
			expect(result.usage.cost.output).toBeCloseTo(model.cost.output * 6);
		});
	});

	describe("Amazon Bedrock GPT-6 Sol (no fast tier)", () => {
		const bedrockSol = (): Model<"openai-responses"> => ({
			id: "openai.gpt-6-sol",
			name: "GPT-6 Sol (Bedrock)",
			api: "openai-responses",
			provider: "bedrock-mantle",
			baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});

		async function run(serviceTier: "fast" | "ultrafast" | "flex" | undefined) {
			let capturedPayload: { service_tier?: string } | undefined;
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
				);
			const result = await streamOpenAIResponses(
				bedrockSol(),
				normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
				{
					apiKey: "test-key",
					serviceTier,
					onPayload: (payload) => {
						capturedPayload = payload as typeof capturedPayload;
					},
				},
			).result();
			return { result, capturedPayload, fetchSpy };
		}

		it("refuses fast locally with an actionable error instead of sending service_tier fast", async () => {
			const { result, capturedPayload, fetchSpy } = await run("fast");
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(capturedPayload).toBeUndefined();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Fast mode is not supported for Amazon Bedrock model openai.gpt-6-sol");
			expect(result.errorMessage).toContain("--service-tier default");
		});

		it("passes an explicit ultrafast through to the provider unchanged", async () => {
			const { capturedPayload, fetchSpy } = await run("ultrafast");
			expect(fetchSpy).toHaveBeenCalled();
			expect(capturedPayload?.service_tier).toBe("ultrafast");
		});

		it("keeps flex and an omitted tier as they were", async () => {
			expect((await run("flex")).capturedPayload?.service_tier).toBe("flex");
			const omitted = await run(undefined);
			expect(omitted.capturedPayload).toBeDefined();
			expect(omitted.capturedPayload && "service_tier" in omitted.capturedPayload).toBe(false);
		});

		it("does not bill an unconfigured model's ultrafast response at an invented multiplier", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					`data: ${JSON.stringify({
						type: "response.completed",
						response: {
							status: "completed",
							service_tier: "ultrafast",
							usage: {
								input_tokens: 1_000_000,
								output_tokens: 1_000_000,
								total_tokens: 2_000_000,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					})}\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
			);
			const model = bedrockSol();
			const result = await streamOpenAIResponses(
				model,
				normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
				{ apiKey: "test-key", serviceTier: "ultrafast" },
			).result();
			expect(result.speed).toBe("fast");
			expect(result.usage.cost.input).toBeCloseTo(model.cost.input);
			expect(result.usage.cost.output).toBeCloseTo(model.cost.output);
		});
	});

	it("still sends fast as-is to OpenAI itself", async () => {
		let capturedPayload: { service_tier?: string } | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		await streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
			{
				apiKey: "test-key",
				serviceTier: "fast",
				onPayload: (payload) => {
					capturedPayload = payload as typeof capturedPayload;
				},
			},
		).result();
		expect(capturedPayload?.service_tier).toBe("fast");
	});
});

describe("openai-responses max_output_tokens compat", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends max_output_tokens by default", async () => {
		let capturedPayload: { max_output_tokens?: number } | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			}),
			{
				apiKey: "sk-test-key",
				maxTokens: 1024,
				onPayload: (payload) => {
					capturedPayload = payload as { max_output_tokens?: number };
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.max_output_tokens).toBe(1024);
	});

	it("omits max_output_tokens when supportsMaxOutputTokens is false", async () => {
		const baseModel = getModel("openai", "gpt-5.4");
		const model: Model<"openai-responses"> = {
			...baseModel,
			compat: { ...baseModel.compat, supportsMaxOutputTokens: false },
		};
		let capturedPayload: { max_output_tokens?: number } | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			}),
			{
				apiKey: "sk-test-key",
				maxTokens: 1024,
				onPayload: (payload) => {
					capturedPayload = payload as { max_output_tokens?: number };
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.max_output_tokens).toBeUndefined();
	});
});
