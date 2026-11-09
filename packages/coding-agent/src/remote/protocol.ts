/**
 * phi remote — shared types.
 *
 * Two wires live here:
 *  1. The PUBLIC protocol v1 between the hub and phone apps (WebSocket JSON). Contract:
 *     example-org/phi-remote docs/PROTOCOL.md (copied to docs/remote-protocol.md in this repo).
 *  2. The INTERNAL local wire between each phi session and the hub over ~/.pi/agent/remote/hub.sock
 *     (newline-delimited JSON, one object per line). Internal to phi; may change freely, but both
 *     sides (src/remote/hub/** and src/extensions/remote/**) must agree on it.
 *
 * Types only — no runtime code — so either side can import it without pulling the other in.
 */

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_DEFAULT_PORT = 7717;

// ---------------------------------------------------------------------------------------------
// Shared domain types (identical on both wires)
// ---------------------------------------------------------------------------------------------

export type SessionStatus = "working" | "idle";

export interface ToolActivity {
	tool: string;
	summary?: string;
}

/** Client capability flags sent in `hello.features` (v1 additions). */
export const REMOTE_FEATURE_SUBAGENTS = "subagents";

/**
 * Hub capability flags sent in `welcome.host.features` (v1 additions). `history`: the hub answers
 * `sessions.past`, `session.transcript` and `session.resume` (docs/remote-protocol.md, "Session
 * history").
 */
export const REMOTE_HOST_FEATURE_HISTORY = "history";
/**
 * `overseer`: the hub reports `isOverseer` / `threadCounts` on summaries, `overseer` / `isOverseer` on
 * past sessions, answers `overseer.board`, and takes `name` on `session.spawn` (docs/remote-protocol.md,
 * "Overseers").
 */
export const REMOTE_HOST_FEATURE_OVERSEER = "overseer";

/** One stored phi session in `sessions.past` (newest `modifiedAt` first). */
export interface PastSession {
	/** phi session id (the session file header id). */
	sessionId: string;
	/** session_info name, else first user message line (≤ 120 chars), else cwd basename. */
	title: string;
	/** True when `title` came from a session_info name. */
	named: boolean;
	/** "" for very old sessions. */
	cwd: string;
	/** Epoch ms. */
	createdAt: number;
	/** Epoch ms (last entry, else file mtime). */
	modifiedAt: number;
	/** User + assistant messages. */
	messageCount: number;
	/** Last assistant reply text, one line, ≤ 200 chars. */
	preview?: string;
	/** Last model used. */
	model?: { provider: string; id: string };
	/** A session with this id is registered with the hub right now. */
	live: boolean;
	liveKind?: "interactive" | "headless";
	/** False only when the session file can no longer be read (the folder is not consulted). */
	resumable: boolean;
	/** The overseer that started (or adopted) this session: the live summary's link, else the registry files'. */
	overseer?: OverseerLink;
	/** This session is an overseer (registry file with at least one thread, or a live thread naming it). */
	isOverseer?: true;
}

/** `SessionSummary.threadCounts`: an overseer's threads by state. The six buckets are disjoint and sum to `total`. */
export interface ThreadCounts {
	total: number;
	/** Live and working. */
	working: number;
	/** Live, not working, no error. */
	idle: number;
	/** Live, not working, with `lastError`. */
	error: number;
	/** Not live and not closed (registry state exited, or running but not registered with the hub). */
	exited: number;
	/** Not live, registry state closed. */
	closed: number;
}

/** One thread of an overseer in `overseer.board` (registry record merged with the live summary). */
export interface BoardThread {
	name: string;
	sessionId: string;
	backend: "forca" | "tmux" | "headless" | "external";
	adopted?: boolean;
	cwd: string;
	/** `provider/id`. */
	model?: string;
	thinking?: string;
	/** Registry state ("running" for a live thread the registry does not list yet). */
	state: "running" | "exited" | "closed";
	/** Registered with the hub right now. */
	live: boolean;
	/** Live summary status, when live. */
	status?: SessionStatus;
	/** Live summary activity as one line (`tool summary`), when live and busy. */
	activity?: string;
	lastText?: string;
	lastError?: string;
	costUsd?: number;
	contextPercent?: number;
	createdAt: number;
	lastActivityAt?: number;
	exitedAt?: number;
	closedAt?: number;
	subagentModels?: { default?: string; allow?: string[] };
}

/** `overseer.board` reply (app frame without `t`/`re`; ctl reply data). */
export interface OverseerBoardData {
	sessionId: string;
	/** The overseer's session name, when known. */
	name?: string;
	/** Registry order (createdAt ascending), then live threads the registry does not list. */
	threads: BoardThread[];
}

export type SubagentRunStatus = "running" | "done" | "failed" | "killed";

/** `SessionSummary.subagent`: the run behind a `kind: "subagent"` session. */
export interface SubagentInfo {
	runId: string;
	/** The parent's `subagent` tool call that launched this run (its transcript `tool` item). */
	toolCallId?: string;
	/** 0-based position in that call's `tasks` / `chain` (0 for a single task). */
	index?: number;
	/** The task's explicit `name`, when it had one. */
	name?: string;
	/** Named agent definition used, if any. */
	agent?: string;
	/** One line, ≤ 200 chars. */
	task: string;
	status: SubagentRunStatus;
	startedAt: number;
	endedAt?: number;
	turns?: number;
	toolCalls?: number;
	/** Launched with the tool's background mode (the parent turn did not wait for it). */
	background?: boolean;
}

export interface SessionSummary {
	sessionId: string;
	/**
	 * Session name, else the tmux session name (see `tmux`), else first prompt line (≤60), else cwd
	 * basename. Subagents: task name, else agent, else first task line.
	 */
	name: string;
	cwd: string;
	host: string;
	pid: number;
	/**
	 * headless = spawned by the hub via `session.spawn`. subagent = a run of a session's `subagent`
	 * tool, served by its parent (only to clients whose `hello.features` has "subagents").
	 */
	kind: "interactive" | "headless" | "subagent";
	/** kind "subagent": the session that launched it. */
	parentSessionId?: string;
	/** kind "subagent": the run. */
	subagent?: SubagentInfo;
	/** Subagent sessions this session launched and still lists (only when total > 0). */
	subagents?: { running: number; total: number };
	/** The tmux session (and window) this phi process runs in, raw values. */
	tmux?: { session: string; window?: string };
	status: SessionStatus;
	model?: { provider: string; id: string; name?: string };
	thinkingLevel?: string;
	startedAt: number;
	lastActivityAt: number;
	/** Last assistant text, ≤200 chars, single line. */
	lastText?: string;
	activity?: ToolActivity;
	usage?: { costUsd?: number; contextPercent?: number };
	/**
	 * Opaque version of the session's slash-command list (`commands.list`); changes whenever the list
	 * does (/reload, an extension registering a command, discovered skills). Compare for equality only.
	 * Absent on sessions that predate slash commands.
	 */
	commandsVersion?: string;
	/**
	 * Set when an overseer session started this one (env `PHI_OVERSEER_SESSION_ID`, `PHI_OVERSEER_NAME`,
	 * `PHI_OVERSEER_THREAD`). Lets an overseer find its threads again after a restart. Additive.
	 */
	overseer?: OverseerLink;
	/**
	 * Error of the last assistant message (one line, ≤ 200 chars) when the last turn ended in an error;
	 * cleared by the next assistant message without one. Additive.
	 */
	lastError?: string;
	/**
	 * Set by the hub (never by a session): this session is an overseer — it has a registry file with at
	 * least one thread, or a live session names it in `overseer.sessionId`. Additive.
	 */
	isOverseer?: true;
	/** Set by the hub on overseers only: their threads by state (registry + live summaries). Additive. */
	threadCounts?: ThreadCounts;
}

/** `SessionSummary.overseer`: the overseer that owns this session (a "thread"). */
export interface OverseerLink {
	/** The overseer's phi session id. */
	sessionId: string;
	/** The overseer's display name, if known. */
	name?: string;
	/** This thread's name as given at spawn. */
	thread?: string;
}

/**
 * Environment variables that pass from an overseer to a thread it starts. The hub's control-wire
 * `session.spawn` / `session.resume` accept only keys in this list or starting with one of the
 * prefixes; anything else is dropped. Values are strings ≤ 4 KiB.
 */
export const THREAD_ENV_KEYS = ["PHI_OVERSEER_SESSION_ID", "PHI_OVERSEER_NAME", "PHI_OVERSEER_THREAD"] as const;
export const THREAD_ENV_PREFIXES = ["PHI_OVERSEER_", "PHI_SUBAGENT_MODEL_"] as const;

/** Where a slash command comes from. */
export type CommandSource = "builtin" | "extension" | "prompt" | "skill";

/** One slash command the session accepts as `/name args` in `session.prompt`. */
export interface CommandInfo {
	/** What the user types after the slash, e.g. `compact`, `skill:use-subs`, `mcp`. */
	name: string;
	/** Single line, ≤ 160 chars. */
	description?: string;
	source: CommandSource;
	/** e.g. `<name>`, `[instructions]`. */
	argumentHint?: string;
}

export interface LiveState {
	status: SessionStatus;
	activity?: ToolActivity;
}

export type TranscriptItem =
	| { id: string; ts: number; kind: "user"; text: string; images?: number }
	| {
			id: string;
			ts: number;
			kind: "assistant";
			text: string;
			thinking?: string;
			model?: string;
			streaming?: boolean;
			error?: string;
	  }
	| {
			id: string;
			ts: number;
			kind: "tool";
			toolCallId: string;
			name: string;
			/** One line, e.g. "bash  ls -la" / "read  src/app.ts". */
			summary: string;
			/** JSON, truncated to ~4 KB. */
			args?: unknown;
			status: "running" | "ok" | "error";
			/** Text, truncated to ~8 KB (head + tail). */
			output?: string;
			outputTruncated?: boolean;
	  }
	| { id: string; ts: number; kind: "note"; label?: string; text: string };

export type LiveEvent =
	| { type: "item.upsert"; item: TranscriptItem }
	| { type: "state"; state: LiveState }
	/**
	 * Resubscribe. `replacedBy` (hub-generated): this session was replaced by that one on the same
	 * phi process (/new, /resume, /fork); subscribe to it instead.
	 */
	| { type: "reset"; replacedBy?: string };

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
}

export interface ModelsPayload {
	models: ModelInfo[];
	current?: { provider: string; id: string };
	thinkingLevel?: string;
	thinkingLevels: string[];
}

export interface PromptImage {
	mimeType: string;
	/** base64 */
	data: string;
}

export type PromptMode = "auto" | "steer" | "followUp";

export type RemoteErrorCode = "not_found" | "bad_request" | "session_offline" | "forbidden" | "internal";

export interface RemoteError {
	code: RemoteErrorCode;
	message: string;
}

// ---------------------------------------------------------------------------------------------
// INTERNAL local wire: session <-> hub over hub.sock (NDJSON)
// ---------------------------------------------------------------------------------------------

/**
 * Operations the hub asks a session to perform. A `req` may carry `sessionId`: the session (its own
 * id, or one of its subagent children's) the operation is for; absent means the session itself.
 */
export type SessionOp =
	| { op: "snapshot"; args: { limit?: number } }
	| { op: "history"; args: { before: string; limit?: number } }
	| { op: "prompt"; args: { text: string; images?: PromptImage[]; mode?: PromptMode } }
	| { op: "abort"; args: Record<string, never> }
	| { op: "models"; args: Record<string, never> }
	| { op: "setModel"; args: { provider: string; modelId: string } }
	| { op: "setThinking"; args: { level: string } }
	| { op: "commands"; args: Record<string, never> }
	/** `overseer`: set by a control-wire close; an interactive session closes only for its own overseer. */
	| { op: "close"; args: { overseer?: string } };

export type SessionOpReplyData =
	| { items: TranscriptItem[]; hasMore: boolean; state: LiveState } // snapshot
	| { items: TranscriptItem[]; hasMore: boolean } // history
	| ModelsPayload // models
	| { commands: CommandInfo[] } // commands
	| Record<string, never>; // everything else

/** Session -> hub. */
export type SessionToHub =
	| {
			t: "register";
			/** Wire version of this local protocol; hub rejects unknown versions with `bye`. */
			v: 1;
			session: SessionSummary;
			/** Set when this session was spawned by the hub (env PHI_REMOTE_SPAWN_ID). */
			spawnId?: string;
	  }
	| { t: "upsert"; session: SessionSummary }
	/**
	 * Register or update a subagent child session served by this connection (`kind: "subagent"`,
	 * `parentSessionId` = the registered session). Its events use `event` with the child's id.
	 */
	| { t: "child.upsert"; session: SessionSummary }
	| { t: "child.remove"; sessionId: string }
	| { t: "event"; sessionId: string; event: LiveEvent }
	| { t: "reply"; re: string; ok: true; data?: SessionOpReplyData }
	| { t: "reply"; re: string; ok: false; error: RemoteError };

/** Hub -> session. */
export type HubToSession =
	| { t: "registered"; hubId: string }
	| ({ t: "req"; id: string; sessionId?: string } & SessionOp)
	| { t: "bye"; reason: string };

/**
 * Local control (CLI / `/remote` command) -> hub, on the same socket. A control connection sends
 * `ctl` frames instead of `register`. Replies: `{ t: "ctl.reply", re, ok, data?, error? }`.
 */
export type ControlOp =
	| { op: "status" }
	| { op: "pair.create" } // -> PairInfo
	| { op: "devices.list" } // -> { devices: DeviceInfo[] }
	| { op: "devices.revoke"; deviceId: string }
	| { op: "shutdown" }
	// --- Session control for local agents (the overseer). Same trust as the rest of hub.sock (0600,
	// this user only), so no device token and no allowed-roots check for spawns.
	| CtlSessionOp;

/**
 * Local-control session operations (overseer). Each mirrors the phone frame of the same name; the
 * reply `data` is the matching `CtlSessionReply` member. Errors use the usual `RemoteError` codes.
 */
export type CtlSessionOp =
	/** -> CtlSessionsData. `subagents: true` also lists subagent child sessions. */
	| { op: "sessions.list"; subagents?: boolean }
	/**
	 * Start a headless `phi --mode rpc` in `cwd` (must exist; no allowed-roots check). Replies once the
	 * child registers -> CtlSpawnData. `name` -> `--name`; `appendSystemPrompt` -> `--append-system-prompt`;
	 * `env` filtered by THREAD_ENV_KEYS / THREAD_ENV_PREFIXES.
	 */
	| {
			op: "session.spawn";
			cwd: string;
			prompt?: string;
			provider?: string;
			modelId?: string;
			thinkingLevel?: string;
			name?: string;
			appendSystemPrompt?: string;
			env?: Record<string, string>;
	  }
	/** -> {} once the session accepted it. A text starting with `/` runs as a slash command. */
	| { op: "session.prompt"; sessionId: string; text: string; mode?: PromptMode }
	| { op: "session.abort"; sessionId: string }
	| { op: "session.setModel"; sessionId: string; provider: string; modelId: string }
	| { op: "session.setThinking"; sessionId: string; level: string }
	/**
	 * End a session. Headless: as from the phone. Interactive: allowed only when the session's
	 * `summary.overseer.sessionId === overseer` (the session shuts itself down; its terminal stays).
	 */
	| { op: "session.close"; sessionId: string; overseer?: string }
	/** Live transcript tail + state + summary -> CtlSnapshotData. */
	| { op: "session.snapshot"; sessionId: string; limit?: number }
	/** Older live transcript items -> { items, hasMore }. */
	| { op: "session.history"; sessionId: string; before: string; limit?: number }
	/** Stored transcript of any session on disk (live or not) -> { items, hasMore }. */
	| { op: "session.transcript"; sessionId: string; before?: string; limit?: number }
	/** Resume a stored session headless (as `session.resume` from the phone) -> CtlSpawnData. */
	| {
			op: "session.resume";
			sessionId: string;
			prompt?: string;
			provider?: string;
			modelId?: string;
			thinkingLevel?: string;
			env?: Record<string, string>;
	  }
	/** An overseer's threads (registry + live) -> OverseerBoardData, as the app's `overseer.board`. */
	| { op: "overseer.board"; sessionId: string };

export interface CtlSessionsData {
	sessions: SessionSummary[];
}

export interface CtlSpawnData {
	sessionId: string;
	cwd: string;
	pid?: number;
	cwdFallback?: true;
}

export interface CtlSnapshotData {
	items: TranscriptItem[];
	hasMore: boolean;
	state: LiveState;
	summary: SessionSummary;
}

export interface PairInfo {
	code: string;
	expiresAt: number;
	hubId: string;
	name: string;
	urls: string[];
	/** phiremote://pair?... deep link (QR payload). */
	link: string;
}

export interface DeviceInfo {
	id: string;
	name: string;
	platform: string;
	createdAt: number;
	lastSeenAt?: number;
	push: boolean;
	connected: boolean;
}

export type ControlToHub = { t: "ctl"; id: string } & ControlOp;
export type HubToControl =
	| { t: "ctl.reply"; re: string; ok: true; data?: unknown }
	| { t: "ctl.reply"; re: string; ok: false; error: RemoteError };
