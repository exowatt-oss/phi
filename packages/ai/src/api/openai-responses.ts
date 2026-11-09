import OpenAI from "openai";
import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputContent,
	ResponseInputItem,
} from "openai/resources/responses/responses.js";
import {
	clampThinkingLevel,
	getOpenAIResponsesFastServiceTier,
	getUnsupportedFastServiceTierError,
	isBedrockOpenAIEndpoint,
} from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	ServiceTier,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";
import {
	extractOpenAICompatibleGatewayError,
	formatActionableGatewayError,
	formatProviderError,
	normalizeProviderError,
} from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest, retryProviderRequestOnce } from "../utils/provider-retry.ts";
import { getDeclaredTools, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolSupport,
	isRetryableResponsesStreamError,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const CHATGPT_WORKSPACE_LIMIT_HINT =
	"You've reached your ChatGPT workspace's usage limit. Ask your workspace admin to increase it at admin.openai.com → Workspace → Usage limits.";
// Fixed reasoning.effort while configuration_update items carry the thinking level.
const CONFIGURATION_UPDATE_REQUEST_EFFORT = "medium";

/**
 * OpenAI API keys start with `sk-`; a different credential sent directly to OpenAI
 * is a Sign in with ChatGPT access token.
 */
function isChatGPTSignIn(model: Model<"openai-responses">, apiKey: string | undefined): boolean {
	return (
		model.provider === "openai" &&
		model.baseUrl === "https://api.openai.com/v1" &&
		apiKey !== undefined &&
		!apiKey.startsWith("sk-")
	);
}

type ExplicitPromptCacheOptions = {
	mode: "explicit";
	ttl?: "30m";
};

type ExplicitPromptCacheBreakpoint = {
	mode: "explicit";
};

type ExplicitPromptCacheContent = ResponseInputContent & {
	prompt_cache_breakpoint?: ExplicitPromptCacheBreakpoint;
};

type InstructionMessage = {
	item: ResponseInputItem;
	role: "system" | "developer";
	content: string | ResponseInputContent[];
};

function getInstructionMessage(item: ResponseInputItem | undefined): InstructionMessage | undefined {
	if (!item || !("role" in item) || !("content" in item)) return undefined;
	if (item.role !== "system" && item.role !== "developer") return undefined;
	if (typeof item.content === "string") return { item, role: item.role, content: item.content };
	if (Array.isArray(item.content)) return { item, role: item.role, content: item.content };
	return undefined;
}

function isCacheableContent(content: ResponseInputContent): boolean {
	return content.type === "input_text" || content.type === "input_image" || content.type === "input_file";
}

function addExplicitPromptCacheBreakpoint(messages: ResponseInput): ResponseInput {
	let breakpointMessageIndex = -1;
	let breakpointContentIndex = -1;

	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const instruction = getInstructionMessage(messages[messageIndex]);
		if (!instruction) break;

		const content =
			typeof instruction.content === "string"
				? [{ type: "input_text", text: instruction.content } satisfies ResponseInputContent]
				: instruction.content;
		for (let contentIndex = content.length - 1; contentIndex >= 0; contentIndex--) {
			if (isCacheableContent(content[contentIndex])) {
				breakpointMessageIndex = messageIndex;
				breakpointContentIndex = contentIndex;
				break;
			}
		}
	}

	if (breakpointMessageIndex < 0) return messages;

	return messages.map((item, messageIndex) => {
		if (messageIndex !== breakpointMessageIndex) return item;
		const instruction = getInstructionMessage(item);
		if (!instruction) return item;
		const content =
			typeof instruction.content === "string"
				? [{ type: "input_text", text: instruction.content } satisfies ResponseInputContent]
				: instruction.content;
		const nextContent: ResponseInputContent[] = content.map((block, contentIndex) =>
			contentIndex === breakpointContentIndex
				? ({ ...block, prompt_cache_breakpoint: { mode: "explicit" } } satisfies ExplicitPromptCacheContent)
				: block,
		);
		return { ...instruction.item, content: nextContent } as ResponseInputItem;
	});
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

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

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsExplicitPromptCacheBreakpoints:
			model.compat?.supportsExplicitPromptCacheBreakpoints ?? model.compat?.supportsExplicitPromptCacheMode ?? false,
		fastServiceTier: model.compat?.fastServiceTier ?? "",
		fastServiceTierCostMultiplier: model.compat?.fastServiceTierCostMultiplier ?? 2,
		sortToolSchemaKeys: model.compat?.sortToolSchemaKeys ?? isBedrockOpenAIEndpoint(model),
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		supportsMidConvoEffort: model.compat?.supportsMidConvoEffort ?? false,
	};
}

/** Effort to send in configuration_update items, or undefined to send it as reasoning.effort. */
function getConfigurationUpdateEffort(
	model: Model<"openai-responses">,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat>,
): string | undefined {
	if (
		!compat.supportsMidConvoEffort ||
		!options?.reasoningEffort ||
		// Sign in with ChatGPT rejects configuration_update items.
		isChatGPTSignIn(model, options.apiKey)
	) {
		return undefined;
	}
	return model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

/**
 * GPT-5.6+ prompt caching. phi always uses explicit mode on these models: the cache
 * is anchored at the stable-instruction breakpoint (see `addExplicitPromptCacheBreakpoint`)
 * with a 30-minute lifetime whenever caching is on, which is what keeps large sessions
 * cached on Bedrock Mantle. `cacheRetention: "none"` keeps explicit mode with no
 * breakpoint, which disables the implicit prefix cache. `prompt_cache_retention` is
 * never sent alongside these options (see `getPromptCacheRetention`).
 */
function getPromptCacheOptions(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): ExplicitPromptCacheOptions | undefined {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	return cacheRetention === "none" ? { mode: "explicit" } : { mode: "explicit", ttl: "30m" };
}

/** Label for a Responses API error: the actual provider, not always "OpenAI". */
function getResponsesErrorPrefix(model: Model<"openai-responses">): string {
	return `${model.provider === "openai" ? "OpenAI" : model.provider} API error`;
}

function hasResponsesSemanticOutput(output: AssistantMessage): boolean {
	return output.content.length > 0;
}

function canRetryResponsesStream(output: AssistantMessage, error: unknown, signal?: AbortSignal): boolean {
	const streamError = error as { retryableWithoutResponseId?: boolean };
	return (
		!signal?.aborted &&
		!hasResponsesSemanticOutput(output) &&
		(output.responseId !== undefined || streamError.retryableWithoutResponseId === true) &&
		isRetryableResponsesStreamError(error)
	);
}

type ResponsesErrorMetadata = Error & {
	gatewayOriginated?: boolean;
	status?: unknown;
	headers?: unknown;
};

function hasGatewayMetadata(metadata: ReturnType<typeof extractOpenAICompatibleGatewayError>): boolean {
	return (
		metadata.callId !== undefined ||
		metadata.requestId !== undefined ||
		metadata.upstreamDeployment !== undefined ||
		metadata.upstreamModel !== undefined ||
		metadata.allowedRegion !== undefined ||
		metadata.attemptedRetries !== undefined ||
		metadata.maxRetries !== undefined ||
		metadata.attemptedFallbacks !== undefined ||
		metadata.maxFallbacks !== undefined
	);
}

function isGatewayOriginatedError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const streamError = error as ResponsesErrorMetadata;
	if (streamError.gatewayOriginated !== undefined) return streamError.gatewayOriginated;
	return hasGatewayMetadata(extractOpenAICompatibleGatewayError(error));
}

function attachResponseErrorMetadata(error: unknown, headers: Headers): unknown {
	if (!(error instanceof Error)) return error;
	const providerError = error as ResponsesErrorMetadata;
	if (providerError.gatewayOriginated === undefined) {
		providerError.gatewayOriginated = hasGatewayMetadata(extractOpenAICompatibleGatewayError(error));
	}
	const normalized = normalizeProviderError(error);
	if (typeof providerError.status !== "number" && normalized.status !== undefined) {
		providerError.status = normalized.status;
	}
	if (!(providerError.headers instanceof Headers)) providerError.headers = headers;
	return error;
}

function shouldUseActionableGatewayHeadline(
	error: unknown,
	metadata: ReturnType<typeof extractOpenAICompatibleGatewayError>,
): boolean {
	if (!isGatewayOriginatedError(error) || (!hasGatewayMetadata(metadata) && metadata.status === undefined))
		return false;
	return (
		(metadata.status !== undefined && metadata.status >= 500 && metadata.status <= 599) ||
		(metadata.status === undefined && isRetryableResponsesStreamError(error))
	);
}

function resetResponsesOutputForRetry(output: AssistantMessage): void {
	output.content = [];
	delete output.responseId;
	delete output.responseModel;
	delete output.rawStopReason;
	delete output.errorMessage;
	delete output.providerErrorMessage;
	output.usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	output.stopReason = "pending";
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"] | ServiceTier;
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	// Start async processing
	(async () => {
		const compat = getCompat(model);
		const configurationUpdateEffort = getConfigurationUpdateEffort(model, options, compat);
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			...(configurationUpdateEffort === undefined ? {} : { providerThinkingLevel: configurationUpdateEffort }),
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
			// Create OpenAI client
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				options?.identity,
				options?.fetch,
				cacheSessionId,
			);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				compat,
				grammarToolInputProperties,
				configurationUpdateEffort,
			);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as typeof params;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const request = () => client.responses.create(params, requestOptions).withResponse();
			const processAttempt = async (requestResult: Awaited<ReturnType<typeof request>>, emitStart: boolean) => {
				const { data: openaiStream, response } = requestResult;
				try {
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);
					if (emitStart) stream.push({ type: "start", partial: output });

					await processResponsesStream(openaiStream, output, stream, model, {
						onProviderStreamEvent: options?.onProviderStreamEvent,
						serviceTier: normalizeServiceTier(options?.serviceTier),
						resolveServiceTier: (responseTier, requestTier) =>
							resolveServiceTier(model, responseTier, requestTier),
						grammarToolInputProperties,
						applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
						responseHeaders: response.headers,
					});
				} catch (error) {
					throw attachResponseErrorMetadata(error, response.headers);
				}
			};

			try {
				const firstAttempt = await retryProviderRequest(request, {
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				});
				await processAttempt(firstAttempt, true);
			} catch (error) {
				if (!canRetryResponsesStream(output, error, options?.signal)) throw error;
				resetResponsesOutputForRetry(output);
				await retryProviderRequestOnce(
					error,
					async () => {
						const retryAttempt = await request();
						await processAttempt(retryAttempt, false);
					},
					{
						maxRetryDelayMs: options?.maxRetryDelayMs,
						signal: options?.signal,
						shouldRetry: (retryError) =>
							!options?.signal?.aborted &&
							!hasResponsesSemanticOutput(output) &&
							isRetryableResponsesStreamError(retryError),
					},
				);
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const normalizedError = normalizeProviderError(error);
			const providerErrorMessage = formatProviderError(normalizedError);
			const gatewayError = extractOpenAICompatibleGatewayError(error);
			if (isGatewayOriginatedError(error)) {
				// Only the served model name; `x-litellm-model-id` is a deployment id and
				// would break the `responseModel` contract.
				output.responseModel ||= gatewayError.upstreamModel;
			}
			output.providerErrorMessage = providerErrorMessage;
			if (model.provider === "gateway" && shouldUseActionableGatewayHeadline(error, gatewayError)) {
				output.errorMessage = formatActionableGatewayError(gatewayError, model);
			} else {
				const errorMessage = formatProviderError(normalizedError, getResponsesErrorPrefix(model));
				// Sign in with ChatGPT shares the subscription's usage limit with other apps.
				// On ChatGPT Business plans, the workspace admin also sets a per-user limit.
				if (errorMessage.includes("subscription_sharing_usage_limit_exceeded")) {
					output.errorMessage = `${errorMessage}\nCheck your ChatGPT usage: ${CHATGPT_USAGE_URL}`;
				} else if (errorMessage.includes("subscription_sharing_workplace_individual_usage_limit_exceeded")) {
					output.errorMessage = `${errorMessage}\n${CHATGPT_WORKSPACE_LIMIT_HINT}`;
				} else {
					output.errorMessage = errorMessage;
				}
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
		serviceTier: options?.serviceTier,
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
) {
	const compat = getCompat(model);
	const headers: ProviderHeaders = { ...getIdentityHeaders(model, identity), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

function buildParams(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat>,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	configurationUpdateEffort: string | undefined,
) {
	const transcriptTools = resolveTranscriptTools(context.messages, getResponsesToolSupport(compat));
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
		configurationUpdateEffort,
	});
	if (compat.sortToolSchemaKeys) {
		// phi: tools declared in additional_tools items (every tool, on "changes" transports) get the same stable key order.
		for (const item of messages) {
			if (item.type === "additional_tools") item.tools = item.tools.map(sortFunctionToolSchemaKeys);
		}
	}

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	// Sign in with ChatGPT rejects these request fields.
	const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
	// Explicit breakpoints only mean something alongside `prompt_cache_options`.
	const input =
		compat.supportsExplicitPromptCacheBreakpoints && cacheRetention !== "none" && !omitUnsupportedFields
			? addExplicitPromptCacheBreakpoint(messages)
			: messages;
	const params: ResponseCreateParamsStreaming & { prompt_cache_options?: ExplicitPromptCacheOptions } = {
		model: model.id,
		input,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: omitUnsupportedFields ? undefined : getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: omitUnsupportedFields ? undefined : getPromptCacheOptions(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens && compat.supportsMaxOutputTokens && !omitUnsupportedFields) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined && !omitUnsupportedFields) {
		params.temperature = options?.temperature;
	}

	// GitHub Copilot has no processing-tier concept and 400s on the param.
	if (options?.serviceTier !== undefined && model.provider !== "github-copilot") {
		params.service_tier = normalizeServiceTier(
			toWireServiceTier(model, options.serviceTier) as ResponseCreateParamsStreaming["service_tier"],
		);
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
		if (compat.sortToolSchemaKeys) params.tools = params.tools.map(sortFunctionToolSchemaKeys);
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	if (model.reasoning) {
		if (reasoningEffort) {
			const requestedEffort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: reasoningEffort;
			const effort = configurationUpdateEffort === undefined ? requestedEffort : CONFIGURATION_UPDATE_REQUEST_EFFORT;
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}

	// Last so model and request sampling parameters override named request fields.
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}

function normalizeServiceTier(
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | ServiceTier | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	// OpenAI SDK 6.26 predates the renamed spelling; the wire API accepts both.
	return serviceTier as ResponseCreateParamsStreaming["service_tier"] | undefined;
}

/**
 * The session's `fast` tier becomes the model's own fast wire tier (Bedrock Astra: `ultrafast`).
 * Every other tier, explicit `ultrafast` included, is sent verbatim. Amazon Bedrock has no `fast`
 * spelling, so `fast` on a Bedrock model without a known fast tier fails locally with an
 * actionable error instead of an invalid `service_tier` or a silent standard-speed request.
 */
function toWireServiceTier(
	model: Model<"openai-responses">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | ServiceTier,
): ResponseCreateParamsStreaming["service_tier"] | ServiceTier | string {
	const unsupported = getUnsupportedFastServiceTierError(model, serviceTier ?? undefined);
	if (unsupported) throw new Error(unsupported);
	if (serviceTier !== "fast") return serviceTier;
	return getOpenAIResponsesFastServiceTier(model)?.tier ?? serviceTier;
}

/** Read the model's fast wire tier back as `fast`, so speed and pricing follow the tier actually served. */
function resolveServiceTier(
	model: Model<"openai-responses">,
	responseTier: ResponseCreateParamsStreaming["service_tier"] | ServiceTier | undefined,
	requestTier: ResponseCreateParamsStreaming["service_tier"] | ServiceTier | undefined,
): ResponseCreateParamsStreaming["service_tier"] | ServiceTier | undefined {
	const tier = responseTier ?? requestTier;
	const fastTier = getOpenAIResponsesFastServiceTier(model)?.tier;
	return fastTier !== undefined && (tier as string | undefined) === fastTier ? "fast" : tier;
}

function sortFunctionToolSchemaKeys<T extends { type: string; parameters?: unknown }>(tool: T): T {
	return tool.type === "function" && tool.parameters ? { ...tool, parameters: sortJsonKeys(tool.parameters) } : tool;
}

/** Recursively sort object keys (arrays keep their order) so a JSON schema serializes the same way every time. */
function sortJsonKeys<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => sortJsonKeys(item)) as T;
	if (value === null || typeof value !== "object") return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		sorted[key] = sortJsonKeys((value as Record<string, unknown>)[key]);
	}
	return sorted as T;
}

function getServiceTierCostMultiplier(
	model: Model<"openai-responses">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | ServiceTier | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "fast":
			// `fast` is OpenAI's renamed `priority`; a model's own fast wire tier (Bedrock) prices first.
			return getOpenAIResponsesFastServiceTier(model)?.costMultiplier ?? (model.id === "gpt-5.5" ? 2.5 : 2);
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | ServiceTier | undefined,
	model: Model<"openai-responses">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
