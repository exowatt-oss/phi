/**
 * Session entries and live agent messages -> phi remote `TranscriptItem`s.
 *
 * Item ids are stable across `snapshot`, `history` and live `item.upsert` events, so the app can
 * key its list by id. They come from message identity, never from position:
 *
 *   u:<ts>                        user message (`message.timestamp`, kept verbatim when persisted)
 *   a:<ts>                        assistant message (`message.timestamp`, fixed when the stream starts)
 *   t:<assistantTs>:<toolCallId>  one tool call of that assistant message; its result merges in.
 *                                 Qualified by the assistant timestamp because some providers reuse
 *                                 tool-call ids across turns.
 *   b:<ts>                        a user `!bash` run (`bashExecution.timestamp`)
 *   e:<entryId>[:<n>]             everything without a message identity of its own: custom
 *                                 messages (their timestamp is rewritten when they are persisted),
 *                                 compaction / branch summaries, context-window markers. Also the
 *                                 fallback for a message without a finite timestamp and for the
 *                                 older of two messages that would collide on one id.
 *
 * Pure functions only; the live side (bridge.ts) renders its in-flight records with the same
 * builders, which is what keeps live upserts byte-identical to the persisted rendering.
 */

import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { TranscriptItem } from "../../remote/protocol.ts";
import { OVERSEER_BOARD_ENTRY } from "../overseer/types.ts";

export type UserItem = Extract<TranscriptItem, { kind: "user" }>;
export type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;
export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
export type NoteItem = Extract<TranscriptItem, { kind: "note" }>;

export const ARGS_MAX_CHARS = 4 * 1024;
export const OUTPUT_MAX_CHARS = 8 * 1024;
export const NOTE_MAX_CHARS = 8 * 1024;
export const TEXT_MAX_CHARS = 64 * 1024;
export const THINKING_MAX_CHARS = 16 * 1024;
const SUMMARY_MAX_CHARS = 200;
/** How far back a snapshot keeps scanning (ids only) to tell persisted from in-flight records. */
const MAX_SCAN_ENTRIES = 5000;

export const itemIds = {
	user: (ts: number) => `u:${ts}`,
	assistant: (ts: number) => `a:${ts}`,
	tool: (assistantTs: number, toolCallId: string) => `t:${assistantTs}:${toolCallId}`,
	bash: (ts: number) => `b:${ts}`,
	entry: (entryId: string, index = 0) => (index === 0 ? `e:${entryId}` : `e:${entryId}:${index}`),
};

type Content = string | readonly (TextContent | ImageContent)[] | null | undefined;

/** Text parts joined by newlines, plus the number of image parts. Tolerates malformed content. */
export function contentParts(content: Content | unknown): { text: string; images: number } {
	if (typeof content === "string") return { text: content, images: 0 };
	if (!Array.isArray(content)) return { text: "", images: 0 };
	const texts: string[] = [];
	let images = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const typed = part as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") texts.push(typed.text);
		else if (typed.type === "image") images++;
	}
	return { text: texts.join("\n"), images };
}

/** Keep the head and the tail of an over-long text, with a marker in between. */
export function headTail(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	const half = Math.max(1, Math.floor((max - 48) / 2));
	const head = text.slice(0, half);
	const tail = text.slice(text.length - half);
	const omitted = text.length - head.length - tail.length;
	return { text: `${head}\n… [${omitted} chars omitted] …\n${tail}`, truncated: true };
}

/** Collapse whitespace to one line and cap it with an ellipsis. */
export function oneLine(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function isFiniteTs(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

const PRIMARY_ARG: Record<string, readonly string[]> = {
	bash: ["command"],
	read: ["path", "file_path"],
	edit: ["path", "file_path"],
	write: ["path", "file_path"],
	ls: ["path"],
	grep: ["pattern"],
	find: ["pattern"],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** A task of the `subagent` tool as one short label: its name, else its agent, else its first line. */
function subagentTaskLabel(task: Record<string, unknown>): string | undefined {
	const label = nonEmpty(task.name) ?? nonEmpty(task.agent);
	if (label) return oneLine(label, 40);
	const text = nonEmpty(task.task);
	if (!text) return undefined;
	const line = text
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	return line ? oneLine(line, 40) : undefined;
}

/**
 * The `subagent` tool on one line: `3 subagents: ws-a, ws-b, ws-c`, `2 subagents (chain): a → b`,
 * `1 subagent: ws-a`, `subagent  status`, `subagent  kill ws-a`, `subagent  message ws-a  <text>`.
 */
export function subagentToolSummary(args: unknown): string {
	if (!isPlainObject(args)) return "subagent";
	const action = args.action;
	if (action === "status") return "subagent  status";
	if (action === "kill" || action === "message") {
		const target = nonEmpty(args.target);
		const message = action === "message" ? nonEmpty(args.message) : undefined;
		const line = `subagent  ${action}${target ? ` ${oneLine(target, 60)}` : ""}${message ? `  ${oneLine(message, SUMMARY_MAX_CHARS)}` : ""}`;
		return line.length > SUMMARY_MAX_CHARS ? `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…` : line;
	}
	const chain = Array.isArray(args.chain) && args.chain.length > 0;
	const list = chain ? (args.chain as unknown[]) : Array.isArray(args.tasks) ? (args.tasks as unknown[]) : undefined;
	let line: string;
	if (list && list.length > 0) {
		const labels = list.map(
			(task, index) => (isPlainObject(task) ? subagentTaskLabel(task) : undefined) ?? `task-${index + 1}`,
		);
		line = `${list.length} subagent${list.length === 1 ? "" : "s"}${chain ? " (chain)" : ""}: ${labels.join(chain ? " → " : ", ")}`;
	} else {
		const label = subagentTaskLabel(args);
		if (!label) return "subagent";
		line = `1 subagent: ${label}`;
	}
	return line.length > SUMMARY_MAX_CHARS ? `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…` : line;
}

/** One line: `bash  ls -la`, `read  src/app.ts`, else `<name>  <first string arg>`, else the name. */
export function toolSummary(name: string, args: unknown): string {
	if (name === "subagent") return subagentToolSummary(args);
	let arg: string | undefined;
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const record = args as Record<string, unknown>;
		for (const key of PRIMARY_ARG[name] ?? []) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) {
				arg = value;
				break;
			}
		}
		if (arg === undefined) {
			for (const value of Object.values(record)) {
				if (typeof value === "string" && value.trim()) {
					arg = value;
					break;
				}
			}
		}
	}
	const title = oneLine(name, SUMMARY_MAX_CHARS);
	if (arg === undefined) return title;
	const summary = `${title}  ${oneLine(arg, SUMMARY_MAX_CHARS)}`;
	return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : summary;
}

function shrink(value: unknown, depth: number): unknown {
	if (typeof value === "string") {
		return value.length > 512 ? `${value.slice(0, 512)}… [${value.length - 512} more chars]` : value;
	}
	if (!value || typeof value !== "object") return value;
	if (depth >= 6) return "[…]";
	if (Array.isArray(value)) {
		const head = value.slice(0, 50).map((entry) => shrink(entry, depth + 1));
		if (value.length > 50) head.push(`… ${value.length - 50} more`);
		return head;
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) out[key] = shrink(entry, depth + 1);
	return out;
}

/** Tool arguments as JSON of at most ~4 KB: long strings shortened, else the JSON text cut. */
export function clampArgs(args: unknown): unknown {
	if (args === undefined) return undefined;
	let json: string | undefined;
	try {
		json = JSON.stringify(args);
	} catch {
		return undefined;
	}
	if (json === undefined) return undefined;
	if (json.length <= ARGS_MAX_CHARS) return args;
	const shrunk = shrink(args, 0);
	const shrunkJson = JSON.stringify(shrunk);
	if (shrunkJson.length <= ARGS_MAX_CHARS) return shrunk;
	return `${shrunkJson.slice(0, ARGS_MAX_CHARS - 1)}…`;
}

function fitsArgs(value: unknown): boolean {
	try {
		return (JSON.stringify(value)?.length ?? 0) <= ARGS_MAX_CHARS;
	} catch {
		return false;
	}
}

function cutText(value: unknown, max: number): unknown {
	if (typeof value !== "string" || value.length <= max) return value;
	return `${value.slice(0, max)}… [${value.length - max} more chars]`;
}

/**
 * `subagent` arguments within ~4 KB that stay an object, so the app can draw its card and match
 * the child sessions by position: task texts are shortened step by step (names, agents and models
 * are kept); only when that is not enough does the generic clamp apply.
 */
export function clampSubagentArgs(args: unknown): unknown {
	if (!isPlainObject(args) || fitsArgs(args)) return clampArgs(args);
	const shrinkTask = (task: unknown, max: number): unknown => {
		if (!isPlainObject(task)) return task;
		const out: Record<string, unknown> = {};
		for (const key of ["name", "agent", "model", "cwd", "timeoutSeconds"]) {
			if (task[key] !== undefined) out[key] = cutText(task[key], 120);
		}
		out.task = cutText(task.task, max);
		return out;
	};
	for (const max of [512, 200, 80, 32]) {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(args)) {
			if ((key === "tasks" || key === "chain") && Array.isArray(value)) {
				out[key] = value.slice(0, 24).map((task) => shrinkTask(task, max));
			} else if (key === "task" || key === "message") {
				out[key] = cutText(value, max);
			} else {
				out[key] = typeof value === "string" ? cutText(value, 120) : value;
			}
		}
		if (fitsArgs(out)) return out;
	}
	return clampArgs(args);
}

/** Text of a tool result (images counted), head+tail truncated to ~8 KB. */
export function toolOutput(content: unknown): { output?: string; outputTruncated?: boolean } {
	const { text, images } = contentParts(content);
	let output = text;
	if (images > 0) output += `${output ? "\n" : ""}[${images} image${images === 1 ? "" : "s"}]`;
	if (!output) return {};
	const clamped = headTail(output, OUTPUT_MAX_CHARS);
	return clamped.truncated ? { output: clamped.text, outputTruncated: true } : { output: clamped.text };
}

export interface ToolCallInfo {
	id: string;
	name: string;
	arguments: unknown;
}

export interface ToolState {
	status: ToolItem["status"];
	/** Result (or partial result) content: `(TextContent | ImageContent)[]`. */
	content?: unknown;
}

/**
 * `assistantTs` keys the id; `startedAt` (when the call started) is the item's `ts`. Live records
 * know the real start; a persisted call uses the time its assistant message was persisted, which
 * is when its calls were issued.
 */
export function toolItem(call: ToolCallInfo, assistantTs: number, state: ToolState, startedAt = assistantTs): ToolItem {
	const args = call.name === "subagent" ? clampSubagentArgs(call.arguments) : clampArgs(call.arguments);
	return {
		id: itemIds.tool(assistantTs, call.id),
		ts: startedAt,
		kind: "tool",
		toolCallId: call.id,
		name: call.name,
		summary: toolSummary(call.name, call.arguments),
		...(args !== undefined ? { args } : {}),
		status: state.status,
		...toolOutput(state.content),
	};
}

export function toolCallsOf(message: AssistantMessage): ToolCallInfo[] {
	if (!Array.isArray(message.content)) return [];
	const calls: ToolCallInfo[] = [];
	for (const part of message.content) {
		if (part && part.type === "toolCall" && typeof part.id === "string") {
			calls.push({ id: part.id, name: String(part.name ?? "tool"), arguments: part.arguments });
		}
	}
	return calls;
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/**
 * Same pattern as `parseSkillBlock` (core/agent-session.ts), which renders an expanded `/skill:` prompt
 * in the TUI; kept here so this pure module does not import the session.
 */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * A user prompt as the user typed it: an expanded skill (`<skill name="x" ...>body</skill>\n\nargs`)
 * reads `/skill:x args`, the way the TUI shows a collapsed skill block followed by the request.
 */
export function typedUserText(text: string): string {
	if (!text.startsWith("<skill ")) return text;
	const match = SKILL_BLOCK.exec(text);
	if (!match) return text;
	const request = match[4]?.trim();
	return request ? `/skill:${match[1]} ${request}` : `/skill:${match[1]}`;
}

export function userItem(message: { content: unknown; timestamp: number }, id?: string): UserItem {
	const { text: raw, images } = contentParts(message.content);
	const text = typedUserText(raw);
	return {
		id: id ?? itemIds.user(message.timestamp),
		ts: message.timestamp,
		kind: "user",
		text: headTail(text, TEXT_MAX_CHARS).text,
		...(images > 0 ? { images } : {}),
	};
}

export function assistantItem(message: AssistantMessage, streaming: boolean, id?: string): AssistantItem {
	const texts: string[] = [];
	const thinking: string[] = [];
	for (const part of Array.isArray(message.content) ? message.content : []) {
		if (!part) continue;
		if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
		else if (part.type === "thinking" && !part.redacted && typeof part.thinking === "string" && part.thinking.trim())
			thinking.push(part.thinking);
	}
	const thinkingText = thinking.join("\n\n");
	let error: string | undefined;
	if (!streaming && message.stopReason === "error") error = message.errorMessage || "Error";
	else if (!streaming && message.stopReason === "aborted") error = "aborted";
	return {
		id: id ?? itemIds.assistant(message.timestamp),
		ts: message.timestamp,
		kind: "assistant",
		text: headTail(texts.join("\n\n"), TEXT_MAX_CHARS).text,
		...(thinkingText ? { thinking: headTail(thinkingText, THINKING_MAX_CHARS).text } : {}),
		...(message.model ? { model: message.model } : {}),
		...(streaming ? { streaming: true } : {}),
		...(error ? { error } : {}),
	};
}

/** Text of an assistant message on one line, ≤200 chars; undefined when it has no text. */
export function assistantLine(message: AssistantMessage): string | undefined {
	const text = (Array.isArray(message.content) ? message.content : [])
		.filter((part): part is TextContent => !!part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ");
	const line = oneLine(text, SUMMARY_MAX_CHARS);
	return line || undefined;
}

/**
 * `SessionSummary.lastError` of a finished assistant message: its error (`stopReason: "error"`),
 * one line, ≤200 chars; undefined for any other stop reason (an abort is not an error). An
 * "error" whose message is an AbortError's ("The operation was aborted.") is an abort too: a
 * provider that failed while the turn was being aborted reports it that way.
 */
export function assistantError(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "error") return undefined;
	const text = typeof message.errorMessage === "string" ? oneLine(message.errorMessage, SUMMARY_MAX_CHARS) : "";
	if (isAbortErrorText(text)) return undefined;
	return text || "Error";
}

/** The message of an AbortError (`DOMException`, Node/Bun, undici) or phi's own abort errors. */
export function isAbortErrorText(text: string): boolean {
	return /^(?:AbortError:\s*)?(?:the|this) operation was aborted\.?$|^request was aborted\.?$|^AbortError\b/i.test(
		text.trim(),
	);
}

/** First non-empty line of a user message, ≤60 chars. */
export function promptLine(content: unknown): string | undefined {
	const text = typedUserText(contentParts(content).text);
	const line = text
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	if (!line) return undefined;
	return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function note(id: string, ts: number, label: string | undefined, text: string): NoteItem {
	return {
		id,
		ts,
		kind: "note",
		...(label ? { label } : {}),
		text: headTail(text, NOTE_MAX_CHARS).text,
	};
}

function bashText(message: {
	command?: unknown;
	output?: unknown;
	exitCode?: unknown;
	cancelled?: unknown;
	truncated?: unknown;
	fullOutputPath?: unknown;
}): string {
	let text = `$ ${String(message.command ?? "")}`;
	if (typeof message.output === "string" && message.output) text += `\n${message.output.replace(/\n+$/, "")}`;
	if (message.cancelled) text += "\n(cancelled)";
	else if (typeof message.exitCode === "number" && message.exitCode !== 0) text += `\n(exit ${message.exitCode})`;
	if (message.truncated && typeof message.fullOutputPath === "string")
		text += `\n[full output: ${message.fullOutputPath}]`;
	return text;
}

function customText(content: unknown): string {
	const { text, images } = contentParts(content);
	return images > 0 ? `${text}${text ? "\n" : ""}[${images} image${images === 1 ? "" : "s"}]` : text;
}

export function entryTs(entry: SessionEntry): number {
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------

export interface EntryMapContext {
	/** Result of a tool call of this entry, if persisted. The backward walk hands out each result once. */
	resultFor(toolCallId: string): ToolResultMessage | undefined;
	/** Live rendering of a tool call that has no persisted result yet. */
	liveTool?(itemId: string): ToolItem | undefined;
	/** Real start time of a tool call this process saw run. */
	toolStartedAt?(itemId: string): number | undefined;
	/** Status for a tool call with neither a persisted result nor a live record. */
	orphanStatus: ToolItem["status"];
}

/**
 * Items of one session entry, oldest first. Tool results produce nothing on their own; they merge
 * into the tool item of the assistant message that called them.
 */
export function entryItems(entry: SessionEntry, context: EntryMapContext): TranscriptItem[] {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			switch (message.role) {
				case "user":
					return [
						isFiniteTs(message.timestamp)
							? userItem(message)
							: userItem({ ...message, timestamp: entryTs(entry) }, itemIds.entry(entry.id)),
					];
				case "assistant": {
					const finite = isFiniteTs(message.timestamp);
					const ts = finite ? message.timestamp : entryTs(entry);
					const items: TranscriptItem[] = [
						assistantItem({ ...message, timestamp: ts }, false, finite ? undefined : itemIds.entry(entry.id)),
					];
					for (const call of toolCallsOf(message)) {
						const id = itemIds.tool(ts, call.id);
						const startedAt = context.toolStartedAt?.(id) ?? entryTs(entry);
						const result = context.resultFor(call.id);
						if (result) {
							const state = {
								status: result.isError ? ("error" as const) : ("ok" as const),
								content: result.content,
							};
							items.push(toolItem(call, ts, state, startedAt));
							continue;
						}
						items.push(context.liveTool?.(id) ?? toolItem(call, ts, { status: context.orphanStatus }, startedAt));
					}
					return items;
				}
				case "toolResult":
					return [];
				case "bashExecution": {
					const ts = isFiniteTs(message.timestamp) ? message.timestamp : entryTs(entry);
					const id = isFiniteTs(message.timestamp) ? itemIds.bash(message.timestamp) : itemIds.entry(entry.id);
					return [note(id, ts, "bash", bashText(message))];
				}
				case "custom":
					return message.display
						? [note(itemIds.entry(entry.id), entryTs(entry), message.customType, customText(message.content))]
						: [];
				case "branchSummary":
					return message.summary
						? [note(itemIds.entry(entry.id), entryTs(entry), "branch summary", message.summary)]
						: [];
				case "compactionSummary":
					return message.summary
						? [note(itemIds.entry(entry.id), entryTs(entry), "compaction", message.summary)]
						: [];
				default:
					return [];
			}
		}
		case "custom_message":
			return entry.display
				? [note(itemIds.entry(entry.id), entryTs(entry), entry.customType, customText(entry.content))]
				: [];
		case "custom": {
			// Extension state, not shown, except `/threads`: the board it prints in the TUI must reach
			// the phone and ctl snapshots too, or the command looks like it did nothing there.
			if (entry.customType !== OVERSEER_BOARD_ENTRY) return [];
			const text = isPlainObject(entry.data) ? nonEmpty(entry.data.text) : undefined;
			return text ? [note(itemIds.entry(entry.id), entryTs(entry), "threads", text)] : [];
		}
		case "compaction":
			// Prune markers summarize nothing away; the TUI does not show them either.
			if (entry.mode === "prune" || !entry.summary) return [];
			return [note(itemIds.entry(entry.id), entryTs(entry), "compaction", entry.summary)];
		case "branch_summary":
			return entry.summary ? [note(itemIds.entry(entry.id), entryTs(entry), "branch summary", entry.summary)] : [];
		case "context_window":
			return [
				note(
					itemIds.entry(entry.id),
					entryTs(entry),
					"context window",
					entry.handoff ? `New context window.\n\n${entry.handoff}` : "New context window.",
				),
			];
		default:
			return [];
	}
}

export interface WalkOptions {
	limit: number;
	/** Return items strictly older than this item id (pagination). */
	before?: string;
	/** Keep scanning ids (not items) back to entries persisted at or after this time. */
	scanBackTo?: number;
	liveTool?: EntryMapContext["liveTool"];
	toolStartedAt?: EntryMapContext["toolStartedAt"];
	orphanStatus: ToolItem["status"];
}

export interface WalkResult {
	/** Oldest -> newest. */
	items: TranscriptItem[];
	hasMore: boolean;
	/** False when `before` was given and never met. */
	found: boolean;
	/** Every item id the walk met, including the ones past `limit`. */
	seen: Set<string>;
}

/** Options of a page of a stored session's transcript (`session.transcript`). */
export interface StoredPageOptions {
	limit: number;
	/** Items strictly older than this item id. */
	before?: string;
}

/**
 * A page of a session's persisted transcript, rendered exactly as that session's own bridge renders
 * it once resumed and idle: the same `walkBranch` over the same branch, with no in-flight records
 * and a tool call without a persisted result shown as `error`. The hub serves stored sessions
 * (`session.transcript`) with it, so the app can swap to the resumed live transcript by id.
 */
export function storedTranscript(branch: readonly SessionEntry[], options: StoredPageOptions): WalkResult {
	return walkBranch(branch, { limit: options.limit, before: options.before, orphanStatus: "error" });
}

/**
 * Walk a branch (root -> leaf order) backwards from the leaf and collect the newest `limit` items
 * (older than `before`, when given). Walking backwards meets tool results before the calls they
 * answer, so each result is handed to the nearest earlier assistant message that called it.
 */
export function walkBranch(branch: readonly SessionEntry[], options: WalkOptions): WalkResult {
	const results = new Map<string, ToolResultMessage>();
	const collected: TranscriptItem[] = [];
	const seen = new Set<string>();
	let found = options.before === undefined;
	let hasMore = false;
	let scanned = 0;
	const context: EntryMapContext = {
		resultFor: (toolCallId) => {
			const result = results.get(toolCallId);
			if (result) results.delete(toolCallId);
			return result;
		},
		liveTool: options.liveTool,
		toolStartedAt: options.toolStartedAt,
		orphanStatus: options.orphanStatus,
	};
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		// Past the page: only keep scanning ids while in-flight records could still be persisted here.
		if (hasMore) {
			const keepScanning =
				options.scanBackTo !== undefined && scanned < MAX_SCAN_ENTRIES && entryTs(entry) >= options.scanBackTo;
			if (!keepScanning) break;
		}
		scanned++;
		if (entry.type === "message" && entry.message.role === "toolResult") {
			results.set(entry.message.toolCallId, entry.message);
			continue;
		}
		const items = entryItems(entry, context);
		for (let position = items.length - 1; position >= 0; position--) {
			let item = items[position];
			if (seen.has(item.id)) item = { ...item, id: itemIds.entry(entry.id, position + 1) };
			seen.add(item.id);
			if (!found) {
				if (item.id === options.before) found = true;
				continue;
			}
			if (collected.length >= options.limit) {
				hasMore = true;
				continue;
			}
			collected.push(item);
		}
	}
	return { items: collected.reverse(), hasMore, found, seen };
}
