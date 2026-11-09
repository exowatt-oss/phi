/**
 * One phi session as seen by the phi remote hub: its summary, its transcript (snapshot + live
 * item upserts) and the operations the phone can ask of it.
 *
 * Live records (the user prompt, the streaming assistant message, running tool calls) are kept as
 * raw references and rendered lazily, so a session with no hub pays O(1) per event. Rendering goes
 * through the same builders as the persisted transcript (transcript.ts), which keeps the ids and
 * contents of live upserts identical to what a later snapshot returns.
 *
 * Items with no live event of their own (user `!bash` runs, custom messages, compaction notes) are
 * picked up from the session tree: a 1 s leaf check while connected walks the newly appended
 * entries and emits them; a leaf that is no longer a descendant of the last one seen means the
 * transcript was rewritten in place, which is announced with a `reset` event.
 */

import { basename } from "node:path";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { findExactModelReferenceMatch } from "../../core/model-resolver.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { SlashCommandInfo } from "../../core/slash-commands.ts";
import type {
	CommandInfo,
	HubToSession,
	LiveState,
	ModelsPayload,
	OverseerLink,
	PromptImage,
	RemoteError,
	SessionOpReplyData,
	SessionStatus,
	SessionSummary,
	SessionToHub,
	ToolActivity,
	TranscriptItem,
} from "../../remote/protocol.ts";
import type { SubagentFeedEvent } from "../subagents/feed.ts";
import {
	buildCommandList,
	type CommandListOptions,
	commandsVersion,
	type RemoteBuiltin,
	resolveSlash,
} from "./commands.ts";
import type { LinkLike } from "./link.ts";
import { type ChildReply, ChildThreads, isChildSessionId } from "./subagents.ts";
import { ITEM_INTERVAL_MS, STATE_INTERVAL_MS, SUMMARY_INTERVAL_MS } from "./throttle.ts";
import { type ExecRunner, sessionDisplayName, TmuxNamer } from "./tmux.ts";
import {
	assistantError,
	assistantItem,
	assistantLine,
	entryItems,
	entryTs,
	itemIds,
	oneLine,
	promptLine,
	type ToolCallInfo,
	type ToolItem,
	toolCallsOf,
	toolItem,
	toolSummary,
	userItem,
	walkBranch,
} from "./transcript.ts";

export { ITEM_INTERVAL_MS, STATE_INTERVAL_MS, SUMMARY_INTERVAL_MS };
/** Leaf check for entries that arrive without a live event (bash runs, custom messages, ...). */
export const RECONCILE_INTERVAL_MS = 1000;
export const DEFAULT_SNAPSHOT_LIMIT = 120;
const MAX_PAGE_LIMIT = 500;
const MAX_LIVE_RECORDS = 400;
const MAX_SENT_HASHES = 1024;
const MAX_TOOL_STARTS = 4096;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/** `/compact` from the phone: how long the reply waits for a quick failure ("Nothing to compact"). */
export const COMPACT_ERROR_WINDOW_MS = 1000;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

interface LiveTool {
	id: string;
	call: ToolCallInfo;
	assistantTs: number;
	/** When the call started: execution start, or when the model issued it until then. */
	startedAt: number;
	status: ToolItem["status"];
	content?: unknown;
}

type LiveRecord =
	| { kind: "user"; id: string; ts: number; message: { content: unknown; timestamp: number } }
	| {
			kind: "assistant";
			id: string;
			ts: number;
			message: AssistantMessage;
			streaming: boolean;
			/** The run ended while this message was still streaming. */
			cutOff?: boolean;
	  }
	| { kind: "tool"; id: string; ts: number; tool: LiveTool };

interface Slot {
	lastSent: number;
	timer?: ReturnType<typeof setTimeout>;
	build?: () => SessionToHub | undefined;
}

type ReqFrame = Extract<HubToSession, { t: "req" }>;

class OpError extends Error {
	readonly code: RemoteError["code"];
	constructor(code: RemoteError["code"], message: string) {
		super(message);
		this.code = code;
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

function renderRecord(record: LiveRecord): TranscriptItem {
	switch (record.kind) {
		case "user":
			return userItem(record.message, record.id);
		case "assistant": {
			const item = assistantItem(record.message, record.streaming, record.id);
			return record.cutOff && !item.error ? { ...item, error: "aborted" } : item;
		}
		case "tool":
			return toolItem(
				record.tool.call,
				record.tool.assistantTs,
				{ status: record.tool.status, content: record.tool.content },
				record.tool.startedAt,
			);
	}
}

/**
 * `SessionSummary.overseer` from this process's environment: set when an overseer started it
 * (`PHI_OVERSEER_SESSION_ID`, plus `PHI_OVERSEER_NAME` / `PHI_OVERSEER_THREAD` when present).
 */
export function overseerFromEnv(env: NodeJS.ProcessEnv): OverseerLink | undefined {
	const sessionId = oneLine(env.PHI_OVERSEER_SESSION_ID ?? "", 200);
	if (!sessionId) return undefined;
	const name = oneLine(env.PHI_OVERSEER_NAME ?? "", 200);
	const thread = oneLine(env.PHI_OVERSEER_THREAD ?? "", 200);
	return { sessionId, ...(name ? { name } : {}), ...(thread ? { thread } : {}) };
}

export interface BridgeOptions {
	pi: Pick<ExtensionAPI, "sendUserMessage" | "setModel" | "setThinkingLevel" | "getThinkingLevel" | "getSessionName"> &
		Partial<Pick<ExtensionAPI, "getCommands" | "getSettings" | "setSessionName">>;
	ctx: ExtensionContext;
	link: LinkLike;
	host: string;
	/** PHI_REMOTE_SPAWN_ID: this session was spawned by the hub (headless). */
	spawnId?: string;
	/** Session id this link last registered under (session replacement on the same connection). */
	previousSessionId?: string;
	/** Process shutdown for an accepted `close` (headless sessions, or a thread closed by its overseer). */
	shutdown?: () => void;
	/**
	 * Run `fn` with a command context (session control such as `newSession`), as a slash command
	 * typed in the terminal would. Without it, `/new` from the phone is unavailable.
	 */
	withCommandContext?: <T>(fn: (ctx: ExtensionCommandContext) => Promise<T>) => Promise<T>;
	now?: () => number;
	/** Environment for the tmux lookup and the overseer link (tests); defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Runs `tmux` (tests); defaults to `execFile`. */
	execRunner?: ExecRunner;
}

export class SessionBridge {
	private readonly pi: BridgeOptions["pi"];
	private readonly ctx: ExtensionContext;
	private readonly link: LinkLike;
	private readonly host: string;
	private readonly spawnId: string | undefined;
	private readonly shutdownProcess: () => void;
	private readonly withCommandContext: BridgeOptions["withCommandContext"];
	private readonly now: () => number;
	private readonly startedAt: number;
	private lastActivityAt: number;
	private status: SessionStatus = "idle";
	private readonly running = new Map<string, ToolActivity>();
	private firstPrompt: string | undefined;
	private lastText: string | undefined;
	/** `summary.lastError`: the last assistant message's error, if it ended in one. */
	private lastError: string | undefined;
	/** An assistant message ended in this process (priming must not overwrite `lastError` then). */
	private assistantEnded = false;
	/** The overseer that started this session, from the environment (fixed for the process). */
	private readonly overseer: OverseerLink | undefined;
	private costUsd = 0;
	private primed = false;
	private readonly records = new Map<string, LiveRecord>();
	private readonly tools = new Map<string, LiveTool>();
	/** Start time per tool item id this process ran; outlives the run so snapshots agree with live. */
	private readonly toolStarts = new Map<string, number>();
	private lastAssistantTs: number | undefined;
	private readonly slots = new Map<string, Slot>();
	private readonly sentHashes = new Map<string, number>();
	private lastSummaryJson: string | undefined;
	private registeredId: string | undefined;
	private hubId: string | undefined;
	private syncedLeaf: string | null | undefined;
	private poll: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	/** The hub was reachable at some point in this bridge's life (subagent threads are kept from then on). */
	private hadConnection = false;
	private readonly children: ChildThreads;
	private readonly tmux: TmuxNamer;

	constructor(options: BridgeOptions) {
		this.pi = options.pi;
		this.ctx = options.ctx;
		this.link = options.link;
		this.host = options.host;
		this.spawnId = options.spawnId;
		this.registeredId = options.previousSessionId;
		this.shutdownProcess = options.shutdown ?? (() => this.ctx.shutdown());
		this.withCommandContext = options.withCommandContext;
		this.overseer = overseerFromEnv(options.env ?? process.env);
		this.now = options.now ?? Date.now;
		this.startedAt = this.now();
		this.lastActivityAt = this.startedAt;
		try {
			this.status = this.ctx.isIdle() ? "idle" : "working";
		} catch {
			this.status = "idle";
		}
		this.children = new ChildThreads({
			link: this.link,
			host: this.host,
			cwd: () => this.ctx.cwd,
			parentId: () => this.registeredId,
			recording: () => this.hadConnection || this.link.connected,
			onCountsChanged: () => this.pushSummary(),
			now: this.now,
			guard: (fn) => this.guard(fn),
		});
		this.tmux = new TmuxNamer({
			env: options.env,
			run: options.execRunner,
			now: this.now,
			onChange: () => this.guard(() => this.pushSummary()),
		});
		this.tmux.refresh(true);
	}

	get kind(): SessionSummary["kind"] {
		return this.spawnId ? "headless" : "interactive";
	}

	get connectedHubId(): string | undefined {
		return this.hubId;
	}

	// -----------------------------------------------------------------------------------------
	// Link lifecycle
	// -----------------------------------------------------------------------------------------

	/**
	 * The link connected (`sameConnection` false), or this bridge took over a connection its
	 * predecessor already registered on (`sameConnection` true, session replacement or reload).
	 */
	onConnected(sameConnection = false): void {
		if (this.disposed || !this.link.connected) return;
		this.prime();
		this.cancelSlots();
		this.sentHashes.clear();
		this.syncedLeaf = this.ctx.sessionManager.getLeafId();
		const sessionId = this.ctx.sessionManager.getSessionId();
		// Subagent threads belong to the session that launched them; the hub drops them with its id.
		if (this.registeredId !== undefined && this.registeredId !== sessionId) this.children.forget();
		const summary = this.summary(sessionId);
		this.lastSummaryJson = JSON.stringify(summary);
		const known = this.registeredId === sessionId;
		if (sameConnection && known && this.link.registered !== false) {
			// Reload: the hub already has this session on this connection.
			this.link.send({ t: "upsert", session: summary });
		} else {
			// A new connection, or a new session id on the old one (the hub drops the old id).
			this.link.send({ t: "register", v: 1, session: summary, ...(this.spawnId ? { spawnId: this.spawnId } : {}) });
		}
		// Apps still subscribed to this id from before must fetch a fresh snapshot.
		if (known) this.link.send({ t: "event", sessionId, event: { type: "reset" } });
		this.registeredId = sessionId;
		this.hadConnection = true;
		// The hub knows a connection's subagent threads only from this registration on.
		this.children.announce();
		this.tmux.refresh();
		if (!this.poll) {
			this.poll = setInterval(() => this.guard(() => this.tickPoll()), RECONCILE_INTERVAL_MS);
			this.poll.unref?.();
		}
	}

	onDisconnected(): void {
		this.stopPoll();
		this.cancelSlots();
		this.children.onDisconnected();
		this.hubId = undefined;
	}

	/** Droppable frames were lost under backpressure; subscribed apps must resubscribe. */
	onDropped(): void {
		this.sendReset();
		this.children.resetAll();
	}

	/** A subagent run of this session started, streamed an event, or ended (subagents/feed.ts). */
	onSubagentFeed(event: SubagentFeedEvent): void {
		if (this.disposed) return;
		this.children.onFeed(event);
	}

	onFrame(frame: HubToSession): void {
		if (this.disposed) return;
		if (frame.t === "registered") {
			if (typeof frame.hubId === "string") this.hubId = frame.hubId;
			return;
		}
		if (frame.t === "req") void this.handleRequest(frame);
	}

	dispose(): void {
		if (this.disposed) return;
		// Subagent threads live and die with this session (replacement, reload, quit).
		this.guard(() => this.children.dispose());
		this.flushSlots();
		this.disposed = true;
		this.stopPoll();
		this.cancelSlots();
		this.records.clear();
		this.tools.clear();
	}

	/** The session id this bridge registered under (handed to its successor on replacement). */
	get sessionIdForHandover(): string | undefined {
		return this.registeredId;
	}

	// -----------------------------------------------------------------------------------------
	// Session events
	// -----------------------------------------------------------------------------------------

	onAgentStart(): void {
		this.status = "working";
		this.touch();
		this.pushState();
	}

	onAgentSettled(): void {
		this.status = "idle";
		this.running.clear();
		this.touch();
		// A run that ended without a message_end / tool end must not leave items spinning.
		for (const record of this.records.values()) {
			if (record.kind === "assistant" && record.streaming) {
				record.streaming = false;
				record.cutOff = true;
				this.pushItem(record.id, () => renderRecord(record), true);
			} else if (record.kind === "tool" && record.tool.status === "running") {
				record.tool.status = "error";
				this.pushItem(record.id, () => renderRecord(record), true);
			}
		}
		this.flushSlots("item:");
		this.reconcile();
		// Everything of the run is persisted by now; snapshots read it from the session tree.
		this.records.clear();
		this.tools.clear();
		this.pushState();
	}

	onMessageStart(message: unknown): void {
		if (!isRecord(message)) return;
		if (message.role === "user") {
			const user = message as { content: unknown; timestamp: number };
			if (typeof user.timestamp !== "number") return;
			const record: LiveRecord = {
				kind: "user",
				id: itemIds.user(user.timestamp),
				ts: user.timestamp,
				message: user,
			};
			this.remember(record);
			// Before priming, the branch scan decides (a resumed session has older prompts).
			if (this.primed) this.firstPrompt ??= promptLine(user.content);
			this.touch();
			this.pushItem(record.id, () => renderRecord(record), true);
			return;
		}
		if (message.role === "assistant") this.trackAssistant(message as unknown as AssistantMessage, true);
	}

	onMessageUpdate(message: unknown): void {
		if (isRecord(message) && message.role === "assistant") {
			this.trackAssistant(message as unknown as AssistantMessage, true);
		}
	}

	onMessageEnd(message: unknown): void {
		if (!isRecord(message)) return;
		if (message.role === "assistant") {
			const assistant = message as unknown as AssistantMessage;
			const record = this.trackAssistant(assistant, false);
			if (!record) return;
			this.lastAssistantTs = record.ts;
			this.lastText = assistantLine(assistant) ?? this.lastText;
			this.lastError = assistantError(assistant);
			this.assistantEnded = true;
			if (this.primed) this.costUsd += Number(assistant.usage?.cost?.total) || 0;
			for (const call of toolCallsOf(assistant)) {
				const tool: LiveTool = {
					id: itemIds.tool(record.ts, call.id),
					call,
					assistantTs: record.ts,
					startedAt: this.now(),
					status: "running",
				};
				this.noteToolStart(tool);
				this.tools.set(call.id, tool);
				const toolRecord: LiveRecord = { kind: "tool", id: tool.id, ts: record.ts, tool };
				this.remember(toolRecord);
				this.pushItem(tool.id, () => renderRecord(toolRecord), false);
			}
			this.touch();
			return;
		}
		if (message.role === "toolResult") {
			const result = message as unknown as ToolResultMessage;
			const tool = this.tools.get(result.toolCallId);
			if (!tool) return;
			tool.status = result.isError ? "error" : "ok";
			tool.content = result.content;
			this.pushTool(tool, true);
			return;
		}
		if (message.role === "user") {
			// An extension may have replaced the prompt in place; the hash check drops no-ops.
			const record =
				typeof message.timestamp === "number" ? this.records.get(itemIds.user(message.timestamp)) : undefined;
			if (record) this.pushItem(record.id, () => renderRecord(record), true);
		}
	}

	onToolStart(toolCallId: string, toolName: string, args: unknown): void {
		let tool = this.tools.get(toolCallId);
		if (!tool) {
			const assistantTs = this.lastAssistantTs ?? this.now();
			tool = {
				id: itemIds.tool(assistantTs, toolCallId),
				call: { id: toolCallId, name: toolName, arguments: args },
				assistantTs,
				startedAt: this.now(),
				status: "running",
			};
			this.tools.set(toolCallId, tool);
			this.remember({ kind: "tool", id: tool.id, ts: assistantTs, tool });
		}
		tool.status = "running";
		tool.startedAt = this.now();
		this.noteToolStart(tool);
		this.running.set(toolCallId, { tool: toolName, summary: toolSummary(toolName, tool.call.arguments) });
		this.touch();
		this.pushTool(tool, false);
		this.pushState();
	}

	onToolUpdate(toolCallId: string, partialResult: unknown): void {
		const tool = this.tools.get(toolCallId);
		if (!tool || !isRecord(partialResult)) return;
		tool.content = partialResult.content;
		this.pushTool(tool, false);
	}

	onToolEnd(toolCallId: string, result: unknown, isError: boolean): void {
		this.running.delete(toolCallId);
		const tool = this.tools.get(toolCallId);
		if (tool) {
			tool.status = isError ? "error" : "ok";
			if (isRecord(result)) tool.content = result.content;
			this.pushTool(tool, true);
		}
		this.touch();
		this.pushState();
	}

	/** Model, thinking level or name changed: just refresh the summary. */
	onSummaryChanged(): void {
		this.pushSummary();
	}

	/** The transcript was rewritten in place (compaction, tree navigation). */
	onTranscriptRewritten(): void {
		this.sendReset();
		this.pushSummary();
	}

	/** Called after events that persist entries without a live event of their own. */
	reconcileSoon(): void {
		if (!this.link.connected) return;
		setTimeout(() => this.guard(() => this.reconcile()), 0).unref?.();
	}

	// -----------------------------------------------------------------------------------------
	// Live tracking
	// -----------------------------------------------------------------------------------------

	private trackAssistant(message: AssistantMessage, streaming: boolean): LiveRecord | undefined {
		if (typeof message.timestamp !== "number") return undefined;
		const id = itemIds.assistant(message.timestamp);
		let record = this.records.get(id);
		if (record?.kind === "assistant") {
			record.message = message;
			record.streaming = streaming;
		} else {
			record = { kind: "assistant", id, ts: message.timestamp, message, streaming };
			this.remember(record);
		}
		const current = record;
		this.pushItem(id, () => renderRecord(current), !streaming);
		return record;
	}

	private noteToolStart(tool: LiveTool): void {
		this.toolStarts.delete(tool.id);
		this.toolStarts.set(tool.id, tool.startedAt);
		while (this.toolStarts.size > MAX_TOOL_STARTS) {
			const oldest = this.toolStarts.keys().next().value;
			if (oldest === undefined) break;
			this.toolStarts.delete(oldest);
		}
	}

	private remember(record: LiveRecord): void {
		this.records.delete(record.id);
		this.records.set(record.id, record);
		while (this.records.size > MAX_LIVE_RECORDS) {
			const oldest = this.records.keys().next().value;
			if (oldest === undefined) break;
			this.records.delete(oldest);
		}
	}

	private touch(): void {
		this.lastActivityAt = this.now();
		this.pushSummary();
	}

	private activity(): ToolActivity | undefined {
		let last: ToolActivity | undefined;
		for (const value of this.running.values()) last = value;
		return last;
	}

	private liveState(): LiveState {
		const activity = this.activity();
		return { status: this.status, ...(activity ? { activity } : {}) };
	}

	// -----------------------------------------------------------------------------------------
	// Emission (coalesced, deduplicated)
	// -----------------------------------------------------------------------------------------

	private currentSessionId(): string | undefined {
		return this.registeredId;
	}

	private schedule(key: string, intervalMs: number, build: () => SessionToHub | undefined, immediate: boolean): void {
		if (this.disposed || !this.link.connected) return;
		let slot = this.slots.get(key);
		if (!slot) {
			slot = { lastSent: 0 };
			this.slots.set(key, slot);
		}
		slot.build = build;
		const elapsed = this.now() - slot.lastSent;
		if (immediate || elapsed >= intervalMs) {
			this.flushSlot(key, slot);
			return;
		}
		if (slot.timer) return;
		const pending = slot;
		pending.timer = setTimeout(() => {
			pending.timer = undefined;
			this.guard(() => this.flushSlot(key, pending));
		}, intervalMs - elapsed);
		pending.timer.unref?.();
	}

	private flushSlot(key: string, slot: Slot): void {
		if (slot.timer) clearTimeout(slot.timer);
		slot.timer = undefined;
		const build = slot.build;
		slot.build = undefined;
		if (!build || !this.link.connected) return;
		slot.lastSent = this.now();
		const frame = build();
		if (frame) this.link.send(frame, { droppable: frame.t === "event" || frame.t === "upsert", key });
	}

	/** Send pending trailing updates now (all of them, or the keys with this prefix). */
	private flushSlots(prefix = ""): void {
		for (const [key, slot] of this.slots) {
			if (slot.build && key.startsWith(prefix)) this.guard(() => this.flushSlot(key, slot));
		}
	}

	private cancelSlots(): void {
		for (const slot of this.slots.values()) {
			if (slot.timer) clearTimeout(slot.timer);
		}
		this.slots.clear();
	}

	private pushItem(id: string, render: () => TranscriptItem, final: boolean): void {
		this.schedule(`item:${id}`, ITEM_INTERVAL_MS, () => this.itemFrame(render()), final);
		if (final) this.slots.delete(`item:${id}`);
	}

	private pushTool(tool: LiveTool, final: boolean): void {
		const record = this.records.get(tool.id);
		const render = (): TranscriptItem =>
			record
				? renderRecord(record)
				: toolItem(tool.call, tool.assistantTs, { status: tool.status, content: tool.content }, tool.startedAt);
		this.pushItem(tool.id, render, final);
	}

	private pushState(): void {
		this.schedule(
			"state",
			STATE_INTERVAL_MS,
			() => {
				const sessionId = this.currentSessionId();
				return sessionId ? { t: "event", sessionId, event: { type: "state", state: this.liveState() } } : undefined;
			},
			false,
		);
		this.pushSummary();
	}

	private pushSummary(): void {
		this.schedule(
			"summary",
			SUMMARY_INTERVAL_MS,
			() => {
				const sessionId = this.currentSessionId();
				if (!sessionId) return undefined;
				const summary = this.summary(sessionId);
				const json = JSON.stringify(summary);
				if (json === this.lastSummaryJson) return undefined;
				this.lastSummaryJson = json;
				return { t: "upsert", session: summary };
			},
			false,
		);
	}

	/** An `item.upsert` frame, or undefined when this exact item was the last one sent for its id. */
	private itemFrame(item: TranscriptItem): SessionToHub | undefined {
		const sessionId = this.currentSessionId();
		if (!sessionId) return undefined;
		const hash = hashString(JSON.stringify(item));
		if (this.sentHashes.get(item.id) === hash) return undefined;
		this.sentHashes.delete(item.id);
		this.sentHashes.set(item.id, hash);
		while (this.sentHashes.size > MAX_SENT_HASHES) {
			const oldest = this.sentHashes.keys().next().value;
			if (oldest === undefined) break;
			this.sentHashes.delete(oldest);
		}
		return { t: "event", sessionId, event: { type: "item.upsert", item } };
	}

	private emitNow(item: TranscriptItem): void {
		this.pushItem(item.id, () => item, true);
	}

	private sendReset(): void {
		if (!this.link.connected) return;
		const sessionId = this.currentSessionId();
		if (!sessionId) return;
		this.cancelSlots();
		this.sentHashes.clear();
		this.syncedLeaf = this.ctx.sessionManager.getLeafId();
		this.link.send({ t: "event", sessionId, event: { type: "reset" } });
	}

	private tickPoll(): void {
		if (this.disposed || !this.link.connected) return;
		// Safety net: session replacement normally re-creates the bridge, but an id that changes
		// under it is registered on the same connection all the same.
		if (this.ctx.sessionManager.getSessionId() !== this.registeredId) {
			this.onConnected(true);
			return;
		}
		this.reconcile();
		this.tmux.refresh();
		this.pushSummary();
	}

	private stopPoll(): void {
		if (this.poll) clearInterval(this.poll);
		this.poll = undefined;
	}

	// -----------------------------------------------------------------------------------------
	// Session tree
	// -----------------------------------------------------------------------------------------

	private orphanStatus(): ToolItem["status"] {
		return this.status === "working" ? "running" : "error";
	}

	private readonly liveTool = (itemId: string): ToolItem | undefined => {
		const record = this.records.get(itemId);
		return record?.kind === "tool" ? (renderRecord(record) as ToolItem) : undefined;
	};

	private readonly toolStartedAt = (itemId: string): number | undefined => this.toolStarts.get(itemId);

	/** Emit items of entries appended since the last check that no live event covered. */
	private reconcile(): void {
		if (this.disposed || !this.link.connected || this.syncedLeaf === undefined) return;
		const sessionManager = this.ctx.sessionManager;
		const leaf = sessionManager.getLeafId();
		if (leaf === this.syncedLeaf) return;
		const fresh: SessionEntry[] = [];
		let cursor = leaf;
		while (cursor && cursor !== this.syncedLeaf && fresh.length < 2000) {
			const entry = sessionManager.getEntry(cursor);
			if (!entry) break;
			fresh.push(entry);
			cursor = entry.parentId;
		}
		if (cursor !== this.syncedLeaf) {
			// The new leaf does not descend from the old one: tree navigation or a branch switch.
			this.sendReset();
			return;
		}
		this.syncedLeaf = leaf;
		fresh.reverse();
		const results = new Map<string, ToolResultMessage>();
		for (const entry of fresh) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				results.set(entry.message.toolCallId, entry.message);
			}
		}
		const consumed = new Set<string>();
		const context = {
			resultFor: (toolCallId: string) => {
				const result = results.get(toolCallId);
				if (result) consumed.add(toolCallId);
				return result;
			},
			liveTool: this.liveTool,
			toolStartedAt: this.toolStartedAt,
			orphanStatus: this.orphanStatus(),
		};
		// Items already sent live hash-match and are skipped; the rest (bash runs, custom messages,
		// summaries, messages that bypassed the event stream) go out now.
		for (const entry of fresh) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				if (consumed.has(entry.message.toolCallId)) continue;
				const item = this.toolItemForResult(entry, entry.message);
				if (item) this.emitNow(item);
				continue;
			}
			for (const item of entryItems(entry, context)) this.emitNow(item);
		}
	}

	/** The tool item a persisted result belongs to, when its assistant message was synced earlier. */
	private toolItemForResult(entry: SessionEntry, result: ToolResultMessage): ToolItem | undefined {
		const state = { status: result.isError ? ("error" as const) : ("ok" as const), content: result.content };
		const live = this.tools.get(result.toolCallId);
		if (live) return toolItem(live.call, live.assistantTs, state, live.startedAt);
		let cursor = entry.parentId;
		for (let steps = 0; cursor && steps < 500; steps++) {
			const parent = this.ctx.sessionManager.getEntry(cursor);
			if (!parent) break;
			if (parent.type === "message" && parent.message.role === "assistant") {
				const call = toolCallsOf(parent.message).find((candidate) => candidate.id === result.toolCallId);
				if (call && typeof parent.message.timestamp === "number") {
					const id = itemIds.tool(parent.message.timestamp, call.id);
					return toolItem(call, parent.message.timestamp, state, this.toolStarts.get(id) ?? entryTs(parent));
				}
			}
			cursor = parent.parentId;
		}
		return undefined;
	}

	private transcript(limit: number): { items: TranscriptItem[]; hasMore: boolean } {
		const branch = this.ctx.sessionManager.getBranch();
		const records = [...this.records.values()];
		let scanBackTo: number | undefined;
		for (const record of records) scanBackTo = scanBackTo === undefined ? record.ts : Math.min(scanBackTo, record.ts);
		const walk = walkBranch(branch, {
			limit,
			scanBackTo,
			liveTool: this.liveTool,
			toolStartedAt: this.toolStartedAt,
			orphanStatus: this.orphanStatus(),
		});
		// Records not found in the tree are still in flight (streaming, or queued for persistence).
		const floating = records.filter((record) => !walk.seen.has(record.id)).map(renderRecord);
		let items = walk.items.concat(floating);
		let hasMore = walk.hasMore;
		if (items.length > limit) {
			hasMore = true;
			items = items.slice(items.length - limit);
		}
		return { items, hasMore };
	}

	// -----------------------------------------------------------------------------------------
	// Summary
	// -----------------------------------------------------------------------------------------

	private prime(): void {
		if (this.primed) return;
		this.primed = true;
		const sessionManager = this.ctx.sessionManager;
		let cost = 0;
		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				cost += Number(entry.message.usage?.cost?.total) || 0;
			}
		}
		this.costUsd = cost;
		const branch = sessionManager.getBranch();
		if (this.firstPrompt === undefined) {
			for (const entry of branch) {
				if (entry.type === "message" && entry.message.role === "user") {
					this.firstPrompt = promptLine(entry.message.content);
					if (this.firstPrompt) break;
				}
			}
		}
		if (!this.assistantEnded) {
			// A resumed session whose last turn failed still reports it until the next reply.
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry = branch[index];
				if (entry.type === "message" && entry.message.role === "assistant") {
					this.lastError = assistantError(entry.message);
					break;
				}
			}
		}
		if (this.lastText === undefined) {
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry = branch[index];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const line = assistantLine(entry.message);
					if (line) {
						this.lastText = line;
						break;
					}
				}
			}
		}
	}

	summary(sessionId = this.ctx.sessionManager.getSessionId()): SessionSummary {
		const ctx = this.ctx;
		const cwd = ctx.cwd;
		let name: string | undefined;
		try {
			name = this.pi.getSessionName()?.trim() || undefined;
		} catch {
			name = undefined;
		}
		const model = ctx.model;
		const thinkingLevel = this.thinkingLevel();
		let contextPercent: number | undefined;
		try {
			const percent = ctx.getContextUsage()?.percent;
			if (typeof percent === "number" && Number.isFinite(percent)) contextPercent = Math.round(percent * 10) / 10;
		} catch {
			contextPercent = undefined;
		}
		const activity = this.activity();
		const commands = this.commandList();
		const tmux = this.tmux.current;
		const subagents = this.children.counts();
		const usage = {
			...(this.primed ? { costUsd: Math.round(this.costUsd * 10_000) / 10_000 } : {}),
			...(contextPercent !== undefined ? { contextPercent } : {}),
		};
		return {
			sessionId,
			name: sessionDisplayName({
				explicit: name,
				tmux,
				firstPrompt: this.firstPrompt,
				cwdName: basename(cwd) || cwd,
			}),
			cwd,
			host: this.host,
			pid: process.pid,
			kind: this.kind,
			status: this.status,
			...(model
				? { model: { provider: model.provider, id: model.id, ...(model.name ? { name: model.name } : {}) } }
				: {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			startedAt: this.startedAt,
			lastActivityAt: this.lastActivityAt,
			...(this.lastText ? { lastText: this.lastText } : {}),
			...(this.lastError ? { lastError: this.lastError } : {}),
			...(activity ? { activity } : {}),
			...(Object.keys(usage).length > 0 ? { usage } : {}),
			...(commands ? { commandsVersion: commandsVersion(commands) } : {}),
			...(subagents ? { subagents } : {}),
			...(tmux ? { tmux: { session: tmux.session, ...(tmux.window ? { window: tmux.window } : {}) } } : {}),
			...(this.overseer ? { overseer: this.overseer } : {}),
		};
	}

	// -----------------------------------------------------------------------------------------
	// Slash commands
	// -----------------------------------------------------------------------------------------

	/** `pi.getCommands()`; empty when the session cannot list them. */
	private slashCommands(): SlashCommandInfo[] {
		try {
			const commands = this.pi.getCommands?.();
			return Array.isArray(commands) ? commands : [];
		} catch {
			return [];
		}
	}

	private commandOptions(): CommandListOptions {
		try {
			return { skillCommands: this.pi.getSettings?.().enableSkillCommands !== false };
		} catch {
			return { skillCommands: true };
		}
	}

	/** What `commands.list` returns; undefined when this session cannot list commands at all. */
	private commandList(): CommandInfo[] | undefined {
		if (!this.pi.getCommands) return undefined;
		return buildCommandList(this.slashCommands(), this.commandOptions());
	}

	// -----------------------------------------------------------------------------------------
	// Requests
	// -----------------------------------------------------------------------------------------

	private async handleRequest(frame: ReqFrame): Promise<void> {
		const id = typeof frame.id === "string" ? frame.id : undefined;
		if (!id) return;
		const target = typeof frame.sessionId === "string" ? frame.sessionId : undefined;
		if (target && target !== this.registeredId && (this.children.has(target) || isChildSessionId(target))) {
			let reply: ChildReply;
			try {
				reply = this.children.perform(target, String(frame.op), isRecord(frame.args) ? frame.args : {});
			} catch (error) {
				reply = {
					ok: false,
					error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
				};
			}
			if (reply.ok) this.link.send({ t: "reply", re: id, ok: true, data: reply.data });
			else this.link.send({ t: "reply", re: id, ok: false, error: reply.error });
			return;
		}
		let data: SessionOpReplyData;
		try {
			data = await this.perform(frame);
		} catch (error) {
			const code = error instanceof OpError ? error.code : "internal";
			const message = error instanceof Error ? error.message : String(error);
			this.link.send({ t: "reply", re: id, ok: false, error: { code, message } });
			return;
		}
		this.link.send({ t: "reply", re: id, ok: true, data });
		if (frame.op === "close") this.closeSoon();
	}

	private async perform(frame: ReqFrame): Promise<SessionOpReplyData> {
		const args: Record<string, unknown> = isRecord(frame.args) ? frame.args : {};
		switch (frame.op as string) {
			case "snapshot": {
				this.reconcile();
				const { items, hasMore } = this.transcript(this.pageLimit(args.limit));
				return { items, hasMore, state: this.liveState() };
			}
			case "history":
				return this.history(args);
			case "prompt":
				return this.prompt(args);
			case "abort":
				// Idle: a no-op. Working: the aborted message_end / tool results (and agent_settled for
				// anything cut off) mark the streaming item `error: "aborted"` and running tools `error`.
				if (this.status === "working" || !this.ctx.isIdle()) this.ctx.abort();
				return {};
			case "models":
				return this.models();
			case "commands":
				return { commands: this.commandList() ?? [] };
			case "setModel":
				return this.setModel(args);
			case "setThinking": {
				const level = args.level;
				if (typeof level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(level)) {
					throw new OpError("bad_request", `level must be one of ${THINKING_LEVELS.join(", ")}`);
				}
				this.pi.setThinkingLevel(level as ThinkingLevel);
				this.pushSummary();
				return {};
			}
			case "close":
				// A headless session closes for anyone on the hub; an interactive one only for the
				// overseer that started it (its PHI_OVERSEER_SESSION_ID), and then exits as /quit does.
				if (
					this.kind !== "headless" &&
					!(this.overseer && typeof args.overseer === "string" && args.overseer === this.overseer.sessionId)
				) {
					throw new OpError("forbidden", "only headless sessions can be closed remotely");
				}
				return {};
			default:
				throw new OpError("bad_request", `unknown op: ${String(frame.op)}`);
		}
	}

	/** The session's thinking level; always `off` on a model without reasoning. */
	private thinkingLevel(): string | undefined {
		try {
			const model = this.ctx.model;
			if (model && !model.reasoning) return "off";
			return this.pi.getThinkingLevel();
		} catch {
			return undefined;
		}
	}

	private pageLimit(value: unknown): number {
		if (value === undefined) return DEFAULT_SNAPSHOT_LIMIT;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
			throw new OpError("bad_request", "limit must be a positive number");
		}
		return Math.min(MAX_PAGE_LIMIT, Math.floor(value));
	}

	private history(args: Record<string, unknown>): { items: TranscriptItem[]; hasMore: boolean } {
		const before = args.before;
		if (typeof before !== "string" || !before) throw new OpError("bad_request", "before must be an item id");
		const limit = this.pageLimit(args.limit);
		const walk = walkBranch(this.ctx.sessionManager.getBranch(), {
			limit,
			before,
			liveTool: this.liveTool,
			toolStartedAt: this.toolStartedAt,
			orphanStatus: this.orphanStatus(),
		});
		if (walk.found) return { items: walk.items, hasMore: walk.hasMore };
		// `before` may be an in-flight item that is not persisted yet.
		const all = this.transcript(limit + this.records.size + 1);
		const index = all.items.findIndex((item) => item.id === before);
		if (index === -1) throw new OpError("not_found", `no item ${before}`);
		const start = Math.max(0, index - limit);
		return { items: all.items.slice(start, index), hasMore: start > 0 || all.hasMore };
	}

	private async prompt(args: Record<string, unknown>): Promise<Record<string, never>> {
		const text = args.text;
		if (typeof text !== "string") throw new OpError("bad_request", "text must be a string");
		let images: PromptImage[] = [];
		if (args.images !== undefined) {
			if (!Array.isArray(args.images)) throw new OpError("bad_request", "images must be an array");
			images = args.images.map((image) => {
				if (!isRecord(image) || typeof image.data !== "string" || typeof image.mimeType !== "string") {
					throw new OpError("bad_request", "each image needs mimeType and base64 data");
				}
				if (!IMAGE_TYPES.has(image.mimeType)) {
					throw new OpError("bad_request", `unsupported image type ${image.mimeType} (jpeg, png, webp or gif)`);
				}
				return { mimeType: image.mimeType, data: image.data };
			});
		}
		if (!text.trim() && images.length === 0) throw new OpError("bad_request", "empty prompt");
		const mode = args.mode ?? "auto";
		if (mode !== "auto" && mode !== "steer" && mode !== "followUp") {
			throw new OpError("bad_request", "mode must be auto, steer or followUp");
		}
		// `/name args`: what typing it in the terminal does (see commands.ts for the two differences).
		const route = resolveSlash(text, this.slashCommands(), this.commandOptions());
		if (route?.kind === "refused") {
			throw new OpError("bad_request", `/${route.name} needs the phi terminal; it is not available from phi remote`);
		}
		if (route?.kind === "builtin") {
			if (images.length > 0) throw new OpError("bad_request", `/${route.name} does not take images`);
			await this.runBuiltin(route.name, route.args);
			return {};
		}
		// Extension commands run without a model (`/mcp`, `/loop`, ...); everything else reaches it.
		if (!route?.extensionCommand && !this.ctx.model) {
			throw new OpError("bad_request", "no model selected in this session");
		}
		const outgoing = route ? route.text : text;
		const content: string | (TextContent | ImageContent)[] =
			images.length > 0
				? [
						{ type: "text", text: outgoing },
						...images.map(
							(image): ImageContent => ({ type: "image", data: image.data, mimeType: image.mimeType }),
						),
					]
				: outgoing;
		// `auto` steers a working session and starts a turn in an idle one: a delivery mode only
		// applies while the agent is busy, so passing it always is also safe against a prompt that
		// was typed in the terminal at the same moment. A slash command dispatches an extension
		// command, or expands a skill or prompt template, exactly as the terminal does.
		this.pi.sendUserMessage(content, {
			deliverAs: mode === "followUp" ? "followUp" : "steer",
			...(route ? { expandPromptTemplates: true } : {}),
		});
		this.touch();
		return {};
	}

	/** The remote-safe TUI built-ins (commands.ts `REMOTE_BUILTINS`), run without a terminal. */
	private async runBuiltin(name: RemoteBuiltin, args: string): Promise<void> {
		switch (name) {
			case "new": {
				if (args) throw new OpError("bad_request", "Usage: /new (no arguments)");
				const withCommandContext = this.withCommandContext;
				if (!withCommandContext) throw new OpError("internal", "/new is not available in this session");
				// Session replacement disposes this bridge; the reply still goes out on the parked
				// connection, after the new session has registered (the hub sends `reset` with
				// `replacedBy` to subscribers of this one).
				const result = await withCommandContext((ctx) => ctx.newSession());
				if (result?.cancelled) throw new OpError("bad_request", "/new was cancelled by an extension");
				return;
			}
			case "compact": {
				// The terminal queues a compaction requested mid-run; an extension can only start one,
				// which would abort the run, so the phone has to wait for idle.
				if (this.status === "working" || !this.ctx.isIdle()) {
					throw new OpError("bad_request", "the session is working; send /compact when it is idle");
				}
				await new Promise<void>((resolve, reject) => {
					let settled = false;
					const settle = (error?: Error) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						if (error) reject(new OpError("bad_request", `compaction failed: ${error.message}`));
						else resolve();
					};
					// Quick failures (nothing to compact, no model) are reported; a running compaction
					// is acknowledged and shows up as a `reset` when it lands.
					const timer = setTimeout(() => settle(), COMPACT_ERROR_WINDOW_MS);
					timer.unref?.();
					this.ctx.compact({
						...(args ? { customInstructions: args } : {}),
						onComplete: () => settle(),
						onError: (error) => settle(error),
					});
				});
				return;
			}
			case "name": {
				if (!args) throw new OpError("bad_request", "Usage: /name <name>");
				if (!this.pi.setSessionName) throw new OpError("internal", "/name is not available in this session");
				this.pi.setSessionName(args);
				this.pushSummary();
				return;
			}
			case "model": {
				if (!args) throw new OpError("bad_request", "Usage: /model <provider/model>");
				// Same pool as the terminal: the scoped models when the session has any.
				const scoped = this.ctx.scopedModels ?? [];
				const pool = scoped.length > 0 ? scoped.map((entry) => entry.model) : this.ctx.modelRegistry.getAvailable();
				const model = findExactModelReferenceMatch(args, pool);
				if (!model) throw new OpError("not_found", `no model ${args}`);
				const ok = await this.pi.setModel(model);
				if (!ok) throw new OpError("bad_request", `no credentials for ${model.provider}`);
				this.pushSummary();
				return;
			}
			case "thinking": {
				const model = this.ctx.model;
				const levels: string[] = model ? getSupportedThinkingLevels(model) : [...THINKING_LEVELS];
				const level = levels.find((candidate) => candidate.toLowerCase() === args.toLowerCase());
				if (!args || !level) {
					throw new OpError("bad_request", `Usage: /thinking <level> (${levels.join(", ")})`);
				}
				this.pi.setThinkingLevel(level as ThinkingLevel);
				this.pushSummary();
				return;
			}
		}
	}

	private models(): ModelsPayload {
		const model = this.ctx.model;
		const available = this.ctx.modelRegistry.getAvailable();
		const thinkingLevel = this.thinkingLevel();
		return {
			models: available.map((entry) => ({
				provider: entry.provider,
				id: entry.id,
				name: entry.name || entry.id,
				reasoning: entry.reasoning === true,
			})),
			...(model ? { current: { provider: model.provider, id: model.id } } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			thinkingLevels: model ? getSupportedThinkingLevels(model) : DEFAULT_THINKING_LEVELS,
		};
	}

	private async setModel(args: Record<string, unknown>): Promise<Record<string, never>> {
		const { provider, modelId } = args;
		if (typeof provider !== "string" || typeof modelId !== "string") {
			throw new OpError("bad_request", "provider and modelId are required");
		}
		const model = this.ctx.modelRegistry.find(provider, modelId);
		if (!model) throw new OpError("not_found", `no model ${provider}/${modelId}`);
		const ok = await this.pi.setModel(model);
		if (!ok) throw new OpError("bad_request", `no credentials for ${provider}`);
		this.pushSummary();
		return {};
	}

	private closeSoon(): void {
		const timer = setTimeout(() => {
			this.guard(() => {
				if (!this.ctx.isIdle()) this.ctx.abort();
			});
			this.guard(() => this.shutdownProcess());
		}, 50);
		timer.unref?.();
	}

	private guard(fn: () => void): void {
		try {
			fn();
		} catch {
			// Never into the session.
		}
	}
}
