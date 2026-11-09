// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** Raw HTTP body reason, already trimmed and truncated to the cap. */
	body?: string;
	/** `error.message`, or `safeJsonStringify(error)` for a non-`Error` throw. */
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	code?: unknown;
	body?: unknown;
	error?: unknown;
	headers?: unknown;
	request_id?: unknown;
	requestId?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export interface OpenAICompatibleGatewayErrorMetadata {
	status?: number;
	callId?: string;
	requestId?: string;
	upstreamDeployment?: string;
	upstreamModel?: string;
	/** LiteLLM gateway key policy region (`x-litellm-model-region`), not a cloud deployment region. */
	allowedRegion?: string;
	attemptedRetries?: number;
	maxRetries?: number;
	attemptedFallbacks?: number;
	maxFallbacks?: number;
}

type HeaderGetter = { get(name: string): string | null };

type HeaderRecord = Record<string, unknown>;

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError) ?? extractHttpLikeErrorCode(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

/**
 * Probe the HTTP status, first numeric hit wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * OpenAI-compatible gateways can return an HTTP 200 SSE stream whose terminal
 * event is an error. The OpenAI SDK then leaves `status` undefined but may copy
 * the gateway's numeric error code onto `error.code` (or keep it in the body).
 * Only accept trimmed 3-digit HTTP-like codes here; provider-specific numeric
 * codes must not become HTTP statuses.
 */
function extractHttpLikeErrorCode(error: SdkErrorShape): number | undefined {
	const nestedError = isRecord(error.error) ? error.error.code : undefined;
	const candidates = [error.code, nestedError];
	for (const candidate of candidates) {
		const normalized =
			typeof candidate === "number"
				? Number.isInteger(candidate)
					? String(candidate)
					: undefined
				: typeof candidate === "string"
					? candidate.trim()
					: undefined;
		if (normalized !== undefined && /^\d{3}$/.test(normalized)) {
			const status = Number(normalized);
			if (status >= 400 && status <= 599) return status;
		}
	}
	return undefined;
}

/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is truncated to the cap.
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * Only a PLAIN object counts as an HTTP body. SDK error fields can hold class
 * instances instead of parsed bodies — AWS SDK v3's `$response.body` is an
 * HTTP stream/response wrapper object, and stringifying one produced garbage
 * like `{"_events":...}` as the "body", which then REPLACED `error.message`
 * in the composed display string. `error.message` is where the SDK puts the
 * real deserialized exception text ("Input is too long...", schema validation
 * details, ...), so the one useful string was discarded for noise. A class
 * instance yields no body, `messageCarriesBody` stays true, and the real
 * message survives. Complements the `pipe` sniffing above: web
 * ReadableStreams (pipeTo/pipeThrough, no `pipe`) and non-stream SDK wrapper
 * classes fail the prototype check, while parsed JSON bodies (plain objects
 * by construction) still pass.
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

/**
 * Extract routing and retry metadata from an OpenAI-compatible SDK error.
 * Headers are optional because a streaming response may fail after they were
 * committed, and SDK errors from non-HTTP paths may not carry them at all.
 */
export function extractOpenAICompatibleGatewayError(error: unknown): OpenAICompatibleGatewayErrorMetadata {
	if (!(error instanceof Error)) return {};

	const sdkError = error as SdkErrorShape;
	const headers = sdkError.headers;
	const metadata: OpenAICompatibleGatewayErrorMetadata = {
		status: normalizeProviderError(error).status,
		callId: getHeader(headers, "x-litellm-call-id") ?? getHeader(headers, "x-litellm-request-id"),
		requestId:
			getHeader(headers, "x-request-id") ??
			getHeader(headers, "request-id") ??
			getStringProperty(sdkError.request_id) ??
			getStringProperty(sdkError.requestId),
		upstreamDeployment: getHeader(headers, "x-litellm-model-id"),
		upstreamModel: getHeader(headers, "x-litellm-model-name"),
		allowedRegion: getHeader(headers, "x-litellm-model-region"),
		attemptedRetries: getHeaderNumber(headers, ["x-litellm-attempted-retries"]),
		maxRetries: getHeaderNumber(headers, ["x-litellm-max-retries"]),
		attemptedFallbacks: getHeaderNumber(headers, ["x-litellm-attempted-fallbacks"]),
		maxFallbacks: getHeaderNumber(headers, ["x-litellm-max-fallbacks"]),
	};

	return removeUndefinedProperties(metadata);
}

/**
 * Render a compact, one-line failure for an OpenAI-compatible gateway. Header
 * fields are deliberately conditional: LiteLLM cannot add retry/fallback
 * headers after a streaming response has committed, so missing fields are not
 * evidence that no attempt or fallback occurred and must not be claimed either
 * way.
 */
export function formatActionableGatewayError(
	metadata: OpenAICompatibleGatewayErrorMetadata,
	model: { provider: string; id: string },
): string {
	const requestedModel = `${model.provider}/${model.id}`;
	const status = metadata.status === undefined ? "upstream request failed" : `upstream status ${metadata.status}`;
	const location = [
		metadata.upstreamDeployment ? `deployment ${metadata.upstreamDeployment}` : undefined,
		metadata.upstreamModel ? `model ${metadata.upstreamModel}` : undefined,
		metadata.allowedRegion ? `allowed region ${metadata.allowedRegion}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(", ");
	const attempts = formatGatewayAttemptSummary(metadata);
	const identifiers = [
		metadata.callId ? `call ID ${metadata.callId}` : undefined,
		metadata.requestId && metadata.requestId !== metadata.callId ? `request ID ${metadata.requestId}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(", ");
	const dashboard = "";

	return (
		[
			`${requestedModel}: ${status}${location ? `; initial route ${location}` : ""}`,
			attempts,
			"retry the request or choose another model",
			identifiers,
		]
			.filter((part) => part.length > 0)
			.join("; ") + dashboard
	);
}

function formatGatewayAttemptSummary(metadata: OpenAICompatibleGatewayErrorMetadata): string {
	const retries =
		metadata.attemptedRetries === undefined
			? undefined
			: metadata.maxRetries === undefined
				? `retry attempts ${metadata.attemptedRetries}`
				: `retry attempts ${metadata.attemptedRetries}/${metadata.maxRetries}`;
	const fallbacks =
		metadata.attemptedFallbacks === undefined
			? undefined
			: metadata.maxFallbacks === undefined
				? `fallback attempts ${metadata.attemptedFallbacks}`
				: `fallback attempts ${metadata.attemptedFallbacks}/${metadata.maxFallbacks}`;
	return [retries, fallbacks].filter((part): part is string => part !== undefined).join(", ");
}

function getHeader(headers: unknown, name: string): string | undefined {
	if (isHeaderGetter(headers)) {
		return normalizeHeaderValue(headers.get(name));
	}
	if (!isRecord(headers)) return undefined;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected) return normalizeHeaderValue(value);
	}
	return undefined;
}

function getHeaderNumber(headers: unknown, names: string[]): number | undefined {
	for (const name of names) {
		const value = getHeader(headers, name);
		if (value === undefined || !/^\d+$/.test(value)) continue;
		return Number(value);
	}
	return undefined;
}

function normalizeHeaderValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function getStringProperty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isHeaderGetter(value: unknown): value is HeaderGetter {
	return isRecord(value) && typeof value.get === "function";
}

function isRecord(value: unknown): value is HeaderRecord {
	return typeof value === "object" && value !== null;
}

function removeUndefinedProperties<T extends object>(value: T): T {
	const result = { ...value } as T & Record<string, unknown>;
	for (const key of Object.keys(result)) {
		if (result[key] === undefined) delete result[key];
	}
	return result;
}

/**
 * Compose a display string from a normalized error. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) or no body/status
 * was extracted, the message is returned unchanged. Otherwise the status and
 * body are surfaced, with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

/**
 * The serving model named inside a provider error body, when it differs from
 * the requested id.
 *
 * OpenAI-compatible gateways echo the model they routed to in the error
 * envelope (`{"error": {..., "model": "..."}}`, or a sibling `model` field),
 * which is the only place the re-mapping is visible when the stream failed
 * before a single chunk arrived. Returns undefined when the body names nothing,
 * names a non-string, or names the model that was requested.
 */
export function extractResponseModelFromError(error: unknown, requestedModelId: string): string | undefined {
	const candidates = [error, (error as { error?: unknown } | null)?.error];
	for (const candidate of candidates) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const named = (candidate as { model?: unknown }).model;
		if (typeof named === "string" && named.length > 0 && named !== requestedModelId) return named;
	}
	return undefined;
}

/**
 * Attribute a provider error to the model the request was actually addressed to.
 *
 * A provider body names, at best, whatever model the serving side decided to
 * talk about. Behind a gateway that is routinely not the model phi asked for:
 * a LiteLLM model group can re-map a request onto an upstream first-party
 * model, and the 400 that comes back names the upstream. Read literally, the
 * error says a model the session never selected rejected the request — which
 * has sent people debugging the wrong model, and made a client-side reroute
 * look like the cause of a failure it had nothing to do with.
 *
 * So the message is prefixed with the requested `provider/modelId`, and with
 * the serving model too when the response named a genuinely different one:
 *
 * - `"gateway/example-small: 400 ..."`
 * - `"gateway/example-small (gateway served claude-fable-5): 400 ..."`
 *
 * "Genuinely different" excludes version pinning, where one id contains the
 * other (`gpt-4o` served as `gpt-4o-2024-08-06`). That is the normal way a
 * provider answers, not a re-map worth a second model name in every error.
 *
 * The provider body is left byte-for-byte intact after the prefix, so anyone
 * reading the transcript sees exactly what the provider said. The text
 * classifiers in `retry.ts` and `overflow.ts` are unanchored substring matches
 * and must not read this prefix at all — they key on
 * `AssistantMessage.providerErrorMessage`, which callers set to the text passed
 * in here.
 */
export function attributeProviderError(
	message: string,
	model: { provider: string; id: string },
	responseModel?: string,
): string {
	const requested = `${model.provider}/${model.id}`;
	const servedElsewhere =
		responseModel !== undefined &&
		responseModel.length > 0 &&
		responseModel !== model.id &&
		!responseModel.includes(model.id) &&
		!model.id.includes(responseModel);
	const prefix = servedElsewhere ? `${requested} (gateway served ${responseModel})` : requested;
	// Re-attributing an already-attributed message (a wrapper that re-throws) would
	// stack prefixes; one is informative, three are noise.
	if (message.startsWith(`${requested}:`) || message.startsWith(`${requested} (gateway served `)) return message;
	return `${prefix}: ${message}`;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
