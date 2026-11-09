import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import {
	DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	getDefaultStreamIdleTimeoutMs,
	guardStreamIdle,
	isStreamIdleTimeoutError,
	MAX_STREAM_IDLE_TIMEOUT_MS,
	resolveStreamIdleTimeoutMs,
	StreamIdleTimeoutError,
	setDefaultStreamIdleTimeoutMs,
	withoutBunTransportTimeout,
	withStreamIdleGuard,
} from "../src/utils/stream-idle-guard.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

async function drain(stream: AssistantMessageEventStream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

afterEach(() => {
	vi.useRealTimers();
	setDefaultStreamIdleTimeoutMs(undefined);
});

describe("resolveStreamIdleTimeoutMs", () => {
	it("uses the process default when the option is undefined", () => {
		expect(resolveStreamIdleTimeoutMs(undefined)).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
	});

	it("prefers the per-call option and treats 0/negative as disabled", () => {
		expect(resolveStreamIdleTimeoutMs(1234)).toBe(1234);
		expect(resolveStreamIdleTimeoutMs(0)).toBe(0);
		expect(resolveStreamIdleTimeoutMs(-5)).toBe(0);
	});

	it("honors setDefaultStreamIdleTimeoutMs, including disable and restore", () => {
		setDefaultStreamIdleTimeoutMs(60_000);
		expect(resolveStreamIdleTimeoutMs(undefined)).toBe(60_000);
		setDefaultStreamIdleTimeoutMs(0);
		expect(resolveStreamIdleTimeoutMs(undefined)).toBe(0);
		setDefaultStreamIdleTimeoutMs(undefined);
		expect(getDefaultStreamIdleTimeoutMs()).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
	});

	it("rejects values that would overflow a Node timer", () => {
		expect(resolveStreamIdleTimeoutMs(MAX_STREAM_IDLE_TIMEOUT_MS)).toBe(MAX_STREAM_IDLE_TIMEOUT_MS);
		expect(() => resolveStreamIdleTimeoutMs(MAX_STREAM_IDLE_TIMEOUT_MS + 1)).toThrow(
			`idleTimeoutMs must be <= ${MAX_STREAM_IDLE_TIMEOUT_MS}`,
		);
		expect(() => setDefaultStreamIdleTimeoutMs(MAX_STREAM_IDLE_TIMEOUT_MS + 1)).toThrow(RangeError);
	});
});

describe("withoutBunTransportTimeout", () => {
	it("disables Bun's hidden 300 s fetch timeout so the guard owns idleness", () => {
		const signal = new AbortController().signal;
		expect(withoutBunTransportTimeout({ method: "POST", signal }, true)).toEqual({
			method: "POST",
			signal,
			timeout: false,
		});
		expect(withoutBunTransportTimeout(undefined, true)).toEqual({ timeout: false });
	});

	it("keeps an explicit caller timeout and leaves Node untouched", () => {
		const explicit = { timeout: 5_000 } as RequestInit;
		expect(withoutBunTransportTimeout(explicit, true)).toBe(explicit);
		const init = { method: "POST" };
		expect(withoutBunTransportTimeout(init, false)).toBe(init);
		expect(withoutBunTransportTimeout(undefined, false)).toBeUndefined();
	});

	it("is applied to the fetch the guard hands to provider adapters", async () => {
		const seen: Array<RequestInit | undefined> = [];
		const source = new AssistantMessageEventStream();
		const guarded = withStreamIdleGuard<SimpleStreamOptions>(
			model,
			{
				idleTimeoutMs: 1000,
				fetch: async (_input, init) => {
					seen.push(init);
					return new Response("ok");
				},
			},
			(options) => {
				void (async () => {
					await options?.fetch?.("https://example.test/stream", { method: "POST" });
					source.end(assistantMessage());
				})();
				return source;
			},
		);
		await guarded.result();
		expect(seen).toHaveLength(1);
		const isBun = typeof process.versions.bun === "string";
		expect((seen[0] as { timeout?: unknown }).timeout).toBe(isBun ? false : undefined);
		expect(seen[0]?.method).toBe("POST");
	});
});

describe("guardStreamIdle", () => {
	it("converts a completely silent stream into a retryable error and aborts the transport", async () => {
		const source = new AssistantMessageEventStream();
		let aborted = false;
		const guarded = guardStreamIdle(source, {
			idleTimeoutMs: 30,
			settleGraceMs: 20,
			abortTransport: () => {
				aborted = true;
			},
		});

		const result = await guarded.result();
		expect(aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("StreamIdleTimeoutError: no data from unknown/unknown for 0.030s");
		expect(isStreamIdleTimeoutError(result.errorMessage)).toBe(true);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("passes a stream that completes before the raw-activity deadline through untouched", async () => {
		const source = new AssistantMessageEventStream();
		let aborted = false;
		const guarded = guardStreamIdle(source, {
			idleTimeoutMs: 100,
			abortTransport: () => {
				aborted = true;
			},
		});

		const partial = assistantMessage({ stopReason: "stop" });
		const pushSlowly = async () => {
			for (let i = 0; i < 5; i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				source.push({ type: "text_delta", contentIndex: 0, delta: `d${i}`, partial });
			}
			source.push({ type: "done", reason: "stop", message: partial });
		};
		void pushSlowly();

		const events = await drain(guarded);
		const result = await guarded.result();
		expect(aborted).toBe(false);
		expect(events.filter((e) => e.type === "text_delta")).toHaveLength(5);
		expect(result.stopReason).toBe("stop");
	});

	it("rewrites an idle-abort terminal into a retryable error", async () => {
		const source = new AssistantMessageEventStream();
		const guarded = guardStreamIdle(source, {
			idleTimeoutMs: 25,
			settleGraceMs: 5000,
			abortTransport: () => {
				// Simulate an adapter observing the abort and reporting stopReason "aborted".
				source.push({
					type: "error",
					reason: "aborted",
					error: assistantMessage({
						stopReason: "aborted",
						content: [],
						providerErrorMessage: "Request was aborted",
					}),
				});
				source.end();
			},
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("error");
		expect(isStreamIdleTimeoutError(result.errorMessage)).toBe(true);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("never rewrites a caller abort", async () => {
		const callerController = new AbortController();
		const source = new AssistantMessageEventStream();
		const guarded = guardStreamIdle(source, {
			idleTimeoutMs: 10_000,
			abortTransport: () => {},
			callerSignal: callerController.signal,
		});

		callerController.abort();
		source.push({
			type: "error",
			reason: "aborted",
			error: assistantMessage({ stopReason: "aborted", content: [] }),
		});
		source.end();

		const result = await guarded.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBeUndefined();
	});

	it("lets a completion that races the idle abort win", async () => {
		const source = new AssistantMessageEventStream();
		const done = assistantMessage({ stopReason: "stop" });
		const guarded = guardStreamIdle(source, {
			idleTimeoutMs: 25,
			settleGraceMs: 5000,
			abortTransport: () => {
				// Bytes arrived exactly as we aborted: the adapter still finished cleanly.
				source.push({ type: "done", reason: "stop", message: done });
				source.end();
			},
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("stop");
	});

	it("synthesizes the terminal event when the source ignores the abort entirely", async () => {
		const source = new AssistantMessageEventStream(); // never settles, even after abort
		const guarded = guardStreamIdle(source, {
			idleTimeoutMs: 20,
			settleGraceMs: 20,
			abortTransport: () => {},
			model: { ...model, provider: "gateway", id: "example-medium" },
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("error");
		expect(result.model).toBe("example-medium");
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("preserves partial-message context on synthesized errors", async () => {
		const source = new AssistantMessageEventStream();
		const partial = assistantMessage({ stopReason: "pending" as AssistantMessage["stopReason"] });
		const guarded = guardStreamIdle(source, {
			idleTimeoutMs: 40,
			settleGraceMs: 20,
			abortTransport: () => {},
		});
		source.push({ type: "text_delta", contentIndex: 0, delta: "partial text", partial });

		const result = await guarded.result();
		expect(result.stopReason).toBe("error");
		expect(result.model).toBe("gpt-test");
		expect(result.content).toEqual(partial.content);
	});

	it("resets on raw SSE ping bytes even when no parsed event is emitted", async () => {
		const source = new AssistantMessageEventStream();
		const startedAt = Date.now();
		const fakeFetch: typeof fetch = async (_input, init) => {
			let interval: ReturnType<typeof setInterval> | undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller): void {
					let count = 0;
					interval = setInterval(() => {
						controller.enqueue(new TextEncoder().encode(": ping\n\n"));
						count++;
						if (count === 3 && interval) {
							clearInterval(interval);
							interval = undefined;
						}
					}, 20);
					init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
				},
				cancel(): void {
					if (interval) clearInterval(interval);
				},
			});
			return new Response(body);
		};

		const guarded = withStreamIdleGuard<SimpleStreamOptions>(
			model,
			{ idleTimeoutMs: 35, fetch: fakeFetch },
			(options) => {
				void (async () => {
					const response = await options?.fetch?.("https://example.test/stream", {
						signal: options.signal,
					});
					if (!response?.body) return;
					for await (const _chunk of response.body) {
						// The SSE parser discards comments, so no assistant event is emitted.
					}
				})();
				return source;
			},
		);

		const result = await guarded.result();
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(85);
		expect(result.errorMessage).toBe("StreamIdleTimeoutError: no data from openai/gpt-test for 0.035s");
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("does not lock non-stream response bodies before an SDK reads them", async () => {
		const source = new AssistantMessageEventStream();
		let responseText: string | undefined;
		const guarded = withStreamIdleGuard<SimpleStreamOptions>(
			model,
			{ idleTimeoutMs: 1000, fetch: async () => new Response("provider error", { status: 400 }) },
			(options) => {
				void (async () => {
					const response = await options?.fetch?.("https://example.test/stream");
					responseText = await response?.text();
					source.end(assistantMessage());
				})();
				return source;
			},
		);

		expect((await guarded.result()).stopReason).toBe("stop");
		expect(responseText).toBe("provider error");
	});

	it("preserves guard activity through the simple-stream adapter boundary", () => {
		const onStreamActivity = vi.fn();
		const options = buildBaseOptions(model, normalizeContext({ messages: [] }), {
			idleTimeoutMs: 1234,
			onStreamActivity,
		});

		expect(options.idleTimeoutMs).toBe(1234);
		options.onStreamActivity?.();
		expect(onStreamActivity).toHaveBeenCalledOnce();
	});

	it("does not arm a watchdog when idleTimeoutMs is zero", async () => {
		const source = new AssistantMessageEventStream();
		const guarded = withStreamIdleGuard(model, { idleTimeoutMs: 0 }, () => source);
		setTimeout(() => source.end(assistantMessage()), 50);

		const result = await guarded.result();
		expect(result.stopReason).toBe("stop");
	});

	it("does not arm for SDK-only APIs without a raw transport hook", async () => {
		vi.useFakeTimers();
		for (const api of ["google-generative-ai", "google-vertex", "bedrock-converse-stream"] as const) {
			const sdkModel: Model<Api> = { ...model, api, provider: api };
			const options = { idleTimeoutMs: 10 };
			let receivedOptions: typeof options | undefined;
			const guarded = withStreamIdleGuard(sdkModel, options, (received) => {
				receivedOptions = received;
				const source = new AssistantMessageEventStream();
				source.end(assistantMessage({ api, provider: api }));
				return source;
			});

			expect((await guarded.result()).stopReason).toBe("stop");
			expect(receivedOptions).toBe(options);
			expect(vi.getTimerCount()).toBe(0);
		}
	});

	it("clears the watchdog after normal completion, provider error, and caller abort", async () => {
		vi.useFakeTimers();
		for (const outcome of ["done", "error", "abort"] as const) {
			const source = new AssistantMessageEventStream();
			const caller = new AbortController();
			const guarded = guardStreamIdle(source, {
				idleTimeoutMs: 1000,
				abortTransport: () => {},
				callerSignal: caller.signal,
			});
			expect(vi.getTimerCount()).toBe(1);
			if (outcome === "done") {
				source.end(assistantMessage());
			} else {
				if (outcome === "abort") caller.abort();
				source.push({
					type: "error",
					reason: outcome === "abort" ? "aborted" : "error",
					error: assistantMessage({ stopReason: outcome === "abort" ? "aborted" : "error" }),
				});
				source.end();
			}
			await guarded.result();
			expect(vi.getTimerCount()).toBe(0);
		}
	});

	it("aborts the transport, cancels its reader, and clears timers on timeout", async () => {
		vi.useFakeTimers();
		const source = new AssistantMessageEventStream();
		const cancel = vi.fn();
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					cancel,
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		let transportSignal: AbortSignal | undefined;
		const guarded = withStreamIdleGuard<SimpleStreamOptions>(model, { idleTimeoutMs: 25, fetch }, (options) => {
			transportSignal = options?.signal;
			transportSignal?.addEventListener(
				"abort",
				() => {
					source.push({
						type: "error",
						reason: "aborted",
						error: assistantMessage({ stopReason: "aborted" }),
					});
					source.end();
				},
				{ once: true },
			);
			void options
				?.fetch?.("https://example.test/stream", { signal: transportSignal })
				.then((response) => response.body?.getReader().read());
			return source;
		});

		await vi.advanceTimersByTimeAsync(25);
		const result = await guarded.result();
		expect(result.stopReason).toBe("error");
		expect(transportSignal?.aborted).toBe(true);
		expect(cancel).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("recognizes the typed timeout directly", () => {
		expect(isStreamIdleTimeoutError(new StreamIdleTimeoutError("anthropic", "claude-opus-5", 420_000))).toBe(true);
	});
});
