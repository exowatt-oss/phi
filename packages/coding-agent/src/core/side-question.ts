/**
 * Side-question core: one-turn, no-tools, forked-context LLM call.
 *
 * Implements the /btw side-question pattern:
 * - Context from buildContextEntries(), trailing partial assistant dropped
 * - In-memory history of prior Q&A pairs, capped at maxHistory (default 20)
 * - System-reminder user message prepended to the question
 * - Direct complete() call with no tools and its own AbortController
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { fitImagesToProviderLimits } from "../utils/image-limits.ts";
import { convertToLlm } from "./messages.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionEntry } from "./session-manager.ts";
import { buildContextEntries, sessionEntryToContextMessages } from "./session-manager.ts";

/** Default maximum Q&A pairs kept in side-question history. */
export const DEFAULT_MAX_SIDE_HISTORY = 20;

/** A single completed side-question Q&A pair. */
export interface SideQuestionPair {
	question: string;
	answer: string;
	usage: Usage;
}

/** System-reminder rules injected as a user message before each side question. */
export const SIDE_QUESTION_SYSTEM_REMINDER = `<system-reminder>
You are a lightweight side assistant. The main agent is running in parallel and is NOT interrupted.
Rules:
- Answer the question directly and concisely.
- Do NOT use any tools.
- Do NOT promise to perform any actions or investigate further.
- This is a one-off response; you will not be called again for follow-up.
- If you don't know the answer, say so plainly.
</system-reminder>`;

/**
 * Build the Message[] to send for a side question.
 *
 * Steps:
 * 1. Convert SessionEntry[] (already compaction-aware from buildContextEntries) to AgentMessage[].
 * 2. Drop trailing assistant messages with stopReason "pending" (partial/streaming).
 * 3. Convert AgentMessages to LLM-compatible Messages.
 * 4. Prepend up to maxHistory Q&A history pairs.
 * 5. Append the system-reminder + question as a user message.
 */
export function buildSideQuestionMessages(
	entries: SessionEntry[],
	model: Model<Api>,
	question: string,
	history: readonly SideQuestionPair[],
	maxHistory: number = DEFAULT_MAX_SIDE_HISTORY,
): Message[] {
	// 1+2: build context entries, then convert to AgentMessage[], drop partial assistant
	// and trailing unmatched tool calls.
	const contextMessages = buildSideQuestionContextMessages(entries);

	// 4: history (capped)
	const historySlice = history.slice(-maxHistory);
	const historyMessages: Message[] = historySlice.flatMap((pair): Message[] => [
		{
			role: "user" as const,
			content: pair.question,
			timestamp: Date.now(),
		},
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: pair.answer }],
			// Minimal synthetic fields — history is replayed in the side thread only,
			// never appended to the main session context.
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: pair.usage,
			stopReason: "stop" as const,
			timestamp: Date.now(),
		},
	]);

	// 5: system-reminder + question
	const questionMessage: Message = {
		role: "user",
		content: `${SIDE_QUESTION_SYSTEM_REMINDER}\n\n${question}`,
		timestamp: Date.now(),
	};

	return [...contextMessages, ...historyMessages, questionMessage];
}

/**
 * Drop trailing assistant messages whose stopReason is "pending" (partial, mid-stream).
 * Normal complete assistant messages are kept.
 */
export function dropTrailingPartialAssistant(messages: AgentMessage[]): AgentMessage[] {
	let end = messages.length;
	while (end > 0) {
		const last = messages[end - 1];
		if (last.role === "assistant" && last.stopReason === "pending") {
			end--;
		} else {
			break;
		}
	}
	return end === messages.length ? messages : messages.slice(0, end);
}

/**
 * Drop trailing assistant messages that contain toolCall blocks with no matching
 * toolResult message following them. Sending an unmatched tool-call to the LLM
 * causes provider-level validation errors.
 *
 * Strategy: walk from the end, collect any trailing assistant+toolResult pairs
 * that form a complete exchange. If the last assistant message has stopReason
 * "toolUse" and has no following toolResult, strip it (and repeat upward for any
 * additional unmatched tool-call turns).
 */
export function dropTrailingUnmatchedToolCalls(messages: AgentMessage[]): AgentMessage[] {
	let trimmed = messages;

	while (trimmed.length > 0) {
		let assistantIndex = trimmed.length - 1;
		while (assistantIndex >= 0 && trimmed[assistantIndex]?.role === "toolResult") assistantIndex--;

		const assistant = trimmed[assistantIndex];
		if (assistant?.role !== "assistant") break;
		const toolCallIds = assistant.content
			.filter(
				(block): block is Extract<(typeof assistant.content)[number], { type: "toolCall" }> =>
					block.type === "toolCall",
			)
			.map((block) => block.id);
		if (assistant.stopReason !== "toolUse" && toolCallIds.length === 0) break;

		const resultIds = new Set(
			trimmed
				.slice(assistantIndex + 1)
				.filter(
					(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
				)
				.map((message) => message.toolCallId),
		);
		if (toolCallIds.length > 0 && toolCallIds.every((id) => resultIds.has(id))) break;

		// Drop the assistant tool-use turn and any partial results after it. Repeat in
		// case an earlier trailing tool-use turn was also incomplete.
		trimmed = trimmed.slice(0, assistantIndex);
	}

	return trimmed;
}

/** Build only the sanitized, compaction-aware main-context prefix. */
export function buildSideQuestionContextMessages(entries: SessionEntry[]): Message[] {
	const contextEntries = buildContextEntries(entries);
	const agentMessages = contextEntries.flatMap(sessionEntryToContextMessages);
	return convertToLlm(dropTrailingUnmatchedToolCalls(dropTrailingPartialAssistant(agentMessages)));
}

/** Result returned from runSideQuestion. */
export interface SideQuestionResult {
	answer: string;
	usage: Usage;
}

/**
 * Execute a single side-question turn.
 *
 * - No tools: passes an empty tools array so the model cannot invoke any.
 * - Own AbortController so closing the panel only aborts this call.
 * - Returns the answer text and usage for display.
 * - thinkingLevel is forwarded to the provider as reasoning effort when set.
 * - idleTimeoutMs uses the owning session's resolved stream watchdog setting.
 */
export async function runSideQuestion(
	model: Model<Api>,
	runtime: ModelRuntime,
	messages: Message[],
	systemPrompt: string | undefined,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	idleTimeoutMs?: number,
): Promise<SideQuestionResult> {
	const controller = new AbortController();

	// Forward external abort (e.g. session teardown)
	let onExternalAbort: (() => void) | undefined;
	if (signal) {
		onExternalAbort = () => controller.abort();
		signal.addEventListener("abort", onExternalAbort, { once: true });
	}

	let response: AssistantMessage;
	try {
		response = await runtime.completeSimple(
			model,
			{
				systemPrompt,
				messages: await fitImagesToProviderLimits(messages),
				tools: [],
			},
			{
				signal: controller.signal,
				cacheRetention: "none",
				...(thinkingLevel !== undefined && { reasoning: thinkingLevel }),
				...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
			},
		);
	} finally {
		if (signal && onExternalAbort) {
			signal.removeEventListener("abort", onExternalAbort);
		}
	}

	const attemptedTool = response.content.find((block) => block.type === "toolCall");
	const answer = attemptedTool
		? `The side-question model tried to call ${attemptedTool.name} instead of answering. Side questions cannot use tools.`
		: response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("");

	return { answer, usage: response.usage };
}

/** Abort a running side question by calling the returned function. */
export type SideQuestionAbort = () => void;

/**
 * Create an in-memory history store for side-question Q&A pairs.
 * The list is capped at maxHistory on append.
 */
export function createSideQuestionHistory(initialMaxHistory: number = DEFAULT_MAX_SIDE_HISTORY): {
	getAll: () => readonly SideQuestionPair[];
	append: (pair: SideQuestionPair) => void;
	setMaxHistory: (maxHistory: number) => void;
	clear: () => void;
} {
	const pairs: SideQuestionPair[] = [];
	let maxHistory = Math.max(1, Math.floor(initialMaxHistory));
	const trim = () => {
		if (pairs.length > maxHistory) pairs.splice(0, pairs.length - maxHistory);
	};
	return {
		getAll: () => pairs,
		append: (pair) => {
			pairs.push(pair);
			trim();
		},
		setMaxHistory: (value) => {
			maxHistory = Math.max(1, Math.floor(value));
			trim();
		},
		clear: () => {
			pairs.length = 0;
		},
	};
}
