/**
 * Shared types of the overseer extension: thread records (the registry), watch configuration,
 * monitor events, and the injectable dependencies (hub connection, command runner, clock) that
 * keep every part testable without a real hub, FORCA or tmux.
 */

import type { HubControlOp } from "../../remote/hub/frames.ts";
import type { PhiInvocation } from "../../remote/hub/spawn.ts";
import type { SessionStatus } from "../../remote/protocol.ts";

export const OVERSEER_EVENT_TYPE = "overseer_event";
export const OVERSEER_BOARD_ENTRY = "overseer-board";
export const STATUS_KEY = "overseer";

export const BACKEND_CHOICES = ["auto", "forca", "tmux", "headless"] as const;
export type BackendChoice = (typeof BACKEND_CHOICES)[number];
export type LaunchBackend = Exclude<BackendChoice, "auto">;
/** `external`: an adopted interactive session whose terminal this overseer did not create. */
export type ThreadBackend = LaunchBackend | "external";
export type ThreadState = "running" | "exited" | "closed";

export const ACTIONS = [
	"spawn",
	"list",
	"read",
	"send",
	"abort",
	"model",
	"close",
	"resume",
	"adopt",
	"watch",
] as const;
export type OverseerAction = (typeof ACTIONS)[number];

export interface WatchConfig {
	/** Wake the overseer when the thread goes working → idle, with its last reply. */
	onIdle: boolean;
	/** Wake once when the thread works without activity for this long. 0 disables. */
	stallMinutes: number;
	/** Heartbeat digest interval while any thread works. 0 disables. */
	heartbeatMinutes: number;
}

export const DEFAULT_WATCH: WatchConfig = { onIdle: true, stallMinutes: 15, heartbeatMinutes: 0 };

export interface SubagentModels {
	default?: string;
	allow?: string[];
}

/** One thread of this overseer, as persisted in `<agentDir>/overseer/<overseerSessionId>.json`. */
export interface ThreadRecord {
	name: string;
	sessionId: string;
	backend: ThreadBackend;
	/** Watched, not started by this overseer (`adopt`). */
	adopted?: boolean;
	cwd: string;
	/** `provider/id`. */
	model?: string;
	thinking?: string;
	/** FORCA terminal handle (`term_…`). */
	terminal?: string;
	tmuxSession?: string;
	/** Launcher script (forca / tmux). */
	launcher?: string;
	pid?: number;
	createdAt: number;
	watch: WatchConfig;
	state: ThreadState;
	/** Seen in the hub at least once (a thread that never registered is never reported exited). */
	registered: boolean;
	lastStatus?: SessionStatus;
	lastActivityAt?: number;
	lastSeenAt?: number;
	lastText?: string;
	lastError?: string;
	costUsd?: number;
	contextPercent?: number;
	subagentModels?: SubagentModels;
	/** Monitor bookkeeping, persisted so a restart does not repeat a notification. */
	notifiedError?: string;
	notifiedStallAt?: number;
	/**
	 * `provider/id[:thinking]` the current turn started on, recorded when the turn is first seen
	 * working (or when `model` switches a working thread); labels that turn's idle/error event, so a
	 * mid-turn switch does not relabel it. Cleared once the thread is seen not working.
	 */
	turnModel?: string;
	/** Set when this overseer sent a message (or resumed with a prompt); cleared by the next turn seen. */
	awaitingReplySince?: number;
	exitedAt?: number;
	closedAt?: number;
}

export type OverseerEventKind = "idle" | "error" | "stalled" | "exited" | "heartbeat";

export interface OverseerEvent {
	kind: OverseerEventKind;
	/** Thread name; "" for a heartbeat digest. */
	thread: string;
	sessionId?: string;
	at: number;
	/** Body: last reply (idle), error text (error), board (heartbeat), detail line (stalled, exited). */
	text?: string;
	/** One-line summary shown after the header ("idle after 4m", "no activity for 16m"). */
	summary?: string;
}

export interface OverseerEventDetails {
	events: OverseerEvent[];
}

/** The part of `ControlClient` the overseer uses (tests pass a fake). */
export interface CtlClientLike {
	request<T = unknown>(op: HubControlOp, timeoutMs?: number): Promise<T>;
	close(): void;
}

export interface RunOptions {
	timeoutMs?: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface RunResult {
	/** Exit code; null when the process could not start or was killed. */
	code: number | null;
	stdout: string;
	stderr: string;
	/** Set when the process could not start (ENOENT) or timed out. */
	error?: string;
}

/** Runs a program with an argument array (never a shell). Never rejects. */
export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export interface OverseerDeps {
	/** Connect to the hub control socket; rejects when no hub listens. */
	connect: () => Promise<CtlClientLike>;
	/** Start the hub the way `/remote` does and wait for its socket. */
	startHub: () => Promise<"running" | "started" | "failed">;
	run: Runner;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	env: NodeJS.ProcessEnv;
	agentDir: () => string;
	newSessionId: () => string;
	invocation: () => PhiInvocation;
	which: (command: string) => string | undefined;
	pidAlive: (pid: number) => boolean;
	/** Hub log path for error messages. */
	hubLog: () => string;
}
