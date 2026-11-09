import type {
	Response,
	ResponseErrorEvent,
	ResponseFailedEvent,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OpenAIResponsesOptions, stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type MockAttempt = {
	events?: readonly ResponseStreamEvent[];
	headers?: Record<string, string>;
	error?: Error;
	iteratorError?: Error;
	onRequest?: () => void;
	onIteratorFinally?: () => void;
	onIteratorReturn?: () => void;
};

const mockState = vi.hoisted(() => ({
	attempts: [] as MockAttempt[],
	calls: 0,
}));

vi.mock("openai", () => {
	function iterate(attempt: MockAttempt): AsyncIterable<ResponseStreamEvent> {
		const source = (async function* () {
			try {
				for (const event of attempt.events ?? []) yield event;
				if (attempt.iteratorError) throw attempt.iteratorError;
			} finally {
				attempt.onIteratorFinally?.();
			}
		})();
		const sourceIterator = source[Symbol.asyncIterator]();
		const iterator: AsyncIterator<ResponseStreamEvent> & AsyncIterable<ResponseStreamEvent> = {
			next: () => sourceIterator.next(),
			return: async () => {
				attempt.onIteratorReturn?.();
				return (await sourceIterator.return?.()) ?? { done: true, value: undefined };
			},
			[Symbol.asyncIterator]() {
				return iterator;
			},
		};
		return iterator;
	}

	class FakeOpenAI {
		responses = {
			create: () => {
				const promise = Promise.resolve(undefined) as Promise<undefined> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => {
					const attempt = mockState.attempts[mockState.calls++];
					if (!attempt) throw new Error("unexpected mock request");
					attempt.onRequest?.();
					if (attempt.error) throw attempt.error;
					return {
						data: iterate(attempt),
						response: { status: 200, headers: new Headers(attempt.headers) },
					};
				};
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

const gatewayModel: Model<"openai-responses"> = {
	...model,
	provider: "gateway",
	baseUrl: "https://llm.example.com/v1",
};

function responseData(id: string, status: Response["status"], error: Response["error"] = null): Response {
	return {
		id,
		created_at: 0,
		output_text: "",
		error,
		incomplete_details: null,
		instructions: null,
		metadata: null,
		model: "test-model",
		object: "response",
		output: [],
		parallel_tool_calls: true,
		temperature: null,
		tool_choice: "auto",
		tools: [],
		top_p: 1,
		status,
	};
}

function responseCreated(id: string): ResponseStreamEvent {
	return {
		type: "response.created",
		sequence_number: 0,
		response: responseData(id, "in_progress"),
	};
}

function streamError(code: string): ResponseStreamEvent {
	const event = {
		type: "error",
		sequence_number: 1,
		code,
		message: `gateway failed with ${code}`,
		param: null,
	} satisfies ResponseErrorEvent;
	return event;
}

function responseFailed(code: "server_error"): ResponseStreamEvent {
	const event = {
		type: "response.failed",
		sequence_number: 1,
		response: responseData("failed-response", "failed", { code, message: "gateway failed" }),
	} satisfies ResponseFailedEvent;
	return event;
}

function completed(id: string): ResponseStreamEvent {
	return {
		type: "response.completed",
		sequence_number: 2,
		response: responseData(id, "completed"),
	};
}

function semanticMessage(): ResponseStreamEvent[] {
	return [
		{
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: {
				type: "message",
				id: "msg-1",
				role: "assistant",
				status: "in_progress",
				content: [],
			},
		} as ResponseStreamEvent,
		{
			type: "response.output_text.delta",
			sequence_number: 2,
			output_index: 0,
			content_index: 0,
			item_id: "msg-1",
			delta: "partial",
		} as ResponseStreamEvent,
	];
}

async function consume(
	options?: Pick<OpenAIResponsesOptions, "signal" | "maxRetries" | "onPayload" | "onResponse">,
	requestModel: Model<"openai-responses"> = model,
) {
	const stream = streamOpenAIResponses(requestModel, context, {
		apiKey: "test",
		maxRetryDelayMs: 100,
		...options,
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

function setAttempts(...attempts: MockAttempt[]) {
	mockState.attempts = attempts;
	mockState.calls = 0;
}

function failedAttempt(code: string, id = "failed") {
	return {
		events: [responseCreated(id), streamError(code)],
		headers: { "retry-after-ms": "0" },
	};
}

function failedResponseAttempt() {
	return {
		events: [responseFailed("server_error")],
		headers: { "retry-after-ms": "0" },
	};
}

function successfulAttempt(id = "success") {
	return { events: [responseCreated(id), ...semanticMessage(), completed(id)] };
}

describe("OpenAI Responses streaming retries", () => {
	beforeEach(() => setAttempts());
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries once after response.created when no semantic output was emitted", async () => {
		setAttempts(failedAttempt(" 502 ", "failed-response"), successfulAttempt("retried-response"));

		const { events, result } = await consume();

		expect(mockState.calls).toBe(2);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(result.responseId).toBe("retried-response");
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(result.stopReason).toBe("stop");
	});

	it.each([
		["server_error response event", "server_error"],
		["internal_error response event", "internal_error"],
		["api_error response event", "api_error"],
	] as const)("retries transient %s response errors", async (_name, code) => {
		setAttempts(
			{ events: [responseCreated("failed-response"), streamError(code)] },
			successfulAttempt("retried-response"),
		);

		const { result } = await consume();

		expect(mockState.calls).toBe(2);
		expect(result.responseId).toBe("retried-response");
		expect(result.stopReason).toBe("stop");
	});

	it.each([
		["before response.created", [streamError("502")]],
		["after semantic output", [...semanticMessage(), streamError("502")]],
		["for a 4xx", [responseCreated("failed-response"), streamError("400")]],
		["for rate limit", [responseCreated("failed-response"), streamError("429")]],
		["for a validation code", [responseCreated("failed-response"), streamError("invalid_prompt")]],
		["for a non-transient code", [responseCreated("failed-response"), streamError("600")]],
	] as const)("does not retry %s", async (_name, events) => {
		setAttempts({ events, headers: { "retry-after-ms": "0" } }, successfulAttempt());

		const { result } = await consume();

		expect(mockState.calls).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("retries a server_error response.failed event", async () => {
		setAttempts(failedResponseAttempt(), successfulAttempt("retried-response"));

		const { result } = await consume();

		expect(mockState.calls).toBe(2);
		expect(result.responseId).toBe("retried-response");
		expect(result.stopReason).toBe("stop");
	});

	it("retries after response.created when the stream ends at EOF", async () => {
		setAttempts({ events: [responseCreated("early-eof")] }, successfulAttempt("retried-response"));

		const { result } = await consume();

		expect(mockState.calls).toBe(2);
		expect(result.responseId).toBe("retried-response");
		expect(result.stopReason).toBe("stop");
	});

	it("retries a completely empty stream once", async () => {
		setAttempts({ events: [] }, successfulAttempt("retried-response"));

		const { result } = await consume();

		expect(mockState.calls).toBe(2);
		expect(result.responseId).toBe("retried-response");
		expect(result.stopReason).toBe("stop");
	});

	it("does not retry an empty completed response when the iterator disconnects after the terminal event", async () => {
		const cause = Object.assign(new Error("socket failure"), { code: "UND_ERR_SOCKET" });
		const terminated = new TypeError("terminated", { cause });
		setAttempts(
			{ events: [completed("completed-response")], iteratorError: terminated },
			successfulAttempt("unexpected-retry"),
		);

		const { result } = await consume();

		expect(mockState.calls).toBe(1);
		expect(result.responseId).toBe("completed-response");
		expect(result.content).toEqual([]);
		expect(result.stopReason).toBe("stop");
	});

	it("retries a nested undici transport failure from the first next before response.created", async () => {
		const cause = Object.assign(new Error("socket failure"), { code: "UND_ERR_SOCKET" });
		const terminated = new TypeError("terminated", { cause });
		setAttempts({ iteratorError: terminated }, successfulAttempt("retried-response"));

		const { result } = await consume();

		expect(mockState.calls).toBe(2);
		expect(result.responseId).toBe("retried-response");
		expect(result.stopReason).toBe("stop");
	});

	it("exhausts the single retry for a nested undici transport failure before response.created", async () => {
		const firstCause = Object.assign(new Error("first socket failure"), { code: "UND_ERR_SOCKET" });
		const secondCause = Object.assign(new Error("second socket failure"), { code: "UND_ERR_SOCKET" });
		setAttempts(
			{ iteratorError: new TypeError("first terminated", { cause: firstCause }) },
			{ iteratorError: new TypeError("second terminated", { cause: secondCause }) },
		);

		const { result } = await consume();

		expect(mockState.calls).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("second terminated");
	});

	it.each(["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])(
		"retries a real nested undici transport failure: %s",
		async (code) => {
			const cause = Object.assign(new Error("socket failure"), { code });
			const terminated = new TypeError("terminated", { cause });
			const observations: string[] = [];
			setAttempts(
				{
					events: [responseCreated("transport-failure")],
					iteratorError: terminated,
					onIteratorReturn: () => observations.push("iterator.return"),
					onIteratorFinally: () => observations.push("generator finally"),
				},
				{ ...successfulAttempt("retried-response"), onRequest: () => observations.push("retry request") },
			);

			const { result } = await consume();

			expect(observations).toContain("iterator.return");
			expect(observations).toContain("generator finally");
			expect(observations.indexOf("iterator.return")).toBeLessThan(observations.indexOf("retry request"));
			expect(mockState.calls).toBe(2);
			expect(result.responseId).toBe("retried-response");
			expect(result.stopReason).toBe("stop");
		},
	);

	it("closes a failed iterator before beginning the stream retry", async () => {
		const observations: string[] = [];
		setAttempts(
			{
				events: [responseCreated("event-failure"), streamError("502")],
				headers: { "x-litellm-call-id": "call-1" },
				onIteratorReturn: () => observations.push("iterator.return"),
				onIteratorFinally: () => observations.push("generator finally"),
			},
			{ ...successfulAttempt("retried-response"), onRequest: () => observations.push("retry request") },
		);

		const { result } = await consume();

		expect(observations).toEqual(["iterator.return", "generator finally", "retry request"]);
		expect(mockState.calls).toBe(2);
		expect(result.stopReason).toBe("stop");
	});

	it("does not retry or relabel an iterator parser error", async () => {
		setAttempts(
			{
				events: [responseCreated("parser-failure")],
				iteratorError: new SyntaxError("invalid JSON"),
				headers: { "x-litellm-call-id": "parser-call" },
			},
			successfulAttempt(),
		);

		const { result } = await consume(undefined, gatewayModel);

		expect(mockState.calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("invalid JSON");
		expect(result.errorMessage).not.toContain("upstream");
		expect(result.errorMessage).not.toContain("retry");
	});

	it("does not retry or relabel an onResponse callback error", async () => {
		setAttempts({ events: [responseCreated("callback-failure")] }, successfulAttempt());
		const callbackError = Object.assign(new Error("callback failed"), { status: 503 });

		const { result } = await consume(
			{
				onResponse: () => {
					throw callbackError;
				},
			},
			gatewayModel,
		);

		expect(mockState.calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("gateway API error (503): callback failed");
		expect(result.errorMessage).not.toContain("upstream");
		expect(result.errorMessage).not.toContain("retry");
	});

	it("does not retry or relabel an onPayload programming error", async () => {
		setAttempts(successfulAttempt());
		const { result } = await consume(
			{
				onPayload: () => {
					throw new Error("payload callback failed");
				},
			},
			gatewayModel,
		);

		expect(mockState.calls).toBe(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("payload callback failed");
		expect(result.errorMessage).not.toContain("upstream");
		expect(result.errorMessage).not.toContain("retry");
	});

	it("keeps actionable raw details for an gateway gateway 4xx", async () => {
		const gatewayError = Object.assign(new Error("403 status code (no body)"), {
			status: 403,
			error: { error: "blocked by gateway policy" },
			headers: new Headers({ "x-litellm-call-id": "call-4xx" }),
		});
		setAttempts({ error: gatewayError });

		const { result } = await consume(undefined, gatewayModel);

		expect(mockState.calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("gateway API error (403)");
		expect(result.errorMessage).toContain("blocked by gateway policy");
		expect(result.errorMessage).not.toContain("retry the request or choose another model");
	});

	it("does not retry an aborted request", async () => {
		const controller = new AbortController();
		controller.abort();
		setAttempts(failedAttempt("502"), successfulAttempt());

		const { result } = await consume({ signal: controller.signal });

		expect(mockState.calls).toBe(1);
		expect(result.stopReason).toBe("aborted");
	});

	it("preserves configured pre-HTTP retries without multiplying them with the stream retry", async () => {
		setAttempts(
			{
				error: Object.assign(new Error("pre-http"), {
					status: 503,
					headers: new Headers({ "retry-after-ms": "0" }),
				}),
			},
			failedAttempt("502"),
			successfulAttempt(),
		);

		const { result } = await consume({ maxRetries: 1 });

		expect(mockState.calls).toBe(3);
		expect(result.stopReason).toBe("stop");
	});

	it("keeps the final structured provider error after the one retry is exhausted", async () => {
		setAttempts(failedAttempt("502", "first-response"), failedAttempt("503", "second-response"));

		const { events, result } = await consume();

		expect(mockState.calls).toBe(2);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.responseId).toBe("second-response");
		expect(result.providerErrorMessage).toContain("503");
		expect(result.errorMessage).toContain("OpenAI API error");
	});
});
