import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import {
	getRefusalDetails,
	isProviderUnavailableAssistantError,
	isRefusalAssistantError,
	isRetryableAssistantError,
	type RetryPolicy,
	retryAssistantCall,
	retryDelayMs,
} from "../src/utils/retry.ts";

/**
 * Auth-layer failures from a revoked or rotated-away Anthropic OAuth refresh
 * token, in the shapes phi actually surfaces them (the raw provider body, and
 * the `ModelsError` wrapper thrown before any request is sent).
 */
const deadOAuthMessages = [
	'OAuth refresh failed for anthropic: Anthropic token refresh request failed. body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
	'{"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
	"OAuth auth derivation failed for anthropic",
	"OAuth refresh returned a token that expires too soon for anthropic",
];

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';
const nvidiaNIMResourceExhaustedMessage = "ResourceExhausted: Worker local total request limit reached (288/48)";
const bunFetchSocketClosedMessage =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const openAIResponsesEarlyEofMessage = "OpenAI Responses stream ended before a terminal response event";
const wrappedDnsLookupError =
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";
const aiohttpTruncatedTransferMessages = [
	"Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>",
	"aiohttp.client_exceptions.ClientPayloadError: Response payload is not completed",
	"TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'",
	'Response payload is not completed: <TransferEncodingError: 400, message="Not enough data to satisfy transfer length header.">',
];
const azurePeakLoadError =
	"The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.";

describe("provider retry classification", () => {
	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: nvidiaNIMResourceExhaustedMessage }),
			),
		).toBe(true);
	});

	it("matches Bun fetch socket drop wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bunFetchSocketClosedMessage }),
			),
		).toBe(true);
	});

	it("matches upstream request buffer exhaustion wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
			),
		).toBe(true);
	});

	it.each([
		wrappedDnsLookupError,
		"connect ENOTFOUND api.example.com",
		"EAI_AGAIN api.example.com",
		"getaddrinfo failed for api.example.com",
	])("matches DNS transport failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each(aiohttpTruncatedTransferMessages)("matches aiohttp truncated-transfer wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each(["400 Bad Request", "HTTP 400"])("does not retry a bare 400 response: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});
	it.each(["The pending stream has been canceled", "The pending stream has been canceled (caused by: socket closed)"])(
		"matches HTTP/2 pending stream cancellation: %s",
		(errorMessage) => {
			// Regression for #10379.
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
		},
	);

	it.each([
		// Regression for #10965 (provider unknown, no status code in the message).
		"The service is temporarily unavailable. Please retry later.",
		// Bedrock ServiceUnavailableException as formatted by formatBedrockError.
		"Service unavailable: The service is temporarily unavailable.",
	])("matches service unavailable wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		// Regression for #10996: node-fetch errors from the google-vertex OAuth token refresh.
		"request to https://oauth2.googleapis.com/token failed, reason:",
		"request to https://oauth2.googleapis.com/token failed, reason: connect ECONNREFUSED 127.0.0.1:9",
	])("matches node-fetch request failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		// Regression for #10920: gateway upstream failures sent as `response.failed` error codes.
		"unknown: Unable to forward upstream stream",
		"upstream_error: Upstream request failed",
		"upstream_stream_read_error: Upstream response stream was interrupted",
		"Upstream HTTP/2 stream failed",
	])("matches gateway upstream failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("matches OpenAI Responses streams that end before terminal events", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIResponsesEarlyEofMessage }),
			),
		).toBe(true);
	});

	it("matches Azure peak-load capacity errors", () => {
		// Regression for #9669.
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: azurePeakLoadError })),
		).toBe(true);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
			),
		).toBe(false);
	});

	it("keeps dead-credential errors out of the same-model retry budget", () => {
		// Re-asking the same provider with the same revoked refresh token just spends
		// the budget on a guaranteed identical failure.
		for (const errorMessage of deadOAuthMessages) {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
		}
	});

	it("uses auth-required structure before retry or provider-fallback text", () => {
		const message = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "timeout 503 overloaded" }),
			authRequired: {
				provider: "custom-timeout-provider",
				reason: "invalid_grant" as const,
				loginCommand: "phi" as const,
				interactiveCommand: "/login custom-timeout-provider",
				credentialInvalidated: true,
			},
		};

		expect(isRetryableAssistantError(message)).toBe(false);
		expect(isProviderUnavailableAssistantError(message)).toBe(false);
	});

	it("keeps the ChatGPT subscription usage limit non-retryable", () => {
		const errorMessage =
			'OpenAI API error (429): {"code":"subscription_sharing_usage_limit_exceeded","message":"Usage limit reached."}';
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it("keeps the ChatGPT Business workspace usage limit non-retryable", () => {
		const errorMessage =
			'OpenAI API error (429): {"code":"subscription_sharing_workplace_individual_usage_limit_exceeded","message":"Usage limit reached."}';
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each([
		"subscription_sharing_usage_unavailable: Usage cannot be checked.",
		"subscription_sharing_user_unavailable: User cannot be loaded.",
	])("retries temporary ChatGPT subscription errors: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("classifies assistant error messages", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		// Regression for #9627.
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "520 status code (no body)" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
			),
		).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});

	it.each([
		// Regression for #11057: status codes inside ids or other numbers are not status codes.
		'401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CU503xyz"}',
		"400 image exceeds 5 MB maximum: 5316784 bytes > 5242880 bytes",
	])("does not match status codes inside ids or longer numbers: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});
});

describe("provider-unavailable classification", () => {
	it("treats dead credentials as unavailable so the ladder reroutes", () => {
		// The 2026-09-01 cascade: a Bedrock blip rerouted onto an Anthropic-direct
		// rung whose refresh token was revoked. Unless this classifies as
		// "unavailable", the reroute ladder never advances past the dead rung.
		for (const errorMessage of deadOAuthMessages) {
			expect(
				isProviderUnavailableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage })),
			).toBe(true);
		}
	});

	it("does not treat a bare authorization failure as a dead credential", () => {
		// A single 401/403 can be a transient upstream auth hiccup; rewriting the
		// session's model on that would be an overreaction.
		for (const errorMessage of ["401 Unauthorized", "403 Forbidden", "invalid api key"]) {
			expect(
				isProviderUnavailableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage })),
			).toBe(false);
		}
	});

	it("still treats capacity throttling as the retry budget's job", () => {
		expect(
			isProviderUnavailableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			),
		).toBe(false);
	});
});

describe("refusal classification", () => {
	it("detects a structural refusal regardless of the error text", () => {
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "something bland",
			refusal: { category: "cyber", explanation: "Declined." },
		});
		expect(isRefusalAssistantError(message)).toBe(true);
		expect(getRefusalDetails(message)).toEqual({ category: "cyber", explanation: "Declined." });
	});

	it.each([
		"The model's safety classifier declined this request (category: cyber): nope.",
		"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.",
		"litellm.BadRequestError: response was blocked by content filter",
		"finish_reason: content_filter",
		"The response was filtered due to the prompt triggering Azure OpenAI's content management policy",
		"Bedrock: request blocked by the guardrail policy",
	])("detects a proxied refusal from error text alone: %s", (errorMessage) => {
		expect(isRefusalAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each(["overloaded_error", "524 status code (no body)", "insufficient_quota", "fetch failed"])(
		"does not mistake an ordinary failure for a refusal: %s",
		(errorMessage) => {
			expect(isRefusalAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
		},
	);

	it("keeps refusals out of the same-model retry budget", () => {
		// Text that would otherwise look retryable ('server error') must not win over
		// the refusal: retrying a policy decline on the same model declines again.
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "server error: response was blocked by content filter",
		});
		expect(isRefusalAssistantError(message)).toBe(true);
		expect(isRetryableAssistantError(message)).toBe(false);
	});

	it("synthesizes details for a text-only refusal and returns none for non-refusals", () => {
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "blocked by content filter",
		});
		expect(getRefusalDetails(message)).toEqual({ category: null, explanation: "blocked by content filter" });
		expect(getRefusalDetails(fauxAssistantMessage("fine"))).toBeUndefined();
	});
});

describe("retryDelayMs", () => {
	it("caps agent retry delay", () => {
		// Regression for #8826.
		expect(retryDelayMs({ baseDelayMs: 2000 }, 6)).toBe(60000);
		expect(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 5000 }, 5)).toBe(5000);
		expect(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 0 }, 5)).toBe(0);
	});
});

describe("retryAssistantCall", () => {
	const disabled: RetryPolicy = { enabled: false, maxRetries: 3, baseDelayMs: 0 };
	const enabled: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 0 };

	it("returns a successful response immediately without retrying", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("ok"));
		const res = await retryAssistantCall(produce, enabled, undefined);
		expect(res.content).toEqual([{ type: "text", text: "ok" }]);
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it("does not retry an aborted message", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "aborted" }));
		const onRetryScheduled = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
	});

	it("does not retry a non-retryable error (quota/billing)", async () => {
		const produce = vi.fn(async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
		);
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("retries a transient error up to maxRetries then returns the final error", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
		expect(onRetryScheduled).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 3, "terminated");
	});

	it("reports capped retry delays", async () => {
		// Regression for #8826.
		let n = 0;
		const policy: RetryPolicy = { enabled: true, maxRetries: 4, baseDelayMs: 10, maxAgentDelayMs: 15 };
		const produce = vi.fn(async () => {
			n++;
			return n < 5
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn();

		await retryAssistantCall(produce, policy, undefined, { onRetryScheduled });

		expect(onRetryScheduled.mock.calls.map((call) => call[2])).toEqual([10, 15, 15, 15]);
	});

	it("stops retrying once a call succeeds", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(produce).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(true, 2);
	});

	it("reports an aborted retried call as unsuccessful", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("", { stopReason: "aborted" });
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(2);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1);
	});

	it("does not retry when policy is disabled", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, disabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("emits onRetryAttemptStart after backoff before each retried call", async () => {
		const events: string[] = [];
		let n = 0;
		const produce = vi.fn(async () => {
			events.push(`produce:${n}`);
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn((attempt: number) => {
			events.push(`retry:${attempt}`);
		});
		const onRetryAttemptStart = vi.fn(() => {
			events.push("attempt-start");
		});
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryAttemptStart });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(onRetryScheduled).toHaveBeenCalledTimes(2);
		expect(onRetryAttemptStart).toHaveBeenCalledTimes(2);
		expect(events).toEqual([
			"produce:0",
			"retry:1",
			"attempt-start",
			"produce:1",
			"retry:2",
			"attempt-start",
			"produce:2",
		]);
	});

	it("aborts backoff sleep via signal, returns an aborted message, and emits onRetryFinished(false)", async () => {
		const controller = new AbortController();
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const policy: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 10_000 };
		const onRetryFinished = vi.fn();
		const p = retryAssistantCall(produce, policy, controller.signal, { onRetryFinished });
		// Let one error call resolve and the first backoff sleep start, then abort.
		await vi.waitFor(() => expect(produce).toHaveBeenCalled());
		controller.abort();
		const res = await p;
		expect(res.stopReason).toBe("aborted");
		expect(res.errorMessage).toBeUndefined();
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1, "terminated");
	});
});
