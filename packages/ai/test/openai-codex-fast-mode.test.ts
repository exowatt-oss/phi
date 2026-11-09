import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/api/openai-codex-responses.ts";
import type { Model, ServiceTier } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const tokenPayload = Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
).toString("base64");
const apiKey = `header.${tokenPayload}.signature`;
const context = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] });

function model(id = "gpt-6.1-sol"): Model<"openai-codex-responses"> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 4096,
	};
}

function completion(serviceTier?: string): Record<string, unknown> {
	return {
		type: "response.completed",
		response: {
			id: "resp_test",
			status: "completed",
			output: [],
			...(serviceTier ? { service_tier: serviceTier } : {}),
			usage: {
				input_tokens: 1000,
				output_tokens: 500,
				total_tokens: 1500,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
}

function captureFetch(responseTier?: string, error?: string) {
	const payloads: Record<string, unknown>[] = [];
	const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const body = init?.body;
		const json =
			typeof body === "string" ? body : Buffer.from(zstdDecompressSync(body as Uint8Array)).toString("utf8");
		payloads.push(JSON.parse(json) as Record<string, unknown>);
		return error
			? new Response(JSON.stringify({ error: { message: error } }), { status: 400 })
			: new Response(`data: ${JSON.stringify(completion(responseTier))}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
	});
	return { fetch, payloads };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Codex Fast mode", () => {
	it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"])("forwards the simple Fast option for %s", async (id) => {
		const { fetch, payloads } = captureFetch("fast");
		const result = await streamSimple(model(id), context, {
			apiKey,
			transport: "sse",
			fetch,
			serviceTier: "fast",
		}).result();
		expect(payloads[0].service_tier).toBe("priority");
		expect(result.stopReason).toBe("stop");
		expect(result.speed).toBe("fast");
		expect(result.usage.cost.total).toBeCloseTo(0.004);
	});
	it.each(["fast", "priority", undefined])(
		"bills Fast correctly when the response tier is %s",
		async (responseTier) => {
			const { fetch } = captureFetch(responseTier);
			const result = await streamSimple(model(), context, {
				apiKey,
				transport: "sse",
				fetch,
				serviceTier: "fast",
			}).result();
			expect(result.speed).toBe("fast");
			expect(result.usage.cost.total).toBeCloseTo(0.004);
		},
	);
	it("keeps the paid-credit Fast rate when GPT-5.5 reports the priority wire tier", async () => {
		const { fetch } = captureFetch("priority");
		const result = await streamSimple(model("gpt-5.5"), context, {
			apiKey,
			transport: "sse",
			fetch,
			serviceTier: "fast",
		}).result();
		expect(result.speed).toBe("fast");
		expect(result.usage.cost.total).toBeCloseTo(0.004);
	});
	it("honors a provider downgrade to standard speed and price", async () => {
		const { fetch, payloads } = captureFetch("default");
		const result = await streamSimple(model(), context, {
			apiKey,
			transport: "sse",
			fetch,
			serviceTier: "fast",
		}).result();
		expect(result.speed).toBe("standard");
		expect(result.usage.cost.total).toBeCloseTo(0.002);
		expect(payloads[0].service_tier).toBe("priority");
	});
	it.each(["default", "flex", undefined] satisfies (ServiceTier | undefined)[])(
		"preserves simple %s requests",
		async (tier) => {
			const { fetch, payloads } = captureFetch(tier);
			await streamSimple(model(), context, { apiKey, transport: "sse", fetch, serviceTier: tier }).result();
			expect(payloads[0].service_tier).toBe(tier);
		},
	);
	it("keeps an unsupported tier refusal actionable without retrying at a different tier", async () => {
		const { fetch } = captureFetch(undefined, "Fast mode is not available for your account");
		const result = await streamSimple(model(), context, {
			apiKey,
			transport: "sse",
			fetch,
			serviceTier: "fast",
		}).result();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Fast mode is not available for your account");
	});
	it("forwards Fast through WebSocket response.create", async () => {
		const sent: Record<string, unknown>[] = [];
		class Socket {
			listeners = new Map<string, Set<(event: unknown) => void>>();
			constructor() {
				queueMicrotask(() => this.emit("open", {}));
			}
			addEventListener(type: string, listener: (event: unknown) => void) {
				const listeners = this.listeners.get(type) ?? new Set();
				listeners.add(listener);
				this.listeners.set(type, listeners);
			}
			removeEventListener(type: string, listener: (event: unknown) => void) {
				this.listeners.get(type)?.delete(listener);
			}
			emit(type: string, event: unknown) {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
			send(json: string) {
				sent.push(JSON.parse(json) as Record<string, unknown>);
				queueMicrotask(() => this.emit("message", { data: JSON.stringify(completion("fast")) }));
			}
			close() {}
		}
		vi.stubGlobal("WebSocket", Socket);
		const result = await streamSimple(model(), context, {
			apiKey,
			transport: "websocket",
			serviceTier: "fast",
		}).result();
		expect(sent[0]).toMatchObject({ type: "response.create", service_tier: "priority" });
		expect(result.stopReason).toBe("stop");
		expect(result.speed).toBe("fast");
		expect(result.usage.cost.total).toBeCloseTo(0.004);
	});
});
