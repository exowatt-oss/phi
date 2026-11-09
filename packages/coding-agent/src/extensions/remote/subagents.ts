/**
 * phi remote, session side: the subagent runs this session launched, served to the hub as child
 * sessions (`kind: "subagent"`) of this one.
 *
 * The subagents extension publishes every run and its child's parsed `--mode json` stream on the
 * extension event bus (subagents/feed.ts). Each run becomes a child thread here: its transcript is
 * rebuilt from that stream (wire `message_update` records are deltas; `message_end` is
 * authoritative) with the same item builders as the session's own transcript (transcript.ts), and
 * kept in memory, because a child runs with `--no-session`. A child stays listed after it finishes
 * until this session ends or is replaced; at most {@link MAX_CHILDREN} are kept (the oldest finished
 * one goes first), each with at most {@link MAX_CHILD_ITEMS} items and about {@link MAX_CHILD_BYTES}
 * of rendered items (the oldest go first).
 *
 * Wire (internal, hub.sock): `child.upsert` / `child.remove` register a child under this session;
 * its events go out as `event` frames with the child's id; the hub routes requests for it here as
 * `req` frames carrying the child's `sessionId`.
 */

import { resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	LiveState,
	RemoteError,
	SessionOpReplyData,
	SessionSummary,
	SubagentRunStatus,
	ToolActivity,
	TranscriptItem,
} from "../../remote/protocol.ts";
import type { SubagentFeedControl, SubagentFeedEvent } from "../subagents/feed.ts";
import type { SubagentRunSnapshot } from "../subagents/types.ts";
import type { LinkLike } from "./link.ts";
import { ITEM_INTERVAL_MS, KeyedThrottle, STATE_INTERVAL_MS, SUMMARY_INTERVAL_MS } from "./throttle.ts";
import {
	assistantItem,
	assistantLine,
	contentParts,
	headTail,
	itemIds,
	NOTE_MAX_CHARS,
	oneLine,
	TEXT_MAX_CHARS,
	type ToolCallInfo,
	type ToolItem,
	toolCallsOf,
	toolItem,
	toolSummary,
	typedUserText,
} from "./transcript.ts";

/** Child sessions kept per parent session. */
export const MAX_CHILDREN = 50;
/** Transcript items kept per child. */
export const MAX_CHILD_ITEMS = 500;
/** Approximate JSON size of the transcript items kept per child. */
export const MAX_CHILD_BYTES = 512 * 1024;
/** Marks a child session id: `<parentSessionId>~sa~<runId>`. */
export const CHILD_ID_MARK = "~sa~";
/** Prefix of a message sent to a running subagent from the phone (shown without it). */
export const REMOTE_MESSAGE_PREFIX = "[message from the user via phi remote] ";
/** Item id of the run's task (the child's first user message). */
export const TASK_ITEM_ID = "u:task";
const TRIMMED_ITEM_ID = "n:trimmed";
const MAX_PAGE_LIMIT = 500;
const DEFAULT_PAGE_LIMIT = 120;
const MAX_SENT_HASHES = 1024;
const MAX_LIVE_TOOLS = 256;
/** A streaming text or thinking block is cut to its head and tail beyond this many chars. */
const MAX_STREAM_BLOCK_CHARS = 3 * TEXT_MAX_CHARS;

export function childSessionId(parentSessionId: string, runId: string): string {
	return `${parentSessionId}${CHILD_ID_MARK}${runId}`;
}

export function isChildSessionId(sessionId: string): boolean {
	return sessionId.includes(CHILD_ID_MARK);
}

/** The run's status as phi remote reports it. */
export function subagentRunStatus(run: Pick<SubagentRunSnapshot, "status" | "killedBy">): SubagentRunStatus {
	switch (run.status) {
		case "pending":
		case "running":
			return "running";
		case "done":
			return "done";
		case "aborted":
			return "killed";
		default:
			return run.killedBy === "kill-action" ? "killed" : "failed";
	}
}

function hashString(text: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) ^ text.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstLine(text: string, max: number): string | undefined {
	const line = text
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	if (!line) return undefined;
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "provider/model-id" -> { provider, id }; a bare id keeps an empty provider. */
function modelOf(reference: string | undefined): SessionSummary["model"] {
	if (!reference) return undefined;
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) return { provider: "", id: reference };
	return { provider: reference.slice(0, slash), id: reference.slice(slash + 1) };
}

/** A user message as the phone shows it: the task without its `Task: ` label, a phone message as typed. */
function childUserText(text: string, first: boolean): string {
	if (first && text.startsWith("Task: ")) return text.slice("Task: ".length);
	if (text.startsWith(REMOTE_MESSAGE_PREFIX)) return text.slice(REMOTE_MESSAGE_PREFIX.length);
	return typedUserText(text);
}

/** Reply to a request on a child session. */
export type ChildReply = { ok: true; data: SessionOpReplyData } | { ok: false; error: RemoteError };

interface StreamBlock {
	type: "text" | "thinking";
	text: string;
}

interface LiveAssistant {
	id: string;
	ts: number;
	message: Record<string, unknown>;
	blocks: (StreamBlock | undefined)[];
	cutOff?: boolean;
}

interface LiveTool {
	id: string;
	call: ToolCallInfo;
	assistantTs: number;
	startedAt: number;
	status: ToolItem["status"];
	content?: unknown;
}

interface Entry {
	/** Final rendering; absent while the item is live. */
	item?: TranscriptItem;
	live?: () => TranscriptItem;
	bytes: number;
}

interface Child {
	sessionId: string;
	run: SubagentRunSnapshot;
	runId: string;
	toolCallId: string;
	index: number;
	background: boolean;
	taskName?: string;
	control: SubagentFeedControl;
	startedAt: number;
	lastActivityAt: number;
	lastText?: string;
	/** The run settled (feed `end`). */
	ended: boolean;
	endedAt?: number;
	entries: Map<string, Entry>;
	bytes: number;
	dropped: number;
	sawFirstUser: boolean;
	assistant?: LiveAssistant;
	lastAssistantTs?: number;
	tools: Map<string, LiveTool>;
	running: Map<string, ToolActivity>;
	noteSeq: number;
	sentHashes: Map<string, number>;
	lastSummaryJson?: string;
}

export interface ChildThreadsOptions {
	link: LinkLike;
	host: string;
	/** The parent session's cwd (a run's relative `cwd` resolves against it). */
	cwd: () => string;
	/** The id the parent session is registered under; undefined before it registered. */
	parentId: () => string | undefined;
	/**
	 * Whether runs are tracked at all: only once the hub was reachable in this process, so a
	 * session that never meets a hub keeps nothing.
	 */
	recording: () => boolean;
	/** The running / total counts changed (they are part of the parent's summary). */
	onCountsChanged: () => void;
	now?: () => number;
	guard?: (fn: () => void) => void;
}

export class ChildThreads {
	private readonly link: LinkLike;
	private readonly host: string;
	private readonly parentCwd: () => string;
	private readonly parentId: () => string | undefined;
	private readonly recording: () => boolean;
	private readonly onCountsChanged: () => void;
	private readonly now: () => number;
	private readonly guard: (fn: () => void) => void;
	private readonly throttle: KeyedThrottle;
	private readonly children = new Map<string, Child>();
	private readonly byRun = new WeakMap<SubagentRunSnapshot, Child>();
	private disposed = false;

	constructor(options: ChildThreadsOptions) {
		this.link = options.link;
		this.host = options.host;
		this.parentCwd = options.cwd;
		this.parentId = options.parentId;
		this.recording = options.recording;
		this.onCountsChanged = options.onCountsChanged;
		this.now = options.now ?? Date.now;
		this.guard =
			options.guard ??
			((fn) => {
				try {
					fn();
				} catch {
					// Never into the session.
				}
			});
		this.throttle = new KeyedThrottle(this.now, this.guard);
	}

	/** Running and total children, for the parent's summary; undefined when there are none. */
	counts(): { running: number; total: number } | undefined {
		if (this.children.size === 0) return undefined;
		let running = 0;
		for (const child of this.children.values()) if (!child.ended) running++;
		return { running, total: this.children.size };
	}

	has(sessionId: string): boolean {
		return this.children.has(sessionId);
	}

	/** Test/diagnostic view of the children ids, oldest first. */
	ids(): string[] {
		return [...this.children.keys()];
	}

	// -----------------------------------------------------------------------------------------
	// Feed
	// -----------------------------------------------------------------------------------------

	onFeed(event: SubagentFeedEvent): void {
		if (this.disposed) return;
		if (event.type === "start") {
			this.start(event);
			return;
		}
		const child = this.byRun.get(event.run);
		if (!child || this.children.get(child.sessionId) !== child) return;
		if (event.type === "event") this.onChildEvent(child, event.event);
		else this.end(child);
	}

	private start(event: Extract<SubagentFeedEvent, { type: "start" }>): void {
		const parentId = this.parentId();
		const run = event.run;
		const runId = run.runId ?? run.id;
		if (!parentId || !runId || !this.recording() || this.byRun.has(run)) return;
		const sessionId = childSessionId(parentId, runId);
		if (this.children.has(sessionId)) return;
		this.makeRoom();
		const now = this.now();
		const child: Child = {
			sessionId,
			run,
			runId,
			toolCallId: event.toolCallId,
			index: event.index,
			background: event.background,
			taskName: event.taskName,
			control: event.control,
			startedAt: run.startedAt ?? now,
			lastActivityAt: now,
			ended: false,
			entries: new Map(),
			bytes: 0,
			dropped: 0,
			sawFirstUser: false,
			tools: new Map(),
			running: new Map(),
			noteSeq: 0,
			sentHashes: new Map(),
		};
		this.children.set(sessionId, child);
		this.byRun.set(run, child);
		const task: TranscriptItem = {
			id: TASK_ITEM_ID,
			ts: child.startedAt,
			kind: "user",
			text: headTail(run.task, TEXT_MAX_CHARS).text,
		};
		this.store(child, task);
		// The hub learns of the child first; it ignores events of children it does not know.
		this.sendChildSummary(child, true);
		this.emitItem(child, task);
		this.onCountsChanged();
	}

	/** Keep at most MAX_CHILDREN: drop the oldest finished child, else the oldest. */
	private makeRoom(): void {
		while (this.children.size >= MAX_CHILDREN) {
			let victim: Child | undefined;
			for (const child of this.children.values()) {
				if (child.ended) {
					victim = child;
					break;
				}
			}
			victim ??= this.children.values().next().value;
			if (!victim) return;
			this.remove(victim);
		}
	}

	private remove(child: Child): void {
		this.children.delete(child.sessionId);
		this.throttle.cancel(`${child.sessionId}|`);
		if (this.link.connected && this.parentId()) {
			this.link.send({ t: "child.remove", sessionId: child.sessionId });
		}
	}

	private end(child: Child): void {
		if (child.ended) return;
		child.ended = true;
		child.endedAt = child.run.endedAt ?? this.now();
		child.lastActivityAt = this.now();
		this.settle(child);
		child.running.clear();
		this.pushState(child);
		this.throttle.flush(`${child.sessionId}|`);
		this.sendChildSummary(child, true);
		this.onCountsChanged();
	}

	/** A turn ended: nothing may stay streaming or running. */
	private settle(child: Child): void {
		const assistant = child.assistant;
		if (assistant) {
			assistant.cutOff = true;
			this.finishAssistant(child, assistant, undefined);
		}
		for (const tool of [...child.tools.values()]) {
			if (tool.status === "running") tool.status = "error";
			this.finishTool(child, tool);
		}
	}

	// -----------------------------------------------------------------------------------------
	// Child event stream -> items
	// -----------------------------------------------------------------------------------------

	private onChildEvent(child: Child, event: Record<string, unknown>): void {
		switch (event.type) {
			case "agent_start":
				this.touch(child);
				this.pushState(child);
				return;
			case "agent_settled":
				this.settle(child);
				child.running.clear();
				this.touch(child);
				this.pushState(child);
				return;
			case "message_start":
				this.onMessageStart(child, event.message);
				return;
			case "message_update":
				this.onMessageUpdate(child, event.assistantMessageEvent);
				return;
			case "message_end":
				this.onMessageEnd(child, event.message);
				return;
			case "tool_execution_start":
				this.onToolStart(child, event);
				return;
			case "tool_execution_update": {
				const tool = typeof event.toolCallId === "string" ? child.tools.get(event.toolCallId) : undefined;
				if (!tool || !isRecord(event.partialResult)) return;
				tool.content = event.partialResult.content;
				this.pushLive(child, tool.id, false);
				return;
			}
			case "tool_execution_end": {
				const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
				if (!toolCallId) return;
				child.running.delete(toolCallId);
				const tool = child.tools.get(toolCallId);
				if (tool) {
					tool.status = event.isError === true ? "error" : "ok";
					if (isRecord(event.result)) tool.content = event.result.content;
					this.finishTool(child, tool);
				}
				this.touch(child);
				this.pushState(child);
				return;
			}
			case "compaction_end": {
				const result = isRecord(event.result) ? event.result : undefined;
				if (typeof result?.summary === "string" && result.summary) {
					this.addNote(child, "compaction", result.summary);
				}
				return;
			}
			default:
				return;
		}
	}

	private onMessageStart(child: Child, message: unknown): void {
		if (!isRecord(message)) return;
		if (message.role === "user") {
			const ts = typeof message.timestamp === "number" ? message.timestamp : this.now();
			const { text, images } = contentParts(message.content);
			// The child's first prompt is the task (already listed as `u:task`).
			const first = !child.sawFirstUser && !text.startsWith(REMOTE_MESSAGE_PREFIX);
			child.sawFirstUser = true;
			const item: TranscriptItem = {
				id: first ? TASK_ITEM_ID : itemIds.user(ts),
				ts: first ? child.startedAt : ts,
				kind: "user",
				text: headTail(childUserText(text, first), TEXT_MAX_CHARS).text,
				...(images > 0 ? { images } : {}),
			};
			this.store(child, item);
			this.emitItem(child, item);
			this.touch(child);
			return;
		}
		if (message.role !== "assistant") return;
		const ts = typeof message.timestamp === "number" ? message.timestamp : this.now();
		if (child.assistant) this.finishAssistant(child, child.assistant, undefined);
		const blocks: (StreamBlock | undefined)[] = [];
		if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
					blocks.push({ type: "text", text: part.text });
				} else if (isRecord(part) && part.type === "thinking" && typeof part.thinking === "string") {
					blocks.push({ type: "thinking", text: part.thinking });
				} else blocks.push(undefined);
			}
		}
		const assistant: LiveAssistant = { id: itemIds.assistant(ts), ts, message, blocks };
		child.assistant = assistant;
		child.lastAssistantTs = ts;
		this.storeLive(child, assistant.id, () => this.renderAssistant(assistant, true));
		this.pushLive(child, assistant.id, true);
		this.touch(child);
	}

	private onMessageUpdate(child: Child, update: unknown): void {
		const assistant = child.assistant;
		if (!assistant || !isRecord(update) || typeof update.contentIndex !== "number") return;
		const index = update.contentIndex;
		if (!Number.isInteger(index) || index < 0 || index > 1000) return;
		switch (update.type) {
			case "text_start":
			case "thinking_start":
				assistant.blocks[index] = { type: update.type === "text_start" ? "text" : "thinking", text: "" };
				break;
			case "text_delta":
			case "thinking_delta": {
				if (typeof update.delta !== "string") return;
				const type = update.type === "text_delta" ? "text" : "thinking";
				const block = assistant.blocks[index];
				if (block && block.type === type) {
					block.text += update.delta;
					if (block.text.length > MAX_STREAM_BLOCK_CHARS) block.text = headTail(block.text, TEXT_MAX_CHARS).text;
				} else assistant.blocks[index] = { type, text: update.delta };
				break;
			}
			case "text_end":
			case "thinking_end":
				if (typeof update.content !== "string") return;
				assistant.blocks[index] = {
					type: update.type === "text_end" ? "text" : "thinking",
					text: headTail(update.content, MAX_STREAM_BLOCK_CHARS).text,
				};
				break;
			default:
				return;
		}
		this.pushLive(child, assistant.id, false);
	}

	private onMessageEnd(child: Child, message: unknown): void {
		if (!isRecord(message)) return;
		if (message.role === "assistant") {
			const final = message as unknown as AssistantMessage;
			const ts = typeof final.timestamp === "number" ? final.timestamp : (child.assistant?.ts ?? this.now());
			const live = child.assistant?.ts === ts ? child.assistant : undefined;
			if (child.assistant && !live) this.finishAssistant(child, child.assistant, undefined);
			this.finishAssistant(child, live ?? { id: itemIds.assistant(ts), ts, message, blocks: [] }, {
				...final,
				timestamp: ts,
			});
			child.lastAssistantTs = ts;
			child.lastText = assistantLine(final) ?? child.lastText;
			for (const call of toolCallsOf(final)) {
				if (child.tools.has(call.id)) continue;
				const tool: LiveTool = {
					id: itemIds.tool(ts, call.id),
					call,
					assistantTs: ts,
					startedAt: this.now(),
					status: "running",
				};
				this.addTool(child, tool);
			}
			this.touch(child);
			return;
		}
		if (message.role === "toolResult") {
			const tool = typeof message.toolCallId === "string" ? child.tools.get(message.toolCallId) : undefined;
			if (!tool) return;
			tool.status = message.isError === true ? "error" : "ok";
			tool.content = message.content;
			this.finishTool(child, tool);
			return;
		}
		if (message.role === "custom" && message.display === true) {
			const { text, images } = contentParts(message.content);
			const body = images > 0 ? `${text}${text ? "\n" : ""}[${images} image${images === 1 ? "" : "s"}]` : text;
			this.addNote(child, typeof message.customType === "string" ? message.customType : undefined, body);
		}
	}

	private onToolStart(child: Child, event: Record<string, unknown>): void {
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		if (!toolCallId) return;
		const name = typeof event.toolName === "string" ? event.toolName : "tool";
		let tool = child.tools.get(toolCallId);
		if (!tool) {
			const assistantTs = child.lastAssistantTs ?? this.now();
			tool = {
				id: itemIds.tool(assistantTs, toolCallId),
				call: { id: toolCallId, name, arguments: event.args },
				assistantTs,
				startedAt: this.now(),
				status: "running",
			};
			this.addTool(child, tool);
		}
		tool.status = "running";
		tool.startedAt = this.now();
		child.running.set(toolCallId, { tool: name, summary: toolSummary(name, tool.call.arguments) });
		this.pushLive(child, tool.id, false);
		this.touch(child);
		this.pushState(child);
	}

	private addTool(child: Child, tool: LiveTool): void {
		child.tools.set(tool.call.id, tool);
		while (child.tools.size > MAX_LIVE_TOOLS) {
			const oldest = child.tools.values().next().value;
			if (!oldest) break;
			if (oldest.status === "running") oldest.status = "error";
			this.finishTool(child, oldest);
		}
		this.storeLive(child, tool.id, () => this.renderTool(tool));
		this.pushLive(child, tool.id, false);
	}

	private finishTool(child: Child, tool: LiveTool): void {
		child.tools.delete(tool.call.id);
		const item = this.renderTool(tool);
		tool.content = undefined;
		this.store(child, item);
		this.emitItem(child, item);
	}

	private finishAssistant(child: Child, assistant: LiveAssistant, final: AssistantMessage | undefined): void {
		if (child.assistant === assistant) child.assistant = undefined;
		let item: TranscriptItem = final
			? assistantItem(final, false, assistant.id)
			: this.renderAssistant(assistant, false);
		if (!final && assistant.cutOff && item.kind === "assistant" && !item.error) item = { ...item, error: "aborted" };
		this.store(child, item);
		this.emitItem(child, item);
	}

	private renderAssistant(assistant: LiveAssistant, streaming: boolean): TranscriptItem {
		const content: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }> = [];
		for (const block of assistant.blocks) {
			if (!block) continue;
			if (block.type === "text") content.push({ type: "text", text: block.text });
			else content.push({ type: "thinking", thinking: block.text });
		}
		const message = {
			...assistant.message,
			content,
			timestamp: assistant.ts,
		} as unknown as AssistantMessage;
		const item = assistantItem(message, streaming, assistant.id);
		return assistant.cutOff && !streaming && !item.error ? { ...item, error: "aborted" } : item;
	}

	private renderTool(tool: LiveTool): ToolItem {
		return toolItem(tool.call, tool.assistantTs, { status: tool.status, content: tool.content }, tool.startedAt);
	}

	private addNote(child: Child, label: string | undefined, text: string): void {
		const item: TranscriptItem = {
			id: `e:${++child.noteSeq}`,
			ts: this.now(),
			kind: "note",
			...(label ? { label } : {}),
			text: headTail(text, NOTE_MAX_CHARS).text,
		};
		this.store(child, item);
		this.emitItem(child, item);
	}

	private touch(child: Child): void {
		child.lastActivityAt = this.now();
		this.pushSummary(child);
	}

	// -----------------------------------------------------------------------------------------
	// Transcript store
	// -----------------------------------------------------------------------------------------

	private store(child: Child, item: TranscriptItem): void {
		let bytes = 0;
		try {
			bytes = JSON.stringify(item).length;
		} catch {
			bytes = 0;
		}
		const existing = child.entries.get(item.id);
		if (existing) child.bytes -= existing.bytes;
		child.entries.set(item.id, { item, bytes });
		child.bytes += bytes;
		this.trim(child);
	}

	private storeLive(child: Child, id: string, render: () => TranscriptItem): void {
		const existing = child.entries.get(id);
		if (existing) child.bytes -= existing.bytes;
		child.entries.set(id, { live: render, bytes: 0 });
		this.trim(child);
	}

	/** Drop the oldest finished items beyond the caps (items still in flight stay). */
	private trim(child: Child): void {
		while (child.entries.size > 1 && (child.entries.size > MAX_CHILD_ITEMS || child.bytes > MAX_CHILD_BYTES)) {
			let victim: [string, Entry] | undefined;
			for (const candidate of child.entries) {
				if (!candidate[1].live) {
					victim = candidate;
					break;
				}
			}
			if (!victim) break;
			child.entries.delete(victim[0]);
			child.bytes -= victim[1].bytes;
			child.dropped++;
		}
	}

	private items(child: Child): TranscriptItem[] {
		const items: TranscriptItem[] = [];
		for (const entry of child.entries.values()) {
			const item = entry.item ?? entry.live?.();
			if (item) items.push(item);
		}
		if (child.dropped > 0 && items.length > 0) {
			items.unshift({
				id: TRIMMED_ITEM_ID,
				ts: items[0].ts,
				kind: "note",
				label: "subagent",
				text: `${child.dropped} earlier item${child.dropped === 1 ? " is" : "s are"} no longer kept.`,
			});
		}
		return items;
	}

	// -----------------------------------------------------------------------------------------
	// Emission
	// -----------------------------------------------------------------------------------------

	private canSend(): boolean {
		return !this.disposed && this.link.connected && this.parentId() !== undefined;
	}

	private pushLive(child: Child, id: string, immediate: boolean): void {
		if (!this.canSend()) return;
		this.throttle.schedule(
			`${child.sessionId}|item:${id}`,
			ITEM_INTERVAL_MS,
			() => {
				if (this.children.get(child.sessionId) !== child) return;
				const entry = child.entries.get(id);
				const item = entry?.item ?? entry?.live?.();
				if (item) this.sendItem(child, item);
			},
			immediate,
		);
	}

	/** A final item: sent at once, superseding any pending live update of it. */
	private emitItem(child: Child, item: TranscriptItem): void {
		this.throttle.delete(`${child.sessionId}|item:${item.id}`);
		if (!this.canSend()) return;
		this.sendItem(child, item);
	}

	private sendItem(child: Child, item: TranscriptItem): void {
		if (!this.canSend()) return;
		const hash = hashString(JSON.stringify(item));
		if (child.sentHashes.get(item.id) === hash) return;
		child.sentHashes.delete(item.id);
		child.sentHashes.set(item.id, hash);
		while (child.sentHashes.size > MAX_SENT_HASHES) {
			const oldest = child.sentHashes.keys().next().value;
			if (oldest === undefined) break;
			child.sentHashes.delete(oldest);
		}
		this.link.send(
			{ t: "event", sessionId: child.sessionId, event: { type: "item.upsert", item } },
			{ droppable: true, key: `${child.sessionId}|item:${item.id}` },
		);
	}

	private pushState(child: Child): void {
		if (this.canSend()) {
			this.throttle.schedule(
				`${child.sessionId}|state`,
				STATE_INTERVAL_MS,
				() => {
					if (!this.canSend() || this.children.get(child.sessionId) !== child) return;
					this.link.send(
						{ t: "event", sessionId: child.sessionId, event: { type: "state", state: this.liveState(child) } },
						{ droppable: true, key: `${child.sessionId}|state` },
					);
				},
				false,
			);
		}
		this.pushSummary(child);
	}

	private pushSummary(child: Child): void {
		if (!this.canSend()) return;
		this.throttle.schedule(
			`${child.sessionId}|summary`,
			SUMMARY_INTERVAL_MS,
			() => this.sendChildSummary(child, false),
			false,
		);
	}

	private sendChildSummary(child: Child, force: boolean): void {
		if (!this.canSend() || this.children.get(child.sessionId) !== child) return;
		const summary = this.summary(child);
		if (!summary) return;
		const json = JSON.stringify(summary);
		if (!force && json === child.lastSummaryJson) return;
		child.lastSummaryJson = json;
		// The first announcement must reach the hub (it ignores events of unknown children); later
		// ones may be dropped and replaced under backpressure like any summary.
		this.link.send(
			{ t: "child.upsert", session: summary },
			force ? {} : { droppable: true, key: `${child.sessionId}|summary` },
		);
	}

	private liveState(child: Child): LiveState {
		const activity = this.activity(child);
		return { status: child.ended ? "idle" : "working", ...(activity ? { activity } : {}) };
	}

	private activity(child: Child): ToolActivity | undefined {
		if (child.ended) return undefined;
		let last: ToolActivity | undefined;
		for (const value of child.running.values()) last = value;
		return last;
	}

	private summary(child: Child): SessionSummary | undefined {
		const parentSessionId = this.parentId();
		if (!parentSessionId) return undefined;
		const run = child.run;
		const status = child.ended ? subagentRunStatus(run) : "running";
		const name = child.taskName ? run.name : (run.agentName ?? firstLine(run.task, 60) ?? run.name);
		const model = modelOf(run.model);
		const activity = this.activity(child);
		const usage = {
			costUsd: Math.round((run.usage?.cost ?? 0) * 10_000) / 10_000,
			...(run.contextWindow && run.usage?.contextTokens
				? { contextPercent: Math.round((run.usage.contextTokens / run.contextWindow) * 1000) / 10 }
				: {}),
		};
		let cwd = this.parentCwd();
		if (run.cwd) {
			try {
				cwd = resolve(cwd, run.cwd);
			} catch {
				// keep the parent's
			}
		}
		return {
			sessionId: child.sessionId,
			name,
			cwd,
			host: this.host,
			pid: run.pid ?? process.pid,
			kind: "subagent",
			parentSessionId,
			status: status === "running" ? "working" : "idle",
			...(model ? { model } : {}),
			...(run.thinkingLevel ? { thinkingLevel: run.thinkingLevel } : {}),
			startedAt: child.startedAt,
			lastActivityAt: child.lastActivityAt,
			...(child.lastText ? { lastText: child.lastText } : {}),
			...(activity ? { activity } : {}),
			usage,
			subagent: {
				runId: child.runId,
				toolCallId: child.toolCallId,
				index: child.index,
				...(child.taskName ? { name: run.name } : {}),
				...(run.agentName ? { agent: run.agentName } : {}),
				task: oneLine(run.task, 200),
				status,
				startedAt: child.startedAt,
				...(child.endedAt !== undefined ? { endedAt: child.endedAt } : {}),
				turns: run.usage?.turns ?? 0,
				toolCalls: run.usage?.toolCalls ?? 0,
				background: child.background,
			},
		};
	}

	// -----------------------------------------------------------------------------------------
	// Connection lifecycle
	// -----------------------------------------------------------------------------------------

	/** The parent (re)registered on a connection: announce every child. */
	announce(): void {
		this.throttle.cancel();
		for (const child of this.children.values()) {
			child.sentHashes.clear();
			child.lastSummaryJson = undefined;
			this.sendChildSummary(child, true);
		}
	}

	onDisconnected(): void {
		this.throttle.cancel();
	}

	/** Frames were dropped under backpressure: subscribers of every child must resubscribe. */
	resetAll(): void {
		this.throttle.cancel();
		if (!this.canSend()) return;
		for (const child of this.children.values()) {
			child.sentHashes.clear();
			child.lastSummaryJson = undefined;
			this.link.send({ t: "event", sessionId: child.sessionId, event: { type: "reset" } });
			this.sendChildSummary(child, true);
		}
	}

	/** Drop every child without telling the hub (it already dropped them with their parent's id). */
	forget(): void {
		this.throttle.cancel();
		this.children.clear();
	}

	/** The parent session ends or is replaced: its children go with it. */
	dispose(): void {
		if (this.disposed) return;
		this.throttle.cancel();
		const connected = this.link.connected && this.parentId() !== undefined;
		for (const child of this.children.values()) {
			if (connected) this.link.send({ t: "child.remove", sessionId: child.sessionId });
		}
		this.children.clear();
		this.disposed = true;
	}

	// -----------------------------------------------------------------------------------------
	// Requests
	// -----------------------------------------------------------------------------------------

	perform(sessionId: string, op: string, args: Record<string, unknown>): ChildReply {
		const child = this.children.get(sessionId);
		if (!child) return fail("not_found", `no subagent session ${sessionId}`);
		switch (op) {
			case "snapshot": {
				const limit = pageLimit(args.limit);
				if (limit === undefined) return fail("bad_request", "limit must be a positive number");
				const items = this.items(child);
				const start = Math.max(0, items.length - limit);
				return {
					ok: true,
					data: { items: items.slice(start), hasMore: start > 0, state: this.liveState(child) },
				};
			}
			case "history": {
				const before = args.before;
				if (typeof before !== "string" || !before) return fail("bad_request", "before must be an item id");
				const limit = pageLimit(args.limit);
				if (limit === undefined) return fail("bad_request", "limit must be a positive number");
				const items = this.items(child);
				const index = items.findIndex((item) => item.id === before);
				if (index === -1) return fail("not_found", `no item ${before}`);
				const start = Math.max(0, index - limit);
				return { ok: true, data: { items: items.slice(start, index), hasMore: start > 0 } };
			}
			case "prompt":
				return this.prompt(child, args);
			case "abort":
				if (!child.ended) child.control.kill("Killed from phi remote");
				return { ok: true, data: {} };
			default:
				return fail("bad_request", `${op} is not available on a subagent session`);
		}
	}

	private prompt(child: Child, args: Record<string, unknown>): ChildReply {
		const text = args.text;
		if (typeof text !== "string") return fail("bad_request", "text must be a string");
		if (Array.isArray(args.images) && args.images.length > 0) {
			return fail("bad_request", "a subagent takes text only");
		}
		if (!text.trim()) return fail("bad_request", "empty prompt");
		const mode = args.mode ?? "auto";
		if (mode !== "auto" && mode !== "steer" && mode !== "followUp") {
			return fail("bad_request", "mode must be auto, steer or followUp");
		}
		if (child.ended) return fail("bad_request", "subagent finished");
		const message = `${REMOTE_MESSAGE_PREFIX}${text}`;
		// A child waiting on a question (message_parent) gets the answer; anything else is a steer
		// (after its current tool call) or a follow-up (after its turn), like the tool's message action.
		const question = child.run.pendingQuestion;
		const sent = question
			? child.control.send({ type: "reply", toolCallId: question.toolCallId, text: message })
			: child.control.send({ type: mode === "followUp" ? "follow_up" : "steer", message });
		if (!sent) {
			const running = child.run.status === "running" || child.run.status === "pending";
			return fail(
				"bad_request",
				running ? "the subagent is not accepting messages yet; try again" : "subagent finished",
			);
		}
		this.touch(child);
		return { ok: true, data: {} };
	}
}

function fail(code: RemoteError["code"], message: string): ChildReply {
	return { ok: false, error: { code, message } };
}

function pageLimit(value: unknown): number | undefined {
	if (value === undefined) return DEFAULT_PAGE_LIMIT;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;
	return Math.min(MAX_PAGE_LIMIT, Math.floor(value));
}
