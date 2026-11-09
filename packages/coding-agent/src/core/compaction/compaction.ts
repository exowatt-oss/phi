/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	contentText,
	getCurrentSystemMessage,
	normalizeContext,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	uuidv7,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	SystemMessage,
	Tool,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { contextAwareCompactionEnabled } from "../context-aware-compaction.ts";
import { convertToLlm } from "../messages.ts";
import {
	buildSessionContext,
	buildSessionProjection,
	type CompactionEntry,
	elideToolResultContent,
	isPruneCompaction,
	type ProjectedSessionEntry,
	type SessionEntry,
	type SessionProjection,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import { combineUsage } from "../usage-totals.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	isEphemeralCustomMessage,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

function getMessagesFromProjectedEntryForCompaction(entry: ProjectedSessionEntry): AgentMessage[] {
	if (entry.sourceEntry.type === "compaction") return [];
	// System messages are prompt state, not conversation; the compaction entry carries their replay.
	return entry.messages.filter((message) => message.role !== "system");
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	/** Constraints or other context carried verbatim through the compaction, when available. */
	pinned?: string[];
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	/**
	 * Tokens of recent conversation kept verbatim through a compaction.
	 * Unset = adaptive: max(20000, 10% of the effective context window).
	 */
	keepRecentTokens?: number;
	/**
	 * Soft ceiling on usable context. Compaction thresholds are computed against
	 * min(contextWindow, softCeilingTokens) instead of the raw window: models with
	 * huge advertised windows (1M-class) degrade behaviorally long before the hard
	 * limit, so waiting for window − reserve means never compacting in practice.
	 * 0 disables the ceiling. Unset = 300k.
	 */
	softCeilingTokens?: number;
	/**
	 * Model to run summarization on, as "provider/modelId[:thinkingLevel]".
	 * Unset = the session model.
	 */
	model?: string;
}

export const DEFAULT_SOFT_CEILING_TOKENS = 300_000;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
/** Fraction of the hard compaction threshold used to open background compaction. */
export const BACKGROUND_COMPACTION_FRACTION = 0.8;
const KEEP_RECENT_WINDOW_FRACTION = 0.1;

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
	softCeilingTokens: DEFAULT_SOFT_CEILING_TOKENS,
};

/** The window compaction policy operates against the model window capped by its or the global soft ceiling. */
export function effectiveContextWindow(
	contextWindow: number,
	settings: CompactionSettings,
	model?: Model<any>,
): number {
	if (contextWindow <= 0) return contextWindow;
	const ceiling = model?.compaction?.softCeilingTokens ?? settings.softCeilingTokens ?? DEFAULT_SOFT_CEILING_TOKENS;
	if (!ceiling || ceiling <= 0) return contextWindow;
	return Math.min(contextWindow, ceiling);
}

export interface CompactionLines {
	effectiveWindow: number;
	hardAt: number;
	windowOpenAt: number;
	pruneAt: number;
}

/** Thresholds derived from a model context window and the effective compaction settings. */
export function compactionLines(
	contextWindow: number,
	settings: CompactionSettings,
	model?: Model<any>,
): CompactionLines {
	const effectiveWindow = effectiveContextWindow(contextWindow, settings, model);
	const hardAt = effectiveWindow - settings.reserveTokens;
	return {
		effectiveWindow,
		hardAt,
		windowOpenAt: Math.floor(BACKGROUND_COMPACTION_FRACTION * hardAt),
		pruneAt: 0.5 * effectiveWindow,
	};
}

/** Settings plus thresholds for an active model, as exposed to extensions. */
export interface CompactionSettingsWithLines extends CompactionSettings {
	effectiveWindow?: number;
	windowOpenAt?: number;
	hardAt?: number;
}

/** Recent-tail budget: explicit setting, else 10% of the effective window (min 20k). */
export function resolveKeepRecentTokens(
	settings: CompactionSettings,
	contextWindow: number,
	model?: Model<any>,
): number {
	if (settings.keepRecentTokens !== undefined) return settings.keepRecentTokens;
	const effective = effectiveContextWindow(contextWindow, settings, model);
	return Math.max(DEFAULT_KEEP_RECENT_TOKENS, Math.floor(effective * KEEP_RECENT_WINDOW_FRACTION));
}

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Provider/model identity used to accept only usage reported by the active model. */
export type ContextModelIdentity = Pick<Model<any>, "provider" | "id">;

/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 * With `model`, also skips usage reported by a different provider/model.
 */
function getAssistantUsage(msg: AgentMessage, model?: ContextModelIdentity): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0 &&
			(!model || (assistantMsg.provider === model.provider && assistantMsg.model === model.id))
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last valid assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(
	messages: AgentMessage[],
	model?: ContextModelIdentity,
): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i], model);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

export interface ContextEstimateOptions {
	/** Only usage reported by this model anchors the estimate; other models' counts are ignored. */
	model?: ContextModelIdentity;
	/** Counted only when no usable usage exists; reported usage already includes them. */
	systemPrompt?: string;
	tools?: Pick<Tool, "name" | "description" | "parameters">[];
	/** Set false when the active prompt or tool definitions changed after the reported usage. */
	useReportedUsage?: boolean;
}

/**
 * Calibrated chars-per-token ratios for the fixed per-request overhead (system prompt and tool
 * definitions). Source: a real anthropic/claude-sonnet-5-5 request with an empty conversation sent a
 * 46,097-char system prompt and 63 tool definitions totalling 64,895 chars of JSON, and was billed
 * 40,845 input tokens. Prose tokenizes at ~3.5 chars/token; JSON schemas (quoted keys, braces, short
 * identifiers) at ~2.0-2.3 chars/token. A flat chars/4 estimated that request at 22,933 tokens.
 */
export const PROSE_CHARS_PER_TOKEN = 3.5;
export const JSON_CHARS_PER_TOKEN = 2.3;

/** Estimate tokens for a system prompt (prose). */
export function estimateSystemPromptTokens(systemPrompt: string | undefined): number {
	return Math.ceil((systemPrompt?.length ?? 0) / PROSE_CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for tool definitions, measured on the compact JSON a provider receives
 * (name, description, and parameter schema per tool; keys and escaping included).
 */
export function estimateToolDefinitionTokens(
	tools: readonly Pick<Tool, "name" | "description" | "parameters">[],
): number {
	let tokens = 0;
	for (const tool of tools) {
		let json = "";
		try {
			json = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }) ?? "";
		} catch {
			json = `${tool.name}${tool.description}`;
		}
		tokens += Math.ceil(json.length / JSON_CHARS_PER_TOKEN);
	}
	return tokens;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 * Without usable usage, the system prompt and tool definitions are estimated too.
 */
export function estimateContextTokens(
	messages: AgentMessage[],
	options: ContextEstimateOptions = {},
): ContextUsageEstimate {
	const usageInfo =
		options.useReportedUsage === false ? undefined : getLastAssistantUsageInfo(messages, options.model);

	if (!usageInfo) {
		let estimated =
			estimateSystemPromptTokens(options.systemPrompt) + estimateToolDefinitionTokens(options.tools ?? []);
		// The prompt and tool declarations ride on system messages; when they are given here, they are
		// counted once, above, rather than again from the transcript.
		const countedSeparately = options.systemPrompt !== undefined || options.tools !== undefined;
		for (const message of messages) {
			if (countedSeparately && message.role === "system") continue;
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Estimate projected context without trusting usage captured before a later edit or compaction. */
export function estimateProjectedContextTokens(
	projection: SessionProjection,
	branchEntries: SessionEntry[],
): ContextUsageEstimate {
	const estimate = estimateContextTokens(projection.messages);
	if (estimate.lastUsageIndex !== null) {
		let projectedMessageIndex = 0;
		let usageEntryId: string | undefined;
		for (const entry of projection.entries) {
			const nextMessageIndex = projectedMessageIndex + entry.messages.length;
			if (estimate.lastUsageIndex < nextMessageIndex) {
				usageEntryId = entry.sourceEntry.id;
				break;
			}
			projectedMessageIndex = nextMessageIndex;
		}

		const usageEntryIndex = usageEntryId ? branchEntries.findIndex((entry) => entry.id === usageEntryId) : -1;
		let latestInvalidatingEntryIndex = -1;
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const entry = branchEntries[i];
			if (entry.type === "context_edit" || entry.type === "compaction") {
				latestInvalidatingEntryIndex = i;
				break;
			}
		}
		if (usageEntryIndex > latestInvalidatingEntryIndex) return estimate;
	}

	const currentSystem = getCurrentSystemMessage(projection.messages);
	let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
	for (const message of projection.messages) {
		if (message.role !== "system") tokens += estimateTokens(message);
	}
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	if (isEphemeralCustomMessage(message)) return 0;

	let chars = 0;

	switch (message.role) {
		case "system": {
			const system = message as SystemMessage;
			chars = estimateTextAndImageContentChars(system.content);
			if (system.sections) {
				for (const section of Object.values(system.sections)) {
					if (section) chars += section.length;
				}
			}
			if (system.toolsAdded) chars += JSON.stringify(system.toolsAdded).length;
			return Math.ceil(chars / 4);
		}
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			if (message.excludeFromContext === true) return 0;
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

function isCutPointMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
			return true;
		case "custom":
			return !message.ephemeral;
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
			return true;
		case "custom":
			return !message.ephemeral;
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") {
		return false;
	}
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

/**
 * Find valid cut points: indices of context-visible user-like or assistant messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "compaction" || (entry.type === "custom_message" && entry.ephemeral)) {
			continue;
		}
		if (sessionEntryToContextMessages(entry).some(isCutPointMessage)) {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the context-visible user-role message that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) {
			return i;
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const messageTokens = sessionEntryToContextMessages(entry).reduce(
			(sum, message) => sum + estimateTokens(message),
			0,
		);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Prefer the closest valid cut point at or after this entry. If trailing
			// tool results exceed the budget by themselves, keep their preceding
			// assistant tool call instead of falling back to the first message.
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// Scan backwards from cutIndex to include adjacent metadata entries that do not affect context.
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at compaction boundaries or context-visible entries.
		if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) {
			break;
		}
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const startsTurn = isTurnStartEntry(cutEntry);
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/**
 * Returns an error message when a summarization response cannot safely be persisted.
 * A length stop contains partial text and must not become a session checkpoint.
 */
export function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	return undefined;
}

function createSummarizationOptions(
	model: Model<any>,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	sessionId: string | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { signal, apiKey, headers, env, sessionId };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

/**
 * Shared choke point for every compaction/branch-summary summarization call. Wraps the
 * single LLM call in {@link retryAssistantCall} so transient stream drops (e.g.
 * `terminated`, socket close) honor the configured retry policy instead of failing
 * the whole compaction on the first attempt. Deterministic errors and aborts return
 * immediately (see {@link retryAssistantCall}).
 */
export async function completeSummarization(
	model: Model<any>,
	context: TranscriptContext,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// Avoid cache writes for one-off summaries. Reuse caller-supplied routing when available;
	// callers without a session ID, including branch summaries, receive a fresh routing ID.
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: "none",
		sessionId: options.sessionId ?? uuidv7(),
	};
	const produce = async (): Promise<AssistantMessage> =>
		streamFn
			? (await streamFn(model, context, requestOptions)).result()
			: completeSimple(model, context, requestOptions);
	return retryAssistantCall(produce, retry, requestOptions.signal, callbacks);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	// Unused. Kept for existing callers; summaries use the model's output limit (#9512).
	_reserveTokens: number | undefined,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			_reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		)
	).text;
}

/** Build the provider context for a standalone summary request. */
function buildSummarizationContext(promptText: string): TranscriptContext {
	return normalizeContext({
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
	});
}

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	// Unused. Kept for existing callers; summaries use the model's output limit (#9512).
	_reserveTokens: number | undefined,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom types like bashExecution, custom, etc.)
	const llmMessages = convertToLlm(currentMessages.filter((message) => !isEphemeralCustomMessage(message)));
	const conversationText = serializeConversation(llmMessages);

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const completionOptions = createSummarizationOptions(model, apiKey, headers, env, signal, thinkingLevel, sessionId);

	const response = await completeSummarization(
		model,
		buildSummarizationContext(promptText),
		completionOptions,
		streamFn,
		retry,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "Summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Summarization attempted to call a tool");
	}

	const textContent = contentText(response.content);

	return { text: textContent, usage: response.usage };
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

const MAX_PINNED_USER_MESSAGE_CHARS = 4000;

/** Merge pinned context while preserving first-seen order and omitting duplicates. */
export function mergePinned(existing?: readonly string[], fromExtension?: readonly string[]): string[] | undefined {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const item of [...(existing ?? []), ...(fromExtension ?? [])]) {
		if (typeof item !== "string" || item.length === 0 || seen.has(item)) continue;
		seen.add(item);
		merged.push(item);
	}
	return merged.length > 0 ? merged : undefined;
}

function checkpointKeep(entry: SessionEntry): string[] {
	if (entry.type !== "custom_message" || entry.customType !== "checkpoint") return [];
	const details = entry.details;
	if (typeof details !== "object" || details === null || !("keep" in details)) return [];
	const keep = (details as { keep?: unknown }).keep;
	return Array.isArray(keep) ? keep.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function checkpointNotes(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "checkpoint") return undefined;
	const notes = contentText(entry.content, "");
	return notes.length > 0 ? notes : undefined;
}

function firstUserMessage(pathEntries: SessionEntry[]): { id?: string; text?: string } {
	const entry = pathEntries.find((candidate) => candidate.type === "message" && candidate.message.role === "user");
	if (entry?.type !== "message" || entry.message.role !== "user") return {};
	const text = contentText(entry.message.content, "");
	return { id: entry.id, text: text.length > 0 ? text.slice(0, MAX_PINNED_USER_MESSAGE_CHARS) : undefined };
}

/** Remove only the verbatim prefix carried in pinned context from a user message. */
function removePinnedUserPrefix(message: AgentMessage, pinnedText: string): AgentMessage | undefined {
	if (message.role !== "user" || pinnedText.length === 0) return message;
	if (typeof message.content === "string") {
		if (!message.content.startsWith(pinnedText)) return message;
		const remainder = message.content.slice(pinnedText.length);
		return remainder.length > 0 ? { ...message, content: remainder } : undefined;
	}

	let remaining = pinnedText;
	let changed = false;
	const content = message.content.flatMap((block) => {
		if (block.type !== "text" || remaining.length === 0) return [block];
		if (block.text.startsWith(remaining)) {
			changed = true;
			const remainder = block.text.slice(remaining.length);
			remaining = "";
			return remainder.length > 0 ? [{ ...block, text: remainder }] : [];
		}
		if (remaining.startsWith(block.text)) {
			changed = true;
			remaining = remaining.slice(block.text.length);
			return [];
		}
		return [block];
	});
	if (!changed || remaining.length > 0) return message;
	return content.length > 0 ? { ...message, content } : undefined;
}

/** Omit exact user/custom messages that are already carried verbatim as pinned context. */
function excludePinnedMessages(messages: AgentMessage[], pinned?: readonly string[]): AgentMessage[] {
	if (!pinned || pinned.length === 0) return messages;
	const pinnedSet = new Set(pinned);
	const filtered = messages.filter((message) => {
		if (message.role !== "user" && message.role !== "custom") return true;
		return !pinnedSet.has(contentText(message.content, ""));
	});
	// Never turn a compactable history into an empty summarizer input solely
	// because its only message is already carried in pinned context.
	return filtered.length > 0 ? filtered : messages;
}

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Constraints or other context carried verbatim through the compaction, when available. */
	pinned?: string[];
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Pinned-only history used only when excluding pinned input would leave no summary input. */
	pinnedFallbackMessages?: AgentMessage[];
	pinnedFallbackTurnPrefixMessages?: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

function isProjectedTurnStart(entry: ProjectedSessionEntry): boolean {
	if (entry.sourceEntry.type === "compaction") return false;
	return entry.messages.some(isTurnStartMessage);
}

function findProjectedTurnStartIndex(entries: ProjectedSessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isProjectedTurnStart(entries[i])) return i;
	}
	return -1;
}

function findProjectedCutPoint(
	entries: ProjectedSessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) cutPoints.push(i);
	}
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	let accumulatedTokens = 0;
	let exceededBudget = false;
	let cutIndex = cutPoints[0];
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const messageTokens = entries[i].messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			exceededBudget = true;
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// A recovery attempt and its omission edits are context-invisible after the last
	// visible input. Advance only for a closed suffix containing an omitted assistant
	// attempt; arbitrary metadata must not move the cut past unsent input.
	const suffix = entries.slice(cutIndex + 1, endIndex);
	// phi: the session boundary hides errored and aborted assistant attempts from context; they are
	// still attempts, so an omitted one is recognized by its entry rather than by its messages.
	const isIntrinsicallyVisible = (entry: ProjectedSessionEntry): boolean =>
		entry.sourceEntry.type !== "context_edit" &&
		((entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant") ||
			sessionEntryToContextMessages(entry.sourceEntry).length > 0);
	const isOmitted = (entry: ProjectedSessionEntry): boolean =>
		isIntrinsicallyVisible(entry) && entry.messages.length === 0;
	const omittedSuffixIds = new Set(suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id));
	const hasExternalReplacement = suffix.some(
		(entry) =>
			entry.sourceEntry.type === "context_edit" &&
			entry.sourceEntry.replacement !== null &&
			!omittedSuffixIds.has(entry.sourceEntry.targetId),
	);
	const isRecoveryOmissionSuffix =
		exceededBudget &&
		!hasExternalReplacement &&
		suffix.some(
			(entry) =>
				entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant" && isOmitted(entry),
		) &&
		suffix.every(
			(entry) => entry.sourceEntry.type !== "compaction" && (!isIntrinsicallyVisible(entry) || isOmitted(entry)),
		);
	if (isRecoveryOmissionSuffix) cutIndex++;

	while (cutIndex > startIndex) {
		const previous = entries[cutIndex - 1];
		if (previous.sourceEntry.type === "compaction" || previous.messages.length > 0) break;
		cutIndex--;
	}
	const startsTurn = isProjectedTurnStart(entries[cutIndex]);
	const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	contextWindow = 0,
	model?: Model<any>,
): CompactionPreparation | undefined {
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "context_window") {
			pathEntries = pathEntries.slice(i);
			break;
		}
	}

	const lastEntry = pathEntries[pathEntries.length - 1];
	// A trailing prune marker does not block a real (summary) compaction.
	if (lastEntry?.type === "compaction" && !isPruneCompaction(lastEntry)) {
		return undefined;
	}

	const projection = buildSessionProjection(pathEntries);
	const projectedEntries = projection.entries;
	const sourceEntries = projectedEntries.map((entry) => entry.sourceEntry);
	// The newest compaction is projected first. Older compaction entries can still
	// occur in its retained raw range, but their projected contribution is empty.
	// phi: only summary compactions carry a previous summary and a drop boundary;
	// prune markers (no projected messages) merely elide tool results in place.
	const prevCompactionIndex = projectedEntries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);
	// phi: pinned and checkpoint state is read in session-path order, as before the
	// projection rewrite. The projection puts the previous compaction ahead of its
	// retained tail, so projected order would treat entries that compaction already
	// covered (its kept first request, an older checkpoint) as newer than its summary.
	let pathPrevCompactionIndex = -1;
	let pathLastCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		const entry = pathEntries[i];
		if (pathLastCompactionIndex < 0 && entry.type === "compaction") pathLastCompactionIndex = i;
		if (entry.type === "compaction" && !isPruneCompaction(entry)) {
			pathPrevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		previousSummary = (projectedEntries[prevCompactionIndex].sourceEntry as CompactionEntry).summary;
		// The canonical projection has already selected the previous compaction's retained tail.
		boundaryStart = prevCompactionIndex + 1;
	}

	// A checkpoint after the latest summary compaction is a newer source of
	// continuation state. Use its notes to seed the next summary update.
	let latestCheckpointIndex = -1;
	let latestCheckpointNotes: string | undefined;
	for (let i = pathEntries.length - 1; i > pathPrevCompactionIndex; i--) {
		const entry = pathEntries[i];
		if (entry.type === "custom_message" && entry.customType === "checkpoint") {
			latestCheckpointIndex = i;
			latestCheckpointNotes = checkpointNotes(entry);
			break;
		}
	}
	if (latestCheckpointIndex > pathPrevCompactionIndex && latestCheckpointNotes !== undefined) {
		previousSummary = latestCheckpointNotes;
	}

	const boundaryEnd = projectedEntries.length;
	const contextAware = contextAwareCompactionEnabled();
	// The session's first request, read from the path. After a compaction, the first
	// request left in the projection is a message that compaction kept; it is not pinned.
	const firstUser: { id?: string; text?: string } = contextAware ? firstUserMessage(pathEntries) : {};
	let pinned = contextAware
		? mergePinned(
				pathPrevCompactionIndex >= 0 ? (pathEntries[pathPrevCompactionIndex] as CompactionEntry).pinned : undefined,
				firstUser.text ? [firstUser.text] : undefined,
			)
		: undefined;
	if (contextAware) {
		const checkpointPinned: string[] = [];
		for (let i = pathLastCompactionIndex + 1; i < pathEntries.length; i++) {
			checkpointPinned.push(...checkpointKeep(pathEntries[i]));
		}
		pinned = mergePinned(pinned, checkpointPinned);
	}

	const tokensBefore = estimateProjectedContextTokens(projection, pathEntries).tokens;

	// phi: a prune watermark elides old tool results in the projection (as copies of
	// their entries). The keep-recent budget and the summary input use the full results,
	// as before the projection rewrite; measuring the elided heads can shrink the history
	// under the budget, so a trailing prune would block the summary tier behind it.
	const rawEntriesById = new Map(pathEntries.map((entry) => [entry.id, entry]));
	const editedIds = new Set(sourceEntries.flatMap((entry) => (entry.type === "context_edit" ? [entry.targetId] : [])));
	const unprunedEntries = projectedEntries.map((entry): ProjectedSessionEntry => {
		const raw = rawEntriesById.get(entry.sourceEntry.id);
		if (!raw || raw === entry.sourceEntry || editedIds.has(raw.id)) return entry;
		return { sourceEntry: raw, messages: sessionEntryToContextMessages(raw) };
	});

	const cutPoint = findProjectedCutPoint(
		unprunedEntries,
		boundaryStart,
		boundaryEnd,
		resolveKeepRecentTokens(settings, contextWindow, model),
	);

	const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
	if (!firstKeptEntry?.id) return undefined; // Session needs migration
	const firstKeptEntryId = firstKeptEntry.id;
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary). phi: the first user
	// message's pinned prefix is removed from the summary input (it rides as pinned context).
	const messagesToSummarize: AgentMessage[] = [];
	const pinnedFallbackMessages: AgentMessage[] = [];
	const collect = (from: number, to: number, into: AgentMessage[], fallback: AgentMessage[]) => {
		for (let i = from; i < to; i++) {
			const isFirstUser = firstUser.id !== undefined && unprunedEntries[i].sourceEntry.id === firstUser.id;
			for (const msg of getMessagesFromProjectedEntryForCompaction(unprunedEntries[i])) {
				if (isEphemeralCustomMessage(msg)) continue;
				const summaryMessage = isFirstUser && firstUser.text ? removePinnedUserPrefix(msg, firstUser.text) : msg;
				if (summaryMessage) into.push(summaryMessage);
				else if (isFirstUser) fallback.push(msg);
			}
		}
	};
	collect(boundaryStart, historyEnd, messagesToSummarize, pinnedFallbackMessages);

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	const pinnedFallbackTurnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		collect(
			cutPoint.turnStartIndex,
			cutPoint.firstKeptEntryIndex,
			turnPrefixMessages,
			pinnedFallbackTurnPrefixMessages,
		);
	}

	if (
		messagesToSummarize.length === 0 &&
		turnPrefixMessages.length === 0 &&
		pinnedFallbackMessages.length === 0 &&
		pinnedFallbackTurnPrefixMessages.length === 0
	) {
		return undefined;
	}

	// Extract file operations from edited model-visible messages and the previous compaction.
	const fileOps = extractFileOperations(messagesToSummarize, sourceEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		...(pinned ? { pinned } : {}),
		messagesToSummarize,
		turnPrefixMessages,
		...(pinnedFallbackMessages.length > 0 ? { pinnedFallbackMessages } : {}),
		...(pinnedFallbackTurnPrefixMessages.length > 0 ? { pinnedFallbackTurnPrefixMessages } : {}),
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// Tool-result pruning (LLM-free compaction tier)
// ============================================================================

/** Fraction of the effective window at which tool-result pruning starts. */
export const PRUNE_TRIGGER_FRACTION = 0.5;
/**
 * Minimum estimated savings that justify advancing the prune watermark. Each
 * advance invalidates the prompt-cache prefix (one uncached re-read) and
 * surfaces a status line, so prunes must be rare and chunky: at 25k this fired
 * every ~10 minutes on heavy sessions (6 events in 70 minutes on 2026-08-20).
 */
export const MIN_PRUNE_SAVINGS_TOKENS = 80_000;

export interface PrunePreparation {
	/** Entry the new watermark points at: everything before it gets its tool results elided. */
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedSavingsTokens: number;
	/** Human-readable note stored as the prune entry's summary. */
	note: string;
}

/**
 * Decide whether eliding old tool results would meaningfully shrink the
 * context, before any LLM summarization is considered. Pure and LLM-free:
 * the caller appends a prune-mode compaction entry with the returned
 * watermark and rebuilds the context.
 */
export function preparePruning(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	contextWindow: number,
	currentContextTokens?: number,
	model?: Model<any>,
): PrunePreparation | undefined {
	if (!settings.enabled || pathEntries.length === 0) return undefined;
	const effectiveWindow = effectiveContextWindow(contextWindow, settings, model);
	const tokens = currentContextTokens ?? estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;
	if (tokens <= PRUNE_TRIGGER_FRACTION * effectiveWindow) return undefined;

	// Same drop boundary as summary compaction: nothing before the last summary
	// cut is in context, so there is nothing there to elide.
	let boundaryStart = 0;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		const entry = pathEntries[i];
		if (entry.type === "compaction" && !isPruneCompaction(entry)) {
			const keptIdx = pathEntries.findIndex((e) => e.id === (entry as CompactionEntry).firstKeptEntryId);
			boundaryStart = keptIdx >= 0 ? keptIdx : i + 1;
			break;
		}
	}

	// Advance from the previous watermark; everything before it is already elided.
	let prevWatermarkIdx = boundaryStart;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		const entry = pathEntries[i];
		if (isPruneCompaction(entry)) {
			const keptIdx = pathEntries.findIndex((e) => e.id === entry.firstKeptEntryId);
			if (keptIdx >= 0) prevWatermarkIdx = Math.max(prevWatermarkIdx, keptIdx);
			break;
		}
	}

	const keepRecent = resolveKeepRecentTokens(settings, contextWindow, model);
	const cutPoint = findCutPoint(pathEntries, boundaryStart, pathEntries.length, keepRecent);
	const watermarkIdx = cutPoint.firstKeptEntryIndex;
	if (watermarkIdx <= prevWatermarkIdx) return undefined;
	const firstKept = pathEntries[watermarkIdx];
	if (!firstKept?.id) return undefined;

	let savings = 0;
	for (let i = prevWatermarkIdx; i < watermarkIdx; i++) {
		const entry = pathEntries[i];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const full = estimateTokens(entry.message);
		const elided = estimateTokens(elideToolResultContent(entry.message));
		savings += Math.max(0, full - elided);
	}
	if (savings < MIN_PRUNE_SAVINGS_TOKENS) return undefined;

	return {
		firstKeptEntryId: firstKept.id,
		tokensBefore: tokens,
		estimatedSavingsTokens: savings,
		note: `Elided older tool outputs (~${Math.round(savings / 1000)}k tokens); conversation and recent results kept verbatim.`,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 * @param sessionId - Optional routing session ID forwarded without enabling prompt caching
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize: preparedMessagesToSummarize,
		turnPrefixMessages: preparedTurnPrefixMessages,
		pinnedFallbackMessages,
		pinnedFallbackTurnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		pinned,
	} = preparation;
	const messagesToSummarize = excludePinnedMessages(
		[...preparedMessagesToSummarize, ...(pinnedFallbackMessages ?? [])],
		pinned,
	);
	const turnPrefixMessages = excludePinnedMessages(
		[...preparedTurnPrefixMessages, ...(pinnedFallbackTurnPrefixMessages ?? [])],
		pinned,
	);

	// Generate summaries and merge into one
	let summary: string;
	let summaryUsage: Usage;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = previousSummary ?? "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				model,
				undefined,
				apiKey,
				headers,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				streamFn,
				env,
				retry,
				callbacks,
				sessionId,
			);
			historyText = historyResult.text;
			historyUsage = historyResult.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			streamFn,
			retry,
			callbacks,
			sessionId,
			customInstructions,
		);
		// Merge into single summary
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
		summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
	} else {
		// Just generate history summary
		const result = await generateSummaryWithUsage(
			messagesToSummarize,
			model,
			undefined,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		);
		summary = result.text;
		summaryUsage = result.usage;
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		...(pinned ? { pinned } : {}),
		usage: summaryUsage,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	env?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
	customInstructions?: string,
): Promise<{ text: string; usage: Usage }> {
	const llmMessages = convertToLlm(messages.filter((message) => !isEphemeralCustomMessage(message)));
	const conversationText = serializeConversation(llmMessages);
	let promptText = `# Conversation\n${conversationText}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	if (customInstructions) {
		promptText = `${promptText}\n\nAdditional focus: ${customInstructions}`;
	}

	const response = await completeSummarization(
		model,
		buildSummarizationContext(promptText),
		createSummarizationOptions(model, apiKey, headers, env, signal, thinkingLevel, sessionId),
		streamFn,
		retry,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "Turn prefix summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Turn prefix summarization attempted to call a tool");
	}

	return {
		text: contentText(response.content),
		usage: response.usage,
	};
}
