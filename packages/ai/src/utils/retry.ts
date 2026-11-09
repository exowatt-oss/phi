import type { AssistantMessage, RefusalDetails } from "../types.ts";
import { isStreamIdleTimeoutError } from "./stream-idle-guard.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",

	// Sign in with ChatGPT: the subscription's shared usage limit, which resets
	// after hours rather than seconds.
	"subscription_sharing_usage_limit_exceeded",
	// Sign in with ChatGPT on a ChatGPT Business plan: a usage limit set by the
	// workspace admin. Only the admin can raise it.
	"subscription_sharing_workplace_individual_usage_limit_exceeded",
]);

/**
 * Text signatures of a provider whose *credentials* are dead, as opposed to its
 * endpoint being down: an OAuth refresh token that has been revoked or rotated
 * away, or a key that no longer authenticates. Deterministic for this provider
 * until a human re-authenticates, so — exactly like account exhaustion — the
 * same-model retry budget cannot clear it and only another provider can answer.
 *
 * These arise on the auth-resolution path rather than from an HTTP response, so
 * they carry no status code to key on. `invalid_grant` is the OAuth 2.0 error
 * code for a refresh token the authorization server rejects; the rest are the
 * wrappers phi puts around it (see `ModelsError` in packages/ai/src/auth).
 *
 * Deliberately narrow: a bare 401/403 stays out, because a single unauthorized
 * response can also mean a transient upstream auth hiccup, and misclassifying
 * that would rewrite a whole session's model on a blip.
 */
const PROVIDER_AUTH_DEAD_ERROR_PATTERN = buildProviderErrorPattern([
	// OAuth 2.0 refresh rejection (RFC 6749 §5.2) and its human-readable forms.
	"invalid_grant",
	"refresh token not found or invalid",
	"refresh token (is )?(invalid|expired|revoked)",

	// phi's own auth-layer wrappers, thrown before any request is sent.
	"oauth refresh failed",
	"oauth auth derivation failed",
	"oauth refresh returned a token that expires too soon",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"model is at capacity",
	"rate.?limit",
	"too many requests",
	// Status codes must not be part of a longer word or number, e.g. a request id or byte count (#11057).
	"(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])",
	// Also matches "The service is temporarily unavailable" (#10965).
	"service.?(?:is.?)?(?:temporarily.?)?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264) and gateway wording such as
	// "The upstream provider returned an error" (#10842).
	"provider.?returned.?(?:an.?)?error",
	"exceeded request buffer limit while retrying upstream",
	// Gateway failure relaying the upstream response stream, sent as an OpenAI
	// Responses `response.failed` event without an error code (#10920).
	"unable to forward upstream",
	// Other gateway upstream failures relayed as `response.failed` error codes (#10920).
	"upstream.?request.?failed",
	"upstream_stream_read_error",
	"stream was interrupted",
	"http/?2 stream failed",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	// node-fetch system errors, e.g. the Google ADC OAuth token refresh used by
	// google-vertex. The reason is often empty (#10996).
	"request to \\S+ failed, reason:",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// aiohttp reports truncated response bodies as payload/transfer-encoding errors.
	// Match the transport-specific wording, not a bare 400 response.
	"response payload is not completed",
	"TransferEncodingError",
	"not enough data to satisfy transfer length header",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	// Codex CLI mid-stream disconnect, relayed by proxies that wrap the Codex CLI,
	// e.g. "stream disconnected before completion: stream closed before response.completed" (#11057).
	"stream disconnected before completion",
	// Node ERR_HTTP2_STREAM_CANCEL: the HTTP/2 session died before the request was
	// sent, e.g. after the Bedrock SDK's 5-minute session timeout (#10379).
	"pending stream has been canceled",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",

	// Sign in with ChatGPT: usage or user data temporarily unavailable. Usage
	// failures can arrive mid-stream without an HTTP 503 in the message.
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

/**
 * Text signatures of a provider that cannot serve *any* request right now, as
 * opposed to a transient failure of this one: the upstream front door is down
 * or unreachable (LiteLLM `APIConnectionError` wrapping an nginx-style 503
 * page, connection refused, DNS failure). Retrying the same model re-asks a
 * dead endpoint with backoff before giving up; only another model can answer
 * the turn while the outage lasts.
 *
 * Deliberately excludes capacity throttling ("overloaded", rate limits, 429)
 * and bare 500s — those clear on their own and belong to the same-model retry
 * budget. A subset of {@link RETRYABLE_PROVIDER_ERROR_PATTERN} on purpose: an
 * unavailable error is still retryable when no fallback model is configured.
 */
const PROVIDER_UNAVAILABLE_ERROR_PATTERN = buildProviderErrorPattern([
	// LiteLLM/OpenAI-SDK wrapper for "could not reach the upstream at all".
	"APIConnectionError",

	// HTTP unavailability, bare status codes and gateway/nginx wording.
	"502",
	"503",
	"504",
	"service.?(temporarily.?)?unavailable",
	"bad gateway",

	// Transport-level unreachability: nothing is listening / nothing resolves.
	"connection.?refused",
	"ECONNREFUSED",
	"ENOTFOUND",
	"getaddrinfo",
]);

/**
 * Capacity throttling that clears on its own. Checked before
 * {@link PROVIDER_UNAVAILABLE_ERROR_PATTERN} because throttle responses can
 * carry a 5xx status (OpenAI's "engine is currently overloaded" 503) while
 * still being the retry budget's job rather than a reason to switch models.
 */
const PROVIDER_CAPACITY_ERROR_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
]);

/**
 * Text signatures of a safety-classifier decline, for providers that do not carry
 * {@link AssistantMessage.refusal} structurally.
 *
 * Deliberately narrow. This list is the *fallback* path: first-party Anthropic
 * requests set `refusal` from `stop_details`, but the same models reached through
 * a gateway (LiteLLM/OpenRouter speaking the OpenAI completions API, Bedrock
 * guardrails) flatten the decline into an error string, and a proxied model is
 * exactly the case where escalating to another model matters. Every entry here
 * must be specific to content policy: anything vaguer would turn ordinary errors
 * into model switches.
 */
const REFUSAL_ERROR_PATTERN = buildProviderErrorPattern([
	// phi's own Anthropic refusal wording (mapStopReason), and the API's.
	"safety classifier declined",
	"stop_reason.{0,3}: ?.?refusal",

	// Anthropic non-stream / gateway-wrapped classifier blocks.
	"blocked under Anthropic's Usage Policy",
	"violative",

	// OpenAI-compatible content filtering (finish_reason content_filter, Azure text).
	"content.?filter",
	"content management policy",

	// Bedrock guardrail interventions.
	"blocked by .{0,40}guardrail",
	"guardrail intervened",
]);

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * `maxAgentDelayMs` caps each computed delay and defaults to 60 seconds.
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`, `maxAgentDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
	/** Optional cap for agent-level retry delays in ms. Defaults to 60 seconds. */
	maxAgentDelayMs?: number;
}

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = retryDelayMs(policy!, attempt);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				const { errorMessage: _errorMessage, ...rest } = response;
				return { ...rest, stopReason: "aborted" };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * The error text a classifier is allowed to match against: what the provider
 * said, never phi's attribution prefix.
 *
 * Every pattern in this file is an unanchored substring match, several of them
 * bare status codes, so prefixing the message with `provider/modelId` widens
 * what they match. It is not hypothetical: the catalog ships
 * `amazon-bedrock/us.mistral.pixtral-large-2502-v1:0`, whose id contains `502`,
 * so classifying the prefixed text would read any error from that model —
 * including a deterministic 400 — as a gateway outage and reroute the session
 * off it. Custom model ids from settings.json are unbounded and can contain
 * `429`, `timeout`, or `billing` just as easily.
 */
function classifiableErrorText(message: AssistantMessage): string {
	return message.providerErrorMessage ?? message.errorMessage ?? "";
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	// Interactive authentication is required. Neither repeating the same request
	// nor silently changing providers can repair this credential.
	if (message.authRequired) return false;
	// A policy decline is deterministic in the request: the same call on the same
	// model declines again. Escalating to another model is the only way through, so
	// refusals never enter the same-model retry budget, whatever else their text
	// happens to match.
	if (isRefusalAssistantError(message)) return false;
	const errorMessage = classifiableErrorText(message);
	if (isStreamIdleTimeoutError(errorMessage)) return true;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	// Dead credentials are deterministic: re-asking the same provider with the same
	// revoked token just spends the budget before surfacing the identical failure.
	if (PROVIDER_AUTH_DEAD_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

/**
 * Classifies whether a failed assistant message means the provider cannot serve
 * this session at all right now — the endpoint is down/unreachable, or the
 * account's quota/billing is exhausted. Both share the property that only a
 * different model or provider can answer the turn, which is what callers use
 * this for: same-model retries are wasted against a dead endpoint, and are
 * guaranteed to fail against an exhausted account.
 *
 * This does not implement fallback policy. Callers own the model chain, its
 * cursor, and how a reroute is surfaced.
 */
export function isProviderUnavailableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	// Preserve the selected provider and failed turn while the user reauthenticates.
	if (message.authRequired) return false;
	// A decline is about the request content, not the provider's health.
	if (isRefusalAssistantError(message)) return false;
	const errorMessage = classifiableErrorText(message);
	// Account-level exhaustion: deterministic for this provider until a human
	// intervenes — the "another model is the only way through" case exactly.
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return true;
	// Dead credentials: same shape as exhaustion — no retry and no other model on
	// this provider can help, so the turn belongs on a different provider.
	if (PROVIDER_AUTH_DEAD_ERROR_PATTERN.test(errorMessage)) return true;
	// Capacity throttling clears on its own; that is the retry budget's job.
	if (PROVIDER_CAPACITY_ERROR_PATTERN.test(errorMessage)) return false;
	return PROVIDER_UNAVAILABLE_ERROR_PATTERN.test(errorMessage);
}

/**
 * Classifies whether a failed assistant message was declined by a safety
 * classifier, rather than failing for transport or capacity reasons.
 *
 * Structure first: {@link AssistantMessage.refusal} is set by providers that report
 * a decline as such (Anthropic's `stop_reason: "refusal"`). Text second, for the
 * proxied paths that lose it — see {@link REFUSAL_ERROR_PATTERN}.
 *
 * This does not implement escalation policy. Callers own the model chain, its
 * cursor, and how a decline is surfaced.
 */
export function isRefusalAssistantError(message: AssistantMessage): boolean {
	if (message.refusal) return true;
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	return REFUSAL_ERROR_PATTERN.test(classifiableErrorText(message));
}

/**
 * The refusal facts for a declined message, structural when the provider gave
 * them and synthesized from the error text when it did not, so callers can render
 * one shape. Returns undefined when the message is not a refusal at all.
 */
export function getRefusalDetails(message: AssistantMessage): RefusalDetails | undefined {
	if (message.refusal) return message.refusal;
	if (!isRefusalAssistantError(message)) return undefined;
	return { category: null, ...(message.errorMessage ? { explanation: message.errorMessage } : {}) };
}
