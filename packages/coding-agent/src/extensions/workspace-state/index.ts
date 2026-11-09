import os from "node:os";
import { contentText } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { isTuiMode } from "../../core/tui-mode.ts";
import { isNestedSubagent } from "../subagents/index.ts";
import { classifyHeuristic, classifyWithLlm } from "./classify.ts";
import { buildWorkspaceStateRecord } from "./record.ts";
import { registerSessionNotesTool } from "./session-notes-tool.ts";
import { workspaceStateStore } from "./state.ts";
import {
	WORKSPACE_STATE_ENTRY,
	WORKSPACE_STATE_NOTES_ENTRY,
	type WorkspaceStateNotes,
	type WorkspaceStateRecord,
} from "./types.ts";

/** `agent_settled` is awaited; an unavailable side call must not hold the turn indefinitely. */
const CLASSIFIER_TIMEOUT_MS = 15_000;
const RECENT_MESSAGES = 8;
const MAX_TOOL_RESULT_CHARS = 600;
const MAX_CONTEXT_CHARS = 12_000;

/** Use the active session branch, not the whole file, so forked-off branches cannot leak in. */
function recentEvidence(ctx: ExtensionContext, notes: WorkspaceStateNotes, finalMessage: string | undefined): string {
	const entries = ctx.sessionManager.getBranch();
	const messages = entries.filter((entry) => entry.type === "message").slice(-RECENT_MESSAGES);
	const transcript = messages
		.map((entry) => {
			if (entry.type !== "message") return "";
			const message = entry.message;
			const limit = message.role === "toolResult" ? MAX_TOOL_RESULT_CHARS : 4_000;
			let content = "";
			if ("content" in message && typeof message.content === "string") {
				content = message.content.slice(0, limit);
			} else if ("content" in message && Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part.type !== "text" || content.length >= limit) continue;
					content += `${content ? "\n" : ""}${part.text.slice(0, limit - content.length)}`;
				}
			}
			return `${message.role}${message.role === "toolResult" ? ` (${message.toolName})` : ""}: ${content}`;
		})
		.join("\n");
	const prior = entries
		.filter((entry) => entry.type === "custom" && entry.customType === WORKSPACE_STATE_ENTRY)
		.slice(-3)
		.map((entry) => (entry.type === "custom" ? (entry.data as WorkspaceStateRecord) : undefined));
	const evidence = `## Recent messages\n${transcript}\n## Prior workspace-state records\n${JSON.stringify(prior)}\n## Sticky session notes\n${JSON.stringify(notes)}`;
	// Reserve space for the final message, which the classifier appends separately.
	const budget = MAX_CONTEXT_CHARS - Math.min(finalMessage?.trim().length ?? 0, 4_000) - 100;
	return evidence.length > budget ? evidence.slice(-budget) : evidence;
}

/** One record per main-session hand-back, with sticky facts independent of classification. */
export default function workspaceStateExtension(pi: ExtensionAPI): void {
	if (isNestedSubagent()) return;

	let notes: WorkspaceStateNotes = {};
	let finalMessage: string | undefined;
	// The session is idle while agent_settled is awaited, so a new prompt can start
	// mid-classification; a result from a superseded turn is dropped.
	let turn = 0;
	const updateNotes = (change: WorkspaceStateNotes): void => {
		notes = {
			...notes,
			...change,
			...(change.open_items
				? {
						open_items: change.open_items
							.map((item) => item.trim().slice(0, 300))
							.filter(Boolean)
							.slice(0, 20),
					}
				: {}),
		};
		pi.appendEntry(WORKSPACE_STATE_NOTES_ENTRY, {
			...notes,
			...(notes.open_items ? { open_items: [...notes.open_items] } : {}),
		});
	};
	registerSessionNotesTool(pi, updateNotes);

	pi.on("session_start", (_event, ctx) => {
		notes = {};
		const previous = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === WORKSPACE_STATE_NOTES_ENTRY)
			.at(-1);
		if (previous?.type === "custom" && previous.data && typeof previous.data === "object") {
			const data = previous.data as Record<string, unknown>;
			if (typeof data.feads_epic === "string") notes.feads_epic = data.feads_epic;
			if (Array.isArray(data.open_items))
				notes.open_items = data.open_items.filter((item): item is string => typeof item === "string");
		}
		finalMessage = undefined;
		workspaceStateStore.clear();
	});
	pi.on("agent_start", () => {
		turn += 1;
		finalMessage = undefined;
		workspaceStateStore.clear();
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const text = contentText(event.message.content).trim();
		if (text.length > 0) finalMessage = text;
	});
	pi.on("tool_result", (event) => {
		if (
			notes.feads_epic ||
			event.isError ||
			!/feads.*create$/i.test(event.toolName) ||
			event.input.issue_type !== "epic"
		)
			return;
		for (const part of event.content) {
			if (part.type !== "text") continue;
			const id = /"id"\s*:\s*"([a-z][\w-]*-[\w-]+)"/i.exec(part.text)?.[1];
			if (id) {
				updateNotes({ feads_epic: id });
				break;
			}
		}
	});

	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		const settledTurn = turn;
		const settledNotes = notes;
		let classification = classifyHeuristic(finalMessage);
		const settings = sessionStateSettings(ctx);
		if ((settings.classifier ?? "llm") === "llm" && ctx.sideQuestion) {
			const outcome = await classifyWithLlm({
				finalMessage,
				context: recentEvidence(ctx, notes, finalMessage),
				sideQuestion: ctx.sideQuestion,
				model: settings.model ?? "",
				signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
			});
			if (turn !== settledTurn) return;
			classification = outcome.classification;
			// stderr would scribble over the TUI; the record's heuristic fallback is visible in the session anyway.
			if (outcome.error && ctx.mode !== "tui")
				console.warn(`[workspace-state] classifier fell back to the heuristic: ${outcome.error}`);
		}
		const record = buildWorkspaceStateRecord({
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			cwd: ctx.cwd,
			host: os.hostname(),
			ts: Date.now(),
			classification,
			notes: settledNotes,
		});
		pi.appendEntry(WORKSPACE_STATE_ENTRY, record);
		workspaceStateStore.publish(record);
		if (isTuiMode() && ctx.mode === "tui" && record.end_state === "awaiting-human") {
			ctx.ui.notify(`Waiting on you: ${record.question ?? "(no question given)"}`, "warning");
		}
	});
}

function sessionStateSettings(ctx: ExtensionContext): { classifier?: string; model?: string } {
	try {
		return SettingsManager.create(ctx.cwd, getAgentDir()).getSessionStateSettings();
	} catch {
		return {};
	}
}

export const __testing = { CLASSIFIER_TIMEOUT_MS, RECENT_MESSAGES, MAX_TOOL_RESULT_CHARS, MAX_CONTEXT_CHARS };
