import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type {
	BetaInputTransformation,
	BetaStopReason,
	BetaTool,
	BetaCacheControlEphemeral as CacheControlEphemeral,
	BetaContentBlockParam as ContentBlockParam,
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
	BetaRawMessageStreamEvent as RawMessageStreamEvent,
	BetaRefusalStopDetails as RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import {
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	ANTHROPIC_ORGANIZATION_ID_ENV,
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../env-api-keys.ts";
import { calculateCost, supportsFastMode } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	ImageContent,
	InferenceSpeed,
	Message,
	Model,
	ProviderEnv,
	ProviderHeaders,
	RefusalDetails,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { attributeProviderError, extractResponseModelFromError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { parseJsonWithRepair, parseStreamingJson, parseToolCallArguments } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { isRetryableProviderError, retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
	getCurrentTools,
	getInitialSystemMessage,
	resolveTranscript,
	type TranscriptContext,
} from "../utils/transcript.ts";

import {
	getJsonSchemaToolParameters,
	resolveJsonSchemaStrictSampling,
	type UnsupportedStrictSchemaKeywordCheck,
} from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "./simple-options.ts";
import { splitErrorToolResultImages, transformMessages } from "./transform-messages.ts";

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Stealth mode: Mimic Claude Code's tool naming exactly
// Anthropic gates newer models on the claude-cli user-agent version: requesting
// claude-opus-5-5 with 2.1.251 fails with "Claude Code 2.1.251 does not support this
// model; version 2.1.280 or newer is required". Keep this at or above the newest
// model's floor; a per-model `headers: { "user-agent": ... }` override in
// models.json should not be needed to reach a GA model.
const claudeCodeVersion = "2.1.280";

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

function convertImageBlock(image: ImageContent) {
	return {
		type: "image" as const,
		source: {
			type: "base64" as const,
			media_type: image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
			data: image.data,
		},
	};
}

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return convertImageBlock(block);
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FAST_MODE_BETA = "fast-mode-2026-02-01";

/** Fast-mode requests rejected for capacity (429/529) skip fast mode for this long when no retry-after is given. */
const FAST_MODE_DEFAULT_COOLDOWN_MS = 60_000;
/** Upper bound on a server-requested fast-mode cooldown; a longer retry-after is clamped. */
const FAST_MODE_MAX_COOLDOWN_MS = 5 * 60_000;
/** An organization with fast mode switched off is re-probed this often (an admin may enable it any time). */
const FAST_MODE_DISABLED_COOLDOWN_MS = 5 * 60_000;
/** A model that rejects `speed` outright stays at standard speed for this long before fast mode is retried. */
const FAST_MODE_UNSUPPORTED_COOLDOWN_MS = 60 * 60_000;

/**
 * Why a fast-mode request was turned down:
 * - "capacity": the fast-mode rate limit or capacity (429/529); also how the API
 *   answers when usage credits run out. Shared by every Opus model on the account.
 * - "disabled": fast mode is not enabled for the organization (400). An admin
 *   has to turn it on; nothing the session does changes that.
 * - "unsupported": the API rejected `speed` for this model (400).
 */
export type AnthropicFastModeRejection = "capacity" | "disabled" | "unsupported";

/**
 * Process-wide fast-mode cooldowns, keyed by provider (capacity: the fast-mode
 * rate limit is one pool shared by every Opus model on the account) or by
 * provider+model (the API rejected `speed` for that model). While a key is
 * cooling down, requests that ask for fast mode go out at standard speed
 * immediately instead of paying a rejected round trip per call, mirroring
 * Claude Code's fallback-and-cooldown behavior.
 */
const fastModeCooldowns = new Map<string, number>();

function fastModeProviderKey(model: Model<"anthropic-messages">): string {
	return `${model.provider}@${model.baseUrl}`;
}

function fastModeModelKey(model: Model<"anthropic-messages">): string {
	return `${fastModeProviderKey(model)}#${model.id}`;
}

function isFastModeCoolingDown(model: Model<"anthropic-messages">, now = Date.now()): boolean {
	for (const key of [fastModeProviderKey(model), fastModeModelKey(model)]) {
		const until = fastModeCooldowns.get(key);
		if (until === undefined) continue;
		if (until > now) return true;
		fastModeCooldowns.delete(key);
	}
	return false;
}

/** Test hook: forget every fast-mode cooldown recorded in this process. */
export function resetAnthropicFastModeCooldowns(): void {
	fastModeCooldowns.clear();
}

/**
 * The API's own error text, without the SDK's `400 {json}` wrapping: the parsed
 * body the Anthropic SDK attaches to the error, else the JSON inside the
 * message, else the message itself.
 */
function anthropicErrorMessage(error: Error): string {
	const parsed = (error as { error?: { error?: { message?: unknown } } }).error?.error?.message;
	if (typeof parsed === "string" && parsed.length > 0) return parsed;
	const start = error.message.indexOf("{");
	if (start >= 0) {
		try {
			const body = JSON.parse(error.message.slice(start)) as { error?: { message?: unknown } };
			if (typeof body.error?.message === "string") return body.error.message;
		} catch {
			// Not a JSON body; fall through to the raw message.
		}
	}
	return error.message;
}

/**
 * A fast-mode request the API turned down for reasons that do not apply at
 * standard speed. Anything else (auth, malformed request, server error) would
 * fail at standard speed too and follows the normal retry path.
 */
function classifyFastModeRejection(error: unknown): AnthropicFastModeRejection | undefined {
	if (!(error instanceof Error) || !("status" in error)) return undefined;
	const status = (error as { status?: unknown }).status;
	if (status === 429 || status === 529) return "capacity";
	if (status !== 400) return undefined;
	const message = anthropicErrorMessage(error);
	// "Fast mode is not enabled for your organization. An organization admin must enable this feature."
	if (/not enabled for your organization|organization admin/i.test(message)) return "disabled";
	if (/\bspeed\b|fast[ -]mode/i.test(message)) return "unsupported";
	return undefined;
}

function fastModeCooldownMs(error: unknown, kind: AnthropicFastModeRejection): number {
	if (kind === "unsupported") return FAST_MODE_UNSUPPORTED_COOLDOWN_MS;
	if (kind === "disabled") return FAST_MODE_DISABLED_COOLDOWN_MS;
	const headers = (error as { headers?: Headers }).headers;
	const retryAfterMs = Number.parseFloat(headers?.get?.("retry-after-ms") ?? "");
	if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, FAST_MODE_MAX_COOLDOWN_MS);
	const retryAfter = headers?.get?.("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs) && delayMs > 0) return Math.min(delayMs, FAST_MODE_MAX_COOLDOWN_MS);
	}
	return FAST_MODE_DEFAULT_COOLDOWN_MS;
}

function readReportedSpeed(usage: unknown): InferenceSpeed | undefined {
	const speed = (usage as { speed?: unknown } | null | undefined)?.speed;
	return speed === "fast" || speed === "standard" ? speed : undefined;
}

/**
 * Cost for an Anthropic response. Fast-mode responses (`usage.speed: "fast"`)
 * bill every rate at `compat.fastModeCostMultiplier` and ignore long-context
 * tiers: Anthropic prices fast mode flat across the full context window.
 */
function calculateAnthropicCost(model: Model<"anthropic-messages">, output: AssistantMessage): void {
	if (output.speed !== "fast") {
		calculateCost(model, output.usage);
		return;
	}
	const multiplier = getAnthropicCompat(model).fastModeCostMultiplier;
	calculateCost(
		{
			...model,
			cost: {
				input: model.cost.input * multiplier,
				output: model.cost.output * multiplier,
				cacheRead: model.cost.cacheRead * multiplier,
				cacheWrite: model.cost.cacheWrite * multiplier,
			},
		},
		output.usage,
	);
}

type AnthropicFallbacks = "default" | Array<{ model: string }>;

/**
 * Resolve the server-side refusal-fallback configuration for this request.
 *
 * Claude Fable 5 / Opus 5 safety classifiers can decline a request with
 * `stop_reason: "refusal"`. With the `server-side-fallback-2026-07-01` beta and a
 * `fallbacks` request parameter, the API retries the declined request on another
 * model inside the same call (and applies fallback credit automatically), so a
 * spurious classifier decline does not kill the agent turn.
 *
 * Resolution order: `options.fallbacks` > `PI_ANTHROPIC_FALLBACKS` env > the
 * model's catalog allow-list (`compat.allowedFallbackModels`) > "default".
 * The env value is "off", "default", or a comma-separated list of model ids
 * (tried in order, max 3 per the API contract). A model with per-turn effort
 * (`compat.supportsMidConvoEffort`) and no allow-list gets no implicit fallback:
 * the replayed request carries effort-only `system` messages that Anthropic's
 * default routing could hand to a model without that support.
 *
 * Only first-party `anthropic` API-key requests are eligible for the env/option
 * and "default" paths: the beta is Claude API only (not Bedrock/Vertex/proxies),
 * OAuth (Claude Code) requests carry their own locked beta set, and injected
 * clients (`options.client`) target other platforms. Another provider only gets
 * fallbacks from an explicit `compat.allowedFallbackModels`.
 */
function resolveFallbacks(
	model: Model<"anthropic-messages">,
	isOAuth: boolean,
	options?: AnthropicOptions,
): AnthropicFallbacks | undefined {
	if (isOAuth || options?.client) return undefined;
	const configured = options?.fallbacks ?? getProviderEnvValue("PI_ANTHROPIC_FALLBACKS", options?.env);
	if (configured === "off" || configured === "none") return undefined;
	const allowList = model.compat?.allowedFallbackModels?.map((fallback) => ({ model: fallback.model })) ?? [];
	if (model.provider !== "anthropic") return allowList.length > 0 ? allowList : undefined;
	if (Array.isArray(configured)) return configured.length > 0 ? configured : undefined;
	if (configured === "default") return "default";
	if (configured === undefined || configured === "") {
		if (allowList.length > 0) return allowList;
		return model.compat?.supportsMidConvoEffort === true ? undefined : "default";
	}
	const entries = configured
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
		.map((id) => ({ model: id }));
	return entries.length > 0 ? entries : "default";
}

/**
 * The catalog model to bill a response against. A server-side fallback serves the
 * turn from another model; when the requested model's allow-list prices that
 * model, its rates apply (fast-mode compat still comes from the requested model).
 */
function resolveUsageModel(
	model: Model<"anthropic-messages">,
	servedModelId: string | undefined,
): Model<"anthropic-messages"> {
	if (!servedModelId || servedModelId === model.id) return model;
	const fallbackCost = model.compat?.allowedFallbackModels?.find(
		(fallback) => fallback.provider === model.provider && fallback.model === servedModelId,
	)?.cost;
	return fallbackCost ? { ...model, id: servedModelId, cost: fallbackCost } : model;
}

const MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";

/**
 * Stable deferred tool declared whenever native tool changes are in use. Anthropic adds
 * hidden prompt scaffolding for mid-conversation tool changes; declaring this placeholder
 * from the first request keeps that scaffolding in the cached prefix, so the first tool
 * change does not invalidate the cache (measured: full miss without it). It is never
 * activated and the model cannot see it.
 */
const DEFERRED_TOOL_PLACEHOLDER: BetaTool = {
	name: "__pi_deferred_placeholder__",
	description: "Reserved placeholder. Never available. Never call this.",
	input_schema: { type: "object", properties: {}, required: [] },
	defer_loading: true,
};

function getAnthropicCompat(model: Model<"anthropic-messages">) {
	const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
	return {
		supportsFastMode: supportsFastMode(model),
		fastModeCostMultiplier: model.compat?.fastModeCostMultiplier ?? 2,
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? isOpenRouter,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? (isOpenRouter ? "openrouter" : undefined),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsMidConvoToolChanges: model.compat?.supportsMidConvoToolChanges ?? false,
	};
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For adaptive thinking models: the model decides when/how much to think.
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 * Default: undefined (thinking is omitted unless `streamSimple()` maps
	 * a simple reasoning level to this option, or callers set it explicitly).
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for adaptive thinking models.
	 * Default: 1024 when `thinkingEnabled` is true and no budget is provided.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking models.
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7+, Fable 5)
	 * - "high": Always thinks, deep reasoning
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 * Default: omitted unless `streamSimple()` maps a simple reasoning
	 * level to this option.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text.
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 * Default: "summarized" when thinking is enabled.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Whether to request the interleaved thinking beta header for non-adaptive
	 * thinking models. Adaptive thinking models have interleaved thinking built in,
	 * so the header is skipped for them regardless of this setting.
	 * Default: true.
	 */
	interleavedThinking?: boolean;
	/**
	 * Anthropic tool choice behavior. String values map to Anthropic's built-in
	 * choices; `{ type: "tool", name }` forces a specific tool.
	 * Default: omitted (Anthropic default behavior, currently equivalent to auto).
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
	/**
	 * Anthropic fast mode (`speed: "fast"` with the `fast-mode-2026-02-01` beta):
	 * the same model served at up to 2.5x output tokens per second for a
	 * per-token premium. Sent only when the model supports it (see
	 * `supportsFastMode`); otherwise the request goes out at standard speed.
	 * When the API turns a fast request down for fast-mode capacity (429/529) or
	 * rejects `speed` for the model (400), the request is retried once at standard
	 * speed, the response records `speed: "standard"` plus a diagnostic, and fast
	 * mode is skipped for a cooldown. Cost follows the speed the response reports.
	 * Default: omitted (standard speed). `streamSimple()` maps
	 * `serviceTier: "fast"` to this option.
	 */
	speed?: InferenceSpeed;
	/**
	 * Server-side refusal fallback (Claude API beta). When the model's safety
	 * classifier declines a request, the API retries it on another model within
	 * the same call and splices the answer onto the open stream.
	 * - "default": Anthropic's recommended per-category fallback routing.
	 * - "off": disable (a refusal surfaces as a stream error, as before).
	 * - Array: explicit chain of up to three `{ model }` entries, tried in order.
	 * Default for first-party anthropic API-key requests: the model's catalog
	 * allow-list (`compat.allowedFallbackModels`) when it has one, else "default"
	 * (none for per-turn-effort models without an allow-list). Always off for
	 * OAuth and injected clients; other providers only use an explicit
	 * `compat.allowedFallbackModels`. Env override: PI_ANTHROPIC_FALLBACKS
	 * ("off" | "default" | comma-separated model ids).
	 */
	fallbacks?: "default" | "off" | Array<{ model: string }>;
}

function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function hasRequestAuth(apiKey: string | undefined, headers: ProviderHeaders | undefined): boolean {
	return (
		!!apiKey ||
		hasHeader(headers, "authorization") ||
		hasHeader(headers, "x-api-key") ||
		hasHeader(headers, "cf-aig-authorization")
	);
}

function assertRequestAuth(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): void {
	if (!hasRequestAuth(apiKey, headers)) throw new Error(`No API key for provider: ${provider}`);
}

/**
 * Anthropic SDK client that never runs the SDK's own credential chain
 * (ANTHROPIC_PROFILE config files, federation env vars). Without this, every
 * client built with `apiKey: null, authToken: null` for header-owned auth would
 * also resolve and exchange SDK credentials behind pi's auth resolver.
 */
class PiAnthropic extends Anthropic {
	protected override _shouldResolveDefaultCredentials(): boolean {
		return false;
	}
}

type AnthropicFederationConfig = NonNullable<ClientOptions["config"]>;

/**
 * Workload identity federation config from the ANTHROPIC_* variables the
 * Anthropic SDK documents; the SDK performs the token exchange and refresh.
 * Only for the anthropic provider, since the exchange is an Anthropic API
 * endpoint, and only when no key or auth header was resolved.
 */
function getAnthropicFederation(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
	env: ProviderEnv | undefined,
): AnthropicFederationConfig | undefined {
	if (model.provider !== "anthropic" || hasRequestAuth(apiKey, headers)) return undefined;
	const federationRuleId = getProviderEnvValue(ANTHROPIC_FEDERATION_RULE_ID_ENV, env);
	const organizationId = getProviderEnvValue(ANTHROPIC_ORGANIZATION_ID_ENV, env);
	const identityTokenFile = getProviderEnvValue(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, env);
	if (!federationRuleId || !organizationId || !identityTokenFile) return undefined;
	return {
		organization_id: organizationId,
		workspace_id: getProviderEnvValue(ANTHROPIC_WORKSPACE_ID_ENV, env),
		authentication: {
			type: "oidc_federation",
			federation_rule_id: federationRuleId,
			service_account_id: getProviderEnvValue(ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, env),
			identity_token: { source: "file", path: identityTokenFile },
		},
	};
}

/**
 * The SDK caches the federated access token per client, but pi creates a client
 * per request. Keep one client for the current federation config and fetch, and
 * clone it per request with `withOptions()`, which shares the token cache.
 */
let federationClient: { key: string; fetch: typeof globalThis.fetch | undefined; client: Anthropic } | undefined;

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	onActivity?: () => void,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			onActivity?.();
			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
	onActivity?: () => void,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal, onActivity)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getAnthropicCompat(model).supportsMidConvoSystemMessages);
	const currentTools = getCurrentTools(normalizedContext.messages);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			let client: Anthropic;
			let isOAuth: boolean;
			// Fast mode is requested for the model, so the beta rides on the request; the
			// `speed` parameter itself is withheld while a cooldown from an earlier
			// rejection is still running.
			const fastModeRequested = options?.speed === "fast" && supportsFastMode(model);
			let sendFast = fastModeRequested && !isFastModeCoolingDown(model);
			let usageModel = model;
			let inputTransformations: BetaInputTransformation[] | undefined;

			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey;
				const federation = getAnthropicFederation(model, apiKey, options?.headers, options?.env);
				if (!federation) assertRequestAuth(model.provider, apiKey, options?.headers);

				let copilotDynamicHeaders: Record<string, string> | undefined;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(normalizedContext.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: normalizedContext.messages,
						hasImages,
					});
				}

				const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
				const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;

				const created = createClient(
					model,
					apiKey,
					options?.headers,
					options?.fetch,
					copilotDynamicHeaders,
					cacheSessionId,
					federation,
					options?.identity,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const retryOptions = {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			};
			const requestFeatures: AnthropicRequestFeatures = {
				fallbacks: resolveFallbacks(model, isOAuth, options),
				fastMode: fastModeRequested,
			};
			let disablePreferredStrictTools = false;
			let response: Response;
			for (;;) {
				options?.signal?.throwIfAborted();
				const built = buildParams(
					model,
					normalizedContext,
					isOAuth,
					options,
					requestFeatures,
					disablePreferredStrictTools,
				);
				if (built.providerThinkingLevel) output.providerThinkingLevel = built.providerThinkingLevel;
				let params = built.params;
				// `speed` needs the fast-mode beta; a configured `anthropic-beta` header
				// that leaves it out keeps the request at standard speed.
				let requestFast = sendFast && params.betas?.includes(FAST_MODE_BETA) === true;
				if (requestFast) params.speed = "fast";
				const nextParams = await options?.onPayload?.(params, model);
				if (nextParams !== undefined) {
					params = { ...(nextParams as MessageCreateParamsStreaming), stream: true };
				}
				requestFast = params.speed === "fast";
				const send = () => client.beta.messages.create(params, requestOptions).asResponse();
				try {
					if (requestFast) {
						try {
							// A fast-mode rejection is handled below by dropping to standard speed,
							// not by waiting out the fast-mode limit with the generic backoff.
							response = await retryProviderRequest(send, {
								...retryOptions,
								shouldRetry: (error) =>
									isRetryableProviderError(error) && classifyFastModeRejection(error) === undefined,
							});
						} catch (error) {
							const rejection = classifyFastModeRejection(error);
							if (rejection === undefined || options?.signal?.aborted) throw error;
							const cooldownMs = fastModeCooldownMs(error, rejection);
							// Only a per-model rejection is scoped to the model; capacity and org
							// policy apply to every fast-mode model on this provider.
							fastModeCooldowns.set(
								rejection === "unsupported" ? fastModeModelKey(model) : fastModeProviderKey(model),
								Date.now() + cooldownMs,
							);
							appendAssistantMessageDiagnostic(
								output,
								createAssistantMessageDiagnostic("anthropic_fast_mode_fallback", error, {
									reason: rejection,
									status: (error as { status?: number }).status ?? null,
									message: error instanceof Error ? anthropicErrorMessage(error) : String(error),
									cooldownMs,
								}),
							);
							delete params.speed;
							requestFast = false;
							// A strict-tools rebuild below must not put `speed` back.
							sendFast = false;
							response = await retryProviderRequest(send, retryOptions);
						}
					} else {
						response = await retryProviderRequest(send, retryOptions);
					}
					sendFast = requestFast;
					break;
				} catch (error) {
					// Only downgrade a rejected request, never an already-started stream.
					if (
						options?.signal?.aborted ||
						disablePreferredStrictTools ||
						!built.hasPreferredStrictTools ||
						!(error instanceof Anthropic.APIError) ||
						error.status !== 400 ||
						error.type !== "invalid_request_error" ||
						![
							"The compiled grammar is too large",
							"Too many strict tools (",
							"Schemas contains too many parameters with union types (",
						].some((message) => error.message.includes(message))
					) {
						throw error;
					}
					disablePreferredStrictTools = true;
					appendAssistantMessageDiagnostic(output, {
						type: "anthropic_strict_tools_fallback",
						timestamp: Date.now(),
						error: { message: error.message },
						details: { reason: "strict_tool_limits_exceeded" },
					});
				}
			}
			// The response's own `usage.speed` overrides this below when present. Until
			// then a successful fast request is billed as fast (the API contract), and a
			// fast request that was withheld or downgraded is recorded as standard.
			if (fastModeRequested) output.speed = sendFast ? "fast" : "standard";
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];
			// Content length at the most recent server-side fallback boundary. -1 = no
			// fallback happened. Blocks before the final boundary belong to the model
			// that declined; per the fallback contract, its thinking/tool_use blocks
			// must not be echoed on the next turn (their signatures belong to the
			// declining model), while its text carries over.
			let fallbackBoundary = -1;
			// Non-empty text/thinking carried on content_block_start, keyed by SSE block
			// index, until that block's first delta arrives. Anthropic always starts a
			// block empty, but the LiteLLM gateway's Bedrock-Converse translation seeds
			// content_block_start.thinking with the first chunk AND re-sends that chunk as
			// the first thinking_delta, which doubled the block ("ByBy design…"). When the
			// first delta repeats the seed, the delta supersedes it; any other seed is
			// genuine leading content and is kept.
			const startSeeds = new Map<number, string>();
			const appendAfterSeed = (sseIndex: number, current: string, delta: string): string => {
				const seed = startSeeds.get(sseIndex);
				if (seed === undefined) return current + delta;
				startSeeds.delete(sseIndex);
				return delta.startsWith(seed) && current === seed ? delta : current + delta;
			};

			for await (const event of iterateAnthropicEvents(response, options?.signal, options?.onStreamActivity)) {
				await options?.onProviderStreamEvent?.(event, model);
				if (event.type === "message_start") {
					output.responseId = event.message.id;
					const transformations = event.message.input_transformations;
					if (Array.isArray(transformations)) inputTransformations = transformations;
					// Server-side fallback (or sticky routing) can serve the turn from a
					// different model than requested; record who actually answered.
					const servingModel = event.message.model as string | undefined;
					// `model` stays the model the request asked for and `responseModel`
					// names who answered, exactly as the OpenAI-compatible path does.
					// Overwriting `model` made the two identical on this path, so nothing
					// downstream could see that a server-side fallback had served the turn
					// from a different (often weaker) model — a host comparing requested
					// against served could never fire, and the transcript silently
					// reattributed the turn. Recorded even when it equals the requested
					// id: behind a gateway that is a confirmation, and an absent value
					// means the server never said, which hosts (P3 Code) show differently.
					if (servingModel) output.responseModel ||= servingModel;
					// Bill a fallback-served turn at the served model's catalog rates.
					usageModel = resolveUsageModel(model, output.responseModel);
					// Capture initial token usage from message_start event
					// This ensures we have input token counts even if the stream is aborted early
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
					// With the fast-mode beta the API reports which speed actually served
					// the request; that value, not the request, is what gets billed.
					const reportedSpeed = readReportedSpeed(event.message.usage);
					if (reportedSpeed) output.speed = reportedSpeed;
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateAnthropicCost(usageModel, output);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: event.content_block.text ?? "",
							index: event.index,
						};
						if (block.text) startSeeds.set(event.index, block.text);
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: event.content_block.thinking ?? "",
							thinkingSignature: event.content_block.signature ?? "",
							index: event.index,
						};
						if (block.thinking) startSeeds.set(event.index, block.thinking);
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "fallback") {
						// A mid-stream refusal handoff: the declining model's output ends here
						// and the named fallback model continues. No block is stored (phi's
						// content model carries text/thinking/toolCall only); instead the
						// boundary is remembered so pre-boundary thinking is pruned at the end,
						// which keeps the next turn's echo valid without the boundary marker.
						const handoffModel = (event.content_block.to as { model?: string } | undefined)?.model;
						// Same split as message_start: the request still went to `model`, and
						// `responseModel` names the model that finished the turn.
						if (handoffModel && handoffModel !== model.id) {
							output.responseModel = handoffModel;
							usageModel = resolveUsageModel(model, handoffModel);
						}
						fallbackBoundary = output.content.length;
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuth
								? fromClaudeCodeName(event.content_block.name, currentTools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text = appendAfterSeed(event.index, block.text, event.delta.text);
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking = appendAfterSeed(event.index, block.thinking, event.delta.thinking);
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						delete (block as any).index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							Object.assign(block, parseToolCallArguments(block.partialJson));
							// Finalize in-place and strip the scratch buffer so replay only
							// carries parsed arguments.
							delete (block as { partialJson?: string }).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					const transformations = event.input_transformations;
					if (Array.isArray(transformations)) inputTransformations = transformations;
					if (event.delta.stop_reason) {
						output.rawStopReason = event.delta.stop_reason;
						const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
						output.stopReason = stopReasonResult.stopReason;
						if (stopReasonResult.errorMessage) {
							output.errorMessage = stopReasonResult.errorMessage;
						}
						if (stopReasonResult.refusal) {
							output.refusal = stopReasonResult.refusal;
						}
					}
					// Only update usage fields if present (not null).
					// Preserves input_tokens from message_start when proxies omit it in message_delta.
					if (event.usage) {
						if (event.usage.input_tokens != null) {
							output.usage.input = event.usage.input_tokens;
						}
						if (event.usage.output_tokens != null) {
							output.usage.output = event.usage.output_tokens;
						}
						if (event.usage.cache_read_input_tokens != null) {
							output.usage.cacheRead = event.usage.cache_read_input_tokens;
						}
						if (event.usage.cache_creation_input_tokens != null) {
							output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
						}
						// Vercel AI Gateway includes the TTL breakdown in deltas, though the SDK only types it on message_start.
						const cacheCreation = (
							event.usage as typeof event.usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }
						).cache_creation;
						if (cacheCreation?.ephemeral_1h_input_tokens != null) {
							output.usage.cacheWrite1h = cacheCreation.ephemeral_1h_input_tokens;
						}
						// Anthropic reports reasoning tokens as a subset of output tokens.
						const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
						if (thinkingTokens != null) {
							output.usage.reasoning = thinkingTokens;
						}
						const reportedSpeed = readReportedSpeed(event.usage);
						if (reportedSpeed) output.speed = reportedSpeed;
					}
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateAnthropicCost(usageModel, output);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Anthropic stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}
			if (inputTransformations && inputTransformations.length > 0) {
				appendAssistantMessageDiagnostic(output, {
					type: "anthropic_input_transformations",
					timestamp: Date.now(),
					details: {
						transformations: inputTransformations.map((transformation) => ({
							type: transformation.type ?? undefined,
							path: transformation.path ?? undefined,
							reason: transformation.reason ?? undefined,
						})),
					},
				});
			}

			if (fallbackBoundary > 0) {
				// Drop the declining model's thinking and tool_use blocks (text stays:
				// the serving model continued from it). Streamed deltas already showed
				// them; this prunes only the persisted message that later turns echo.
				const kept = output.content.filter((block, index) => index >= fallbackBoundary || block.type === "text");
				output.content.length = 0;
				output.content.push(...kept);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const providerErrorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			// A failing response can still have named its serving model before it failed.
			output.responseModel ||= extractResponseModelFromError(error, model.id);
			output.errorMessage = attributeProviderError(providerErrorMessage, model, output.responseModel);
			// Classifiers read this, not the prefixed text. See AssistantMessage.providerErrorMessage.
			if (output.errorMessage !== providerErrorMessage) output.providerErrorMessage = providerErrorMessage;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 *
 * Three cases, in the order they are checked:
 *
 * - The catalog maps the level to a string: send that.
 * - The catalog maps it to an explicit `null`: the model does NOT accept an
 *   effort value for this level, so return undefined and omit
 *   `output_config.effort` entirely. `getSupportedThinkingLevels` already reads
 *   `null` that way; this function used to disagree and fall through to the
 *   switch below, which invented a plausible-looking value. That is how a turn
 *   rerouted onto claude-fable-5 — a model whose adaptive effort vocabulary is
 *   just `"low"` — put `output_config.effort: "medium"` on the wire and got
 *   `400 invalid_request_error: Invalid effort level` back. Omitting the field
 *   leaves adaptive thinking at the model's own default, which every
 *   adaptive-thinking model accepts.
 * - The level is absent from the map (or there is no map): fall through to the
 *   standard low/medium/high vocabulary. An absent key means "passes through
 *   unchanged", which is the catalog convention for the common levels.
 *
 * Note: effort "max" is available on most adaptive-thinking Claude models, while native
 * "xhigh" is only available on Opus 4.7/4.8, Opus 5, and Sonnet 5.
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort | undefined {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;
	if (mapped === null) return undefined;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	if (!getAnthropicFederation(model, options?.apiKey, options?.headers, options?.env)) {
		assertRequestAuth(model.provider, options?.apiKey, options?.headers);
	}

	// The "fast" processing tier is Anthropic fast mode here; "flex" has no
	// Anthropic equivalent and is ignored.
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
		...(options?.serviceTier === "fast" ? { speed: "fast" as const } : {}),
	} satisfies AnthropicOptions;
	if (!options?.reasoning) {
		return stream(model, context, {
			...base,
			thinkingEnabled: false,
		} satisfies AnthropicOptions);
	}

	// For models with adaptive thinking: use an effort level.
	// For older models: use budget-based thinking.
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			...(effort !== undefined ? { effort } : {}),
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
	federation?: AnthropicFederationConfig,
	identity?: ClientIdentity,
): { client: Anthropic; isOAuthToken: boolean } {
	// Copilot: Bearer auth.
	if (model.provider === "github-copilot") {
		const client = new PiAnthropic({
			apiKey: null,
			authToken: apiKey ?? null,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch,
			defaultHeaders: mergeHeaders(
				getIdentityHeaders(model, identity),
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers instead of the client identity.
	if (apiKey && isOAuthToken(apiKey)) {
		const client = new PiAnthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key, header-owned auth, or workload identity federation.
	const compat = getAnthropicCompat(model);
	const sessionAffinityHeaders: ProviderHeaders = {};
	if (sessionId && compat.sendSessionAffinityHeaders) {
		const header = compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity";
		sessionAffinityHeaders[header] = sessionId;
	}
	const defaultHeaders = mergeHeaders(
		getIdentityHeaders(model, identity),
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		sessionAffinityHeaders,
		model.headers,
		optionsHeaders,
	);
	if (federation) {
		const key = JSON.stringify([model.baseUrl, federation]);
		if (federationClient?.key !== key || federationClient.fetch !== fetch) {
			const client = new PiAnthropic({
				apiKey: null,
				authToken: null,
				config: federation,
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
				fetch,
			});
			federationClient = { key, fetch, client };
		}
		return { client: federationClient.client.withOptions({ defaultHeaders }), isOAuthToken: false };
	}

	const client = new PiAnthropic({
		apiKey: apiKey ?? null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders,
	});

	return { client, isOAuthToken: false };
}

/** Per-request features resolved in `stream()` that need a beta and a request parameter. */
interface AnthropicRequestFeatures {
	/** Server-side refusal fallbacks (see `resolveFallbacks`). */
	fallbacks?: AnthropicFallbacks;
	/** Fast mode was requested for a model that supports it (see `AnthropicOptions.speed`). */
	fastMode?: boolean;
}

function getBetaFeatures(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	isOAuthToken: boolean,
	nativeToolChanges: boolean,
	options?: AnthropicOptions,
	requestFeatures: AnthropicRequestFeatures = {},
): NonNullable<MessageCreateParamsStreaming["betas"]> {
	let configuredFeatures: string | null | undefined;
	for (const headers of [model.headers, options?.headers]) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (name.toLowerCase() === "anthropic-beta") configuredFeatures = value;
		}
	}
	if (configuredFeatures === null) return [];
	if (configuredFeatures !== undefined) {
		return [
			...new Set(
				configuredFeatures
					.split(",")
					.map((feature) => feature.trim())
					.filter((feature) => feature.length > 0),
			),
		];
	}

	const features: NonNullable<MessageCreateParamsStreaming["betas"]> = [];
	if (isOAuthToken) features.push("claude-code-20250219", "oauth-2025-04-20");
	if (shouldUseFineGrainedToolStreamingBeta(model, context)) features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	if (
		model.reasoning &&
		options?.thinkingEnabled === true &&
		(options.interleavedThinking ?? true) &&
		model.compat?.forceAdaptiveThinking !== true
	) {
		features.push(INTERLEAVED_THINKING_BETA);
	}
	// Grants the `fallbacks` request parameter and applies fallback credit
	// automatically on server-side retries (no separate credit header needed).
	if (requestFeatures.fallbacks !== undefined) features.push(SERVER_SIDE_FALLBACK_BETA);
	// Grants the `speed` request parameter and makes the response report
	// `usage.speed`. Harmless on a request that ends up without `speed`.
	if (requestFeatures.fastMode === true) features.push(FAST_MODE_BETA);
	if (model.compat?.supportsMidConvoEffort === true) {
		features.push(MID_CONVERSATION_OUTPUT_CONFIG_BETA, THINKING_BINDING_CONTROLS_BETA);
	}
	if (nativeToolChanges) features.push(INLINE_TOOLS_BETA);
	return [...new Set(features)];
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
	requestFeatures: AnthropicRequestFeatures = {},
	disablePreferredStrictTools = false,
): {
	params: MessageCreateParamsStreaming;
	hasPreferredStrictTools: boolean;
	/** Effort of the final effort marker, recorded on the reply so later requests can replay it. */
	providerThinkingLevel: AnthropicEffort | undefined;
} {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	const compat = getAnthropicCompat(model);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const initialSystemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	const conversationMessages = initialSystemMessage ? transformedMessages.slice(1) : transformedMessages;
	// Native tool changes keep the request-level tool list fixed and define every later tool
	// by value in a `tool_addition` block, which also expresses same-name redefinitions.
	// Anthropic rejects a tool list where every tool is deferred, so there must be an initial
	// active tool to anchor the placeholder. Otherwise the current tool list is sent.
	let hasPreferredStrictTools = false;
	const convertToolDefinitions = (tools: Tool[], toolCacheControl?: CacheControlEphemeral): BetaTool[] => {
		const definitions = convertTools(
			tools,
			isOAuthToken,
			compat.supportsEagerToolInputStreaming,
			compat.supportsStrictTools,
			toolCacheControl,
			disablePreferredStrictTools,
		);
		if (
			definitions.some((definition, index) => {
				const config = tools[index].constrainedSampling;
				return definition.strict === true && config && config.type === "json_schema" && config.strict === "prefer";
			})
		) {
			hasPreferredStrictTools = true;
		}
		return definitions;
	};
	const initialTools = initialSystemMessage?.toolsAdded ?? [];
	const nativeToolChanges =
		compat.supportsMidConvoSystemMessages && compat.supportsMidConvoToolChanges && initialTools.length > 0;
	const thinkingDisabled =
		model.reasoning && options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null;
	// Effort cannot change between messages while thinking is disabled, so "off" sends no effort markers.
	const effortMessages = model.compat?.supportsMidConvoEffort === true && !thinkingDisabled;
	const converted = convertMessages(
		conversationMessages,
		isOAuthToken,
		cacheControl,
		compat.allowEmptySignature,
		effortMessages ? model.provider : undefined,
		nativeToolChanges ? convertToolDefinitions : undefined,
	);
	const activeEffort = options?.effort ?? "high";
	const betaFeatures = getBetaFeatures(model, context, isOAuthToken, nativeToolChanges, options, requestFeatures);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: effortMessages ? insertThinkingLevelMessages(converted, activeEffort) : converted.messages,
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
		...(betaFeatures.length > 0 ? { betas: betaFeatures } : {}),
	};

	// For OAuth tokens, we MUST include Claude Code identity
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (initialSystemText) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(initialSystemText),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (initialSystemText) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(initialSystemText),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	if (
		options?.temperature !== undefined &&
		!options?.thinkingEnabled &&
		model.compat?.supportsMidConvoEffort !== true &&
		compat.supportsTemperature
	) {
		params.temperature = options.temperature;
	}

	const toolCacheControl = compat.supportsCacheControlOnTools ? cacheControl : undefined;
	if (nativeToolChanges) {
		// Initial tools stay active with the cache breakpoint on the last one, followed by the
		// placeholder. The list never changes afterwards: later tools are defined by value in
		// `tool_addition` blocks and withdrawn by `tool_removal`, so the cached prefix survives
		// every tool change.
		params.tools = [...convertToolDefinitions(initialTools, toolCacheControl), DEFERRED_TOOL_PLACEHOLDER];
	} else {
		const tools = getCurrentTools(context.messages);
		if (tools.length > 0) {
			params.tools = convertToolDefinitions(tools, toolCacheControl);
		}
	}

	if (thinkingDisabled) {
		// No effort is sent, so the model default applies. Anthropic rejects `block_binding`
		// with disabled thinking.
		params.thinking = { type: "disabled" };
	} else if (effortMessages) {
		// Managed effort models use adaptive thinking so prefix mismatches can
		// be dropped instead of surfacing as persistent 400 responses.
		params.thinking = {
			type: "adaptive",
			display: options?.thinkingDisplay ?? "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		};
		params.output_config = { effort: "high" };
	} else if (model.reasoning && options?.thinkingEnabled) {
		// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
		// older Claude 4 models (whose API default is also "summarized").
		const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
		if (model.compat?.forceAdaptiveThinking === true) {
			// Adaptive thinking: Claude decides when and how much to think.
			params.thinking = { type: "adaptive", display };
			if (options.effort) {
				params.output_config = { effort: options.effort };
			}
		} else {
			// Budget-based thinking for older models
			params.thinking = {
				type: "enabled",
				budget_tokens: options.thinkingBudgetTokens || 1024,
				display,
			};
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	// `fallbacks` needs the server-side-fallback beta; a configured `anthropic-beta`
	// header that leaves it out keeps the parameter off the wire.
	if (requestFeatures.fallbacks !== undefined && betaFeatures.includes(SERVER_SIDE_FALLBACK_BETA)) {
		params.fallbacks = requestFeatures.fallbacks;
	}

	return { params, hasPreferredStrictTools, providerThinkingLevel: effortMessages ? activeEffort : undefined };
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertToolResult(msg: ToolResultMessage, content = msg.content): ContentBlockParam {
	return {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content: convertContentBlocks(content),
		is_error: msg.isError,
	};
}

interface ConvertedAnthropicMessages {
	messages: MessageParam[];
	assistantLevels: Map<number, AnthropicEffort>;
}

function convertMessages(
	transformedMessages: Message[],
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
	managedProvider?: string,
	/** Converts tool definitions for native `tool_addition` blocks; undefined when tool changes are not native. */
	convertToolDefinitions?: (tools: Tool[]) => BetaTool[],
): ConvertedAnthropicMessages {
	const params: MessageParam[] = [];
	const assistantLevels = new Map<number, AnthropicEffort>();
	// Later system messages are held back and emitted directly before the next assistant
	// message (or at the end of the transcript). Anthropic requires `tool_result` blocks to
	// immediately follow their `tool_use`, so a system message between them is rejected; this
	// also mirrors where the managed-effort system messages are inserted. As a result an
	// update placed before a user message in the transcript lands after it on the wire.
	const pendingSystemMessages: MessageParam[] = [];
	const flushPendingSystemMessages = (): void => {
		params.push(...pendingSystemMessages);
		pendingSystemMessages.length = 0;
	};

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "system") {
			// Later system messages only reach this point when the model accepts them natively;
			// otherwise the transcript was collapsed into the leading message before conversion.
			const text = renderSystemMessageUpdate(msg);
			const blocks: ContentBlockParam[] = [];
			if (text.length > 0) blocks.push({ type: "text", text: sanitizeSurrogates(text) });
			if (convertToolDefinitions) {
				const added = msg.toolsAdded ?? [];
				const redefined = new Set(added.map((tool) => tool.name));
				for (const tool of msg.toolsRemoved ?? []) {
					// A new definition under the same name replaces the old one, so no removal is needed.
					if (redefined.has(tool.name)) continue;
					blocks.push({
						type: "tool_removal",
						tool: { type: "tool_reference", name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name },
					});
				}
				for (const definition of convertToolDefinitions(added)) {
					blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
				}
			}
			if (blocks.length > 0) pendingSystemMessages.push({ role: "system", content: blocks });
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return convertImageBlock(item);
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			flushPendingSystemMessages();
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					const thinkingSignature = block.thinkingSignature;
					const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
					if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
					if (!hasThinkingSignature) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			const messageIndex = params.length;
			params.push({
				role: "assistant",
				content: blocks,
			});
			if (
				managedProvider !== undefined &&
				msg.api === "anthropic-messages" &&
				msg.provider === managedProvider &&
				isAnthropicEffort(msg.providerThinkingLevel)
			) {
				assistantLevels.set(messageIndex, msg.providerThinkingLevel);
			}
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint.
			const toolResults: ContentBlockParam[] = [];
			// Anthropic rejects error tool results that contain anything but text, so their images follow
			// all tool results of the turn, which must come first in the user message (#10794).
			const errorImages: ContentBlockParam[] = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const toolMsg = transformedMessages[j] as ToolResultMessage;
				const split = splitErrorToolResultImages(toolMsg);
				toolResults.push(convertToolResult(toolMsg, split?.content));
				if (split) {
					errorImages.push({ type: "text", text: split.caption }, ...split.images.map(convertImageBlock));
				}
				j++;
			}

			// Skip the messages we've already processed.
			i = j - 1;

			params.push({
				role: "user",
				content: [...toolResults, ...errorImages],
			});
		}
	}

	flushPendingSystemMessages();

	// Add cache_control to the last user or system message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user" || lastMessage.role === "system") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" ||
						lastBlock.type === "image" ||
						lastBlock.type === "tool_result" ||
						lastBlock.type === "tool_addition" ||
						lastBlock.type === "tool_removal")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return { messages: params, assistantLevels };
}

function isAnthropicEffort(value: unknown): value is AnthropicEffort {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function insertThinkingLevelMessages(
	converted: ConvertedAnthropicMessages,
	activeEffort: AnthropicEffort,
): MessageParam[] {
	const messages: MessageParam[] = [];
	for (let index = 0; index < converted.messages.length; index++) {
		const historicalEffort = converted.assistantLevels.get(index);
		if (historicalEffort !== undefined) {
			messages.push({ role: "system", content: [], output_config: { effort: historicalEffort } });
		}
		messages.push(converted.messages[index]);
	}
	messages.push({ role: "system", content: [], output_config: { effort: activeEffort } });
	return messages;
}

function shouldUseFineGrainedToolStreamingBeta(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
): boolean {
	return getCurrentTools(context.messages).length > 0 && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

// Keywords Anthropic strict tool use rejects with a 400 for the whole request.
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
const ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"maxItems",
	"uniqueItems",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
]);
const ANTHROPIC_STRICT_STRING_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);

const isAnthropicStrictUnsupportedKeyword: UnsupportedStrictSchemaKeywordCheck = (key, value) => {
	if (ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS.has(key)) return true;
	if (key === "minItems") return value !== 0 && value !== 1;
	if (key === "format") return typeof value !== "string" || !ANTHROPIC_STRICT_STRING_FORMATS.has(value);
	return false;
};

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	supportsStrictTools: boolean,
	cacheControl?: CacheControlEphemeral,
	disablePreferredStrictTools = false,
): BetaTool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const config = tool.constrainedSampling;
		const strict =
			disablePreferredStrictTools && config && config.type === "json_schema" && config.strict === "prefer"
				? undefined
				: resolveJsonSchemaStrictSampling(tool, supportsStrictTools, isAnthropicStrictUnsupportedKeyword);
		const parameters = getJsonSchemaToolParameters(tool, strict);
		const schema = parameters as { properties?: unknown; required?: string[] };
		const legacyInputSchema = {
			type: "object" as const,
			properties: schema.properties ?? {},
			required: schema.required ?? [],
		};
		const inputSchema =
			strict === true
				? {
						...(parameters as Record<string, unknown>),
						...legacyInputSchema,
					}
				: legacyInputSchema;

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(strict === true ? { strict: true } : {}),
			input_schema: inputSchema,
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(
	reason: BetaStopReason | string,
	stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string; refusal?: RefusalDetails } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal": {
			// A terminal refusal *for this request*: either fallbacks were off, or every
			// model in the chain declined / the category had no recommended fallback.
			// Name the category so the user can tell a policy decline from a model
			// error, and hand the same facts to consumers structurally in `refusal` so
			// the harness can escalate to another model without parsing this sentence.
			const category = stopDetails?.category;
			const explanation = stopDetails?.explanation;
			return {
				refusal: { category: category ?? null, ...(explanation ? { explanation } : {}) },
				stopReason: "error",
				errorMessage: `The model's safety classifier declined this request${
					category ? ` (category: ${category})` : ""
				}${explanation ? `: ${explanation}` : ""}. Retrying the same request on a different model (e.g. an Opus 4.x) usually succeeds.`,
			};
		}
		case "pause_turn": // Stop is good enough -> resubmit
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
