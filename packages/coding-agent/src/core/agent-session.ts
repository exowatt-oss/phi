/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCallOutcome,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type NewContextRequest,
	type PrepareNextTurnContext,
	runToolCall,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	contentText,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getOpenAIResponsesFastServiceTier,
	isBedrockOpenAIEndpoint,
	retryDelayMs,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	InferenceSpeed,
	Model,
	ProviderHeaders,
	ServiceTier,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getRefusalDetails,
	getSupportedThinkingLevels,
	isContextOverflow,
	isProviderUnavailableAssistantError,
	isRecoverableLength,
	isRefusalAssistantError,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
	supportsFastMode,
} from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { fitSuppliedImages } from "../utils/image-limits.ts";
import { collectImageAttachmentsFromText, hasImagePathCandidates } from "../utils/image-path-attach.ts";
import { processImage } from "../utils/image-process.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { agentSessionRegistry } from "./agent-session-registry.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import type { CacheWarmer, CacheWarmingStatus } from "./cache-warmer.ts";
import {
	BACKGROUND_COMPACTION_FRACTION,
	type CompactionPreparation,
	type CompactionResult,
	type ContextUsageEstimate,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	compactionLines,
	effectiveContextWindow,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateSystemPromptTokens,
	estimateTokens,
	estimateToolDefinitionTokens,
	generateBranchSummary,
	mergePinned,
	prepareCompaction,
	preparePruning,
	shouldCompact,
} from "./compaction/index.ts";
import { contextAwareCompactionEnabled } from "./context-aware-compaction.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentActivityOutcome,
	type BoundaryContextPreview,
	type ContextBreakdown,
	type ContextUsage,
	type ExecuteToolOptions,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeAutoCompactResult,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionBoundaryDraft,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolExposure,
	type ToolInfo,
	type ToolLoadout,
	type TreePreparation,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { type BeforeAgentStartTrigger, emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { SideQuestionRequest } from "./extensions/types.ts";
import { createToolNameMatcher, isMcpToolName } from "./mcp-servers.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { applyRoutedCost } from "./routing.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type CompactionTrigger,
	type ContextEditEntry,
	getLatestCompactionEntry,
	isPruneCompaction,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "./session-manager.ts";
import {
	applyToolModifiers,
	type CacheWarmingMode,
	DEFAULT_TOOL_NAMES,
	type SettingsManager,
} from "./settings-manager.ts";
import { runSideQuestion } from "./side-question.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, isSyntheticPath, type SourceInfo } from "./source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
	type SystemPromptRuntime,
} from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, combineUsage, createUsageTotals } from "./usage-totals.ts";
import {
	findLatestResponse,
	getBranchSelection,
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "./virtual-models.ts";

const MAX_CONTEXT_HANDOFF_CHARS = 20_000;

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Tool execution events of calls a tool made through `ctx.executeTool()` carry `parentToolCallId`. */
type WithParentToolCallId<E> = E extends {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? E & { parentToolCallId?: string }
	: E;

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled"; aborted: boolean }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "service_tier_changed"; tier: ServiceTier }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			contextWindowStarted?: boolean;
			/** Live inputs to retain when the UI rebuilds before request preparation finishes. */
			pendingMessages?: AgentMessage[];
			errorMessage?: string;
			/** True for LLM-free tool-result pruning: nothing was summarized away — UIs should surface a status line, not a compaction card. */
			prune?: boolean;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			/** A safety classifier declined the turn; it is being replayed on the next model in the chain. */
			type: "refusal_fallback";
			category: string | null;
			explanation: string | undefined;
			from: string;
			to: string;
			/** 1-indexed position of the model being escalated to, within the configured chain. */
			rung: number;
			chainLength: number;
	  }
	| {
			/** Declined with no usable model left in the chain: the error is terminal. */
			type: "refusal_fallback_exhausted";
			category: string | null;
			explanation: string | undefined;
			from: string;
			tried: string[];
	  }
	| {
			/** Non-sticky mode only: the chain head was restored after an escalated run. */
			type: "refusal_fallback_restored";
			to: string;
	  }
	| {
			/** The provider could not serve the turn (down, unreachable, or out of quota); it is being replayed on the next model in `errorFallback.chain`. */
			type: "error_fallback";
			reason: string;
			from: string;
			to: string;
			/**
			 * Thinking level actually in force on `to`, after clamping to what that
			 * model supports. A host that mirrors phi's model selection must adopt
			 * this instead of replaying the level it had for `from`.
			 */
			thinkingLevel: ThinkingLevel;
			/** 1-indexed position of the model being rerouted to, within the resolved chain. */
			rung: number;
			chainLength: number;
	  }
	| {
			/** Provider unavailable with no usable model left in the chain: the error is terminal. */
			type: "error_fallback_exhausted";
			reason: string;
			from: string;
			tried: string[];
	  }
	| {
			/** Non-sticky mode only: the original model was restored after a rerouted run. */
			type: "error_fallback_restored";
			from: string;
			to: string;
			/** Thinking level in force on `to` after the restore, clamped to what it supports. */
			thinkingLevel: ThinkingLevel;
	  }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Requested level before initial model-capability clamping. */
	preferredThinkingLevel?: ThinkingLevel;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Keeps the prompt cache entry of the last session request warm. */
	cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/**
	 * Whether the initial tools come from the `defaultTools` setting. When true, a resumed session
	 * replaces them with the loadout its transcript records, with `defaultToolModifiers` applied, and
	 * reload activates tools newly added to the setting. Tools removed from it stay active.
	 */
	usesDefaultTools?: boolean;
	/**
	 * `+name`/`-name` entries applied on top of the `defaultTools` setting, from `--tools`. Reload
	 * applies them to the reloaded setting too, so a removed tool stays removed.
	 */
	defaultToolModifiers?: string[];
	/**
	 * Optional allowlist of tool names or patterns (`*` matches any characters). When provided, only
	 * matching tools are exposed. A non-empty list without `mcp__` entries also keeps MCP tools
	 * registered for codemode and tool_search; only tool_search can declare them. An empty list
	 * exposes no tools.
	 */
	allowedToolNames?: string[];
	/** Optional denylist of tool names or patterns. When provided, matching tools are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/**
	 * Mutable ref shared with the Agent's stream function. `override` is the
	 * session's processing tier (`--service-tier`, `/fast`); undefined follows the
	 * `serviceTier` setting and `*-fast` model ids.
	 */
	serviceTierRef?: ServiceTierRef;
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
}

export interface ServiceTierRef {
	override?: ServiceTier;
}

/** Session entry recording a `/fast`-style tier change so `/resume` restores it. */
const SERVICE_TIER_ENTRY_TYPE = "service_tier";

const SERVICE_TIERS: ReadonlySet<string> = new Set<ServiceTier>(["default", "flex", "fast", "ultrafast"]);

function readServiceTierEntry(data: unknown): ServiceTier | undefined {
	const tier = (data as { tier?: unknown } | undefined)?.tier;
	return typeof tier === "string" && SERVICE_TIERS.has(tier) ? (tier as ServiceTier) : undefined;
}

/** Which fast tier, if any, a model can be served at. */
export type FastTierKind = "anthropic" | "openai";

const OPENAI_TIERED_APIS: ReadonlySet<string> = new Set([
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);

/**
 * "anthropic" for Claude Opus models the Claude API serves in fast mode,
 * "openai" for OpenAI-style APIs that take `service_tier` (GitHub Copilot
 * rejects it), undefined when a fast tier would be ignored or refused. Amazon
 * Bedrock's OpenAI endpoints have no `fast` tier of their own, so only models
 * with a known fast wire tier there (GPT-6 Astra: `ultrafast`) qualify.
 */
export function getFastTierKind(model: Model<any> | undefined): FastTierKind | undefined {
	if (!model) return undefined;
	if (model.api === "anthropic-messages") return supportsFastMode(model) ? "anthropic" : undefined;
	if (isBedrockOpenAIEndpoint(model) && !getOpenAIResponsesFastServiceTier(model)) return undefined;
	if (OPENAI_TIERED_APIS.has(model.api) && model.provider !== "github-copilot") return "openai";
	return undefined;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export type QueuedInputDisposition = "handled" | "queued";
export type PromptDisposition = QueuedInputDisposition | "started";

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe how an accepted prompt was dispatched. Not called if the prompt is rejected. */
	preflightResult?: (disposition: PromptDisposition) => void;
}

/** Options for model/thinking mutations. */
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	persist?: boolean;
}

/** @deprecated phi 0.83 name for {@link ModelMutationOptions}; `persist` now defaults to session-only. */
export type ModelChangeOptions = ModelMutationOptions;

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

interface ProviderRequestPrefix {
	provider: string;
	model: string;
	systemPrompt: string;
	tools: readonly AgentTool[];
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

function compactionStats(messages: AgentMessage[]): { toolResultsElided: number; turnsSummarized: number } {
	return {
		toolResultsElided: messages.filter((message) => message.role === "toolResult").length,
		turnsSummarized: messages.length,
	};
}

type AutoCompactionReason = "overflow" | "threshold" | "manual" | "checkpoint";
type CompactionEventReason = "manual" | "threshold" | "overflow";

function compactionEventReason(reason: AutoCompactionReason): CompactionEventReason {
	return reason === "checkpoint" ? "threshold" : reason;
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Last requested level before model-capability clamping; lets session-only
	 * switches survive a temporary hop through a non-reasoning model. */
	private _preferredThinkingLevel: ThinkingLevel;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _agentRunAbortRequested = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Inputs whose images are still being prepared; later inputs queue behind them (see _inCallOrder). */
	private _inputsPreparing = 0;
	private _inputPreparation: Promise<unknown> = Promise.resolve();
	/** Prompts admitted to start a run that has not started yet; later prompts treat them as streaming. */
	private _promptsStarting = 0;
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Provider-bound inputs waiting until request preparation can no longer add a context boundary. */
	private _pendingProviderMessages: AgentMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private _pendingNewContext: NewContextRequest | undefined;
	private _reportedUsagePrefix: ProviderRequestPrefix | null | undefined;
	private _providerRequestPrefix: ProviderRequestPrefix | undefined;
	private _skipNextProviderRequestPreflight = false;
	/** Manual /compact issued while a run was active; consumed at the next safe boundary. */
	private _pendingManualCompaction: { customInstructions?: string } | undefined = undefined;
	/** In-flight background summarization. Never locks the session — see _startBackgroundCompaction. */
	private _backgroundCompaction: { controller: AbortController; promise: Promise<void> } | undefined = undefined;
	/** Finished background summary awaiting application at the next safe boundary. */
	private _backgroundCompactionReady:
		| {
				summary?: string;
				firstKeptEntryId?: string;
				tokensBefore?: number;
				usage?: Usage;
				details?: unknown;
				fromExtension: boolean;
				stats?: { toolResultsElided: number; turnsSummarized: number };
				pinned?: string[];
				newContext?: NewContextRequest;
				/** Context tokens when the background snapshot was taken. */
				snapshotTokens?: number;
				/** Latest summary-compaction id when the snapshot was taken; a mismatch at apply time discards the result. */
				baselineCompactionId: string | null;
		  }
		| undefined = undefined;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	/**
	 * Failed response that the next request repeats, set by auto-retry and overflow recovery. The
	 * retry is routed with it as `failed`, since the context no longer contains it.
	 */
	private _failedResponse: AssistantMessage | undefined;

	// Refusal-escalation state (see _prepareRefusalFallback)
	/** Chain refs already declined/skipped during the current escalation, so the ladder never revisits a rung. */
	private _refusalTriedRefs = new Set<string>();
	/** Model to restore when `refusalFallback.sticky` is false and the escalated run finishes. */
	private _refusalRestoreModel: Model<any> | undefined = undefined;
	/** Remaining synthetic refusals for PI_DEBUG_FORCE_REFUSAL; see _takeForcedRefusal. */
	private _forcedRefusalsRemaining = Number.parseInt(process.env.PI_DEBUG_FORCE_REFUSAL ?? "0", 10) || 0;

	// Provider-outage rerouting state (see _prepareErrorFallback)
	/** Chain refs already tried during the current reroute, so the ladder never revisits a rung. */
	private _errorTriedRefs = new Set<string>();
	/** Model to restore when `errorFallback.sticky` is false and the rerouted run finishes. */
	private _errorRestoreModel: Model<any> | undefined = undefined;
	/** Set once the chain is exhausted, so repeat failures in the same run stay quiet. */
	private _errorFallbackExhausted = false;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	private _lastAssistantMessage: AssistantMessage | undefined;
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	private _isBeforeSettle = false;
	private _abortDuringBeforeSettle = false;
	private _isEmittingAgentSettled = false;
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _serviceTierRef: ServiceTierRef;
	private _initialActiveToolNames?: string[];
	/**
	 * Tools of the restored or reloaded loadout that are not registered yet, such as tools of MCP
	 * servers that are still connecting. They are activated when they are registered, and dropped when
	 * `setActiveToolsByName()` deactivates a tool or the next agent run starts.
	 */
	private _pendingToolNames = new Set<string>();
	private _usesDefaultTools: boolean;
	private _defaultToolModifiers: string[];
	/** Matches the `--tools` entries: tool names or patterns. */
	private _allowedTools?: (name: string) => boolean;
	/**
	 * Whether the allowlist filters MCP tools: it is empty (`--no-tools`) or names an MCP tool
	 * (`mcp__*`). Otherwise it keeps MCP tools registered for codemode and tool_search.
	 */
	private _allowlistFiltersMcp = false;
	private _excludedTools?: (name: string) => boolean;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	/** Created on the first `ctx.executeTool()` call. */
	private _nestedToolCalls: NestedToolCallRunner | undefined;
	/** Declared tools whose declarations requests leave out, from `prepareLoadout` hooks. */
	private _hiddenDeclarations: ReadonlySet<string> = new Set();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** Prompt options after before_agent_start mutations for the active run. */
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;
	/**
	 * phi: the last before_agent_start prompt sent to the provider and the base it was built on. A
	 * forced prompt is per run and never recorded, so the context breakdown carries it between runs.
	 */
	private _lastForcedSystemPrompt: { base: string; sent: string } | undefined;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._preferredThinkingLevel =
			config.preferredThinkingLevel ??
			(config.agent.state.model.reasoning
				? config.agent.state.thinkingLevel
				: (config.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL));
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._cacheWarmer = config.cacheWarmer;
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
		}
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._serviceTierRef = config.serviceTierRef ?? {};
		if (this._serviceTierRef.override === undefined) {
			this._serviceTierRef.override = this._readPersistedServiceTier();
		}
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._usesDefaultTools = config.usesDefaultTools ?? false;
		this._defaultToolModifiers = config.defaultToolModifiers ?? [];
		if (config.allowedToolNames) {
			this._allowedTools = createToolNameMatcher(config.allowedToolNames);
			this._allowlistFiltersMcp =
				config.allowedToolNames.length === 0 || config.allowedToolNames.some((entry) => entry.startsWith("mcp__"));
		}
		this._excludedTools = config.excludedToolNames ? createToolNameMatcher(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentToolResolver();
		this._installAgentNextTurnRefresh();
		this._installAgentRequestProjection();
		this._installAgentBoundaryHooks();
		// phi: request preflight (compaction at request time, pending-input restore) wraps the
		// canonical projection above, so it sees the projected context and re-adds live inputs.
		this._installAgentRequestPreflight();
		this._installAgentContextPersistence();
		this._installHiddenDeclarationsProjection();
		this._installAgentForcedPromptProjection();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		agentSessionRegistry.created(this);
		if (this._usesDefaultTools) this._restoreToolsFromTranscript(this._defaultToolModifiers);
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model, { signal });
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(
		selectedModel: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		thinkingLevel: ThinkingLevel;
	}> {
		// Route a virtual model first: summaries size their input and output from the model they get.
		const { model, thinkingLevel } = isVirtualModel(selectedModel)
			? await this._modelRuntime.resolveModel(selectedModel, convertToLlm(this.messages), {
					reason: "direct",
					thinkingLevel: this.thinkingLevel,
					signal,
				})
			: { model: selectedModel, thinkingLevel: this.thinkingLevel };
		if (this.agent.streamFunction === streamSimple) {
			return { ...(await this._getRequiredRequestAuth(model, signal)), thinkingLevel };
		}

		try {
			const result = await this._modelRuntime.getAuth(model, { signal });
			if (!result) return { model, thinkingLevel };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
				thinkingLevel,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			return { model, thinkingLevel };
		}
	}

	/**
	 * The model whose limits apply to `message`, or undefined when the message came from another
	 * model. Under a virtual selection, that is the physical model that produced it.
	 */
	private _modelForMessage(message: AssistantMessage): Model<any> | undefined {
		const model = this.model;
		if (model && isVirtualModel(model)) return this._modelRuntime.getPhysicalModel(message.provider, message.model);
		return model?.provider === message.provider && model.id === message.model ? model : undefined;
	}

	/**
	 * Record the selection on the current branch when the branch implies another one, so a resume
	 * restores it. Tree navigation can leave the latest `model_change` on another branch; responses
	 * cannot record a virtual selection because they name physical models. Responses do record a
	 * physical selection unless the branch holds a virtual one; checking a physical selection against
	 * responses would record it on every prompt while `prepareRequest` redirects to another model.
	 */
	private _recordSelection(): void {
		const model = this.model;
		if (!model) return;
		const getModel = (provider: string, modelId: string) => this._modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(this.sessionManager.getBranch(), getModel);
		if (!recorded || (recorded.provider === model.provider && recorded.modelId === model.id)) return;
		const recordedModel = getModel(recorded.provider, recorded.modelId);
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) return;
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	/** The model whose limits apply to the conversation. */
	private _limitsModel(): Model<any> | undefined {
		return this.routedModel?.model ?? this.model;
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolResolver(): void {
		this.agent.resolveToolCall = async (toolName, context) => {
			const definition = this._toolDefinitions.get(toolName)?.definition;
			const autoActivateOnCall = definition?.autoActivateOnCall;
			if (!autoActivateOnCall || (typeof autoActivateOnCall === "function" && !autoActivateOnCall(context)))
				return undefined;

			const tool = this._toolRegistry.get(toolName);
			if (!tool) return undefined;
			if (!this.getActiveToolNames().includes(toolName)) {
				this.setActiveToolsByName([...this.getActiveToolNames(), toolName]);
			}
			return tool;
		};
	}

	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = (context) => this._beforeToolCall(context);
		this.agent.afterToolCall = (context) => this._afterToolCall(context);
	}

	/** `tool_call` handlers. `parentToolCallId` is set for calls another tool made. */
	private async _beforeToolCall(
		{ toolCall, args }: BeforeToolCallContext,
		parentToolCallId?: string,
	): Promise<BeforeToolCallResult | undefined> {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				...(parentToolCallId ? { parentToolCallId } : {}),
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	}

	/** `tool_result` handlers and image normalization. `parentToolCallId` is set for calls another tool made. */
	private async _afterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		parentToolCallId?: string,
	): Promise<AfterToolCallResult | undefined> {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					...(parentToolCallId ? { parentToolCallId } : {}),
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
					isError,
					usage: result.usage,
				})
			: undefined;

		const content = hookResult?.content ?? result.content ?? [];
		// Runs after the extension hook so images injected or replaced by extensions are normalized too.
		const resizeOptions = this._limitsModel()?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
		});

		if (!hookResult && normalizedContent === content) {
			return undefined;
		}

		// The hook result already dropped structured content that replaced content no longer matches.
		return {
			content: normalizedContent,
			details: hookResult?.details,
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			isError: hookResult?.isError ?? isError,
			usage: hookResult?.usage,
		};
	}

	private _consumeNewContext(request?: NewContextRequest): AgentContext | undefined {
		const next = request ?? this._pendingNewContext;
		if (!next) return undefined;
		this._pendingNewContext = undefined;

		const handoff = next.handoff?.trim().slice(0, MAX_CONTEXT_HANDOFF_CHARS) || undefined;
		const usage = this.getContextUsage();
		this.sessionManager.appendContextWindow(handoff, usage?.tokens ?? null);
		this._reportedUsagePrefix = null;
		const messages = this.sessionManager.buildSessionContext().messages;
		this.agent.state.messages = messages;

		// The window replays its prompt/tool state ahead of the marker.
		const marker = messages.find((message) => message.role !== "system")!;
		this._emit({ type: "message_start", message: marker });
		this._emit({ type: "message_end", message: marker });

		return {
			messages: messages.slice(),
			tools: this.agent.state.tools.slice(),
		};
	}

	/** Whether `projection`, the current session projection, exceeds the compaction threshold of `model` (phi: effective window). */
	private _exceedsCompactionThreshold(model: Model<any>, projection: SessionProjection): boolean {
		if (model.contextWindow <= 0) return false;
		const settings = this.settingsManager.getCompactionSettings(this.model);
		return shouldCompact(
			estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens,
			effectiveContextWindow(model.contextWindow, settings, contextAwareCompactionEnabled() ? model : undefined),
			settings,
		);
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		const projection = this.sessionManager.buildSessionProjection();
		// Inputs that arrived during the run are persisted only when the request goes out, so the
		// projected context lacks them; they still count toward this request's size.
		const pending = this._pendingProviderMessages.filter((message) => !context.messages.includes(message));
		const requestContext = pending.length > 0 ? { ...context, messages: [...context.messages, ...pending] } : context;

		// A virtual selection is checked in prepareRequest, against the model the request is routed to.
		if (
			!model ||
			isVirtualModel(model) ||
			model.contextWindow <= 0 ||
			!shouldCompact(
				this._estimateContextTokens(requestContext).tokens,
				effectiveContextWindow(model.contextWindow, settings, contextAwareCompactionEnabled() ? model : undefined),
				settings,
			)
		) {
			return { ...context, messages: projection.messages };
		}
		await this._runAutoCompaction("threshold", false);
		return { ...context, messages: this.agent.state.messages.slice() };
	}

	/**
	 * Run a call that the tool call `parentToolCallId` made through `ctx.executeTool()`. It goes
	 * through the agent's tool pipeline with the session's hooks, against the callable tools.
	 */
	private async _executeNestedToolCall(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome> {
		this._nestedToolCalls ??= new NestedToolCallRunner({
			getTools: () => this._getCallableTools(),
			isSequential: () => this.agent.toolExecution === "sequential",
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const assistantMessage = this._findLastAssistantMessage();
				if (!assistantMessage) {
					return Promise.resolve({
						toolCall,
						result: { content: [{ type: "text", text: "No assistant message issued this call" }], details: {} },
						isError: true,
					});
				}
				return runToolCall(toolCall, {
					tools: this._getCallableTools(),
					assistantMessage,
					context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
					beforeToolCall: (context) => this._beforeToolCall(context, parentId),
					afterToolCall: (context) => this._afterToolCall(context, parentId),
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await this._extensionRunner.emit(event);
				this._emit(event);
			},
		});
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	/** Start a fresh model context while preserving the full session transcript. */
	newContext(options: NewContextRequest = {}): void {
		const request = { handoff: options.handoff?.trim() || undefined };
		if (this.isStreaming) {
			this._pendingNewContext = request;
			return;
		}
		this._consumeNewContext(request);
	}

	/**
	 * Best available native estimate of the active context. Exact-prefix usage wins; an unknown
	 * legacy prefix uses the larger of matching-model usage and the full prompt/tool/message estimate.
	 */
	private _estimateContextTokens(
		context: AgentContext = this.agent.state,
		estimateOptions: { declaredOnly?: boolean } = {},
	): ContextUsageEstimate {
		// phi: until the first request declares it into the transcript, the prompt lives only in the
		// session; count it anyway so the estimate covers it before the model reports usage.
		// `declaredOnly` counts the transcript as the model saw it, without that fallback.
		const declared = getCurrentSystemMessage(context.messages) !== undefined;
		const options = {
			model: this.model,
			systemPrompt: declared
				? getCurrentSystemPrompt(context.messages)
				: estimateOptions.declaredOnly
					? undefined
					: this.systemPrompt,
			tools: declared || !estimateOptions.declaredOnly ? context.tools : undefined,
		};
		const fullEstimate = estimateContextTokens(context.messages, { ...options, useReportedUsage: false });
		if (this._reportedUsageApplies(context)) {
			const estimate = estimateContextTokens(context.messages, options);
			return this._usageInvalidatedByLaterEntry(context.messages, estimate) ? fullEstimate : estimate;
		}

		if (this._reportedUsagePrefix !== undefined || !this._hasCurrentModelUsageAfterActiveCompaction()) {
			return fullEstimate;
		}

		const historicalEstimate = estimateContextTokens(context.messages, options);
		if (this._usageInvalidatedByLaterEntry(context.messages, historicalEstimate)) return fullEstimate;
		return historicalEstimate.tokens > fullEstimate.tokens ? historicalEstimate : fullEstimate;
	}

	/**
	 * Whether `estimate` anchors on usage that a later context edit or compaction on the branch
	 * invalidated: the provider counted a context that no longer exists.
	 */
	private _usageInvalidatedByLaterEntry(messages: AgentMessage[], estimate: ContextUsageEstimate): boolean {
		if (estimate.lastUsageIndex === null) return false;
		const usageMessage = messages[estimate.lastUsageIndex];
		const entryId = usageMessage ? this._findPersistedMessageEntryId(usageMessage) : undefined;
		if (entryId === undefined) return false;
		const branch = this.sessionManager.getBranch();
		const usageIndex = branch.findIndex((entry) => entry.id === entryId);
		if (usageIndex < 0) return false;
		return branch.slice(usageIndex + 1).some((entry) => entry.type === "context_edit" || entry.type === "compaction");
	}

	private _reportedUsageApplies(context: AgentContext): boolean {
		const prefix = this._reportedUsagePrefix;
		if (!prefix) return false;
		const model = this.model;
		const tools = context.tools ?? [];
		return (
			!!model &&
			prefix.provider === model.provider &&
			prefix.model === model.id &&
			prefix.systemPrompt === getCurrentSystemPrompt(context.messages) &&
			prefix.tools.length === tools.length &&
			prefix.tools.every((tool, index) => tool === tools[index])
		);
	}

	private _hasCurrentModelUsageAfterActiveCompaction(): boolean {
		const latestCompaction = this.sessionManager.buildContextEntries()[0];
		if (latestCompaction?.type !== "compaction") return true;
		const model = this.model;
		if (!model) return false;

		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i > branch.lastIndexOf(latestCompaction); i--) {
			const entry = branch[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const message = entry.message;
			if (
				message.provider === model.provider &&
				message.model === model.id &&
				message.stopReason !== "aborted" &&
				message.stopReason !== "error" &&
				calculateContextTokens(message.usage) > 0
			) {
				return true;
			}
		}
		return false;
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const contextAware = contextAwareCompactionEnabled();
			const compactionRequest = contextAware ? turn.compaction : undefined;
			const startedNewContext =
				this._consumeNewContext(turn.newContext) ??
				(compactionRequest?.mode === "fresh"
					? this._consumeNewContext({ handoff: compactionRequest.notes })
					: undefined);
			const baseContext = startedNewContext ?? turn.context;
			const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context: baseContext }, signal);
			const previousContext = previousSnapshot?.context ?? baseContext;
			let nextContext = previousContext;
			const settings = this.settingsManager.getCompactionSettings();
			const model = this.model;
			const contextWindow = model?.contextWindow ?? 0;
			const lines = compactionLines(contextWindow, settings, contextAware ? model : undefined);
			const hasToolCall = turn.message.content.some((part) => part.type === "toolCall");
			// Providers report tool-calling turns as "toolUse" ("stop" shows up on some
			// gateways, "length"-truncated tool calls are failed but the loop continues);
			// error/aborted turns never reach this hook.
			const runContinues =
				hasToolCall &&
				(turn.message.stopReason === "toolUse" ||
					turn.message.stopReason === "stop" ||
					turn.message.stopReason === "length");
			// Usage from the just-finished LLM call plus a chars/4 estimate of the
			// trailing tool results, which that usage cannot include yet. Without the
			// trailing estimate a turn that just read huge files still looks "under"
			// the threshold and the next LLM call overflows instead of compacting here.
			const contextEstimate = runContinues ? this._estimateContextTokens(previousContext) : undefined;
			const effectiveWindow = lines.effectiveWindow;
			const canManageContext =
				!startedNewContext &&
				settings.enabled &&
				runContinues &&
				contextWindow > 0 &&
				this._autoCompactionAbortController === undefined &&
				this._compactionAbortController === undefined &&
				contextEstimate !== undefined &&
				contextEstimate.usageTokens > 0;

			const messagesBeforeCompaction = this.agent.state.messages;
			const latestCompactionBefore = getLatestCompactionEntry(this.sessionManager.getBranch());
			let contextManagementRan = false;
			if (!startedNewContext && compactionRequest?.mode === "summarize" && contextWindow > 0) {
				const contextTokens = contextEstimate?.tokens ?? this._estimateContextTokens(previousContext).tokens;
				if (contextTokens >= lines.windowOpenAt) {
					const checkpointNotes = compactionRequest.notes.trim();
					if (this._backgroundCompactionReady) {
						const applied = await this._applyBackgroundCompaction({
							contextTokens,
							trigger: "checkpoint",
							checkpointNotes,
							pinned: compactionRequest.keep,
						});
						if (!applied) {
							await this._runAutoCompaction("checkpoint", false, checkpointNotes, compactionRequest.keep);
						}
					} else {
						await this._runAutoCompaction("checkpoint", false, checkpointNotes, compactionRequest.keep);
					}
				} else {
					this._appendCheckpointMessage(compactionRequest.notes, compactionRequest.keep);
				}
				contextManagementRan = true;
			}

			if (canManageContext && !contextManagementRan) {
				contextManagementRan = true;
				let contextTokens = contextEstimate.tokens;

				const manualRequest = this._pendingManualCompaction;
				if (manualRequest) {
					// A /compact issued mid-run executes here, at a step boundary,
					// instead of aborting the run it was issued during.
					this._pendingManualCompaction = undefined;
					await this._runAutoCompaction("manual", false, manualRequest.customInstructions);
				} else {
					// Tier 1 (LLM-free): elide old tool results once past half the window.
					const prune = preparePruning(
						this.sessionManager.getBranch(),
						settings,
						contextWindow,
						contextTokens,
						this._compactionCeilingModel(),
					);
					if (prune) {
						this._applyPruning(prune);
						contextTokens = Math.max(0, contextTokens - prune.estimatedSavingsTokens);
					}

					// Tier 2: kick off summarization in the background well before the
					// hard threshold, so crossing it usually swaps in a ready summary
					// instead of blocking the loop for a full summarization call.
					const hardThreshold = lines.hardAt;
					const backgroundOpenAt = contextAware
						? lines.windowOpenAt
						: BACKGROUND_COMPACTION_FRACTION * hardThreshold;
					if (
						!this._backgroundCompaction &&
						!this._backgroundCompactionReady &&
						contextTokens > backgroundOpenAt &&
						contextTokens <= hardThreshold
					) {
						this._startBackgroundCompaction(settings, contextWindow, contextTokens);
					}

					if (this._backgroundCompactionReady) {
						if (!contextAware || contextTokens > lines.hardAt) {
							await this._applyBackgroundCompaction({ contextTokens });
						} else {
							this._restartStaleBackgroundCompaction(contextTokens, settings, contextWindow);
						}
					} else if (shouldCompact(contextTokens, effectiveWindow, settings)) {
						// Tier 3 (hard threshold): prefer the in-flight background job;
						// fall back to the blocking path only when there is none.
						if (this._backgroundCompaction) {
							await this._backgroundCompaction.promise;
						}
						const applied = this._backgroundCompactionReady
							? await this._applyBackgroundCompaction({ contextTokens })
							: false;
						if (!applied) {
							await this._runAutoCompaction("threshold", false);
						}
					}
				}
			}

			const latestCompactionAfter = getLatestCompactionEntry(this.sessionManager.getBranch());
			if (
				contextManagementRan &&
				(this.agent.state.messages !== messagesBeforeCompaction || latestCompactionAfter !== latestCompactionBefore)
			) {
				// Copy: state.messages is the agent's live internal array. Handing it to
				// the loop as its context would alias the two — the loop pushes streamed
				// partials into its context while message_end pushes into agent state, so
				// a shared array double-appends every subsequent message.
				nextContext = { ...previousContext, messages: this.agent.state.messages.slice() };
			}

			nextContext = this._consumeNewContext() ?? nextContext;

			// Prompt/tool loadout for the next request (upstream): the section diff and tool
			// declarations ride on a system message appended before the request.
			const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
			const options = normalizeBuildSystemPromptOptions({
				...runOptions,
				selectedTools: this.getActiveToolNames(),
				toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
				toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
			});
			const updateMessage = this._preparePromptAndToolLoadout(options, nextContext.messages);
			// Keep session.systemPrompt and ctx.getSystemPrompt() in step with what the provider sees.
			this._runSystemPromptOptions = options;

			return {
				...previousSnapshot,
				context: {
					...nextContext,
					tools: this.agent.state.tools.slice(),
				},
				messages: updateMessage
					? [...(previousSnapshot?.messages ?? []), updateMessage]
					: previousSnapshot?.messages,
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	private _restorePendingProviderMessages(context: AgentContext): AgentContext {
		for (const message of this._pendingProviderMessages) {
			if (!context.messages.includes(message)) context.messages.push(message);
			if (!this.agent.state.messages.includes(message)) this.agent.state.messages.push(message);
		}
		return context;
	}

	private _appendCheckpointMessage(notes: string, keep?: string[]): void {
		const details = keep ? { keep } : undefined;
		const message: CustomMessage = {
			role: "custom",
			customType: "checkpoint",
			content: notes,
			display: true,
			details,
			timestamp: Date.now(),
		};
		this.agent.state.messages = [...this.agent.state.messages, message];
		this.sessionManager.appendCustomMessageEntry("checkpoint", notes, true, details);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private _persistMessage(message: AgentMessage): string | undefined {
		if (message.role === "custom") {
			return this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				message.ephemeral,
			);
		} else if (
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult"
		) {
			return this.sessionManager.appendMessage(message);
		}
		return undefined;
	}

	private _flushPendingProviderMessages(): void {
		while (this._pendingProviderMessages.length > 0) {
			// SessionManager updates its tree before I/O; an I/O error must not append the input twice.
			const message = this._pendingProviderMessages.shift()!;
			const entryId = this._persistMessage(message);
			if (entryId) this._entryIdsByMessage.set(message, entryId);
		}
	}

	/**
	 * phi request preflight on upstream's `prepareRequest` hook: compaction at request time (not only
	 * at turn boundaries), then re-add inputs that arrived during the run and were not persisted yet,
	 * and remember the exact prefix the provider saw so reported usage can be trusted next time.
	 */
	private _installAgentRequestPreflight(): void {
		const previousPrepareRequest = this.agent.prepareRequest;
		this.agent.prepareRequest = async (request, signal) => {
			const previous = await previousPrepareRequest?.(request, signal);
			let prepared = previous?.context ?? request.context;
			if (!this._skipNextProviderRequestPreflight) {
				prepared = await this._compactBeforeNextAssistantResponse(prepared);
			}
			prepared = this._restorePendingProviderMessages(this._consumeNewContext() ?? prepared);
			const model = this.model;
			this._providerRequestPrefix = model
				? {
						provider: model.provider,
						model: model.id,
						systemPrompt: getCurrentSystemPrompt(prepared.messages),
						tools: prepared.tools?.slice() ?? [],
					}
				: undefined;
			return { ...previous, context: prepared };
		};
	}

	private _installAgentContextPersistence(): void {
		const previousTransform = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			this._flushPendingProviderMessages();
			return previousTransform ? await previousTransform(messages, signal) : messages;
		};
	}

	private _installAgentRequestProjection(): void {
		const previousPrepareRequest = this.agent.prepareRequest;
		this.agent.prepareRequest = async (request, signal) => {
			const failed = this._failedResponse;
			this._failedResponse = undefined;
			const prepare = async () => {
				const projection = this.sessionManager.buildSessionProjection();
				// phi: inputs that landed during the run are persisted only when the request goes out
				// (see _flushPendingProviderMessages), so the projection lacks them. They are still part
				// of this request: routing must see the user's turn and the threshold must count them.
				const pending = this._pendingProviderMessages.filter((message) => !projection.messages.includes(message));
				const canonicalContext = {
					...request.context,
					messages: pending.length > 0 ? [...projection.messages, ...pending] : projection.messages,
					// Messages declare the provider-visible loadout; context.tools keeps executable implementations.
					tools: this.agent.state.tools.slice(),
				};
				const previous = await previousPrepareRequest?.(
					{
						...request,
						context: canonicalContext,
						model: this.agent.state.model,
						thinkingLevel: this.agent.state.thinkingLevel,
					},
					signal,
				);
				return { previous, context: previous?.context ?? canonicalContext, projection };
			};
			let { previous, context, projection } = await prepare();
			const model = previous?.model ?? this.agent.state.model;
			const thinkingLevel = previous?.thinkingLevel ?? this.agent.state.thinkingLevel;
			if (!isVirtualModel(model)) return { ...previous, context, model, thinkingLevel };

			// The selection stays in agent state; only this request uses the routed model. A routing
			// failure rejects, which ends the run with an error response. Only messages the user wrote
			// start a turn; extension messages can follow them, e.g. from before_agent_start.
			const lastResponse = context.messages.findLastIndex((message) => message.role === "assistant");
			const userTurn = context.messages.slice(lastResponse + 1).some((message) => message.role === "user");
			const state = getVirtualModelState(this.sessionManager.getBranch(), model.provider, model.id);
			const route = await this._modelRuntime.resolveModel(model, convertToLlm(context.messages), {
				reason: failed ? "retry" : userTurn ? "user" : "continuation",
				thinkingLevel,
				signal,
				failed,
				state,
			});
			if (route.state !== undefined && route.state !== state) {
				const data: VirtualModelStateData = { provider: model.provider, modelId: model.id, state: route.state };
				const entry = this.sessionManager.getEntry(
					this.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data),
				);
				if (entry) this._emit({ type: "entry_appended", entry });
			}
			// The route stands: the router already decided this request. The state entry does not change
			// the projection.
			if (this._exceedsCompactionThreshold(route.model, projection)) {
				await this._runAutoCompaction("threshold", false);
				({ previous, context } = await prepare());
			}
			return { ...previous, context, model: route.model, thinkingLevel: route.thinkingLevel };
		};
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean> {
		this._lastActivityOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		const messageEntryId = this._findPersistedMessageEntryId(message);
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		if (!messageEntryId) {
			this._extensionRunner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "turn_end could not resolve the persisted assistant entry ID",
			});
			return false;
		}
		const toolResultEntryIds = toolResults.flatMap((result) => {
			const entryId = this._findPersistedMessageEntryId(result);
			return entryId ? [entryId] : [];
		});
		const boundary = await this._extensionRunner.emitBoundary(
			{
				type: "turn_end",
				turnIndex: this._turnIndex,
				message,
				toolResults,
				messageEntryId,
				toolResultEntryIds,
				outcome: this._lastActivityOutcome,
			},
			(entries) => this._buildBoundaryContext(entries, "turn_end"),
		);
		this._commitBoundaryDrafts(boundary.entries);
		if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
			this._reportInvalidBoundaryContinuation("turn_end");
			return false;
		}
		return boundary.continue;
	}

	private _installAgentBoundaryHooks(): void {
		const previousFinishTurn = this.agent.finishTurn;
		this.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
			const previousDecision = await previousFinishTurn?.(turn, signal);
			if (previousDecision?.action === "end") return previousDecision;
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			return undefined;
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	private _refreshFinalizedContext(): void {
		const projection = this.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this.agent.state.messages = projection.messages;
	}

	private _applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): SessionEntry[] {
		const appended: SessionEntry[] = [];
		for (const draft of drafts) {
			let entryId: string;
			switch (draft.type) {
				case "custom":
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					entryId = manager.appendCustomMessageEntry(
						draft.customType,
						draft.content,
						draft.display,
						draft.details,
					);
					break;
				case "context_edit":
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
				case "compaction": {
					const tokensBefore = estimateProjectedContextTokens(
						manager.buildSessionProjection(),
						manager.getBranch(),
					).tokens;
					entryId = manager.appendCompaction(
						draft.summary,
						draft.firstKeptEntryId,
						tokensBefore,
						draft.details,
						true,
						draft.usage,
					);
					break;
				}
			}
			const entry = manager.getEntry(entryId);
			if (entry) appended.push(entry);
		}
		return appended;
	}

	private _createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): SessionManager {
		const header = this.sessionManager.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
		this._applyBoundaryDrafts(manager, drafts);
		return manager;
	}

	private _getPendingBoundaryMessages(): AgentMessage[] {
		return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
	}

	private _buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): BoundaryContextPreview {
		const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
		const pendingMessages = this._getPendingBoundaryMessages();
		const llmMessages = convertToLlm(projection.messages);
		const finalRole = llmMessages[llmMessages.length - 1]?.role;
		const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
		const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
		const pendingCustomContext = this._pendingCustomMessages.length > 0;
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue:
				contextCanContinue ||
				pendingCustomContext ||
				(boundary === "turn_end"
					? this.agent.hasQueuedMessages()
					: finalRole === "assistant" && this.agent.hasQueuedMessages()),
		};
	}

	private _commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): void {
		const appended = this._applyBoundaryDrafts(this.sessionManager, drafts);
		this._refreshFinalizedContext();
		for (const entry of appended) this._emit({ type: "entry_appended", entry });
	}

	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		this._extensionRunner.emitError({
			extensionPath: "<boundary>",
			event,
			error: `${event} requested continuation without runnable model context`,
		});
	}

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (!this.isIdle || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._cacheWarmer?.onAgentSettled();
		this._isAgentRunActive = false;
		this._isEmittingAgentSettled = true;
		try {
			const aborted = this._agentRunAbortRequested;
			await this._extensionRunner.emit({ type: "agent_settled", aborted });
			this._emit({ type: "agent_settled", aborted });
		} finally {
			this._isEmittingAgentSettled = false;
		}

		const deferred = this._deferredSettledActions.splice(0);
		if (deferred.length > 0) {
			try {
				for (const action of deferred) await action();
			} finally {
				this._resolveIdleWaitIfIdle();
			}
			return;
		}
		this._resolveIdleWaitIfIdle();
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		const requestEnded = event.type === "message_end" && event.message.role === "assistant";
		const requestPrefix = requestEnded ? this._providerRequestPrefix : undefined;
		if (requestEnded) {
			this._providerRequestPrefix = undefined;
			this._skipNextProviderRequestPreflight = false;
		}
		if (event.type === "message_start" && event.message.role === "assistant") {
			this._flushPendingProviderMessages();
		}

		// An abort requested while the run was starting, e.g. during before_agent_start, stops it
		// here. agent_start is awaited before the first request.
		if (event.type === "agent_start" && this._agentRunAbortRequested) this.agent.abort();
		// Record the calls a tool made through ctx.executeTool() and their usage on its result message.
		if (this._nestedToolCalls) {
			if (event.type === "message_start" && event.message.role === "toolResult") {
				const message = event.message;
				const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
				if (summary?.calls) message.nestedCalls = summary.calls;
				if (summary?.usage) {
					message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
				}
			} else if (event.type === "agent_end") {
				this._nestedToolCalls.clear();
			}
		}
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Gateway-routed (gateway/auto) turns are billed at the served model's price, not auto's placeholder.
		if (event.type === "message_end" && event.message.role === "assistant") {
			applyRoutedCost(event.message, (provider, id) => this._modelRuntime.getModel(provider, id));
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		if (requestPrefix && event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message as AssistantMessage;
			if (
				requestPrefix.provider === message.provider &&
				requestPrefix.model === message.model &&
				message.stopReason !== "error" &&
				message.stopReason !== "aborted" &&
				calculateContextTokens(message.usage) > 0
			) {
				this._reportedUsagePrefix = requestPrefix;
			}
		}

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			let entryId: string | undefined;
			if (this._isAgentRunActive && (event.message.role === "user" || event.message.role === "custom")) {
				// phi: inputs that land during a run are persisted when the request goes out
				// (after any preflight compaction), so they never end up inside the summary.
				this._pendingProviderMessages.push(event.message);
			} else {
				entryId = this._persistMessage(event.message);
			}
			if (entryId) this._entryIdsByMessage.set(event.message, entryId);
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				this._lastAssistantMessage = assistantMsg;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}

		// A turn ends after its assistant message and every tool result has been appended,
		// so this is the first point in the run where a context-only custom message can be
		// inserted without landing between a tool call and its result. Flushing after the
		// extension and listener dispatch above also picks up messages that turn_end
		// handlers queued.
		if (event.type === "turn_end") {
			this._flushPendingCustomMessages();
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		if (this._agentRunAbortRequested) return false;
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	private _findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		const mapped = this._entryIdsByMessage.get(message);
		if (mapped) return mapped;
		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		const messageIndex = this.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;
		const projection = this.sessionManager.buildSessionProjection();
		let projectedIndex = 0;
		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				if (projectedIndex === messageIndex) {
					this._entryIdsByMessage.set(message, entry.sourceEntry.id);
					return entry.sourceEntry.id;
				}
				projectedIndex++;
			}
		}
		return undefined;
	}

	/**
	 * Persistently omit a failed attempt and its tool results from model context. Results are
	 * found in the projected context, so the pair stays together whether the attempt comes from
	 * the current run or a resumed session. An unpaired result fails the next request (#11227).
	 */
	private _omitRecoveryAttempt(message: AssistantMessage): void {
		const toolCallIds = new Set(message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])));
		// A context edit replaces the projected copy, so match it by source entry as well.
		const entryId = this._findPersistedMessageEntryId(message);
		const messages = this.agent.state.messages;
		const index = messages.findIndex(
			(m) => m === message || (entryId !== undefined && this._entryIdsByMessage.get(m) === entryId),
		);
		const toolResults: AgentMessage[] = [];
		for (const m of index < 0 ? [] : messages.slice(index + 1)) {
			if (m.role === "assistant") break;
			if (m.role === "toolResult" && toolCallIds.has(m.toolCallId)) toolResults.push(m);
		}
		const targets = [message, ...toolResults];
		const targetIds = targets.map((target) => this._findPersistedMessageEntryId(target));
		const unresolvedProjectedTarget = targets.some(
			(target, index) => targetIds[index] === undefined && this.agent.state.messages.includes(target),
		);
		if (unresolvedProjectedTarget) {
			throw new Error("Cannot persist recovery omission because a projected message has no source entry");
		}
		for (const targetId of targetIds) {
			if (!targetId) continue;
			const editId = this.sessionManager.appendContextEdit(targetId, null);
			const entry = this.sessionManager.getEntry(editId);
			if (entry) this._emit({ type: "entry_appended", entry });
		}
		this._refreshFinalizedContext();
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			if (event.message.role === "assistant" && !this._boundaryDispatchedMessages.delete(event.message)) {
				await this._dispatchTurnEndBoundary(event.message, event.toolResults);
			}
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
				...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = undefined;
			this._cacheWarmer.cancel();
		}
		cleanupSessionResources(this.sessionId);
		agentSessionRegistry.disposed(this);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Refresh the public finalized transcript from the canonical session projection. */
	refreshContext(): void {
		this._refreshFinalizedContext();
	}

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current cache-warming state and the policy inputs that produced it. */
	get cacheWarmingStatus(): CacheWarmingStatus | undefined {
		return this._cacheWarmer?.status;
	}

	/** Persist the cache-warming mode and immediately reconcile active warming. */
	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.settingsManager.setCacheWarmingMode(mode);
		this._cacheWarmer?.onModeChanged();
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Under a virtual selection, the physical model and thinking level of the latest successful response. */
	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		if (!this.model || !isVirtualModel(this.model)) return undefined;
		const latest = findLatestResponse(this.agent.state.messages);
		const model = latest && this._modelRuntime.getPhysicalModel(latest.provider, latest.model);
		return model && { model, thinkingLevel: latest?.thinkingLevel };
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive && !this.isCompacting;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	get systemPrompt(): string {
		return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools, which are the tools declared to the model.
	 * Tools with `codemode` or `deferred` exposure are callable from other tools without being active.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Get the names of the tools that tools can call through `ctx.executeTool()`. */
	getCallableToolNames(): string[] {
		return this._getCallableTools().map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			exposure: this._getToolExposure(definition.name),
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			...(definition.reachesTools ? { reachesTools: definition.reachesTools } : {}),
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown and hidden tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const previous = this.getActiveToolNames();
		this._setActiveTools(toolNames);
		// A loadout that deactivates a tool replaces the restored one, whose pending tools are dropped.
		// One that only adds tools, like activating tool_search, keeps them.
		const active = new Set(this.getActiveToolNames());
		if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
	}

	private _setActiveTools(toolNames: string[]): void {
		const tools = this._applyToolLoadout(toolNames);
		for (const tool of tools) this._pendingToolNames.delete(tool.name);
		this._rebuildSystemPrompt(tools.map((tool) => tool.name));
	}

	/**
	 * Whether `--tools` and `--exclude-tools` keep the tool registered. MCP tools stay registered
	 * unless the allowlist filters them (see `_allowlistFiltersMcp`).
	 */
	private _isAllowedTool(name: string): boolean {
		if (this._excludedTools?.(name)) return false;
		if (!this._allowedTools || this._allowedTools(name)) return true;
		return !this._allowlistFiltersMcp && isMcpToolName(name);
	}

	/**
	 * Whether the tool may be active, which declares it to the model. MCP tools the allowlist keeps
	 * without matching them are only for codemode and tool_search: they may be declared only when
	 * tool_search can load them (non-`direct` exposure and tool_search registered). This also applies
	 * to tools restored from the transcript or set by extensions.
	 */
	private _isActivatable(name: string): boolean {
		if (!this._allowedTools || this._allowedTools(name) || !isMcpToolName(name)) return true;
		return this._getToolExposure(name) !== "direct" && this._toolRegistry.has("tool_search");
	}

	private _getToolExposure(name: string): ToolExposure {
		return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
	}

	/**
	 * Tools callable through `ctx.executeTool()`: the active `direct` tools and every registered
	 * `codemode` or `deferred` tool.
	 */
	private _getCallableTools(active: ReadonlySet<string> = new Set(this.getActiveToolNames())): AgentTool[] {
		return [...this._toolRegistry.values()].filter((tool) => {
			const exposure = this._getToolExposure(tool.name);
			return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
		});
	}

	/**
	 * Set the agent's tools for the given active tool names and return them. The active tools are
	 * the registered, non-hidden ones; they are declared to the model. Active tools with a
	 * `prepareLoadout` hook can change the declared descriptions and hide declarations from
	 * requests (see {@link _installHiddenDeclarationsProjection}).
	 */
	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		const tools = [...new Set(toolNames)].flatMap((name) => {
			const tool = this._toolRegistry.get(name);
			return tool && this._getToolExposure(name) !== "hidden" && this._isActivatable(name) ? [tool] : [];
		});
		const hooks = tools.flatMap((tool) => {
			const entry = this._toolDefinitions.get(tool.name);
			return entry?.definition.prepareLoadout ? [entry] : [];
		});
		const hidden = new Set<string>();
		let declared = tools;
		if (hooks.length > 0) {
			const loadout: ToolLoadout = {
				declared: tools,
				callable: this._getCallableTools(new Set(tools.map((tool) => tool.name))),
				registered: [...this._toolRegistry.values()],
				getExposure: (name) => this._getToolExposure(name),
				getNamespace: (name) => this._toolDefinitions.get(name)?.definition.namespace,
				getPromptGuidelines: (name) => this._toolPromptGuidelines.get(name) ?? [],
			};
			const descriptions = new Map<string, string>();
			for (const { definition, sourceInfo } of hooks) {
				try {
					const changes = definition.prepareLoadout?.(loadout);
					for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
						descriptions.set(name, description);
					}
					for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
				} catch (error) {
					this._extensionRunner.emitError({
						extensionPath: sourceInfo.path,
						event: "prepare_loadout",
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}
			declared = tools.map((tool) => {
				const description = descriptions.get(tool.name);
				return description === undefined ? tool : { ...tool, description };
			});
		}
		this._hiddenDeclarations = hidden;
		this.agent.state.tools = declared;
		return declared;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		for (const name of this._toolRegistry.keys()) {
			const snippet = this._toolPromptSnippets.get(name);
			// Tools without a snippet are not listed.
			if (snippet) toolSnippets[name] = snippet;
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "";
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			hiddenTools: [...this._hiddenDeclarations],
			toolSnippets,
			toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
			runtime: this._systemPromptRuntime(),
		});
	}

	/**
	 * Apply a prompt and tool loadout for the next request. Sets the executable tools and
	 * returns a system message patching the prompt sections the model currently has (replayed
	 * from `messages`), or undefined when the prompt is unchanged. Tool changes are declared by
	 * the agent loop before the request.
	 *
	 * A forced prompt does not affect the transcript: the structured sections are still diffed
	 * and persisted, and the forced text is projected onto the request by
	 * {@link _installAgentForcedPromptProjection}.
	 */
	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		options.selectedTools = this._applyToolLoadout(options.selectedTools).map((tool) => tool.name);
		// The tool list and rules must match the declarations the request carries.
		options.hiddenTools = [...this._hiddenDeclarations];
		const sections = diffSystemPromptSections(
			getCurrentSystemMessage(messages)?.sections ?? {},
			buildSystemPromptSections(options),
		);
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/**
	 * Send a forced prompt as the provider's leading system prompt without recording it.
	 *
	 * A `before_agent_start` handler that returns `systemPrompt` needs that exact text at the
	 * head of the request; a mid-conversation system message would leave the original prompt
	 * in place. The forced text is a rendering of the current prompt, so the transcript keeps
	 * its structured sections and the request is projected instead: the system messages
	 * collapse into one head holding the forced text and the current tools. Runs after the
	 * `context` extension handlers.
	 */
	/**
	 * Remove the declarations that `prepareLoadout` hooks hide from every request. The whole
	 * transcript is filtered with the current set, so the projected declarations stay consistent
	 * across requests and only change when the loadout does.
	 */
	private _installHiddenDeclarationsProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const hidden = this._hiddenDeclarations;
			if (hidden.size === 0) return transformed;
			return transformed.map((message) => {
				if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
				const { toolsAdded, toolsRemoved, ...rest } = message;
				const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
				const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
				return {
					...rest,
					...(added.length > 0 ? { toolsAdded: added } : {}),
					...(removed.length > 0 ? { toolsRemoved: removed } : {}),
				};
			});
		};
	}

	private _installAgentForcedPromptProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const forced = this._runSystemPromptOptions?.forceSystemPrompt;
			this._lastForcedSystemPrompt =
				forced === undefined ? undefined : { base: buildSystemPrompt(this._baseSystemPromptOptions), sent: forced };
			if (forced === undefined) return transformed;
			const current = getCurrentSystemMessage(transformed);
			const head: SystemMessage = {
				role: "system",
				content: forced,
				...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
				timestamp: current?.timestamp ?? Date.now(),
			};
			return [head, ...transformed.filter((message) => message.role !== "system")];
		};
	}

	/**
	 * Restore the active tool loadout declared by the session transcript, if it declares one.
	 * Tools reachable only from other tools are never declared, but they do not depend on the active
	 * set, so the transcript's declarations are the whole loadout.
	 * @param modifiers `+name`/`-name` entries applied to the restored loadout.
	 */
	private _restoreToolsFromTranscript(modifiers: readonly string[] = []): void {
		this._pendingToolNames.clear();
		// All system messages on the branch, including those before a compaction. Compaction snapshots
		// are derived from these, so replaying them gives the current loadout.
		const systemMessages = this.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "system" ? [entry.message] : []));
		// No recorded loadout: keep the current tools.
		if (systemMessages.length === 0) return;
		// Tools the branch ever added or removed. Removed tools stay inactive.
		const mentioned = new Set(
			systemMessages
				.flatMap((message) => [...(message.toolsAdded ?? []), ...(message.toolsRemoved ?? [])])
				.map((tool) => tool.name),
		);
		// Extension tools the branch never mentioned were registered after it recorded its loadout, so
		// they are activated like newly registered tools. Built-in tools follow `defaultTools` instead.
		const newTools = [...this._toolRegistry.keys()].filter(
			(name) =>
				!mentioned.has(name) && !this._baseToolDefinitions.has(name) && this._isActivatedOnRegistration(name),
		);
		// The recorded loadout plus the new tools, with `--tools +name`/`-name` applied.
		const names = applyToolModifiers(
			[...getCurrentTools(systemMessages).map((tool) => tool.name), ...newTools],
			modifiers,
		);
		// Recorded tools that are not registered yet, such as MCP tools of servers still connecting, are
		// activated when they register. Excluded tools never register, so they are not kept pending.
		this._pendingToolNames = new Set(names.filter((name) => this._isAllowedTool(name)));
		// Ignores names that are not registered.
		this._setActiveTools(names);
	}

	private _systemPromptRuntime(): SystemPromptRuntime {
		const model = this.agent.state.model;
		if (!model) return { now: new Date() };
		const tier = this.serviceTier;
		const fastUnavailable = tier === "fast" && !this.fastTierKind;
		return {
			now: new Date(),
			model: `${model.provider}/${model.id}`,
			thinkingLevel: model.reasoning ? this.agent.state.thinkingLevel : "off (not supported)",
			speed: tier === "default" || fastUnavailable ? "standard" : tier,
		};
	}

	/**
	 * Rebuild the base prompt so its date/time, model, thinking level and speed are
	 * current. Runs at each run start and on model/thinking/speed changes, never per
	 * tool step, so the prompt prefix stays cacheable within a run.
	 */
	/** Rebuild the base prompt options (tools, runtime line); the next request sends the section diff. */
	private _refreshSystemPrompt(): void {
		this._rebuildSystemPrompt(this.getActiveToolNames());
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Start a continuation run that delivers messages queued while the agent was
	 * not running (e.g. subagent results that arrived during an idle-time
	 * compaction). No-op when a run is active, a compaction/branch summary is
	 * still in flight, or nothing is queued.
	 */
	private _maybeStartQueuedRun(): void {
		if (this._isAgentRunActive || this.isCompacting || !this.agent.hasQueuedMessages()) {
			return;
		}
		// Run failures surface as error assistant messages inside the run itself;
		// a residual throw here has no caller to report to.
		void this._runQueuedContinuation().catch(() => {});
	}

	/**
	 * phi: continue the agent. From the context-window rollover marker, queued input opens the new
	 * window (rollover continuity); from any other tail upstream's rule applies (a continuation runs
	 * first and queued follow-ups stay deferred until it would stop).
	 */
	private async _continueAgent(): Promise<void> {
		const last = this.agent.state.messages[this.agent.state.messages.length - 1];
		const fromRolloverMarker = last?.role === "custom" && last.customType === "context-window";
		await this.agent.continue({ queuedInputFirst: fromRolloverMarker });
	}

	private async _runQueuedContinuation(): Promise<void> {
		this._isAgentRunActive = true;
		this._refreshSystemPrompt();
		try {
			await this._continueAgent();
			while (await this._handlePostAgentRun()) {
				await this._continueAgent();
			}
		} finally {
			this._runSystemPromptOptions = undefined;
			this._flushPendingBashMessages();
			await this._finishRefusalFallback();
			await this._finishErrorFallback();
			await this._emitAgentSettled();
		}
	}

	/**
	 * Start a run from a user or custom message. The session counts as busy from here on, so
	 * messages sent while before_agent_start handlers run are queued into this run instead of
	 * starting another, and an abort requested meanwhile aborts the run as soon as it exists.
	 * @param onStarted Called once the run's messages are prepared, before the first request.
	 */
	private async _startRun(trigger: BeforeAgentStartTrigger, onStarted?: () => void): Promise<void> {
		this._isAgentRunActive = true;
		this._agentRunAbortRequested = false;
		let messages: AgentMessage[];
		try {
			messages = await this._prepareRun(trigger);
		} catch (error) {
			this._isAgentRunActive = false;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			this._resolveIdleWaitIfIdle();
			throw error;
		}
		// Messages held while the run was starting go before its starting messages, as they would
		// have while idle. No run exists yet, so they cannot split a tool call from its result.
		this._flushPendingBashMessages();
		this._flushPendingCustomMessages();
		onStarted?.();

		// Compaction before the prompt may have scheduled a retry; the new prompt replaces it.
		this._failedResponse = undefined;
		this._recordSelection();
		// The run records the loadout in the transcript; restored tools that did not register by now
		// are dropped, so a tool that never registers does not stay pending.
		this._pendingToolNames.clear();
		// phi: the first request of an empty session needs no preflight compaction pass.
		this._skipNextProviderRequestPreflight = this.agent.state.messages.length === 0;
		try {
			await this.agent.prompt(messages);
			while (!this._agentRunAbortRequested) {
				if (await this._handlePostAgentRun()) {
					if (this._agentRunAbortRequested) break;
					await this._continueAgent();
					continue;
				}
				if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary())) break;
				if (this._agentRunAbortRequested) break;
				await this._continueAgent();
			}
		} finally {
			this._skipNextProviderRequestPreflight = false;
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = undefined;
			this._runSystemPromptOptions = undefined;
			this._flushPendingProviderMessages();
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			await this._finishRefusalFallback();
			await this._finishErrorFallback();
			await this._emitAgentSettled();
		}
	}

	/**
	 * Prepare a run and return its starting messages: refresh the runtime prompt sections (phi),
	 * compact first when needed, emit before_agent_start, apply the run's prompt options and tool
	 * loadout, and build the starting message followed by pending nextTurn messages (consumed here)
	 * and handler messages, with a system patch first when the prompt changed.
	 */
	private async _prepareRun(trigger: BeforeAgentStartTrigger): Promise<AgentMessage[]> {
		this._refreshSystemPrompt();
		// Check if we need to compact before sending (catches aborted responses).
		// The starting message is sent below, so do not call agent.continue() here.
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) {
			await this._checkCompaction(lastAssistant, false);
		}

		const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
		const result = await this._extensionRunner.emitBeforeAgentStart(trigger, this._baseSystemPromptOptions);
		// Handlers may edit event.systemPromptOptions.selectedTools or call setActiveTools(),
		// which updates the live loadout instead. An explicit edit wins; otherwise the live
		// loadout is authoritative, so a setActiveTools() call is not undone here.
		const handlerEditedTools =
			result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
			result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
		if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();

		const messages: AgentMessage[] = [];
		if (trigger.messageType === "custom") {
			messages.push(trigger.message);
		} else {
			// Normalize images after before_agent_start so extension-driven model selection
			// determines the resize profile used for the request and history. phi: images
			// referenced by path were attached in prompt(); they are fitted here with the rest.
			const normalized = await this._normalizePromptImages(trigger.images);
			const text =
				normalized.failures.length > 0 ? `${trigger.prompt}\n\n${normalized.failures.join("\n")}` : trigger.prompt;
			messages.push({
				role: "user",
				content: [{ type: "text", text }, ...normalized.images],
				timestamp: Date.now(),
			});
		}
		// Inject any pending "nextTurn" messages as context alongside the starting message
		messages.push(...this._pendingNextTurnMessages);
		this._pendingNextTurnMessages = [];
		for (const msg of result.messages) {
			messages.push({
				role: "custom",
				customType: msg.customType,
				// Untyped extensions can pass null/missing content; normalize at ingestion.
				content: msg.content ?? [],
				display: msg.display,
				details: msg.details,
				...(msg.ephemeral ? { ephemeral: true } : {}),
				timestamp: Date.now(),
			});
		}
		const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
		this._runSystemPromptOptions = result.systemPromptOptions;
		if (updateMessage) messages.unshift(updateMessage);
		return messages;
	}

	/**
	 * Fit prompt images to the selected model's limits (upstream order: after before_agent_start).
	 * phi: only failures are reported in the prompt text; resize notes are not appended to the
	 * user's own message (phi fits to Claude's native view, where no coordinate mapping is needed).
	 */
	private async _normalizePromptImages(
		images: ImageContent[] | undefined,
	): Promise<{ images: ImageContent[]; failures: string[] }> {
		if (!images) return { images: [], failures: [] };

		const normalizedImages: ImageContent[] = [];
		const failures: string[] = [];
		for (const image of images) {
			const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				resizeOptions: this._limitsModel()?.inputLimits?.images?.resize,
			});
			if (!processed.ok) {
				failures.push(processed.message);
				continue;
			}
			normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		}
		return { images: normalizedImages, failures };
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const message = this._takeForcedRefusal(this._lastAssistantMessage);
		this._lastAssistantMessage = undefined;
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}
		if (!message) return this.agent.hasQueuedMessages();
		if (message.stopReason === "aborted") {
			this._pendingNewContext = undefined;
			return false;
		}

		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}

		if (this._consumeNewContext()) {
			return message.stopReason !== "stop" || this.agent.hasQueuedMessages();
		}

		// Refusals are checked before retries on purpose: a policy decline is
		// deterministic in the request, so the same-model retry budget can only spend
		// attempts on a guaranteed second decline. Escalation is the only way through.
		if (isRefusalAssistantError(message) && (await this._prepareRefusalFallback(message))) {
			return true;
		}

		// A provider that is down (or out of quota) stays down for longer than the
		// retry budget's backoff: same-model retries would re-ask a dead endpoint
		// three times before surfacing the error. Reroute to another model now.
		if (isProviderUnavailableAssistantError(message) && (await this._prepareErrorFallback(message))) {
			return true;
		}

		if (this._isRetryableError(message)) {
			if (await this._prepareRetry(message)) {
				if (this._agentRunAbortRequested) this._finishCancelledRetry();
				this._failedResponse = message;
				return !this._agentRunAbortRequested;
			}
			// Retry budget exhausted on a transient-looking error: rerouting to
			// another model is still better than surfacing the failure.
			if (await this._prepareErrorFallback(message)) {
				return true;
			}
		}

		if (message.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
		}

		const compacted = await this._checkCompaction(message);
		if (this._consumeNewContext()) {
			return message.stopReason !== "stop" || this.agent.hasQueuedMessages();
		}
		if (compacted) return !this._agentRunAbortRequested;

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
	}

	private async _runBeforeSettleBoundary(): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("agent_before_settle")) return this.agent.hasQueuedMessages();
		this._isBeforeSettle = true;
		this._abortDuringBeforeSettle = false;
		try {
			const result = await this._extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
			);
			this._commitBoundaryDrafts(result.entries);
			this._flushPendingCustomMessages();
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			if (this._abortDuringBeforeSettle) return false;
			const shouldContinue = result.continue || this.agent.hasQueuedMessages();
			if (shouldContinue && !finalContext.canContinue) {
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				return false;
			}
			return shouldContinue;
		} finally {
			this._isBeforeSettle = false;
		}
	}

	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) {
			return { text, images };
		}

		const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior);
		if (inputResult.action === "handled") {
			return undefined;
		}
		if (inputResult.action === "transform") {
			return { text: inputResult.text, images: inputResult.images ?? images };
		}
		return { text, images };
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => await this.prompt(text, options));
			return;
		}
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let run: Promise<void> | undefined;
		let starting = false;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			// Loop: a no-args command may forward its trailing text, which can itself
			// be a command. forwardText is strictly shorter each pass, so this ends.
			while (expandPromptTemplates && text.startsWith("/")) {
				const result = await this._tryExecuteExtensionCommand(text);
				if (!result.handled) break;
				if (!result.forwardText) {
					// Extension command executed, no prompt to send
					preflightResult?.("handled");
					return;
				}
				// The command takes no args: the remainder is the real prompt.
				text = result.forwardText;
			}

			if (this._compactionAbortController !== undefined) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			// Emit input event for extension interception (before skill/template expansion)
			const processedInput = await this._runInputHandlers(
				text,
				options?.images,
				options?.source ?? "interactive",
				this.isStreaming ? options?.streamingBehavior : undefined,
			);
			if (!processedInput) {
				preflightResult?.("handled");
				return;
			}
			const { text: currentText } = processedInput;
			let currentImages = processedInput.images;

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			const prepareAndQueue = async (): Promise<boolean> => {
				// Attach images referenced by path in the message text. Pasted screenshots
				// arrive as temp-file paths; without this the model only sees them if it
				// volunteers a read-tool call on the path. Images are fitted to the limits of
				// the model that receives them: below for queued input, in _prepareRun for a
				// new run (before_agent_start may select the model).
				if (currentImages?.length || hasImagePathCandidates(expandedText)) {
					currentImages = await this._prepareImages(expandedText, currentImages, { fitSupplied: false });
				}

				// If streaming, queue via steer() or followUp() based on option. A prompt that
				// passed this point but has not started its run yet counts as streaming, so an
				// input admitted behind it steers or queues into that run instead of starting another.
				if (this.isStreaming || (this._promptsStarting > 0 && !this.isCompacting)) {
					if (!options?.streamingBehavior) {
						throw new Error(
							"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
						);
					}
					const queuedImages = currentImages?.length
						? await fitSuppliedImages(currentImages, {
								autoResizeImages: this.settingsManager.getImageAutoResize(),
							})
						: currentImages;
					if (options.streamingBehavior === "followUp") {
						await this._queueFollowUp(expandedText, queuedImages);
					} else {
						await this._queueSteer(expandedText, queuedImages);
					}
					return true;
				}

				// A compaction is rewriting agent state while the agent is idle. Starting
				// a run now would race it (the compaction's context rebuild replaces
				// agent.state.messages mid-run). Queue the prompt; it is delivered when
				// compaction finishes.
				if (this.isCompacting) {
					await this._queueFollowUp(
						expandedText,
						currentImages?.length
							? await fitSuppliedImages(currentImages, {
									autoResizeImages: this.settingsManager.getImageAutoResize(),
								})
							: currentImages,
					);
					return true;
				}
				// Validate model and auth before this prompt counts as starting, so a failure here
				// leaves nothing queued against a run that will never start.
				if (!this.model) {
					throw new Error(formatNoModelSelectedMessage());
				}

				const hasConfiguredAuth =
					this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
					(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
				if (!hasConfiguredAuth) {
					const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
					if (isOAuth) {
						throw new Error(
							`Authentication failed for "${this.model.provider}". ` +
								`Credentials may have expired or network is unavailable. ` +
								`Run '/login ${this.model.provider}' to re-authenticate.`,
						);
					}
					throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
				}

				// Counted inside the ordered section, so the next admitted input sees it.
				this._promptsStarting++;
				starting = true;
				return false;
			};
			// Prompts with no images and no paths keep their original timing unless an earlier
			// input is still preparing images, in which case they queue behind it.
			const queued =
				currentImages?.length || hasImagePathCandidates(expandedText) || this._inputsPreparing > 0
					? await this._inCallOrder(prepareAndQueue)
					: await prepareAndQueue();
			if (queued) {
				preflightResult?.("queued");
				return;
			}

			// Acknowledge after the cheap validations above, before any work that can await.
			// Both compaction and before_agent_start extension hooks may involve slow LLM or
			// network work, so RPC clients must not wait for them before receiving the ack.
			preflightResult?.("started");

			// _startRun marks the run active synchronously, so the handoff from "starting" has no gap.
			run = this._startRun({ messageType: "user", prompt: expandedText, images: currentImages });
		} catch (error) {
			if (starting) {
				this._promptsStarting--;
				// Inputs admitted behind this prompt queued into the run it was starting; deliver them anyway.
				this._maybeStartQueuedRun();
			}
			// Not acknowledged: the caller surfaces the thrown error itself.
			throw error;
		}

		if (starting) this._promptsStarting--;
		try {
			await run;
		} catch (error) {
			// The run failed before it produced anything; deliver inputs queued behind it.
			this._maybeStartQueuedRun();
			throw error;
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<{ handled: boolean; forwardText?: string }> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		let args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return { handled: false };

		// A command that declares it takes no arguments must not swallow a trailing
		// prompt: "/no-feads say hello" runs the command, then "say hello" is the prompt.
		let forwardText: string | undefined;
		if (command.acceptsArgs === false && args.trim()) {
			forwardText = args.trim();
			args = "";
		}

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return { handled: true, forwardText };
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return { handled: true };
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	private async _queueUserInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
	): Promise<QueuedInputDisposition> {
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		const processedInput = await this._runInputHandlers(
			text,
			images,
			source,
			this.isStreaming ? behavior : undefined,
		);
		if (!processedInput) return "handled";

		let expandedText = this._expandSkillCommand(processedInput.text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		const queue = (text: string, queuedImages?: ImageContent[]) =>
			behavior === "steer" ? this._queueSteer(text, queuedImages) : this._queueFollowUp(text, queuedImages);
		// Sync pre-check: queueing must stay synchronous when no images are involved, so a
		// steer typed mid-turn lands before the next provider request (phi image auto-attach).
		const queuedImages = processedInput.images;
		if (queuedImages?.length || hasImagePathCandidates(expandedText) || this._inputsPreparing > 0) {
			await this._inCallOrder(async () =>
				queue(expandedText, await this._prepareImages(expandedText, queuedImages)),
			);
			return "queued";
		}
		await queue(expandedText, queuedImages);
		return "queued";
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async steer(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "steer", options?.source ?? "interactive");
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "followUp", options?.source ?? "interactive");
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({ role: "user", content, timestamp: Date.now() });
	}

	/**
	 * Run `task` after every earlier input whose images are still being prepared.
	 * Preparation is async, so without this an image message could be queued after
	 * a later text-only one, and hosts that match deliveries by order would
	 * acknowledge the wrong message.
	 */
	private _inCallOrder<T>(task: () => Promise<T>): Promise<T> {
		this._inputsPreparing++;
		const run = this._inputPreparation.then(task).finally(() => {
			this._inputsPreparing--;
		});
		this._inputPreparation = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Fit supplied images (RPC/SDK `images`) to provider limits, then best-effort
	 * auto-attach images referenced by file path in the message text (e.g.
	 * terminal-pasted screenshots). A referenced file byte-identical to a supplied
	 * image is not attached again: hosts such as P3 Code send an attachment's
	 * bytes and also name its saved path. Failures never block the prompt.
	 */
	private async _prepareImages(
		text: string,
		images: ImageContent[] | undefined,
		options: { fitSupplied?: boolean } = {},
	): Promise<ImageContent[] | undefined> {
		const supplied =
			images?.length && options.fitSupplied !== false
				? await fitSuppliedImages(images, { autoResizeImages: this.settingsManager.getImageAutoResize() })
				: images;
		if (!hasImagePathCandidates(text)) return supplied;
		try {
			const { images: detected } = await collectImageAttachmentsFromText(text, this._cwd, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				skipIdenticalTo: images,
			});
			if (detected.length === 0) return supplied;
			return [...(supplied ?? []), ...detected];
		} catch {
			return supplied;
		}
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "ephemeral">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			...(message.ephemeral ? { ephemeral: true } : {}),
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			if (this._isEmittingAgentSettled) {
				this._deferredSettledActions.push(async () => await this.sendCustomMessage(message, options));
				return;
			}
			if (this.isCompacting) {
				// An idle-time compaction is rewriting agent state. Starting a turn now
				// would race it: the compaction's context rebuild clobbers the run and
				// the message can be dropped with an "already processing" error. Queue
				// it; the session flushes the queue when compaction ends.
				this.agent.followUp(appMessage);
			} else {
				await this._startRun({ messageType: "custom", message: appMessage });
			}
		} else if (this.isStreaming) {
			// Appending now would put the message between an assistant tool call and its
			// result, which providers that validate message order reject on replay. Defer
			// to the end of the turn. Nothing is emitted yet: message events must not
			// describe messages the session tree does not contain.
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
			appMessage.ephemeral,
		);
		this._refreshFinalizedContext();
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) {
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		if (this._isAgentRunActive) {
			this._agentRunAbortRequested = true;
		}
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		this._refreshSystemPrompt();
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		this._forgetErrorFallbackRestore();
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			this._addPersistedDefaultToNonEmptyScope(model);
		}

		// Re-clamp the thinking level for the new model's capabilities (per-model
		// override first, else the session's preferred level). A clamp is not a new
		// preference and never persists.
		this._applyThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this._scopedModels.length === 0) return;
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this._scopedModels = [...this._scopedModels, { model }];

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// Apply model
		this._forgetErrorFallbackRestore();
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}

		// Apply thinking level.
		// - Explicit scoped model thinking level is an explicit persisted preference.
		// - Undefined inherits the current session preference; applying a model clamp
		//   must not overwrite that preference or its persisted default.
		if (next.thinkingLevel !== undefined) {
			this.setThinkingLevel(thinkingLevel);
		} else {
			this._applyThinkingLevel(thinkingLevel);
		}

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		this._forgetErrorFallbackRestore();
		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		// Re-clamp thinking level for new model's capabilities without treating the
		// clamp as a new thinking preference. Model cycling persists the selected
		// model, but only explicit thinking controls persist a thinking level.
		this._applyThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Service Tier / Fast Mode
	// =========================================================================

	/**
	 * Processing tier the next request will ask for: the session override
	 * (`--service-tier`, `/fast`) when set, else the `serviceTier` setting and
	 * `*-fast` model ids.
	 */
	get serviceTier(): ServiceTier {
		return this._serviceTierRef.override ?? this.settingsManager.getServiceTierForModel(this.model?.id);
	}

	/**
	 * Set the session's processing tier. Undefined clears the override so the
	 * setting applies again. Recorded in the session so `/resume` restores it; the
	 * `serviceTier` setting is never written here (see `/settings` for that), so a
	 * `/fast` toggle stays with this session and never leaks into subagents or
	 * later sessions.
	 */
	setServiceTier(tier: ServiceTier | undefined): void {
		const previous = this.serviceTier;
		this._serviceTierRef.override = tier;
		this.sessionManager.appendCustomEntry(SERVICE_TIER_ENTRY_TYPE, { tier: tier ?? null });
		const next = this.serviceTier;
		if (next !== previous) {
			this._refreshSystemPrompt();
			this._emit({ type: "service_tier_changed", tier: next });
		}
	}

	/** Whether the session asks for a fast tier (Anthropic fast mode / OpenAI fast processing / explicit ultrafast). */
	get fastMode(): boolean {
		return this.serviceTier === "fast" || this.serviceTier === "ultrafast";
	}

	/** Turn fast mode on or off for this session. Off pins "default" so a `serviceTier: fast` setting is also overridden. */
	setFastMode(enabled: boolean): void {
		this.setServiceTier(enabled ? "fast" : "default");
	}

	/** Fast tier the current model can actually be served at, if any. */
	get fastTierKind(): FastTierKind | undefined {
		return getFastTierKind(this.model);
	}

	/**
	 * Speed the provider reported for the most recent assistant response, when it
	 * reported one. "standard" while fast mode is on means the last request was
	 * downgraded (fast-mode rate limit, capacity, or an unsupported model).
	 */
	get lastResponseSpeed(): InferenceSpeed | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") return message.speed;
		}
		return undefined;
	}

	private _readPersistedServiceTier(): ServiceTier | undefined {
		let tier: ServiceTier | undefined;
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === SERVICE_TIER_ENTRY_TYPE) {
				tier = readServiceTierEntry(entry.data);
			}
		}
		return tier;
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * The effective (possibly clamped) level is saved to session history/events.
	 * The requested preference is kept for the session and persisted to global
	 * defaults only when `options.persist` is true.
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		// Preserve the requested level independently of the current model's ceiling.
		// Without this, a session-only hop through a non-reasoning model would lose
		// its own preference and read another process's persisted default on return.
		this._preferredThinkingLevel = level;
		this._applyThinkingLevel(level);
		if (options.persist) {
			// Persist the requested preference, not a capability clamp. Otherwise a
			// model picker/cycle after an extension switch could leak a clamped level,
			// and `off` on a non-reasoning model could erase the user's real default.
			this.settingsManager.setDefaultThinkingLevel(level);
		}
	}

	/** @returns the level actually applied, after clamping to the current model's capabilities. */
	private _applyThinkingLevel(level: ThinkingLevel): ThinkingLevel {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this._refreshSystemPrompt();
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
		return effectiveLevel;
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		// Per-model default takes priority when switching to a model that has one
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		// Otherwise the session's own preference: a session-only hop through a
		// non-reasoning model must not read another process's persisted default on return.
		return this._preferredThinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Generate Pi's built-in compaction summary for manual and automatic compaction. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		model: Model<any>,
		customInstructions: string | undefined,
		signal: AbortSignal,
		// phi: the summarizer is the compaction model (e.g. sonnet:low); its level wins over routing's.
		thinkingLevel: ThinkingLevel | undefined,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		// Resolve the request only when Pi summarizes itself: routing may call models or fail.
		const request = await this._getSummarizationRequestAuth(model, signal);
		return compact(
			preparation,
			request.model,
			request.apiKey,
			request.headers,
			customInstructions,
			signal,
			thinkingLevel ?? request.thinkingLevel,
			this.agent.streamFunction,
			request.env,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			undefined, // sessionId
		);
	}

	private _clearManualCompactionState(): void {
		this._compactionAbortController = undefined;
		this._resolveIdleWaitIfIdle();
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		const fromExtension = false;
		let cancelledByExtension = false;

		try {
			const model = this.model;
			if (!model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const summarizer = this._resolveSummarizationModel();
			const settings = this.settingsManager.getCompactionSettings(model);
			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(
				pathEntries,
				settings,
				this.model.contextWindow,
				this._compactionCeilingModel(),
			);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let extensionPinned: string[] | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
				extensionPinned = result?.pinned;
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by automatic compaction.
				const result = await this._runDefaultCompaction(
					preparation,
					model,
					customInstructions,
					this._compactionAbortController.signal,
					summarizer.thinkingLevel,
					"manual",
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			const preparationPinned = (preparation as unknown as { pinned?: string[] }).pinned;
			const compactionPinned = mergePinned(preparationPinned, extensionPinned);
			const stats = compactionStats([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
			this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
				undefined,
				"manual",
				stats,
				compactionPinned,
			);
			this._reportedUsagePrefix = null;
			const newEntries = this.sessionManager.getEntries();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = this._compactionAbortController.signal.aborted || cancelledByExtension;
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			throw error;
		} finally {
			this._clearManualCompactionState();
			// Deliver anything that queued while compaction had the session locked
			// (e.g. background subagent results). The UI's own queued submissions go
			// through prompt(), which tolerates an already-running continuation.
			this._maybeStartQueuedRun();
		}
	}

	/**
	 * Cancel in-progress compaction (manual, auto, or background) and drop any
	 * queued manual request or finished-but-unapplied background summary.
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
		this._backgroundCompaction?.controller.abort();
		this._backgroundCompactionReady = undefined;
		this._pendingManualCompaction = undefined;
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Automatic cases:
	 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
	 *    remove the failed assistant message, compact, and retry the turn once.
	 * 2. Overflow without retry: a successful response exceeded the configured
	 *    context window; compact but preserve the completed response.
	 * 3. Threshold without retry: valid or estimated context usage crossed the
	 *    configured threshold; compact without retrying the completed response.
	 *
	 * Each case calls `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, that method calls the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		// Never stack compactions: a second one would snapshot the branch mid-rewrite.
		if (this.isCompacting) return false;

		// A /compact queued during the run executes now that the session is idle.
		if (this._pendingManualCompaction) {
			const request = this._pendingManualCompaction;
			this._pendingManualCompaction = undefined;
			try {
				await this.compact(request.customInstructions);
			} catch {
				// "Nothing to compact" and friends must never block the turn flow.
			}
			return this.agent.hasQueuedMessages();
		}

		const settings = this.settingsManager.getCompactionSettings(this.model);
		const contextAware = contextAwareCompactionEnabled();
		const sessionContextWindow = this.model?.contextWindow ?? 0;
		const lines = compactionLines(sessionContextWindow, settings, contextAware ? this.model : undefined);

		// A background summary that finished after the run ended applies at the
		// context-aware window boundary. Legacy mode keeps the historical eager apply.
		if (this._backgroundCompactionReady) {
			if (!contextAware) {
				if (await this._applyBackgroundCompaction()) return this.agent.hasQueuedMessages();
			} else if (settings.enabled && sessionContextWindow > 0) {
				const contextTokens = this._estimateContextTokens().tokens;
				if (contextTokens >= lines.windowOpenAt) {
					if (await this._applyBackgroundCompaction({ contextTokens })) {
						return this.agent.hasQueuedMessages();
					}
				} else {
					this._restartStaleBackgroundCompaction(contextTokens, settings, sessionContextWindow);
				}
			}
		}

		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model. Under a virtual selection, the
		// physical model that produced the message supplies the limits.
		const messageModel = this._modelForMessage(assistantMessage);
		const sameModel = messageModel !== undefined;
		const contextWindow = (messageModel ?? this.model)?.contextWindow ?? 0;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		const currentProjection = this.sessionManager.buildSessionProjection();
		const assistantEntryId = this._findPersistedMessageEntryId(assistantMessage);
		const assistantIsProjected =
			assistantEntryId === undefined ||
			currentProjection.entries.some(
				(entry) =>
					entry.sourceEntry.id === assistantEntryId &&
					entry.messages.some((message) => message.role === "assistant"),
			);
		const branch = this.sessionManager.getBranch();
		const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
		const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
		const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
		const latestAssistantEdit = entriesAfterAssistant
			.filter(
				(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
			)
			.at(-1);
		const assistantRetainedForExplicitRecovery =
			assistantEntryId === undefined ||
			(!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
				latestAssistantEdit?.replacement !== null);
		const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
		const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
		const contextOverflow =
			sameModel &&
			((explicitOverflow && assistantRetainedForExplicitRecovery) ||
				(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
		const recoverableLength =
			sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, messageModel.maxTokens);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return false;
			}

			// Persistently omit the selected final attempt before post-run recovery compaction.
			this._overflowRecoveryAttempted = true;
			this._omitRecoveryAttempt(assistantMessage);
			const retry = await this._runAutoCompaction("overflow", willRetry);
			if (retry) this._failedResponse = assistantMessage;
			return retry;
		}

		// Case 3: threshold compaction without retry.
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		// phi: the message's own usage counts only when it describes the current prefix (same
		// model, prompt and tools as the provider saw). Usage captured before a context edit
		// describes a context that no longer exists, so an edited projection is re-estimated.
		const hasContextEdits = currentProjection.entries.some((entry) => entry.sourceEntry.type === "context_edit");
		const directContextTokens =
			sameModel && this._reportedUsageApplies(this.agent.state) && assistantMessage.usage
				? calculateContextTokens(assistantMessage.usage)
				: 0;
		let contextTokens: number;
		if (hasContextEdits) {
			contextTokens = estimateProjectedContextTokens(currentProjection, branch).tokens;
		} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			// Only what the model saw counts here: a prompt that no request has declared yet is
			// not part of the context this message reports on.
			contextTokens = this._estimateContextTokens(this.agent.state, { declaredOnly: true }).tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (
			shouldCompact(
				contextTokens,
				effectiveContextWindow(contextWindow, settings, contextAware ? this.model : undefined),
				settings,
			)
		) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	private async _runAutoCompaction(
		reason: AutoCompactionReason,
		willRetry: boolean,
		customInstructions?: string,
		pinned?: string[],
	): Promise<boolean> {
		// Never stack compactions: a second one would snapshot the branch mid-rewrite
		// and both would append conflicting compaction entries.
		if (this.isCompacting) return false;
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		const eventReason = compactionEventReason(reason);
		let abortController: AbortController | undefined;
		let started = false;
		let fromExtension = false;
		const cancelledByExtension = false;

		try {
			if (!model) {
				return false;
			}

			let pathEntries = this.sessionManager.getBranch();
			abortController = new AbortController();
			this._autoCompactionAbortController = abortController;

			// An extension may claim the automatic trigger with a fresh context window. This runs before
			// summarization auth and summary preparation, which a summary-free rollover does not need.
			// A claimed trigger never reaches session_before_compact.
			if (reason !== "manual" && this._extensionRunner.hasHandlers("session_before_auto_compact")) {
				const claim = (await this._extensionRunner.emit({
					type: "session_before_auto_compact",
					branchEntries: pathEntries,
					pendingMessages: this._pendingProviderMessages.slice(),
					reason: eventReason === "overflow" ? "overflow" : "threshold",
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeAutoCompactResult | undefined;
				if (this._autoCompactionAbortController.signal.aborted) return false;
				if (claim?.newContext) {
					started = true;
					this._emit({ type: "compaction_start", reason: eventReason });
					this._consumeNewContext(claim.newContext);
					this._emit({
						type: "compaction_end",
						reason: eventReason,
						result: undefined,
						aborted: true,
						willRetry,
						contextWindowStarted: true,
						pendingMessages: this._pendingProviderMessages.slice(),
					});
					return willRetry || this.agent.hasQueuedMessages();
				}
			}

			const summarizer = this._resolveSummarizationModel();

			// Inputs that arrived during the run are the newest turn of the summary's cut: persisted
			// now, they bound the kept tail and are never part of a summary (a rollover above carried
			// them as pendingMessages instead).
			this._flushPendingProviderMessages();
			pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(
				pathEntries,
				settings,
				this.model.contextWindow,
				this._compactionCeilingModel(),
			);
			if (!preparation) {
				return false;
			}
			if (reason === "checkpoint" && customInstructions) {
				preparation.previousSummary = customInstructions;
			}

			started = true;
			this._emit({ type: "compaction_start", reason: eventReason });
			abortController.signal.throwIfAborted();

			let extensionCompaction: CompactionResult | undefined;
			let extensionPinned: string[] | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: eventReason,
					willRetry,
					signal: abortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel || this._autoCompactionAbortController.signal.aborted) {
					this._emit({
						type: "compaction_end",
						reason: eventReason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					await this._emitSessionCompactFailed({
						reason: eventReason,
						aborted: true,
						willRetry: false,
						fromExtension: false,
					});
					return false;
				}

				if (extensionResult?.newContext) {
					this._consumeNewContext(extensionResult.newContext);
					this._emit({
						type: "compaction_end",
						reason: eventReason,
						result: undefined,
						aborted: true,
						willRetry,
						contextWindowStarted: true,
						pendingMessages: this._pendingProviderMessages.slice(),
					});
					return willRetry || this.agent.hasQueuedMessages();
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
				extensionPinned = extensionResult?.pinned;
			}
			abortController.signal.throwIfAborted();

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by manual compaction.
				const compactResult = await this._runDefaultCompaction(
					preparation,
					summarizer.model,
					customInstructions,
					abortController.signal,
					summarizer.thinkingLevel,
					eventReason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason: eventReason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				await this._emitSessionCompactFailed({
					reason: eventReason,
					aborted: true,
					willRetry: false,
					fromExtension,
				});
				return false;
			}

			const preparationPinned = (preparation as unknown as { pinned?: string[] }).pinned;
			const stats = compactionStats([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
			const compactionPinned = mergePinned(mergePinned(preparationPinned, extensionPinned), pinned);
			this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
				undefined,
				reason,
				stats,
				compactionPinned,
			);
			this._reportedUsagePrefix = null;
			const newEntries = this.sessionManager.getEntries();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: eventReason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({
				type: "compaction_end",
				reason: eventReason,
				result,
				aborted: false,
				willRetry,
				pendingMessages: this._pendingProviderMessages.slice(),
			});

			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			const aborted = abortController?.signal.aborted === true || cancelledByExtension;
			if (started) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				this._emit({
					type: "compaction_end",
					reason: eventReason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: eventReason,
					errorMessage,
					aborted,
					willRetry: false,
					fromExtension,
				});
			}
			return false;
		} finally {
			if (this._autoCompactionAbortController === abortController) {
				this._autoCompactionAbortController = undefined;
			}
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Compact without disrupting work: while a run is active the request is
	 * queued and executes at the next step boundary (or right after the run
	 * settles); when idle it compacts immediately. Never aborts running tools.
	 */
	async requestCompaction(customInstructions?: string): Promise<CompactionResult | "queued"> {
		if (this.isStreaming) {
			this._pendingManualCompaction = { customInstructions: customInstructions || undefined };
			return "queued";
		}
		return await this.compact(customInstructions);
	}

	/** Latest summary-mode compaction id on the current branch (prune markers don't count). */
	private _latestSummaryCompactionId(): string | null {
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "compaction" && !isPruneCompaction(entry)) {
				return entry.id;
			}
		}
		return null;
	}

	/**
	 * Model to run summarization on: the `compaction.model` setting when it
	 * resolves, else the session model. An explicit summarizer defaults to low
	 * thinking — checkpoint summaries don't need frontier reasoning budgets.
	 */
	private _resolveSummarizationModel(): { model: Model<any>; thinkingLevel: ThinkingLevel | undefined } {
		// Without an explicit summarizer the request's own level applies: the session level for a
		// physical model, the route's level for a virtual one (see _getSummarizationRequestAuth).
		const fallback = { model: this.model as Model<any>, thinkingLevel: undefined };
		const spec = this.settingsManager.getCompactionModel(this.model?.provider);
		if (!spec) return fallback;
		const slash = spec.indexOf("/");
		if (slash <= 0) return fallback;
		const colon = spec.lastIndexOf(":");
		const hasThinkingSuffix = colon > slash;
		const reference = hasThinkingSuffix ? spec.slice(0, colon) : spec;
		const suffix = hasThinkingSuffix ? spec.slice(colon + 1) : undefined;
		const provider = reference.slice(0, slash);
		const modelId = reference.slice(slash + 1);
		const resolved = this._modelRuntime.getModel(provider, modelId);
		if (!resolved) return fallback;
		const level =
			suffix && (THINKING_LEVEL_OPTIONS as readonly string[]).concat(["xhigh", "max"]).includes(suffix)
				? (suffix as ThinkingLevel)
				: "low";
		return { model: resolved, thinkingLevel: level };
	}

	/**
	 * Apply an LLM-free prune: persist the watermark, rebuild the context with
	 * old tool results elided, and surface it as a lightweight compaction card.
	 * The start/end pair is emitted in the same tick, so the UI never locks.
	 */
	private _applyPruning(prune: { note: string; firstKeptEntryId: string; tokensBefore: number }): void {
		this.sessionManager.appendCompaction(
			prune.note,
			prune.firstKeptEntryId,
			prune.tokensBefore,
			undefined,
			false,
			undefined,
			"prune",
			"threshold",
		);
		const sessionContext = this.sessionManager.buildSessionContext();
		this.agent.state.messages = sessionContext.messages;
		const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);
		// No compaction_start and prune: true — nothing was summarized away, so
		// UIs surface a quiet status line instead of a compaction card.
		this._emit({
			type: "compaction_end",
			reason: "threshold",
			result: {
				summary: prune.note,
				firstKeptEntryId: prune.firstKeptEntryId,
				tokensBefore: prune.tokensBefore,
				estimatedTokensAfter,
			},
			aborted: false,
			willRetry: false,
			prune: true,
		});
	}

	/** The model whose `compaction.softCeilingTokens` applies; per-model ceilings are a context-aware ladder feature. */
	private _compactionCeilingModel(): Model<any> | undefined {
		return contextAwareCompactionEnabled() ? this.model : undefined;
	}

	/**
	 * Start summarizing the current branch in the background. Unlike the
	 * blocking paths this never sets a compaction abort controller, so
	 * isCompacting stays false and the session keeps accepting input; the
	 * finished summary is applied at the next safe boundary.
	 */
	private _startBackgroundCompaction(
		settings: ReturnType<SettingsManager["getCompactionSettings"]>,
		contextWindow: number,
		snapshotTokens = this._estimateContextTokens().tokens,
	): void {
		if (!this.model) return;
		const pathEntries = this.sessionManager.getBranch();
		const baselineCompactionId = this._latestSummaryCompactionId();
		const controller = new AbortController();
		const promise = (async () => {
			try {
				if (contextAwareCompactionEnabled() && this._extensionRunner.hasHandlers("session_before_auto_compact")) {
					const claim = await this._extensionRunner.emit({
						type: "session_before_auto_compact",
						branchEntries: pathEntries,
						pendingMessages: this._pendingProviderMessages.slice(),
						reason: "threshold",
						willRetry: false,
						signal: controller.signal,
					});
					if (controller.signal.aborted) return;
					if (claim?.newContext) {
						this._backgroundCompactionReady = {
							newContext: claim.newContext,
							fromExtension: true,
							baselineCompactionId,
							snapshotTokens,
						};
						return;
					}
				}

				const preparation = prepareCompaction(pathEntries, settings, contextWindow, this._compactionCeilingModel());
				if (!preparation) return;
				let extensionCompaction: CompactionResult | undefined;
				let extensionPinned: string[] | undefined;
				let fromExtension = false;
				if (this._extensionRunner.hasHandlers("session_before_compact")) {
					const result = (await this._extensionRunner.emit({
						type: "session_before_compact",
						preparation,
						branchEntries: pathEntries,
						customInstructions: undefined,
						reason: "threshold",
						willRetry: false,
						signal: controller.signal,
					})) as SessionBeforeCompactResult | undefined;
					if (result?.cancel) return;
					if (result?.newContext) {
						this._backgroundCompactionReady = {
							newContext: result.newContext,
							fromExtension: true,
							baselineCompactionId,
							snapshotTokens,
						};
						return;
					}
					if (result?.compaction) {
						extensionCompaction = result.compaction;
						fromExtension = true;
					}
					extensionPinned = result?.pinned;
				}

				let summary: string;
				let firstKeptEntryId: string;
				let tokensBefore: number;
				let usage: Usage | undefined;
				let details: unknown;
				if (extensionCompaction) {
					({ summary, firstKeptEntryId, tokensBefore, usage, details } = extensionCompaction);
				} else {
					const summarizer = this._resolveSummarizationModel();
					const { apiKey, headers, env } =
						this.agent.streamFunction === streamSimple
							? await this._getRequiredRequestAuth(summarizer.model)
							: await this._getSummarizationRequestAuth(summarizer.model);
					const compactResult = await compact(
						preparation,
						summarizer.model,
						apiKey,
						headers,
						undefined,
						controller.signal,
						summarizer.thinkingLevel,
						this.agent.streamFunction,
						env,
						this.settingsManager.getRetrySettings(),
						this._summarizationRetryCallbacks({ source: "compaction", reason: "threshold" }),
					);
					({ summary, firstKeptEntryId, tokensBefore, usage, details } = compactResult);
				}
				if (controller.signal.aborted) return;
				this._backgroundCompactionReady = {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage,
					details,
					fromExtension,
					stats: compactionStats([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
					pinned: mergePinned((preparation as unknown as { pinned?: string[] }).pinned, extensionPinned),
					baselineCompactionId,
					snapshotTokens,
				};
			} catch {
				// Best-effort: on background failure the blocking hard-threshold
				// path still runs exactly as before.
			} finally {
				this._backgroundCompaction = undefined;
			}
		})();
		this._backgroundCompaction = { controller, promise };
	}

	private _restartStaleBackgroundCompaction(
		contextTokens: number,
		settings: ReturnType<SettingsManager["getCompactionSettings"]>,
		contextWindow: number,
	): void {
		const ready = this._backgroundCompactionReady;
		if (!ready || ready.snapshotTokens === undefined || contextTokens - ready.snapshotTokens <= 40_000) return;
		this._backgroundCompactionReady = undefined;
		this._startBackgroundCompaction(settings, contextWindow, contextTokens);
	}

	/** Apply a finished background summary or a claimed fresh context at a safe boundary. */
	private async _applyBackgroundCompaction(
		options: {
			contextTokens?: number;
			trigger?: CompactionTrigger;
			checkpointNotes?: string;
			pinned?: string[];
		} = {},
	): Promise<boolean> {
		const ready = this._backgroundCompactionReady;
		this._backgroundCompactionReady = undefined;
		if (!ready) return false;
		if (this._latestSummaryCompactionId() !== ready.baselineCompactionId) return false;

		const trigger = options.trigger ?? "background";
		const eventReason = compactionEventReason(
			trigger === "background" || trigger === "stall" ? "threshold" : trigger,
		);
		if (ready.newContext) {
			this._emit({ type: "compaction_start", reason: eventReason });
			this._consumeNewContext(ready.newContext);
			this._emit({
				type: "compaction_end",
				reason: eventReason,
				result: undefined,
				aborted: true,
				willRetry: false,
				contextWindowStarted: true,
				pendingMessages: this._pendingProviderMessages.slice(),
			});
			return true;
		}

		if (!ready.summary || !ready.firstKeptEntryId || ready.tokensBefore === undefined) return false;
		const branch = this.sessionManager.getBranch();
		if (!branch.some((entry) => entry.id === ready.firstKeptEntryId)) return false;

		const summary = options.checkpointNotes
			? `## Checkpoint (model-authored)\n\n${options.checkpointNotes}\n\n${ready.summary}`
			: ready.summary;
		this._emit({ type: "compaction_start", reason: eventReason });
		this.sessionManager.appendCompaction(
			summary,
			ready.firstKeptEntryId,
			ready.tokensBefore,
			ready.details,
			ready.fromExtension,
			ready.usage,
			undefined,
			trigger,
			ready.stats,
			mergePinned(ready.pinned, options.pinned),
		);
		this._reportedUsagePrefix = null;
		const newEntries = this.sessionManager.getEntries();
		const sessionContext = this.sessionManager.buildSessionContext();
		this.agent.state.messages = sessionContext.messages;
		const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);
		const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
			| CompactionEntry
			| undefined;
		if (this._extensionRunner && savedCompactionEntry) {
			await this._extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension: ready.fromExtension,
				reason: eventReason,
				willRetry: false,
			});
		}
		this._emit({
			type: "compaction_end",
			reason: eventReason,
			result: {
				summary,
				firstKeptEntryId: ready.firstKeptEntryId,
				tokensBefore: ready.tokensBefore,
				estimatedTokensAfter,
				usage: ready.usage,
				details: ready.details,
			},
			aborted: false,
			willRetry: false,
		});
		return true;
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		this._extensionRunner.reportUnhandledMcpServers();
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._rebuildSystemPrompt(this.getActiveToolNames());
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = isSyntheticPath(entry.extensionPath) ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (isSyntheticPath(extensionPath)) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
				...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				getSettings: () => this.settingsManager.getSettings(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				// Extension-driven changes are session-scoped: they must not rewrite the
				// user's default model/thinking level for other running or future sessions.
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model, { persist: false });
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level, { persist: false }),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				getCompactionSettings: () => this.settingsManager.getCompactionSettings(),
				newContext: (options) => this.newContext(options),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getContextBreakdown: () => this.getContextBreakdown(),
				sideQuestion: async (request: SideQuestionRequest) => {
					let model = request.model;
					if (typeof model === "string") {
						const separator = model.indexOf("/");
						if (separator <= 0 || separator === model.length - 1) {
							throw new Error(`Invalid side-question model reference: ${model}`);
						}
						model = this._modelRuntime.getModel(model.slice(0, separator), model.slice(separator + 1));
					}
					if (request.model === undefined) model = this.model;
					if (!model) throw new Error(`Unknown side-question model: ${String(request.model)}`);
					if (request.signal?.aborted)
						throw new DOMException("The side-question request was aborted", "AbortError");
					const thinkingLevel = request.thinkingLevel === "off" ? undefined : request.thinkingLevel;
					return runSideQuestion(
						model,
						this._modelRuntime,
						request.messages,
						request.systemPrompt,
						request.signal,
						thinkingLevel,
						this.settingsManager.getStreamIdleTimeoutMs(),
					);
				},
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
				executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),
				getCallableTools: () => this._getCallableTools(),
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
				registerVirtualModel: (definition) => {
					this._modelRuntime.registerVirtualModel(definition);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterVirtualModel: (provider, id) => {
					this._modelRuntime.unregisterVirtualModel(provider, id);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		// Tools that were already activated on registration. A tool whose exposure changes to
		// `direct` or `model-only` (for example from `hidden`) is activated like a new tool.
		const previousActivatedOnRegistration = new Set(
			[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedTools = this._allowedTools;

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => this._isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => this._isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => this._isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
						source: "builtin",
					}),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => this._isAllowedTool(name));

		if (allowedTools) {
			for (const toolName of this._toolRegistry.keys()) {
				// Naming or matching a tool activates it even when it is not active by default. MCP tools
				// kept registered without being named stay inactive.
				if (allowedTools(toolName) && this._isDeclarable(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				if (this._isActivatedOnRegistration(tool.name)) nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousActivatedOnRegistration.has(toolName) && this._isActivatedOnRegistration(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}
		// Pending tools that are registered now become active.
		nextActiveToolNames.push(...this._pendingToolNames);

		this._setActiveTools([...new Set(nextActiveToolNames)]);
	}

	/** Whether activating the tool declares it to the model. */
	private _isDeclarable(name: string): boolean {
		const exposure = this._getToolExposure(name);
		return exposure === "direct" || exposure === "model-only";
	}

	/** Whether registering the tool activates it, which declares it to the model. */
	private _isActivatedOnRegistration(name: string): boolean {
		return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		const getDefaultTools = () =>
			this._usesDefaultTools
				? applyToolModifiers(
						this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES,
						this._defaultToolModifiers,
					)
				: [];
		const previousDefaultTools = new Set(getDefaultTools());
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		// Activate tools newly added to defaultTools. Removed ones stay active, and tools disabled
		// during the session stay disabled unless the setting newly adds them.
		const addedDefaultTools = getDefaultTools().filter((name) => !previousDefaultTools.has(name));
		// Tools the new extensions register later, such as MCP tools, are pending until then.
		for (const name of this.getActiveToolNames()) this._pendingToolNames.add(name);
		this._buildRuntime({
			activeToolNames: [...this.getActiveToolNames(), ...addedDefaultTools],
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			this._extensionRunner.reportUnhandledMcpServers();
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, (this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	private _finishCancelledRetry(): void {
		if (this._retryAttempt === 0) return;
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = retryDelayMs(settings, this._retryAttempt);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		this._omitRecoveryAttempt(message);

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			this._finishCancelledRetry();
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	// =========================================================================
	// Refusal fallback (model escalation)
	// =========================================================================

	/** `provider/modelId`, the form used by `refusalFallback.chain` entries. */
	private static _modelRef(model: { provider: string; id: string }): string {
		return `${model.provider}/${model.id}`;
	}

	/**
	 * PI_DEBUG_FORCE_REFUSAL=<n>: treat the next n completed turns as if a safety
	 * classifier had declined them.
	 *
	 * The ladder is only interesting when it triggers, and real classifier declines
	 * are non-deterministic and require writing exactly the kind of prompt nobody
	 * should be writing to test infrastructure. This makes an escalation
	 * reproducible on demand: the forced message is a copy, so the genuine answer
	 * stays in session history while the ladder runs on the copy.
	 */
	private _takeForcedRefusal(message: AssistantMessage | undefined): AssistantMessage | undefined {
		if (!message || this._forcedRefusalsRemaining <= 0 || isRefusalAssistantError(message)) return message;
		this._forcedRefusalsRemaining--;
		return {
			...message,
			stopReason: "error",
			errorMessage:
				"The model's safety classifier declined this request (category: cyber): forced by PI_DEBUG_FORCE_REFUSAL.",
			refusal: { category: "cyber", explanation: "forced by PI_DEBUG_FORCE_REFUSAL" },
		};
	}

	/**
	 * Resolve a fallback chain (`refusalFallback.chain`, `errorFallback.chain`)
	 * into the models that are actually usable now: refs that name a known model
	 * and whose provider auth actually resolves. An unusable rung is dropped rather
	 * than failing the ladder — a chain that names a gateway model on a machine
	 * without the gateway key should still escalate through the rungs it can reach.
	 *
	 * `checkAuth` is not sufficient on its own. For OAuth providers it only reports
	 * whether a credential-shaped object exists on disk, never whether it is still
	 * live, so a months-old expired token with a revoked refresh token passes it.
	 * A rung like that used to be kept in the ladder and then throw `ModelsError`
	 * during auth resolution — before any request was made, so the failure never
	 * became an assistant error the reroute logic could classify. One stale
	 * `auth.json` entry silently disarmed the whole outage-fallback feature and
	 * turned a survivable gateway blip into a hard turn failure.
	 *
	 * So each candidate is probed with `getAuth`, which performs the refresh a real
	 * request would perform, and any rung that throws or resolves to nothing is
	 * skipped. This runs only on the failure path (a turn already failed), so the
	 * extra probe costs nothing in the common case — unlike `checkAuth`, which is
	 * called for every provider when listing models and must stay cheap and offline.
	 */
	private async _resolveFallbackChain(chain: string[]): Promise<Array<{ ref: string; model: Model<any> }>> {
		const resolved: Array<{ ref: string; model: Model<any> }> = [];
		const seen = new Set<string>();
		for (const entry of chain) {
			const ref = entry.trim();
			if (ref.length === 0 || seen.has(ref)) continue;
			seen.add(ref);
			const separator = ref.indexOf("/");
			if (separator <= 0 || separator === ref.length - 1) continue;
			const model = this._modelRuntime.getModel(ref.slice(0, separator), ref.slice(separator + 1));
			if (!model) continue;
			if (!(await this._isFallbackRungReachable(model))) continue;
			resolved.push({ ref: AgentSession._modelRef(model), model });
		}
		return resolved;
	}

	/**
	 * Whether a fallback rung can actually serve a request right now.
	 *
	 * Cheap structural check first (is auth configured at all), then the real
	 * resolution a request would do, so an expired OAuth credential whose refresh
	 * token is dead is recognised as unusable here instead of throwing mid-reroute.
	 * Every failure mode is "skip this rung", never "fail the ladder": a provider
	 * that cannot authenticate is exactly what the next rung exists for.
	 */
	private async _isFallbackRungReachable(model: Model<any>): Promise<boolean> {
		try {
			if (!(await this._modelRuntime.checkAuth(model.provider))) return false;
		} catch {
			return false;
		}
		try {
			const resolution = await this._modelRuntime.getAuth(model);
			// A provider needing no key (ambient/local) resolves to nothing and is fine;
			// one that declares `authHeader` but produced no key cannot sign a request.
			if (!resolution) return !this._modelRuntime.getCompatibilityRequestConfig(model).authHeader;
			return true;
		} catch {
			// Expired/revoked OAuth, unreadable credential store, failed key resolution.
			return false;
		}
	}

	/**
	 * Escalate a declined turn to the next model in the chain and replay it.
	 *
	 * Mirrors {@link _prepareRetry}: the declined assistant message is dropped from
	 * agent state (session history keeps it, so the transcript still shows what
	 * happened) and the caller continues the agent, which re-sends the same context
	 * to the new model. Unlike Anthropic's server-side `fallbacks` beta this works
	 * across providers and on OAuth auth, because the switch happens here.
	 *
	 * @returns true if the caller should continue the agent on a new model
	 */
	private async _prepareRefusalFallback(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRefusalFallbackSettings();
		const currentModel = this.model;
		const details = getRefusalDetails(message);
		const from = currentModel ? AgentSession._modelRef(currentModel) : `${message.provider}/${message.model}`;
		if (!settings.enabled || settings.chain.length === 0) return false;

		const chain = await this._resolveFallbackChain(settings.chain);
		// The model that just declined never gets another turn in this escalation, and
		// neither does anything already tried since the last answered turn.
		this._refusalTriedRefs.add(from);
		const currentIndex = chain.findIndex((rung) => rung.ref === from);
		const next = chain.find((rung, index) => index > currentIndex && !this._refusalTriedRefs.has(rung.ref));

		if (!next) {
			this._emit({
				type: "refusal_fallback_exhausted",
				category: details?.category ?? null,
				explanation: details?.explanation,
				from,
				tried: [...this._refusalTriedRefs],
			});
			this._refusalTriedRefs.clear();
			return false;
		}

		// Remember where to come back to before the first switch of this run.
		if (!settings.sticky && !this._refusalRestoreModel && currentModel) {
			this._refusalRestoreModel = currentModel;
		}
		this._refusalTriedRefs.add(next.ref);

		// Drop the declined message from agent state (kept in session for history).
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		await this._applyEscalatedModel(next.model);

		this._emit({
			type: "refusal_fallback",
			category: details?.category ?? null,
			explanation: details?.explanation,
			from,
			to: next.ref,
			rung: chain.indexOf(next) + 1,
			chainLength: chain.length,
		});
		return true;
	}

	/**
	 * Switch models for an escalation.
	 *
	 * Deliberately not {@link setModel}: that persists the choice as the user's
	 * default provider/model, and a classifier decline is not a preference. The
	 * session-level model change is recorded (so the transcript and any resumed
	 * session know which model answered), settings are left alone.
	 *
	 * The preferred thinking level is clamped to the TARGET model before it is
	 * applied. Carrying a level verbatim across an escalation replays a level the
	 * new model may not have: a gateway model mapping `max` to its own effort
	 * vocabulary, rerouted onto a first-party model with a different vocabulary,
	 * turns an outage into a hard `400 invalid_request_error: Invalid effort
	 * level` on the replayed turn — a failure the fallback existed to prevent.
	 *
	 * @returns the thinking level in force on `model` after the switch.
	 */
	private async _applyEscalatedModel(model: Model<any>): Promise<ThinkingLevel> {
		const previousModel = this.model;
		const requestedLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		// Clamped against `model` explicitly rather than relying on the assignment
		// above having already landed, so the invariant does not depend on statement
		// order here.
		//
		// The cast bridges two structurally identical `ThinkingLevel` unions: the one
		// pi-ai's clamp returns and the one pi-agent-core's `_applyThinkingLevel` takes.
		// Same seven members, different declaring package, so TypeScript will not unify
		// them; the clamp only ever returns a member of the model's supported set.
		const thinkingLevel = this._applyThinkingLevel(clampThinkingLevel(model, requestedLevel) as ThinkingLevel);
		await this._emitModelSelect(model, previousModel, "set");
		return thinkingLevel;
	}

	/**
	 * End-of-run bookkeeping for the ladder: clear the per-escalation memory and,
	 * when `refusalFallback.sticky` is false, put the chain head back so the next
	 * turn starts from the preferred model again.
	 */
	private async _finishRefusalFallback(): Promise<void> {
		this._refusalTriedRefs.clear();
		const restore = this._refusalRestoreModel;
		this._refusalRestoreModel = undefined;
		if (!restore || modelsAreEqual(restore, this.model)) return;
		await this._applyEscalatedModel(restore);
		this._emit({ type: "refusal_fallback_restored", to: AgentSession._modelRef(restore) });
	}

	// =========================================================================
	// Error fallback (provider-outage rerouting)
	// =========================================================================

	/** First line of a provider error, capped, for event payloads the UI prints. */
	private static _shortErrorReason(message: AssistantMessage): string {
		const firstLine = (message.errorMessage ?? "provider unavailable").split("\n", 1)[0].trim();
		return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
	}

	/**
	 * Reroute a turn whose provider cannot serve it — endpoint down or
	 * unreachable, or account quota exhausted — to the next model in
	 * `errorFallback.chain` and replay it.
	 *
	 * Mirrors {@link _prepareRefusalFallback}: the failed assistant message is
	 * dropped from agent state (session history keeps it, so the transcript still
	 * shows what happened) and the caller continues the agent on the new model.
	 *
	 * A chain with no usable rungs is a silent no-op: configured models and
	 * authentication depend on the local environment.
	 *
	 * @returns true if the caller should continue the agent on a new model
	 */
	private async _prepareErrorFallback(message: AssistantMessage): Promise<boolean> {
		if (this._errorFallbackExhausted) return false;
		const settings = this.settingsManager.getErrorFallbackSettings();
		if (!settings.enabled || settings.chain.length === 0) return false;
		const chain = await this._resolveFallbackChain(settings.chain);
		if (chain.length === 0) return false;

		const currentModel = this.model;
		const from = currentModel ? AgentSession._modelRef(currentModel) : `${message.provider}/${message.model}`;
		const reason = AgentSession._shortErrorReason(message);
		// The model that just failed never gets another turn in this reroute, and
		// neither does anything already tried since the run started.
		this._errorTriedRefs.add(from);
		const currentIndex = chain.findIndex((rung) => rung.ref === from);
		const next = chain.find((rung, index) => index > currentIndex && !this._errorTriedRefs.has(rung.ref));

		if (!next) {
			this._errorFallbackExhausted = true;
			this._emit({
				type: "error_fallback_exhausted",
				reason,
				from,
				tried: [...this._errorTriedRefs],
			});
			return false;
		}

		// The switch ends any same-model retry sequence: close it out for the UI
		// and give the fallback model a fresh budget.
		if (this._retryAttempt > 0) {
			this._emit({ type: "auto_retry_end", success: false, attempt: this._retryAttempt, finalError: reason });
			this._retryAttempt = 0;
		}

		// Remember where to come back to before the first switch of this run.
		if (!settings.sticky && !this._errorRestoreModel && currentModel) {
			this._errorRestoreModel = currentModel;
		}
		this._errorTriedRefs.add(next.ref);

		// Drop the failed message from agent state (kept in session for history).
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		const thinkingLevel = await this._applyEscalatedModel(next.model);

		this._emit({
			type: "error_fallback",
			reason,
			from,
			to: next.ref,
			thinkingLevel,
			rung: chain.indexOf(next) + 1,
			chainLength: chain.length,
		});
		return true;
	}

	/**
	 * Drop the model a non-sticky reroute was going to restore.
	 *
	 * Called from every explicit model change — `setModel` (the user, an extension,
	 * or an RPC host) and both cycle paths — because the restore is a promise to
	 * undo phi's *own* switch, not to undo the user's. With `sticky: false` now the
	 * default, a reroute mid-run followed by an explicit change would otherwise end
	 * the run by silently putting the pre-reroute model back, overwriting a choice
	 * the user had just made. Whoever changes the model deliberately owns it from
	 * that point.
	 *
	 * Deliberately does not touch `_errorTriedRefs`: which rungs this run has
	 * already burned stays true regardless of who is driving.
	 */
	private _forgetErrorFallbackRestore(): void {
		this._errorRestoreModel = undefined;
	}

	/**
	 * End-of-run bookkeeping for the reroute ladder: clear the per-run memory and,
	 * when `errorFallback.sticky` is false, put the original model back so the
	 * next turn starts from the preferred model again.
	 */
	private async _finishErrorFallback(): Promise<void> {
		this._errorTriedRefs.clear();
		this._errorFallbackExhausted = false;
		const restore = this._errorRestoreModel;
		this._errorRestoreModel = undefined;
		if (!restore || modelsAreEqual(restore, this.model)) return;
		const from = this.model ? AgentSession._modelRef(this.model) : AgentSession._modelRef(restore);
		const thinkingLevel = await this._applyEscalatedModel(restore);
		this._emit({
			type: "error_fallback_restored",
			from,
			to: AgentSession._modelRef(restore),
			thinkingLevel,
		});
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			this.sessionManager.appendMessage(bashMessage);
			this._refreshFinalizedContext();
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			this.sessionManager.appendMessage(bashMessage);
		}
		this._pendingBashMessages = [];
		this._refreshFinalizedContext();
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		if (this.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const signal = this._branchSummaryAbortController.signal;
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					...(await this._getSummarizationRequestAuth(this.model!, signal)),
					signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update finalized context from the canonical session projection.
			this._refreshFinalizedContext();
			this._reportedUsagePrefix = undefined;
			this._restoreToolsFromTranscript();

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this._limitsModel();
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;
		const settings = this.settingsManager.getCompactionSettings();
		const lines = compactionLines(contextWindow, settings, contextAwareCompactionEnabled() ? model : undefined);

		// Kept assistant messages precede the active compaction even though they appear after its
		// summary in the projected context. Their provider usage does not describe the new context.
		if (!this._hasCurrentModelUsageAfterActiveCompaction()) {
			return { tokens: null, contextWindow, effectiveWindow: lines.effectiveWindow, percent: null };
		}

		const estimate = this._estimateContextTokens();
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			effectiveWindow: lines.effectiveWindow,
			percent,
		};
	}

	/**
	 * Category breakdown of current context usage: fixed overhead (system prompt,
	 * tool definitions) plus the conversation bucketed by message role. The
	 * headline total/percent come from provider usage (authoritative, via
	 * getContextUsage); the per-category numbers are heuristic estimates and need
	 * not sum exactly to the total.
	 */
	getContextBreakdown(): ContextBreakdown | undefined {
		const model = this.model;
		if (!model) return undefined;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// The prompt the provider sees is replayed from the transcript sections (see `systemPrompt`).
		// Between runs, a before_agent_start prompt is gone from it (forced per run, re-applied on the
		// next one), so carry the last forced prompt's additions over onto the current base.
		const last = this._lastForcedSystemPrompt;
		const systemPromptTokens = estimateSystemPromptTokens(
			last && this._runSystemPromptOptions === undefined
				? last.sent.startsWith(last.base)
					? this.systemPrompt + last.sent.slice(last.base.length)
					: last.sent
				: this.systemPrompt,
		);

		const toolList = this.agent.state.tools ?? [];
		const toolsTokens = estimateToolDefinitionTokens(toolList);

		const byRole: Record<string, { tokens: number; count?: number }> = {};
		let messagesTokens = 0;
		for (const message of this.messages) {
			const role = message.role;
			const tokens = estimateTokens(message);
			messagesTokens += tokens;
			let bucket = byRole[role];
			if (!bucket) {
				bucket = { tokens: 0, count: 0 };
				byRole[role] = bucket;
			}
			bucket.tokens += tokens;
			bucket.count = (bucket.count ?? 0) + 1;
		}

		const usage = this.getContextUsage();
		const settings = this.settingsManager.getCompactionSettings();
		const lines = compactionLines(contextWindow, settings, contextAwareCompactionEnabled() ? model : undefined);

		return {
			total: usage?.tokens ?? null,
			contextWindow,
			percent: usage?.percent ?? null,
			estimatedTotal: systemPromptTokens + toolsTokens + messagesTokens,
			systemPrompt: { tokens: systemPromptTokens },
			tools: { tokens: toolsTokens, count: toolList.length },
			messages: { total: messagesTokens, byRole },
			compaction: {
				enabled: settings.enabled,
				reserveTokens: settings.reserveTokens,
				effectiveWindow: lines.effectiveWindow,
				windowOpenAt: lines.windowOpenAt,
				softCeilingTokens: model.compaction?.softCeilingTokens ?? settings.softCeilingTokens,
				threshold: settings.enabled
					? contextAwareCompactionEnabled()
						? lines.hardAt
						: contextWindow - settings.reserveTokens
					: null,
			},
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolRenderers: (name) =>
				this._extensionRunner.resolveToolRenderers(name, () => this.getToolDefinition(name)),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	/**
	 * Ask the current model to describe what went wrong in this session for a bug report.
	 * Used when the user declines to share the transcript itself.
	 */
	async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
		const model = this.model;
		if (!model) {
			throw new Error("No model selected");
		}
		return generateBugReportSummary({
			...(await this._getSummarizationRequestAuth(model, options.signal)),
			messages: this.messages,
			hint: options.hint,
			signal: options.signal,
			streamFn: this.agent.streamFunction,
			retry: this.settingsManager.getRetrySettings(),
			sessionId: this.sessionId,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
