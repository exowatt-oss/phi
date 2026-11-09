/**
 * Built-in `stall-guard` extension: recover text-only turns that stop while
 * the model is still talking like an unfinished work log.
 *
 * Ten days of sessions showed that broad commitment prose was mostly healthy
 * final reports. v4 therefore judges structure first, then handoff shape, and
 * only fires for three degenerate forms: an empty stop, a telegraphic
 * self-talk wall, or a short commitment/bare promise.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { findOrphanedBackgroundRuns, isNestedSubagent } from "../subagents/index.ts";

/** customType of the steered continuation nudge (participates in LLM context). */
export const STALL_NUDGE_MESSAGE_TYPE = "stall-guard-nudge";
/** customType of the visible give-up warning after consecutive stalls. */
export const STALL_WARNING_MESSAGE_TYPE = "stall-guard-warning";
/** customType of the resume-time stale-claim note (a stalled turn was the session's last word before a restart). */
export const STALL_RESUME_NOTE_MESSAGE_TYPE = "stall-guard-resume-note";

/** Raw-reasoning dialect retained from the measured corpus. */
const LEAKED_REASONING_PATTERNS: RegExp[] = [
	/\bwe\s+(?:need|can|should|must|will)\s+\w+/i,
	/\bneed\s+(?:to\s+)?(?:proceed|reply|request|re-request|ensure|update|merge|post|check|verify|run|keep|continue|fix)\b/i,
	/^\s*(?:do|proceed|reply|continue)\.\s*$/im,
	/\bthen\s+(?:re-)?(?:request|reply|merge|deploy|verify|poll|run|check|post)\b/i,
];

const DECISION_REQUEST: RegExp[] = [
	/\blet me know\b/i,
	/\bplease (?:confirm|advise|decide|choose|pick|clarify)\b/i,
	/\b(?:confirm|advise|clarify) (?:whether|if|which|what)\b/i,
	/\bwaiting (?:on|for) (?:your|you)\b/i,
	/\b(?:which|what) would you (?:like|prefer)\b/i,
	/\bwant me to\b/i,
	/\bshould I\b/i,
	/\byour call\b/i,
	/\bawaiting your\b/i,
	/\bneed (?:your|a) (?:decision|input|approval|sign-?off|answer|confirmation)\b/i,
	/\bhow (?:do|would) you want\b/i,
	/\btell me (?:which|what|whether|if)\b/i,
];

const DELIBERATIVE_STARTS = new Set(["need", "then", "let's", "maybe", "also"]);
const IMPERATIVE_OR_AMBIGUOUS_STARTS = new Set([
	"do",
	"use",
	"check",
	"run",
	"close",
	"open",
	"verify",
	"fine",
	"now",
	"next",
	"could",
]);

/**
 * Hallucinated Codex-harness budget status. It is deliberately anchored: a
 * legitimate report can mention token counts without being this status line.
 */
const HALLUCINATED_STATUS_LINE_PATTERN =
	/^you(?:['’]ve| have)\s+(?:got\s+)?[\d,]+\s+(?:weighted\s+)?tokens?\s+left[.!]?$/i;

export function textIsHallucinatedStatusLine(text: string): boolean {
	return HALLUCINATED_STATUS_LINE_PATTERN.test(text.trim());
}

export interface StallVerdict {
	stalled: boolean;
	reason?: string;
}

type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function reasoningTelemetry(message: AssistantMessage): string {
	const reasoning = message.usage?.reasoning;
	return reasoning === undefined ? "missing" : String(reasoning);
}

function stalledReason(message: AssistantMessage, reason: string): string {
	return `${reason} (reasoning=${reasoningTelemetry(message)})`;
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function hasBlockLevelMarkdown(text: string): boolean {
	return text.split(/\r?\n/).some((line) => /^[ \t]*(?:#|[-*][ \t]+|\d+\.[ \t]+|```|\|.*\|[ \t]*)/.test(line));
}

function paragraphs(text: string): string[] {
	return text
		.trim()
		.split(/\r?\n[ \t]*\r?\n/)
		.filter((paragraph) => paragraph.trim().length > 0);
}

function isReportShaped(text: string): boolean {
	const parts = paragraphs(text);
	if (parts.length < 3) return false;
	// A measured self-talk wall can contain blank-line-separated command
	// clusters. Treat those as dialect, not as a report; ordinary prose
	// paragraphs do not independently meet the telegraphic threshold.
	return parts.every((paragraph) => !telegraphicDialect(paragraph));
}

function lastMeaningfulLine(text: string): string | undefined {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.at(-1);
}

function isQuestionOrHandoff(text: string): boolean {
	if (lastMeaningfulLine(text)?.endsWith("?")) return true;
	return DECISION_REQUEST.some((pattern) => pattern.test(text));
}

function sentenceUnits(text: string): string[] {
	return text
		.trim()
		.split(/(?<=[.!?…])\s+|\r?\n+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0);
}

function wordList(sentence: string): string[] {
	return sentence.match(/[A-Za-z0-9'’-]+/g) ?? [];
}

function telegraphicDialect(text: string): boolean {
	const sentences = sentenceUnits(text);
	if (sentences.length === 0) return false;

	let fragments = 0;
	let deliberativeStarts = 0;
	let leakedHits = 0;
	let addressesUser = false;
	for (const sentence of sentences) {
		const words = wordList(sentence);
		const firstWord = words[0]?.toLowerCase();
		const startsAsDeliberation = firstWord !== undefined && DELIBERATIVE_STARTS.has(firstWord);
		const startsAsImperative = firstWord !== undefined && IMPERATIVE_OR_AMBIGUOUS_STARTS.has(firstWord);
		const addressesUserSentence = /\b(?:you|your|yours)\b/i.test(sentence);
		addressesUser ||= addressesUserSentence;
		const isShort = words.length <= 4;
		// The corpus' walls omit ordinary articles even when a sentence is a
		// little longer than a bare fragment. Keep that signal conservative so
		// normal prose with a missing "the" does not become a stall.
		const isArticlePoor = words.length > 0 && words.length <= 8 && !/\b(?:a|an|the)\b/i.test(sentence);
		if (!addressesUserSentence && (startsAsImperative || isShort || isArticlePoor)) fragments++;
		if (startsAsDeliberation) deliberativeStarts++;

		for (const pattern of LEAKED_REASONING_PATTERNS) {
			const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
			leakedHits += sentence.match(new RegExp(pattern.source, flags))?.length ?? 0;
		}
	}

	if (addressesUser) return false;
	const fragmentWall = sentences.length >= 3 && fragments / sentences.length >= 0.4;
	return (fragmentWall && (deliberativeStarts > 0 || leakedHits > 0)) || leakedHits >= 2;
}

const COMPLETION_VOCABULARY =
	/\b(?:done|shipped|merged|complete[d]?|finished|passed|green|deployed|landed|published|closed)\b/i;

function isBarePromise(text: string): boolean {
	const trimmed = text.trim();
	if (textIsHallucinatedStatusLine(text)) return true;
	if (/^continuing\b/i.test(trimmed) && trimmed.length <= 60 && sentenceUnits(trimmed).length === 1) return true;
	if (/^doing (?:that|this|it) now\.?$/i.test(trimmed)) return true;
	if (trimmed.length > 120 || /[;—–:\n]/.test(text) || COMPLETION_VOCABULARY.test(trimmed)) return false;
	if (/^(?:i['’]m|i am)\s+.+\.?$/i.test(trimmed)) {
		return /\b\w+ing\b|\b(?:at|in)\s+the\b|\b(?:at|in)\s+(?:final|shipping|review|deployment)\b/i.test(trimmed);
	}
	if (/^(?:i['’]ll|i will)\s+.+\.?$/i.test(trimmed)) {
		return /\b(?:merge|deploy|continue|proceed|run|start|finish|ship|publish|build|implement|verify|validate|call|check|open|close|update|create)\b/i.test(
			trimmed,
		);
	}
	return false;
}

const SHORT_COMMITMENT_PATTERNS: RegExp[] = [
	/\b(?:i['’]m|i am)\s+(?:now\s+|directly\s+|currently\s+)?(?:\w+ing\b|at\s+the\s+\w+(?:\s+\w+)?\s+stage\b|on\s+it\b)/i,
	/\b(?:i['’]ve|i have)\s+(?:now\s+)?started\b/i,
	/\b(?:i['’]ll|i will)\s+(?:now\s+)?(?:\w+ing\s+)?\w+/i,
	/\b(?:is|are)\s+now\s+\w+ing\b/i,
	/\bwork\s+continues\b/i,
	/\bcontinues?\s+now\b/i,
	/\bnext\s+(?:is|up|steps?)\b/i,
	/\b(?:the\s+)?next\s+[\w/-]+(?:\s+[\w/-]+){0,2}\s+(?:is|are)\b/i,
	/\b(?:i['’]ll|i will)\s+(?:ping|notify|update|report back to|let)\s+you\b/i,
	/\bmy next (?:message|update|reply) will\b/i,
];

const SHORT_COMMITMENT_FORWARD_MARKER =
	/\b(?:next|now|then|once|will|going to|continues?|moving|proceeding|started|stage|before shipping|until)\b/i;

const REQUEST_TO_USER_PATTERNS: RegExp[] = [
	/\bi need you to\b/i,
	/\bplease\b/i,
	/\b(?:can|could|would) you\b/i,
	/\bthen reply\b/i,
	/\breply (?:with|when|once)\b/i,
	/\byou(?:['’]ll)? need to\b/i,
];

const TERMINAL_LAST_SENTENCE_PATTERN =
	/\b(?:stop(?:ping)? here|wrapped up|all set|nothing (?:else|further)|no further (?:action|work|changes)|that['’]s (?:all|it)|done|is (?:complete|done|finished|shipped|merged|deployed|live|verified))\.?$/i;

function hasPlanArrowChain(text: string): boolean {
	return sentenceUnits(text).some((sentence) => (sentence.match(/(?:→|->)/g) ?? []).length >= 2);
}

function isShortCommitment(text: string): boolean {
	if (text.length > 600 || paragraphs(text).length >= 3 || hasBlockLevelMarkdown(text)) return false;
	if (isQuestionOrHandoff(text) || REQUEST_TO_USER_PATTERNS.some((pattern) => pattern.test(text))) return false;

	const commitmentShape =
		SHORT_COMMITMENT_PATTERNS.some((pattern) => pattern.test(text)) ||
		sentenceUnits(text).some((sentence) => /^Continuing\.$/i.test(sentence)) ||
		hasPlanArrowChain(text);
	if (!commitmentShape) return false;
	if (!SHORT_COMMITMENT_FORWARD_MARKER.test(text) && !hasPlanArrowChain(text)) return false;

	const lastSentence = sentenceUnits(text).at(-1);
	if (lastSentence === undefined || !TERMINAL_LAST_SENTENCE_PATTERN.test(lastSentence)) return true;
	// A conditional outcome at the end of a forward plan is not a terminal
	// declaration (for example, "I'll stay ... until production is verified").
	if (/\b(?:until|before|once|when)\b/i.test(lastSentence)) return true;
	return false;
}

/** Judge the final message of a finished run. */
export function detectStall(finalMessage: AgentMessage | undefined): StallVerdict {
	if (!finalMessage || finalMessage.role !== "assistant") return { stalled: false };
	const message = finalMessage as AssistantMessage;
	if (message.stopReason !== "stop" || message.errorMessage) return { stalled: false };
	if (!Array.isArray(message.content)) return { stalled: false };

	const toolCalls = message.content.filter((block): block is ToolCallBlock => block.type === "toolCall");
	if (toolCalls.some((call) => call.name === "loop_control")) {
		return { stalled: false, reason: "loop_control owns continuation" };
	}
	if (toolCalls.length > 0) {
		return { stalled: false, reason: "stop included a tool call" };
	}
	const text = textOf(message);
	if (!text.trim()) return { stalled: true, reason: stalledReason(message, "empty stop") };

	if (hasBlockLevelMarkdown(text) || isReportShaped(text) || text.length > 1200) {
		return { stalled: false, reason: "report-shaped text" };
	}
	if (isQuestionOrHandoff(text)) return { stalled: false, reason: "question or decision handoff" };
	if (telegraphicDialect(text)) return { stalled: true, reason: stalledReason(message, "telegraphic self-talk wall") };
	if (isBarePromise(text))
		return { stalled: true, reason: stalledReason(message, "bare promise or hallucinated status line") };
	if (isShortCommitment(text)) return { stalled: true, reason: stalledReason(message, "short commitment") };
	return { stalled: false };
}

const WARNING_TEXT = "stall guard: 3 continuations this prompt — stopping; give it a concrete next command";

function nudgeText(attempt: number): string {
	return `<harness-reminder>Your last message ended the turn without a tool call while the task appears unfinished and nothing is running in the background. Call the next concrete tool now, or give the user your final answer. (Automatic reminder ${attempt}/3 — not a user message, not a blocker.)</harness-reminder>`;
}

export default function stallGuardExtension(pi: ExtensionAPI): void {
	if (isNestedSubagent()) return;
	if ((process.env.PI_STALL_GUARD ?? "").toLowerCase() === "off") return;

	let consecutiveStalls = 0;
	let warningShown = false;

	const resetForUserPrompt = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }): void => {
		consecutiveStalls = 0;
		warningShown = false;
		ctx.ui.setStatus("stall-guard", undefined);
	};

	// Input is the boundary for the per-prompt cap. Extension-generated input
	// (including the nudge itself) must not reset the user's budget.
	pi.on("input", (event, ctx) => {
		if (event.source !== "extension") resetForUserPrompt(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		let lastMessage: AgentMessage | undefined;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "custom_message" && entry.customType.startsWith("stall-guard")) return;
			if (entry.type !== "message") continue;
			lastMessage = entry.message;
			break;
		}
		if (!lastMessage || lastMessage.role !== "assistant") return;
		if (!detectStall(lastMessage).stalled) return;
		const ranTools = branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult");
		if (!ranTools) return;
		if (findOrphanedBackgroundRuns(branch).runIds.length > 0) return;

		ctx.ui.setStatus(
			"stall-guard",
			"stall guard: last turn ended mid-work with nothing running — your next prompt resumes it",
		);
		pi.sendMessage({
			customType: STALL_RESUME_NOTE_MESSAGE_TYPE,
			content:
				"[stall guard] The last message claims work is in progress, but nothing is running — the claim went stale. " +
				"On the next turn, continue the actual work with tools, or state plainly that you are blocked and on what.",
			display: false,
			ephemeral: true,
		});
	});

	pi.on("agent_end", (event, ctx) => {
		const finalMessage = event.messages[event.messages.length - 1];
		const verdict = detectStall(finalMessage);
		if (!verdict.stalled) {
			consecutiveStalls = 0;
			warningShown = false;
			ctx.ui.setStatus("stall-guard", undefined);
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		const ranTools = branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult");
		const backgroundRuns = findOrphanedBackgroundRuns(branch);
		if (!ranTools || backgroundRuns.runIds.length > 0) {
			consecutiveStalls = 0;
			warningShown = false;
			ctx.ui.setStatus(
				"stall-guard",
				`⏸ turn ended without tool calls · ${backgroundRuns.runIds.length} background agents running`,
			);
			return;
		}

		if (warningShown) return;
		if (consecutiveStalls < 3) {
			consecutiveStalls++;
			ctx.ui.setStatus("stall-guard", `↻ stall guard: continued ${consecutiveStalls}/3`);
			pi.sendMessage(
				{
					customType: STALL_NUDGE_MESSAGE_TYPE,
					content: nudgeText(consecutiveStalls),
					display: false,
					ephemeral: true,
				},
				{ triggerTurn: true },
			);
			return;
		}

		warningShown = true;
		pi.sendMessage({
			customType: STALL_WARNING_MESSAGE_TYPE,
			content: WARNING_TEXT,
			display: true,
			ephemeral: true,
		});
	});

	pi.registerMessageRenderer(STALL_NUDGE_MESSAGE_TYPE, (_message, _options, theme) => {
		return new Text(theme.fg("muted", "stall guard: continuing"), 0, 0);
	});

	pi.registerMessageRenderer(STALL_WARNING_MESSAGE_TYPE, (message, _options, theme) => {
		const text = typeof message.content === "string" ? message.content : WARNING_TEXT;
		return new Text(theme.fg("dim", text), 0, 0);
	});

	pi.registerMessageRenderer(STALL_RESUME_NOTE_MESSAGE_TYPE, (_message, _options, theme) => {
		return new Text(theme.fg("muted", "stall guard: the last turn ended mid-work; prompting resumes it"), 0, 0);
	});
}
