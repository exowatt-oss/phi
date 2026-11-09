/**
 * /btw — non-blocking side questions (Claude Code-style)
 *
 * Runs a one-off question against the current model in a detached async IIFE
 * so the main agent turn keeps running. The side query reuses the compaction-
 * applied context, drops any trailing partial assistant message, prepends up to
 * 20 in-memory Q&A history pairs as context, appends the new question wrapped
 * in a <system-reminder> user message, and gets a one-turn no-tools answer.
 *
 * Usage while the agent is streaming (or idle):
 *   /btw what's a compaction boundary?   → fires side query, returns immediately
 *   /btw                                  → reopens last answer widget
 *
 * The widget appears above the editor with a spinner, then shows the answer and
 * the token cost. It stays until you clear it or fire another /btw.
 *
 * IMPORTANT: this extension must NOT be permanently installed because the
 * built-in /btw command will claim the slot when it ships. Use it with
 * `pi -e packages/coding-agent/examples/extensions/btw.ts` or copy temporarily
 * to ~/.pi/agent/extensions/ only for testing. Remove before Phase 1 lands.
 *
 * Persistence/renderer: only registered when ctx.mode === "tui" (TUI-only).
 * Close shortcut (Esc equivalent): registered via pi.registerShortcut when the
 * API accepts a plain key string.
 *
 * Implements Phase 0 of the /btw plan (reports/2026-08-03-phi-btw-plan.md).
 */

import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BtwPair {
	question: string;
	answer: string;
}

interface BtwEntryData {
	question: string;
	answer: string;
	inputTokens: number;
	outputTokens: number;
	costTotal: number;
}

// A session entry persisted as a TUI-only btw record (never sent to LLM).
// The entry type key matches the registerEntryRenderer call below.
const ENTRY_TYPE = "btw-answer";

// Maximum Q&A pairs held in memory and replayed as side-thread context.
const MAX_HISTORY = 20;

// The system-reminder user message that wraps every side question.
const SIDE_REMINDER = `<system-reminder>
You are a separate lightweight agent answering a side question while the main agent continues its work. Rules:
- You are NOT interrupting the main agent. It keeps running.
- Do NOT use any tools. Answer directly from your knowledge and the context shown.
- Keep your answer focused and concise. One response only — no follow-ups.
- Never promise to take actions. Say "I don't know" rather than offering to investigate.
- Never reference your own constraints unless directly asked.
</system-reminder>`;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

// Q&A history for the side thread. Capped at MAX_HISTORY. Cleared on session
// switch (the module is reloaded by jiti per session).
const history: BtwPair[] = [];

// Last answer for bare `/btw` reopen.
let lastAnswer: string | undefined;
let lastQuestion: string | undefined;

// AbortController for the current in-flight side query (if any).
let currentAbort: AbortController | undefined;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a cost value as a short dollar string. */
function formatCost(total: number): string {
	if (total < 0.01) {
		return `$${(total * 1000).toFixed(2)}m`;
	}
	return `$${total.toFixed(4)}`;
}

/** Build the widget lines for the pending/spinner state. */
function pendingLines(question: string): string[] {
	return [`◐ btw: ${question} — answering…`];
}

/** Build the widget lines for an error state. */
function errorLines(question: string, message: string): string[] {
	return [`✗ btw: ${question} — ${message}`];
}

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

type AnyContent = string | Array<{ type?: string; text?: string }>;

function extractText(content: AnyContent): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Context snapshot
// ---------------------------------------------------------------------------

/**
 * Build the messages array for the side call:
 *   1. Compaction-applied branch entries → user/assistant messages
 *   2. Drop the trailing partial assistant (stop_reason !== "stop")
 *   3. Prepend up to MAX_HISTORY btw history pairs as user/assistant
 *   4. Append the new question as a user message with the system-reminder
 */
function buildSideMessages(
	ctx: {
		sessionManager: { buildContextEntries: () => Array<{ type: string; message?: unknown }> };
	},
	question: string,
): UserMessage[] {
	const entries = ctx.sessionManager.buildContextEntries();

	// Collect user/assistant messages, drop partial trailing assistant.
	type RawMsg = { role: string; content: AnyContent; stopReason?: string };
	const base: Array<{ role: "user" | "assistant"; content: string }> = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message as RawMsg;
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		const text = extractText(msg.content);
		if (!text.trim()) continue;
		base.push({ role: msg.role as "user" | "assistant", content: text });
	}

	// Drop trailing partial assistant (no stop reason yet — streaming).
	if (base.length > 0) {
		const last = base[base.length - 1];
		if (last && last.role === "assistant") {
			let lastAssistantEntry: (typeof entries)[0] | undefined;
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e !== undefined && e.type === "message" && (e.message as RawMsg | undefined)?.role === "assistant") {
					lastAssistantEntry = e;
					break;
				}
			}
			if (lastAssistantEntry) {
				const aMsg = lastAssistantEntry.message as AssistantMessage;
				if (!aMsg.stopReason || aMsg.stopReason === ("pending" as string)) {
					base.pop();
				}
			}
		}
	}

	// Build the side messages array from history pairs first.
	const ts = Date.now();
	const messages: UserMessage[] = [];

	// Prepend history pairs (each pair = user message + assistant response).
	// We embed them as plain user/assistant content blocks so the model sees
	// the prior btw thread as context, exactly as CC does.
	const historyToSend = history.slice(-MAX_HISTORY);
	for (const pair of historyToSend) {
		messages.push({
			role: "user",
			content: [{ type: "text", text: pair.question }],
			timestamp: ts,
		});
		// Simulate the assistant answer from history as a user message with
		// an [assistant] prefix — we can't push a real AssistantMessage into
		// the UserMessage[] array, so we use a labeled user turn instead.
		// This is a Phase 0 approximation; Phase 1 will use the full message
		// array type that includes AssistantMessage interleaved.
		messages.push({
			role: "user",
			content: [{ type: "text", text: `[previous btw answer]\n${pair.answer}` }],
			timestamp: ts,
		});
	}

	// Append the full compacted base context as a user message so the model
	// has session context. We inject the whole thing as a labeled block.
	if (base.length > 0) {
		const contextLines: string[] = [];
		for (const m of base) {
			contextLines.push(`[${m.role}]: ${m.content}`);
		}
		messages.push({
			role: "user",
			content: [
				{
					type: "text",
					text: `<session_context>\n${contextLines.join("\n\n")}\n</session_context>`,
				},
			],
			timestamp: ts,
		});
	}

	// Finally: the actual question with the system-reminder.
	messages.push({
		role: "user",
		content: [{ type: "text", text: `${SIDE_REMINDER}\n\n${question}` }],
		timestamp: ts,
	});

	return messages;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// -------------------------------------------------------------------------
	// TUI-only persistence renderer
	// -------------------------------------------------------------------------
	pi.registerEntryRenderer<BtwEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data: BtwEntryData = entry.data ?? {
			question: "",
			answer: "",
			inputTokens: 0,
			outputTokens: 0,
			costTotal: 0,
		};
		const mdTheme = getMarkdownTheme();
		const box = new Box(1, 0, (t) => theme.fg("dim", t));

		const label = `${theme.fg("accent", theme.bold("/btw"))} ${theme.fg("muted", data.question)}`;
		box.addChild(new Text(label, 0, 0));
		box.addChild(new Markdown(data.answer, 0, 1, mdTheme));

		const costStr = `${formatCost(data.costTotal)} · ${data.inputTokens}in / ${data.outputTokens}out`;
		box.addChild(new Text(theme.fg("dim", costStr), 0, 0));

		return box;
	});

	// -------------------------------------------------------------------------
	// /btw command
	// -------------------------------------------------------------------------
	pi.registerCommand("btw", {
		description: "Ask a side question without interrupting the current agent turn",
		handler: async (args, ctx) => {
			const question = args.trim();

			// Bare /btw: reopen the last answer.
			if (!question) {
				if (lastAnswer && lastQuestion) {
					ctx.ui.setWidget("btw", [
						`${theme_fg_accent(ctx, "/btw")} ${lastQuestion}`,
						"",
						lastAnswer,
						"",
						theme_fg_dim(ctx, "(previous answer — /btw <question> for a new one)"),
					]);
				} else {
					ctx.ui.notify("No previous /btw answer. Provide a question.", "info");
				}
				return;
			}

			// Guard: need a model and auth.
			if (!ctx.model) {
				ctx.ui.notify("/btw: no model selected", "error");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) {
				ctx.ui.notify(`/btw: ${auth.error}`, "error");
				return;
			}
			if (!auth.apiKey && !auth.headers) {
				ctx.ui.notify(`/btw: no auth for ${ctx.model.provider}`, "error");
				return;
			}

			// Abort any in-flight side query.
			currentAbort?.abort();
			const abort = new AbortController();
			currentAbort = abort;

			// Snapshot: build messages (compaction-applied context + history + question).
			const messages = buildSideMessages(ctx, question);
			const systemPrompt = ctx.getSystemPrompt();
			const model = ctx.model;

			// Set pending widget immediately (synchronous, before the IIFE runs).
			ctx.ui.setWidget("btw", pendingLines(question));

			// Fire and forget — the IIFE runs detached; errors are caught inside.
			void (async () => {
				try {
					const response = await ctx.modelRegistry.complete(
						model,
						{ systemPrompt, messages },
						{
							apiKey: auth.apiKey ?? "",
							headers: auth.headers,
							env: auth.env,
							signal: abort.signal,
							sessionId: uuidv7(),
							// No tools — side questions cannot use tools.
						},
					);

					if (abort.signal.aborted) return;

					if (response.stopReason === "aborted") {
						ctx.ui.setWidget("btw", undefined);
						return;
					}

					const answer = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
						.trim();

					// Accumulate cost.
					const usage = (response as AssistantMessage).usage;
					const costTotal = usage?.cost?.total ?? 0;
					const inputTokens = usage?.input ?? 0;
					const outputTokens = usage?.output ?? 0;
					const costLine = `${formatCost(costTotal)} · ${inputTokens}in / ${outputTokens}out`;

					// Update history.
					history.push({ question, answer });
					if (history.length > MAX_HISTORY) {
						history.splice(0, history.length - MAX_HISTORY);
					}
					lastQuestion = question;
					lastAnswer = answer;

					// Update widget with the answer.
					// Widget content is plain string[] lines.
					const lines: string[] = [`/btw: ${question}`, "", ...answer.split("\n"), "", costLine];
					ctx.ui.setWidget("btw", lines);

					// Persist as TUI-only entry (does not go to LLM context).
					if (ctx.mode === "tui") {
						pi.appendEntry<BtwEntryData>(ENTRY_TYPE, {
							question,
							answer,
							inputTokens,
							outputTokens,
							costTotal,
						});
					}
				} catch (err) {
					if (abort.signal.aborted) return;
					const message = err instanceof Error ? err.message : String(err);
					ctx.ui.setWidget("btw", errorLines(question, message));
				}
			})();

			// Return immediately — handler never awaits the IIFE above.
		},
	});

	// -------------------------------------------------------------------------
	// Close shortcut: clear the btw widget.
	// The plan calls for Esc/Enter/Space to close. We register ctrl+shift+b as
	// a dedicated close key because Esc is owned by the agent abort action and
	// cannot be claimed here without conflicting.
	// -------------------------------------------------------------------------
	pi.registerShortcut("ctrl+shift+b", {
		description: "Close /btw answer widget",
		handler: async (ctx) => {
			currentAbort?.abort();
			currentAbort = undefined;
			ctx.ui.setWidget("btw", undefined);
		},
	});
}

// ---------------------------------------------------------------------------
// Local theme helpers (avoid importing theme directly — ctx.ui.theme exists
// only at render time; here we emit plain ANSI via string literals for the
// widget which is string[]).
// ---------------------------------------------------------------------------

// These are no-ops at widget-string level (widgets take plain strings).
// They exist so the intent is clear when reading the code.
function theme_fg_accent(_ctx: unknown, s: string): string {
	return s;
}

function theme_fg_dim(_ctx: unknown, s: string): string {
	return s;
}
