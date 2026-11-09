import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Api, Model, StreamOptions } from "../src/types.ts";
import { isStreamIdleTimeoutError, withStreamIdleGuard } from "../src/utils/stream-idle-guard.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [] });

function keepaliveThenStallFetch(chunk: string): {
	fetch: typeof globalThis.fetch;
	cancel: ReturnType<typeof vi.fn>;
} {
	const cancel = vi.fn();
	const fetch: typeof globalThis.fetch = async () => {
		let interval: ReturnType<typeof setInterval> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller): void {
				let count = 0;
				const emit = (): void => {
					controller.enqueue(new TextEncoder().encode(chunk));
					count++;
					if (count === 5 && interval) {
						clearInterval(interval);
						interval = undefined;
					}
				};
				emit();
				interval = setInterval(emit, 20);
			},
			cancel(): void {
				if (interval) clearInterval(interval);
				cancel();
			},
		});
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { fetch, cancel };
}

async function expectKeepalivesThenStallToTimeout<TApi extends Api>(
	model: Model<TApi>,
	options: StreamOptions,
	produce: (options: StreamOptions | undefined) => ReturnType<typeof streamAnthropic>,
	cancel: ReturnType<typeof vi.fn>,
): Promise<void> {
	const startedAt = Date.now();
	const result = await withStreamIdleGuard(model, options, produce).result();

	// Five frames span 80 ms, longer than the 45 ms watchdog. Only the stall
	// after the final frame may abort the stream.
	expect(Date.now() - startedAt).toBeGreaterThanOrEqual(115);
	expect(result.stopReason).toBe("error");
	expect(isStreamIdleTimeoutError(result.errorMessage)).toBe(true);
	expect(cancel).toHaveBeenCalledOnce();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("adapter raw keepalive visibility", () => {
	it("keeps Anthropic event: ping frames alive, then aborts a real stall", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
		const { fetch, cancel } = keepaliveThenStallFetch('event: ping\ndata: {"type":"ping"}\n\n');
		const options = { apiKey: "test", fetch, idleTimeoutMs: 45 };

		await expectKeepalivesThenStallToTimeout(
			model,
			options,
			(guardedOptions) => streamAnthropic(model, context, guardedOptions),
			cancel,
		);
	});

	it("keeps OpenAI SSE comment pings alive, then aborts a real stall", async () => {
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
		const { fetch, cancel } = keepaliveThenStallFetch(": ping\n\n");
		const options = { apiKey: "test", fetch, idleTimeoutMs: 45 };

		await expectKeepalivesThenStallToTimeout(
			model,
			options,
			(guardedOptions) => streamOpenAICompletions(model, context, guardedOptions),
			cancel,
		);
	});
});
