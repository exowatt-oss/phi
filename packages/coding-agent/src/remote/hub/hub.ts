/**
 * phi remote hub: one process per user per machine.
 *
 * - Local side: a unix socket (`hub.sock`, NDJSON). Each phi session connects, `register`s its
 *   SessionSummary, streams `upsert`/`event` frames and answers the `req`s the hub forwards.
 *   Local control clients (the CLI, the in-session `/remote` command) send `ctl` frames instead.
 * - Network side: plain HTTP + WebSocket (protocol v1, docs/remote-protocol.md) on 127.0.0.1 and
 *   every Tailscale IPv4 (or `--bind`). Phones pair with one-time codes, then authenticate each
 *   socket with a device token in the first `hello` frame.
 * - Headless sessions (`session.spawn`) and APNs pushes on working → idle.
 */

import { randomBytes } from "node:crypto";
import {
	accessSync,
	chmodSync,
	closeSync,
	constants as fsConstants,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { connect as connectIpc, createServer as createIpcServer, type Socket } from "node:net";
import { homedir, type NetworkInterfaceInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir, getSessionsDir, VERSION } from "../../config.ts";
import { headlessLogPath, hubIdPath, hubJsonPath, hubLockPath, hubLogPath, hubSocketPath } from "../paths.ts";
import {
	type CommandInfo,
	type ControlToHub,
	type CtlSessionsData,
	type CtlSnapshotData,
	type CtlSpawnData,
	type DeviceInfo,
	type HubToControl,
	type HubToSession,
	type LiveEvent,
	type OverseerBoardData,
	type PairInfo,
	type PastSession,
	type PromptImage,
	type PromptMode,
	REMOTE_DEFAULT_PORT,
	REMOTE_FEATURE_SUBAGENTS,
	REMOTE_HOST_FEATURE_HISTORY,
	REMOTE_HOST_FEATURE_OVERSEER,
	REMOTE_PROTOCOL_VERSION,
	type RemoteError,
	type RemoteErrorCode,
	type SessionOp,
	type SessionOpReplyData,
	type SessionStatus,
	type SessionSummary,
	type TranscriptItem,
} from "../protocol.ts";
import { ApnsClient, type PushAlert, type PushSender } from "./apns.ts";
import { ConnLog, formatAddr, formatDuration, logValue, plainIp } from "./conn-log.ts";
import { DeviceStore } from "./devices.ts";
import {
	capLogFile,
	RotatingLog,
	readJsonFile,
	removeFile,
	secureRemoteDir,
	writeJsonFile,
	writePrivateFile,
} from "./files.ts";
import {
	type AppConnectionInfo,
	CLOSE_PROTOCOL_MISMATCH,
	CLOSE_UNAUTHORIZED,
	type HubControlOp,
	type HubFrame,
	type HubStatus,
	type PushTestResult,
} from "./frames.ts";
import {
	decodeCursor,
	type IndexedSession,
	NotASessionError,
	pageAfter,
	readStoredTranscript,
	SessionHistoryIndex,
	UnknownItemError,
} from "./history.ts";
import { createHttpLiteServer, type HttpHead, type HttpReply, type HttpRequest } from "./http.ts";
import { type ModelCatalog, PhiModelCatalog } from "./models.ts";
import { attachNdjsonReader, ndjson } from "./ndjson.ts";
import { displayHostname, lookupMagicDnsName, pairingUrls, tailscaleIPv4s } from "./network.ts";
import { boardData, boardThreads, countThreads, OverseerIndex, registryLink } from "./overseers.ts";
import { PairCodes, RateLimiter } from "./pairing.ts";
import { mergeRecentCwds, readRecentSessionCwds } from "./recent-cwds.ts";
import {
	filterThreadEnv,
	type HeadlessChild,
	HeadlessManager,
	isSafeModelArg,
	isSpawnThinkingLevel,
	type PhiInvocation,
	resolveResumeCwd,
	resolveSpawnCwd,
	SPAWN_NAME_MAX,
	SPAWN_SYSTEM_PROMPT_MAX,
	type SpawnArgsOptions,
	type SpawnModelOptions,
	validateSpawnCwd,
} from "./spawn.ts";
import { acceptWebSocket, CLOSE_GOING_AWAY, type WsConnection } from "./ws.ts";

export interface HubOptions {
	/** HTTP port; 0 picks an ephemeral port (tests). Default 7717. */
	port?: number;
	/** Explicit bind addresses. Omitted: 127.0.0.1 + every Tailscale IPv4, re-scanned. */
	binds?: string[];
	/** Extra roots `session.spawn` may use besides $HOME. */
	allowRoots?: string[];
	home?: string;
	hostname?: string;
	version?: string;
	/** Directory with persisted sessions, for `cwds.recent` and session history. */
	sessionsDir?: string;
	/**
	 * Overseer registry files, for overseer summaries and `overseer.board`. Default: `overseer` next to
	 * `sessionsDir` when that is set, else `<agentDir>/overseer`.
	 */
	overseerDir?: string;
	/** Fallback poll of `overseerDir` besides fs.watch (default 5 s). */
	overseerPollMs?: number;
	/** `sessions.past` refreshes the history index first when it is older than this (default 2 s). */
	historyMaxAgeMs?: number;
	/**
	 * `session.resume` of a session that is not live waits until the hub has been up this long
	 * (default 10 s): sessions that ran before the hub (re)started re-register within a few seconds,
	 * and resuming one of them before it does would start a second process on its file.
	 */
	resumeLiveGraceMs?: number;
	pingIntervalMs?: number;
	helloTimeoutMs?: number;
	requestTimeoutMs?: number;
	spawnTimeoutMs?: number;
	upsertThrottleMs?: number;
	pushDebounceMs?: number;
	rescanIntervalMs?: number;
	pairRateLimit?: { limit: number; windowMs: number };
	/** Pairing code lifetime (default 10 minutes). */
	pairCodeTtlMs?: number;
	/**
	 * HTTP connection timeouts (slowloris): `idleMs` closes a connection that sends nothing for that
	 * long (default 15 s), `headersMs` bounds the time to send the request headers (default 10 s),
	 * `requestMs` the whole request (default 15 s).
	 */
	httpTimeouts?: { idleMs?: number; headersMs?: number; requestMs?: number };
	/** WebSocket connections allowed to wait for their `hello` at once (default 32). */
	maxPendingAuth?: number;
	/** Push transport; defaults to APNs per `apns.json`. */
	pushSender?: PushSender;
	/** Whether push is configured; defaults to "apns.json is valid". */
	pushEnabled?: () => boolean;
	/** Extra time a pending spawn gets per other pending spawn (default 1 s; see spawnSession). */
	spawnGracePerPendingMs?: number;
	/** Command used for headless children (tests override). */
	invocation?: PhiInvocation;
	/** Models for `models.list` without a session and spawn validation (default: phi's registry). */
	modelCatalog?: ModelCatalog;
	magicDnsLookup?: () => Promise<string | undefined>;
	/** Network interfaces for the default binds (tests); defaults to `os.networkInterfaces()`. */
	interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
	/** Called when a local client asks the hub to shut down. Default: `stop()`. */
	onShutdownRequested?: () => void;
	log?: (line: string) => void;
	/** App-connection log lines of one kind from one IP within this window are folded (default 1 s). */
	connLogWindowMs?: number;
}

export class HubAlreadyRunningError extends Error {
	readonly pid: number | undefined;
	constructor(pid: number | undefined) {
		super(`phi remote hub is already running${pid ? ` (pid ${pid})` : ""}`);
		this.pid = pid;
	}
}

interface PendingRequest {
	callback: (error: RemoteError | undefined, data: SessionOpReplyData | undefined) => void;
	timer: NodeJS.Timeout;
}

interface SessionConn {
	socket: Socket;
	sessionId?: string;
	/** Set when this connection is a child the hub spawned. */
	headless?: HeadlessChild;
	pending: Map<string, PendingRequest>;
	/** Subagent sessions this connection serves (`child.upsert`), all owned by `sessionId`. */
	children: Set<string>;
}

interface SessionEntry {
	conn: SessionConn;
	summary: SessionSummary;
	status: SessionStatus;
	lastAssistant?: { text: string; error?: string };
	lastUpsertAt: number;
	upsertTimer?: NodeJS.Timeout;
	pushTimer?: NodeJS.Timeout;
	/** An app aborted the current run; the coming working → idle must not push. */
	abortRequested?: boolean;
	/** `threadCounts` of the last `session.upsert` broadcast ("" when it was not an overseer). */
	overseerKey?: string;
}

interface AppClient {
	ws: WsConnection;
	/** Per-hub sequence number, ties the log lines of one connection together. */
	conn: number;
	/** Epoch ms of the upgrade. */
	acceptedAt: number;
	/** `performance.now()` at the upgrade, for the time to `welcome`. */
	acceptedMono: number;
	/** `dev_x "name"` once authenticated; kept after a revoke so the close line still names it. */
	label?: string;
	deviceName?: string;
	/** A hello failure was logged; the close line would only repeat it. */
	failLogged?: boolean;
	deviceId?: string;
	/** `?v=` query parameter of the upgrade request, if any. */
	protocolParam?: string;
	subs: Map<string, "pending" | "active">;
	focus: string | null;
	helloTimer?: NodeJS.Timeout;
	/** `hello.features`: optional protocol additions this app understands. */
	features: Set<string>;
}

/** What a spawn or resume settles with. */
interface SpawnSettled {
	sessionId: string;
	/** Folder fields of an app's `ack` (resumes only; a fresh spawn's ack has none). */
	ackCwd?: AckCwd;
	/** The folder the session runs in. */
	cwd: string;
	pid?: number;
}

/**
 * Who is answered when a spawn or resume settles: an app request (`ack`) or a control request
 * (`ctl.reply`). Called once, with an error or with the settled session.
 */
type Waiter = (error: RemoteError | undefined, settled?: SpawnSettled) => void;

/** The answer to one control-wire request (`ctl.reply`); only the first call is sent. */
interface CtlReply {
	ok(data?: unknown): void;
	fail(error: RemoteError): void;
}

interface PendingSpawn {
	/** Requests acked when the child registers (several when resumes of one session joined). */
	waiters: Waiter[];
	/** Sent in order once the child registers. */
	prompts: string[];
	child: HeadlessChild;
	timer: NodeJS.Timeout;
	/** `session.resume`: the session this child continues. */
	resumeOf?: string;
	/** `session.resume`: the folder it runs in, for the ack. */
	ackCwd?: AckCwd;
}

/** `session.resume` ack fields: the folder used, and whether it differs from the recorded one. */
interface AckCwd {
	cwd: string;
	cwdFallback?: true;
}

/** A `session.resume` of a session that is not live, from the request until its child registers. */
interface PendingResume {
	sessionId: string;
	/** Shared with the PendingSpawn once the child is started, so later resumes can still join. */
	waiters: Waiter[];
	prompts: string[];
	spawnId?: string;
	/** Ends the startup-grace wait early (the session registered). */
	wake?: () => void;
}

const ACK_FRAMES = new Set([
	"session.prompt",
	"session.abort",
	"session.setModel",
	"session.setThinking",
	"session.spawn",
	"session.resume",
	"session.close",
	"push.register",
	"push.unregister",
]);

/** Subagent sessions one session connection may serve (the session side keeps 50). */
const MAX_CHILDREN_PER_SESSION = 64;
const MAX_FEATURES = 32;
const SPAWN_GRACE_PER_PENDING_MS = 1000;
/** Requests a subagent session does not take. */
const SUBAGENT_UNSUPPORTED = new Set([
	"session.close",
	"models.list",
	"session.setModel",
	"session.setThinking",
	"commands.list",
]);
/** `commands.list`: at most this many entries, each description one line of ≤ 160 chars. */
const MAX_COMMANDS = 500;
const MAX_COMMAND_DESCRIPTION = 160;
const COMMAND_SOURCES = new Set(["builtin", "extension", "prompt", "skill"]);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_PAIR_BODY = 16 * 1024;
/** Largest frame accepted before `hello` authenticates the socket (the hello itself is tiny). */
const PRE_AUTH_MAX_MESSAGE = 64 * 1024;
/** Largest frame after `hello` (contract: 12 MiB, prompts may carry images). */
const MAX_MESSAGE = 12 * 1024 * 1024;
const DEFAULT_MAX_PENDING_AUTH = 32;
/** hub.log is copied to hub.log.1 and truncated past this size, checked every 64 KiB logged. */
const HUB_LOG_MAX_BYTES = 5 * 1024 * 1024;
const HUB_LOG_CHECK_BYTES = 64 * 1024;
/**
 * hub.sock listen backlog: a burst of headless children (hundreds spawned at once) connects while
 * the hub is still busy spawning. The kernel clamps it (`somaxconn`: 128 on macOS, 4096 on current
 * Linux); a child refused by a full queue retries with backoff (extensions/remote/link.ts).
 */
const IPC_BACKLOG = 4096;
/** TCP connections per listening address (phones, pairing, probes); far above real use. */
const MAX_HTTP_CONNECTIONS = 256;

type HttpLiteServer = ReturnType<typeof createHttpLiteServer>;
const RECENT_CWDS_CACHE_MS = 30_000;
const MAGIC_DNS_CACHE_MS = 60_000;
/** `sessions.past`: default and largest page. */
const PAST_DEFAULT_LIMIT = 50;
const PAST_MAX_LIMIT = 200;
const PAST_MAX_QUERY = 200;
const HISTORY_MAX_AGE_MS = 2000;
const RESUME_LIVE_GRACE_MS = 10_000;
/** Stored transcripts read at once (each may parse a large part of a big session file). */
const MAX_TRANSCRIPT_READS = 2;

export function buildPairLink(info: { code: string; name: string; hubId: string; urls: readonly string[] }): string {
	const parts = [
		"v=1",
		`code=${encodeURIComponent(info.code)}`,
		`name=${encodeURIComponent(info.name)}`,
		`hubId=${encodeURIComponent(info.hubId)}`,
		...info.urls.map((url) => `url=${encodeURIComponent(url)}`),
	];
	return `phiremote://pair?${parts.join("&")}`;
}

function oneLine(text: unknown, max: number): string {
	if (typeof text !== "string") return "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The ack `cwd` of a live session resumed in place: where it already runs. */
function liveCwd(entry: SessionEntry): AckCwd | undefined {
	return entry.summary.cwd ? { cwd: entry.summary.cwd } : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Path of an HTTP request target, or undefined when it is not origin-form (`/path?query`).
 * Never throws: `new URL()` throws on targets such as `//` or `http://[`, which would otherwise
 * take the hub down from an unauthenticated request.
 */
export function requestTarget(raw: string | undefined): { path: string; query: URLSearchParams } | undefined {
	const target = raw ?? "/";
	if (!target.startsWith("/") || target.startsWith("//")) return undefined;
	const cut = target.search(/[?#]/);
	const path = cut === -1 ? target : target.slice(0, cut);
	const rest = cut === -1 ? "" : target.slice(cut + 1);
	const hash = rest.indexOf("#");
	let query: URLSearchParams;
	try {
		query = new URLSearchParams(target[cut] === "?" ? (hash === -1 ? rest : rest.slice(0, hash)) : "");
	} catch {
		query = new URLSearchParams();
	}
	return { path, query };
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Addresses the hub listens on without `--bind`: loopback plus this machine's Tailscale IPv4s
 * (100.64.0.0/10). Never a wildcard, never IPv6, never a LAN address.
 */
export function defaultBindAddresses(ifaces?: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
	return ["127.0.0.1", ...tailscaleIPv4s(ifaces)];
}

/** Probe `hub.sock`: the running hub's status, or undefined if nothing answers. */
export function probeHub(socketPath = hubSocketPath(), timeoutMs = 1000): Promise<HubStatus | undefined> {
	return new Promise((resolve) => {
		const socket = connectIpc(socketPath);
		let done = false;
		const finish = (value: HubStatus | undefined) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		socket.on("error", () => finish(undefined));
		socket.on("connect", () => socket.write(ndjson({ t: "ctl", id: "probe", op: "status" })));
		attachNdjsonReader(socket, (msg) => {
			if (isObject(msg) && msg.t === "ctl.reply" && msg.re === "probe") {
				finish(msg.ok ? (msg.data as HubStatus) : undefined);
			}
		});
		socket.on("close", () => finish(undefined));
	});
}

export class Hub {
	readonly hostname: string;
	readonly version: string;
	hubId = "";
	startedAt = 0;
	port: number;

	private readonly opts: HubOptions;
	private readonly explicitBinds: string[] | undefined;
	private readonly allowRoots: string[];
	private readonly home: string;
	private readonly servers = new Map<string, HttpLiteServer>();
	private ipcServer: ReturnType<typeof createIpcServer> | undefined;
	private socketPath = "";
	private readonly sessionConns = new Set<SessionConn>();
	private readonly ctlSockets = new Set<Socket>();
	private readonly sessions = new Map<string, SessionEntry>();
	private readonly clients = new Set<AppClient>();
	private devices!: DeviceStore;
	private readonly pairCodes: PairCodes;
	private readonly pairLimiter: RateLimiter;
	private headless!: HeadlessManager;
	private readonly pendingSpawns = new Map<string, PendingSpawn>();
	/** `session.resume`s in progress by session id; a second resume of one session joins the first. */
	private readonly resumes = new Map<string, PendingResume>();
	private readonly history: SessionHistoryIndex;
	private readonly overseers: OverseerIndex;
	private transcriptReads = 0;
	private readonly transcriptQueue: (() => void)[] = [];
	private readonly spawnGraceMs: number;
	private readonly apns: ApnsClient | undefined;
	private readonly pushSender: PushSender;
	private readonly pushEnabled: () => boolean;
	private readonly models: ModelCatalog;
	private rescanTimer: NodeJS.Timeout | undefined;
	private recentCwdsCache: { at: number; cwds: string[] } | undefined;
	private magicDnsCache: { at: number; name: string | undefined } | undefined;
	private reqSeq = 0;
	private lockHeld = false;
	private stopping: Promise<void> | undefined;
	private readonly log: (line: string) => void;
	private readonly connLog: ConnLog;
	private connSeq = 0;

	constructor(options: HubOptions = {}) {
		this.opts = options;
		this.port = options.port ?? REMOTE_DEFAULT_PORT;
		this.explicitBinds = options.binds && options.binds.length > 0 ? [...new Set(options.binds)] : undefined;
		this.home = options.home ?? homedir();
		this.allowRoots = [this.home, ...(options.allowRoots ?? [])];
		this.hostname = options.hostname ?? displayHostname();
		this.version = options.version ?? VERSION;
		this.pairCodes = new PairCodes(options.pairCodeTtlMs);
		this.spawnGraceMs = options.spawnGracePerPendingMs ?? SPAWN_GRACE_PER_PENDING_MS;
		this.models = options.modelCatalog ?? new PhiModelCatalog(this.home);
		this.history = new SessionHistoryIndex({
			sessionsDir: options.sessionsDir ?? getSessionsDir(),
			log: (line) => this.log(line),
		});
		this.overseers = new OverseerIndex({
			// Next to the sessions folder (both live in the agent dir; tests point sessionsDir at a temp dir).
			dir:
				options.overseerDir ??
				(options.sessionsDir ? join(dirname(options.sessionsDir), "overseer") : join(getAgentDir(), "overseer")),
			log: (line) => this.log(line),
		});
		this.pairLimiter = new RateLimiter(options.pairRateLimit?.limit ?? 5, options.pairRateLimit?.windowMs ?? 60_000);
		if (options.pushSender) {
			this.apns = undefined;
			this.pushSender = options.pushSender;
			this.pushEnabled = options.pushEnabled ?? (() => true);
		} else {
			const apns = new ApnsClient();
			this.apns = apns;
			this.pushSender = apns.send;
			this.pushEnabled = options.pushEnabled ?? (() => apns.config() !== undefined);
		}
		if (options.log) {
			this.log = options.log;
		} else {
			// stderr is hub.log under launchd / systemd / `phi remote start`; keep it bounded.
			let sinceCheck = Number.POSITIVE_INFINITY;
			this.log = (line: string) => {
				const text = `[${new Date().toISOString()}] ${line}\n`;
				if (sinceCheck > HUB_LOG_CHECK_BYTES) {
					sinceCheck = 0;
					capLogFile(hubLogPath(), HUB_LOG_MAX_BYTES);
				}
				sinceCheck += text.length;
				process.stderr.write(text);
			};
		}
		this.connLog = new ConnLog((line) => this.log(line), { windowMs: options.connLogWindowMs });
	}

	/** Addresses currently listening. */
	get binds(): string[] {
		return [...this.servers.keys()];
	}

	// ----------------------------------------------------------------------------------------
	// Lifecycle
	// ----------------------------------------------------------------------------------------

	async start(): Promise<void> {
		secureRemoteDir();
		this.socketPath = hubSocketPath();
		this.devices = new DeviceStore();
		this.headless = new HeadlessManager({
			invocation: this.opts.invocation,
			log: new RotatingLog(headlessLogPath()),
			onExit: (child) => this.onHeadlessExit(child),
		});
		this.hubId = this.loadHubId();

		await this.listenIpc();
		try {
			const initial = this.explicitBinds ?? defaultBindAddresses(this.opts.interfaces?.());
			for (const address of initial) {
				const ok = await this.bind(address);
				if (!ok && (this.explicitBinds || address === "127.0.0.1")) {
					throw new Error(`could not listen on ${address}:${this.port}`);
				}
			}
		} catch (error) {
			await this.closeServers();
			this.releaseLock();
			throw error;
		}
		this.startedAt = Date.now();
		this.writeHubJson();
		// Warm the session history index in the background; `sessions.past` answers with what it has
		// (and `indexing: true`) until the first build is done.
		this.history
			.refresh()
			.catch((error: unknown) =>
				this.log(`history index failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		// Overseer registry files: a change re-publishes that overseer's summary (threadCounts).
		this.overseers.watch(
			(ids) => {
				for (const id of ids) this.syncOverseer(id);
			},
			{ pollMs: this.opts.overseerPollMs },
		);
		if (!this.explicitBinds) {
			this.rescanTimer = setInterval(() => void this.rescan(), this.opts.rescanIntervalMs ?? 30_000);
			this.rescanTimer.unref?.();
		}
		this.log(`hub ${this.hubId} listening on ${this.binds.map((b) => `${b}:${this.port}`).join(", ")}`);
	}

	stop(): Promise<void> {
		this.stopping ??= this.doStop();
		return this.stopping;
	}

	/**
	 * Synchronous last resort when the process is going away without `stop()` (uncaught error,
	 * second Ctrl-C, `process.exit`): SIGTERM every headless child.
	 */
	killChildrenSync(): void {
		try {
			this.headless?.killAllSync();
		} catch {
			// exiting anyway
		}
	}

	private async doStop(): Promise<void> {
		if (this.rescanTimer) clearInterval(this.rescanTimer);
		const shuttingDown: RemoteError = { code: "internal", message: "hub is shutting down" };
		for (const pending of this.pendingSpawns.values()) {
			clearTimeout(pending.timer);
			this.settleWaiters(pending.waiters, shuttingDown);
		}
		this.pendingSpawns.clear();
		for (const resume of this.resumes.values()) {
			this.settleWaiters(resume.waiters, shuttingDown);
			resume.wake?.();
		}
		this.resumes.clear();
		const historyClosed = this.history.close();
		const overseersClosed = this.overseers.close();
		for (const client of this.clients) client.ws.close(CLOSE_GOING_AWAY, "hub shutting down");
		for (const entry of this.sessions.values()) {
			if (entry.upsertTimer) clearTimeout(entry.upsertTimer);
			if (entry.pushTimer) clearTimeout(entry.pushTimer);
		}
		for (const conn of this.sessionConns) {
			this.failPending(conn, "hub is shutting down");
			conn.socket.end();
		}
		for (const socket of this.ctlSockets) socket.end();
		await historyClosed;
		await overseersClosed;
		await this.headless?.stopAll();
		await this.closeServers();
		for (const client of this.clients) client.ws.terminate();
		for (const conn of this.sessionConns) conn.socket.destroy();
		this.apns?.close();
		const info = readJsonFile<{ pid?: number }>(hubJsonPath());
		if (info?.pid === process.pid) removeFile(hubJsonPath());
		this.releaseLock();
		this.log("hub stopped");
	}

	private async closeServers(): Promise<void> {
		const closing: Promise<void>[] = [];
		for (const server of this.servers.values()) {
			closing.push(new Promise((resolve) => server.close(() => resolve())));
			server.closeAll();
		}
		this.servers.clear();
		if (this.ipcServer) {
			const ipc = this.ipcServer;
			this.ipcServer = undefined;
			closing.push(new Promise((resolve) => ipc.close(() => resolve())));
			try {
				unlinkSync(this.socketPath);
			} catch {
				// already gone
			}
		}
		await Promise.all(closing);
	}

	private loadHubId(): string {
		try {
			const existing = readFileSync(hubIdPath(), "utf8").trim();
			if (/^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
		} catch {
			// first run
		}
		const id = randomBytes(8).toString("hex");
		writePrivateFile(hubIdPath(), `${id}\n`);
		return id;
	}

	private writeHubJson(): void {
		writeJsonFile(hubJsonPath(), {
			hubId: this.hubId,
			pid: process.pid,
			port: this.port,
			binds: this.binds,
			startedAt: this.startedAt,
			version: this.version,
		});
	}

	/**
	 * Take `hub.lock` (O_EXCL, holds our pid) for the hub's lifetime. A lock whose holder answers on
	 * the socket within a few seconds means a hub is running (or just starting); a lock whose holder
	 * is dead, or alive but silent (pid reused after a reboot), is stale and taken over.
	 */
	private async acquireLock(): Promise<void> {
		const path = hubLockPath();
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const fd = openSync(path, "wx", 0o600);
				writeSync(fd, `${process.pid}\n`);
				closeSync(fd);
				this.lockHeld = true;
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			let holder = 0;
			try {
				holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0;
			} catch {
				holder = 0;
			}
			const deadline = Date.now() + 5000;
			while (holder && isProcessAlive(holder) && Date.now() < deadline) {
				const running = await probeHub(this.socketPath, 500);
				if (running) throw new HubAlreadyRunningError(running.pid);
				await new Promise((r) => setTimeout(r, 200));
			}
			const running = await probeHub(this.socketPath, 500);
			if (running) throw new HubAlreadyRunningError(running.pid);
			removeFile(path);
		}
		throw new Error(`could not take ${path}`);
	}

	private releaseLock(): void {
		if (!this.lockHeld) return;
		this.lockHeld = false;
		try {
			if (Number.parseInt(readFileSync(hubLockPath(), "utf8").trim(), 10) === process.pid) removeFile(hubLockPath());
		} catch {
			// gone
		}
	}

	private async listenIpc(): Promise<void> {
		const existing = await probeHub(this.socketPath);
		if (existing) throw new HubAlreadyRunningError(existing.pid);
		await this.acquireLock();
		try {
			unlinkSync(this.socketPath); // stale socket from a crashed hub
		} catch {
			// none
		}
		const server = createIpcServer((socket) => this.onIpcConnection(socket));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ path: this.socketPath, backlog: IPC_BACKLOG }, () => {
				server.off("error", reject);
				resolve();
			});
		}).catch(async (error: NodeJS.ErrnoException) => {
			this.releaseLock();
			if (error.code === "EADDRINUSE") {
				const other = await probeHub(this.socketPath);
				throw new HubAlreadyRunningError(other?.pid);
			}
			throw error;
		});
		server.on("error", (error) => this.log(`ipc server error: ${error.message}`));
		try {
			chmodSync(this.socketPath, 0o600);
		} catch {
			// directory is 0700 anyway
		}
		this.ipcServer = server;
	}

	private async bind(address: string): Promise<boolean> {
		if (this.servers.has(address)) return true;
		const timeouts = this.opts.httpTimeouts ?? {};
		const server = createHttpLiteServer({
			onRequest: (request, reply) => this.onHttpRequest(request, reply),
			onUpgrade: (head, socket, rest) => this.onUpgrade(head, socket, rest),
			onError: (error) => this.log(`http request failed: ${error instanceof Error ? error.message : String(error)}`),
			// Slowloris: the head must arrive within headersMs, the whole request within requestMs, and
			// a connection may not sit silent for idleMs. Upgraded WebSockets rely on ping/pong instead.
			headersTimeoutMs: timeouts.headersMs ?? 10_000,
			requestTimeoutMs: timeouts.requestMs ?? 15_000,
			idleTimeoutMs: timeouts.idleMs ?? 15_000,
			maxHeaderBytes: 16 * 1024,
			maxBodyBytes: MAX_PAIR_BODY,
			maxConnections: MAX_HTTP_CONNECTIONS,
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(this.port, address, () => {
					server.off("error", reject);
					resolve();
				});
			});
		} catch (error) {
			this.log(`cannot listen on ${address}:${this.port}: ${(error as Error).message}`);
			return false;
		}
		server.on("error", (error) => this.log(`http server ${address} error: ${error.message}`));
		const actual = server.address();
		if (this.port === 0 && actual && typeof actual === "object") this.port = actual.port;
		this.servers.set(address, server);
		return true;
	}

	/** Bind Tailscale addresses that appeared since the last scan (Tailscale may start after us). */
	private async rescan(): Promise<void> {
		if (this.explicitBinds || this.stopping) return;
		const current = new Set(defaultBindAddresses(this.opts.interfaces?.()));
		let changed = false;
		for (const address of current) {
			if (!this.servers.has(address) && (await this.bind(address))) {
				this.log(`now also listening on ${address}:${this.port}`);
				changed = true;
			}
		}
		for (const [address, server] of this.servers) {
			if (!current.has(address)) {
				server.close();
				server.closeAll();
				this.servers.delete(address);
				this.log(`stopped listening on vanished address ${address}`);
				changed = true;
			}
		}
		if (changed) this.writeHubJson();
	}

	// ----------------------------------------------------------------------------------------
	// HTTP: /v1/info, /v1/pair, /v1/ws
	// ----------------------------------------------------------------------------------------

	private onHttpRequest(request: HttpRequest, reply: HttpReply): void {
		const path = requestTarget(request.url)?.path;
		const method = request.method;
		if (path === "/v1/info" && (method === "GET" || method === "HEAD")) {
			reply.json(200, {
				name: this.hostname,
				hubId: this.hubId,
				hubVersion: this.version,
				protocol: REMOTE_PROTOCOL_VERSION,
			});
			return;
		}
		if (path === "/v1/pair") {
			if (method !== "POST") {
				reply.json(405, { error: "method_not_allowed" });
				return;
			}
			this.handlePair(request, reply);
			return;
		}
		if (path === "/v1/ws") {
			reply.json(426, { error: "upgrade_required" });
			return;
		}
		reply.json(404, { error: "not_found" });
	}

	private handlePair(request: HttpRequest, reply: HttpReply): void {
		const ip = request.remoteAddress;
		// Every attempt counts, malformed ones included (contract clarification 5).
		if (!this.pairLimiter.take(ip)) {
			reply.json(429, { error: "rate_limited" });
			return;
		}
		let body: Record<string, unknown>;
		try {
			if (!request.body) throw new Error("no body"); // too large (> 16 KiB) or chunked
			const parsed = JSON.parse(request.body.toString("utf8")) as unknown;
			if (!isObject(parsed) || typeof parsed.code !== "string") throw new Error("no code");
			body = parsed;
		} catch {
			reply.json(400, { error: "bad_request" });
			return;
		}
		if (!this.pairCodes.redeem(body.code)) {
			reply.json(401, { error: "invalid_code" });
			return;
		}
		const name = oneLine(str(body.deviceName) ?? "", 80) || "iPhone";
		const platform = oneLine(str(body.platform) ?? "", 20) || "ios";
		const { device, token } = this.devices.add(name, platform);
		this.log(`paired device "${device.name}" (${device.id}) from ${ip}`);
		reply.json(200, { deviceId: device.id, token, hubId: this.hubId, name: this.hostname });
	}

	private onUpgrade(head: HttpHead, socket: Socket, rest: Buffer): void {
		socket.on("error", () => {});
		try {
			this.upgrade(head, socket, rest);
		} catch (error) {
			this.log(`websocket upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
			socket.destroy();
		}
	}

	private upgrade(req: HttpHead, socket: Socket, head: Buffer): void {
		const target = requestTarget(req.url);
		const ip = plainIp(socket.remoteAddress);
		const from = formatAddr(socket.remoteAddress, socket.remotePort);
		const refuse = (status: string, why: string) => {
			this.connLog.line("fail", ip, `app upgrade refused from ${from}: ${status} (${why})`);
			socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			setTimeout(() => socket.destroy(), 2000).unref();
		};
		if (target?.path !== "/v1/ws") {
			refuse("404 Not Found", "not /v1/ws");
			return;
		}
		let pendingAuth = 0;
		for (const c of this.clients) if (!c.deviceId) pendingAuth++;
		if (pendingAuth >= (this.opts.maxPendingAuth ?? DEFAULT_MAX_PENDING_AUTH)) {
			// Unauthenticated sockets hold memory until their hello deadline; cap how many may wait.
			refuse("503 Service Unavailable", `${pendingAuth} sockets already waiting for hello`);
			return;
		}
		const ws = acceptWebSocket(req, socket, head, {
			pingIntervalMs: this.opts.pingIntervalMs ?? 20_000,
			maxMessageBytes: PRE_AUTH_MAX_MESSAGE,
		});
		if (!ws) {
			this.connLog.line("fail", ip, `app upgrade refused from ${from}: bad WebSocket handshake`);
			return;
		}
		const client: AppClient = {
			ws,
			conn: ++this.connSeq,
			acceptedAt: Date.now(),
			acceptedMono: performance.now(),
			protocolParam: target.query.get("v") ?? target.query.get("protocol") ?? undefined,
			subs: new Map(),
			focus: null,
			features: new Set(),
		};
		this.clients.add(client);
		this.connLog.line(
			"connect",
			ip,
			`app #${client.conn} connected from ${from} on ${formatAddr(ws.localAddress, ws.localPort)}`,
		);
		const helloTimeoutMs = this.opts.helloTimeoutMs ?? 5000;
		client.helloTimer = setTimeout(() => {
			if (!client.deviceId)
				this.failHello(client, CLOSE_UNAUTHORIZED, "hello required", `no hello in ${helloTimeoutMs}ms`);
		}, helloTimeoutMs);
		ws.on("message", (data) => this.onClientMessage(client, data));
		ws.on("missedPong", (missed, max) => {
			this.connLog.line(
				"pong",
				ip,
				`app #${client.conn} missed pong ${missed}/${max}${client.label ? ` (${client.label})` : ""} from ${from}, last pong ${ws.lastPongAt ? `${formatDuration(Date.now() - ws.lastPongAt)} ago` : "never"}`,
			);
		});
		ws.on("close", (code, reason) => {
			if (client.helloTimer) clearTimeout(client.helloTimer);
			this.clients.delete(client);
			if (!client.failLogged) {
				const who = client.label ? client.label : `before hello, from ${from}`;
				this.connLog.line(
					"close",
					ip,
					`app #${client.conn} closed by ${ws.closedBy ?? "?"}: ${who}, code ${code}${reason ? ` "${logValue(reason, 80)}"` : ""}, after ${formatDuration(Date.now() - client.acceptedAt)}`,
				);
			}
			if (client.deviceId && !this.stopping) {
				const now = Date.now();
				try {
					this.devices.update(client.deviceId, (d) => {
						d.lastSeenAt = now;
					});
				} catch (error) {
					this.log(`could not save devices.json: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		});
	}

	// ----------------------------------------------------------------------------------------
	// WebSocket clients (phones)
	// ----------------------------------------------------------------------------------------

	private send(client: AppClient, frame: HubFrame): void {
		client.ws.send(JSON.stringify(frame));
	}

	private sendError(client: AppClient, re: string | undefined, code: RemoteErrorCode, message: string): void {
		this.send(client, { t: "error", ...(re !== undefined ? { re } : {}), code, message });
	}

	private sendAck(client: AppClient, re: string, error?: RemoteError, sessionId?: string, cwd?: AckCwd): void {
		this.send(client, {
			t: "ack",
			re,
			ok: !error,
			...(error ? { error } : {}),
			...(sessionId ? { sessionId } : {}),
			...(!error && cwd ? cwd : {}),
		});
	}

	/** Reply to a failed request in the shape its frame type expects (`ack` or `error`). */
	private fail(client: AppClient, t: string, re: string | undefined, error: RemoteError): void {
		if (ACK_FRAMES.has(t) && re !== undefined) this.sendAck(client, re, error);
		else this.sendError(client, re, error.code, error.message);
	}

	private broadcast(frame: HubFrame): void {
		const text = JSON.stringify(frame);
		for (const client of this.clients) if (client.deviceId) client.ws.send(text);
	}

	/** Whether `client` may see `summary`: subagent sessions only reach apps that asked for them. */
	private visibleTo(client: AppClient, summary: SessionSummary): boolean {
		return summary.kind !== "subagent" || client.features.has(REMOTE_FEATURE_SUBAGENTS);
	}

	/** `session.upsert` / `session.remove` of `summary`, to the apps allowed to see it. */
	private broadcastSession(summary: SessionSummary, frame: HubFrame): void {
		if (summary.kind !== "subagent") {
			this.broadcast(frame);
			return;
		}
		const text = JSON.stringify(frame);
		for (const client of this.clients) {
			if (client.deviceId && this.visibleTo(client, summary)) client.ws.send(text);
		}
	}

	private onClientMessage(client: AppClient, data: string | Buffer): void {
		let frame: unknown;
		try {
			frame = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
		} catch {
			frame = undefined;
		}
		if (!isObject(frame) || typeof frame.t !== "string") {
			if (!client.deviceId) this.failHello(client, CLOSE_UNAUTHORIZED, "hello required", "first frame is not JSON");
			else {
				const re = isObject(frame) ? str(frame.id) : undefined;
				this.sendError(client, re, "bad_request", "frames must be JSON objects with a `t` field");
			}
			return;
		}
		if (!client.deviceId) {
			if (frame.t !== "hello") {
				this.failHello(client, CLOSE_UNAUTHORIZED, "hello required", `first frame is "${logValue(frame.t)}"`);
				return;
			}
			try {
				this.handleHello(client, frame);
			} catch (error) {
				this.failHello(
					client,
					1011,
					"internal error",
					`internal error: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}
		const t = frame.t;
		const re = str(frame.id);
		try {
			this.dispatch(client, t, re, frame);
		} catch (error) {
			this.fail(client, t, re, {
				code: "internal",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private handleHello(client: AppClient, frame: Record<string, unknown>): void {
		const protocol = frame.protocol;
		if (
			(protocol !== undefined && protocol !== REMOTE_PROTOCOL_VERSION) ||
			(client.protocolParam !== undefined && client.protocolParam !== String(REMOTE_PROTOCOL_VERSION))
		) {
			this.failHello(
				client,
				CLOSE_PROTOCOL_MISMATCH,
				`protocol ${REMOTE_PROTOCOL_VERSION} required`,
				`protocol mismatch (hello ${logValue(protocol)}, url ${logValue(client.protocolParam)})`,
			);
			return;
		}
		const device = this.devices.verify(frame.token);
		if (!device) {
			const why = typeof frame.token === "string" && frame.token ? "unknown device token" : "no token";
			this.failHello(client, CLOSE_UNAUTHORIZED, "unauthorized", why);
			return;
		}
		if (client.helloTimer) clearTimeout(client.helloTimer);
		client.helloTimer = undefined;
		if (Array.isArray(frame.features)) {
			for (const feature of frame.features.slice(0, MAX_FEATURES)) {
				if (typeof feature === "string" && feature.length <= 64) client.features.add(feature);
			}
		}
		client.deviceId = device.id;
		client.ws.setMaxMessageBytes(MAX_MESSAGE);
		const deviceName = isObject(frame.device) ? oneLine(str(frame.device.name) ?? "", 80) : "";
		this.devices.update(device.id, (d) => {
			d.lastSeenAt = Date.now();
			if (deviceName) d.name = deviceName;
		});
		this.send(client, {
			t: "welcome",
			host: {
				name: this.hostname,
				hubId: this.hubId,
				hubVersion: this.version,
				protocol: REMOTE_PROTOCOL_VERSION,
				features: [REMOTE_HOST_FEATURE_HISTORY, REMOTE_HOST_FEATURE_OVERSEER],
			},
			deviceId: device.id,
		});
		client.deviceName = deviceName || device.name;
		client.label = `${device.id} "${logValue(client.deviceName, 80)}"`;
		const app = isObject(frame.app) ? frame.app : {};
		this.connLog.line(
			"hello",
			plainIp(client.ws.remoteAddress),
			`app #${client.conn} hello ok: ${client.label}, app ${logValue(app.version)} (${logValue(app.build)}), protocol ${logValue(protocol ?? client.protocolParam ?? REMOTE_PROTOCOL_VERSION)}, welcome in ${Math.round(performance.now() - client.acceptedMono)}ms`,
		);
	}

	/** Refuse an unauthenticated socket: one log line (never the token), then the close frame. */
	private failHello(client: AppClient, code: number, reason: string, why: string): void {
		client.failLogged = true;
		const from = formatAddr(client.ws.remoteAddress, client.ws.remotePort);
		this.connLog.line(
			"fail",
			plainIp(client.ws.remoteAddress),
			`app #${client.conn} hello failed from ${from}: ${why}, close ${code}, after ${formatDuration(performance.now() - client.acceptedMono)}`,
		);
		client.ws.close(code, reason);
	}

	private dispatch(client: AppClient, t: string, re: string | undefined, f: Record<string, unknown>): void {
		const needsId = t !== "session.unsubscribe" && t !== "focus" && t !== "hello";
		if (needsId && re === undefined) {
			this.sendError(client, undefined, "bad_request", `${t} requires a string id`);
			return;
		}
		const id = re as string;
		switch (t) {
			case "hello":
				return; // already authenticated; ignore
			case "ping":
				this.send(client, { t: "pong", re: id });
				return;
			case "sessions.list":
				this.send(client, {
					t: "sessions",
					re: id,
					sessions: this.presentAll(this.sortedSummaries().filter((summary) => this.visibleTo(client, summary))),
				});
				return;
			case "session.subscribe":
				this.subscribe(client, id, f);
				return;
			case "session.unsubscribe": {
				const sid = str(f.sessionId);
				if (sid) client.subs.delete(sid);
				return;
			}
			case "focus": {
				const sid = f.sessionId;
				client.focus = typeof sid === "string" ? sid : null;
				return;
			}
			case "session.history": {
				const sid = this.requireSession(client, t, id, f);
				if (!sid) return;
				const before = str(f.before);
				if (!before) {
					this.fail(client, t, id, { code: "bad_request", message: "before is required" });
					return;
				}
				const limit = limitArg(f.limit);
				if (limit === null) {
					this.fail(client, t, id, { code: "bad_request", message: "limit must be a number >= 1" });
					return;
				}
				this.forward(client, t, id, sid, { op: "history", args: { before, limit } }, (data) => {
					const d = data as { items?: unknown; hasMore?: unknown } | undefined;
					this.send(client, {
						t: "session.history",
						re: id,
						sessionId: sid,
						items: Array.isArray(d?.items) ? d.items : [],
						hasMore: d?.hasMore === true,
					});
				});
				return;
			}
			case "session.prompt": {
				const sid = this.requireSession(client, t, id, f);
				if (!sid) return;
				const text = typeof f.text === "string" ? f.text : undefined;
				const images = parseImages(f.images);
				const mode: PromptMode | undefined =
					f.mode === undefined
						? "auto"
						: f.mode === "auto" || f.mode === "steer" || f.mode === "followUp"
							? f.mode
							: undefined;
				if (text === undefined || images === null || mode === undefined) {
					this.fail(client, t, id, { code: "bad_request", message: "invalid prompt" });
					return;
				}
				if (images && images.length > 0 && this.sessions.get(sid)?.summary.kind === "subagent") {
					this.fail(client, t, id, { code: "bad_request", message: "a subagent takes text only" });
					return;
				}
				const args = { text, mode, ...(images && images.length > 0 ? { images } : {}) };
				this.forward(client, t, id, sid, { op: "prompt", args }, () => this.sendAck(client, id));
				return;
			}
			case "session.abort": {
				const sid = this.requireSession(client, t, id, f);
				if (!sid) return;
				const entry = this.sessions.get(sid);
				if (entry && entry.status === "working") entry.abortRequested = true;
				this.forward(client, t, id, sid, { op: "abort", args: {} }, () => this.sendAck(client, id));
				return;
			}
			case "models.list": {
				if (f.sessionId === undefined || f.sessionId === null) {
					// New-thread screen: the machine's models and the user's defaults.
					this.models.list().then(
						(payload) => this.send(client, { t: "models", re: id, ...payload }),
						(error: unknown) =>
							this.sendError(
								client,
								id,
								"internal",
								`could not load models: ${error instanceof Error ? error.message : String(error)}`,
							),
					);
					return;
				}
				const sid = this.requireSession(client, t, id, f);
				if (!sid) return;
				this.forward(client, t, id, sid, { op: "models", args: {} }, (data) => {
					const d = (isObject(data) ? data : {}) as Record<string, unknown>;
					this.send(client, {
						t: "models",
						re: id,
						models: Array.isArray(d.models) ? (d.models as never[]) : [],
						...(isObject(d.current) ? { current: d.current as { provider: string; id: string } } : {}),
						...(typeof d.thinkingLevel === "string" ? { thinkingLevel: d.thinkingLevel } : {}),
						thinkingLevels: Array.isArray(d.thinkingLevels) ? (d.thinkingLevels as string[]) : [],
					});
				});
				return;
			}
			case "session.setModel": {
				const sid = this.requireSession(client, t, id, f);
				if (!sid) return;
				const provider = str(f.provider);
				const modelId = str(f.modelId);
				if (!provider || !modelId) {
					this.fail(client, t, id, { code: "bad_request", message: "provider and modelId are required" });
					return;
				}
				this.forward(client, t, id, sid, { op: "setModel", args: { provider, modelId } }, () =>
					this.sendAck(client, id),
				);
				return;
			}
			case "session.setThinking": {
				const sid = this.requireSession(client, t, id, f);
				if (!sid) return;
				const level = str(f.level);
				if (!level) {
					this.fail(client, t, id, { code: "bad_request", message: "level is required" });
					return;
				}
				this.forward(client, t, id, sid, { op: "setThinking", args: { level } }, () => this.sendAck(client, id));
				return;
			}
			case "commands.list": {
				const sid = this.requireSession(client, t, id, f);
				if (!sid) return;
				this.forward(client, t, id, sid, { op: "commands", args: {} }, (data) => {
					const d = (isObject(data) ? data : {}) as Record<string, unknown>;
					this.send(client, { t: "commands", re: id, sessionId: sid, commands: sanitizeCommands(d.commands) });
				});
				return;
			}
			case "cwds.recent":
				this.send(client, { t: "cwds", re: id, cwds: this.recentCwds() });
				return;
			case "session.spawn":
				this.spawnSession(client, id, f).catch((error: unknown) =>
					this.fail(client, t, id, {
						code: "internal",
						message: error instanceof Error ? error.message : String(error),
					}),
				);
				return;
			case "session.close":
				this.closeSession(client, id, f);
				return;
			case "overseer.board":
				this.overseerBoard(f.sessionId).then(
					(board) =>
						"error" in board
							? this.sendError(client, id, board.error.code, board.error.message)
							: this.send(client, { t: "overseer.board", re: id, ...board }),
					(error: unknown) =>
						this.sendError(client, id, "internal", error instanceof Error ? error.message : String(error)),
				);
				return;
			case "sessions.past":
			case "session.transcript":
			case "session.resume": {
				const run =
					t === "sessions.past"
						? this.pastSessions(client, id, f)
						: t === "session.transcript"
							? this.sessionTranscript(client, id, f)
							: this.resumeSession(client, id, f);
				run.catch((error: unknown) =>
					this.fail(client, t, id, {
						code: "internal",
						message: error instanceof Error ? error.message : String(error),
					}),
				);
				return;
			}
			case "push.register": {
				const apnsToken = str(f.apnsToken)?.trim();
				const env = f.env;
				const bundleId = str(f.bundleId)?.trim();
				if (
					!apnsToken ||
					!/^[0-9A-Fa-f]{32,512}$/.test(apnsToken) ||
					(env !== "sandbox" && env !== "production") ||
					!bundleId ||
					!/^[A-Za-z0-9.-]{1,200}$/.test(bundleId)
				) {
					this.fail(client, t, id, { code: "bad_request", message: "invalid push registration" });
					return;
				}
				this.devices.update(client.deviceId as string, (d) => {
					d.push = { apnsToken, env, bundleId };
				});
				this.sendAck(client, id);
				return;
			}
			case "push.unregister":
				this.devices.update(client.deviceId as string, (d) => {
					delete d.push;
				});
				this.sendAck(client, id);
				return;
			default:
				this.sendError(client, re, "bad_request", `unknown frame type: ${t}`);
		}
	}

	private requireSession(client: AppClient, t: string, re: string, f: Record<string, unknown>): string | undefined {
		const sid = str(f.sessionId);
		if (!sid) {
			this.fail(client, t, re, { code: "bad_request", message: "sessionId is required" });
			return undefined;
		}
		const entry = this.sessions.get(sid);
		if (!entry || !this.visibleTo(client, entry.summary)) {
			this.fail(client, t, re, { code: "not_found", message: `no live session ${sid}` });
			return undefined;
		}
		if (entry.summary.kind === "subagent" && SUBAGENT_UNSUPPORTED.has(t)) {
			this.fail(client, t, re, { code: "bad_request", message: `${t} is not available on a subagent session` });
			return undefined;
		}
		return sid;
	}

	/** Forward `op` to the session; on failure reply in the frame's shape, on success call `onOk`. */
	private forward(
		client: AppClient,
		t: string,
		re: string,
		sessionId: string,
		op: SessionOp,
		onOk: (data: SessionOpReplyData | undefined) => void,
	): void {
		this.requestSession(sessionId, op, (error, data) => {
			if (error) this.fail(client, t, re, error);
			else onOk(data);
		});
	}

	private subscribe(client: AppClient, re: string, f: Record<string, unknown>): void {
		const sid = this.requireSession(client, "session.subscribe", re, f);
		if (!sid) return;
		const limit = limitArg(f.limit);
		if (limit === null) {
			this.sendError(client, re, "bad_request", "limit must be a number >= 1");
			return;
		}
		// Events that arrive before the snapshot reply are already reflected in it (the session
		// answers in order on one socket), so the subscription stays "pending" — muted — until the
		// reply is handled, synchronously, in the same pass that reads it.
		client.subs.set(sid, "pending");
		this.requestSession(sid, { op: "snapshot", args: { limit } }, (error, data) => {
			if (client.subs.get(sid) !== "pending") {
				this.sendError(client, re, "not_found", `session ${sid} is no longer subscribed`);
				return;
			}
			if (error) {
				client.subs.delete(sid);
				this.sendError(client, re, error.code, error.message);
				return;
			}
			const d = (isObject(data) ? data : {}) as Record<string, unknown>;
			const entry = this.sessions.get(sid);
			this.send(client, {
				t: "session.snapshot",
				re,
				sessionId: sid,
				items: Array.isArray(d.items) ? (d.items as never[]) : [],
				hasMore: d.hasMore === true,
				state: isObject(d.state)
					? (d.state as never)
					: {
							status: entry?.status ?? "idle",
							...(entry?.summary.activity ? { activity: entry.summary.activity } : {}),
						},
			});
			client.subs.set(sid, "active");
		});
	}

	private sortedSummaries(): SessionSummary[] {
		return [...this.sessions.values()]
			.map((e) => e.summary)
			.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
	}

	private recentCwds(): string[] {
		const live = this.sortedSummaries()
			.filter((s) => s.kind !== "subagent")
			.map((s) => s.cwd);
		const now = Date.now();
		if (!this.recentCwdsCache || now - this.recentCwdsCache.at > RECENT_CWDS_CACHE_MS) {
			let persisted: string[] = [];
			try {
				persisted = readRecentSessionCwds(this.opts.sessionsDir ?? getSessionsDir(), 20);
			} catch {
				persisted = [];
			}
			this.recentCwdsCache = { at: now, cwds: persisted };
		}
		const acceptable = (cwd: string) => !("error" in validateSpawnCwd(cwd, this.allowRoots, this.home));
		return mergeRecentCwds(live.filter(acceptable), this.recentCwdsCache.cwds.filter(acceptable), 20);
	}

	// ----------------------------------------------------------------------------------------
	// Headless sessions
	// ----------------------------------------------------------------------------------------

	/**
	 * Model arguments of `session.spawn` / `session.resume`: safe strings the model registry knows, and
	 * one of phi's thinking levels (a superset of every `models.list` `thinkingLevels`; the child clamps
	 * it to what its model supports, as `--thinking` does).
	 */
	private async checkModelArgs(
		f: Record<string, unknown>,
	): Promise<{ args: Omit<SpawnModelOptions, "sessionFile"> } | { error: RemoteError }> {
		const provider = f.provider === undefined ? undefined : f.provider;
		const modelId = f.modelId === undefined ? undefined : f.modelId;
		if (
			(provider !== undefined && !isSafeModelArg(provider)) ||
			(modelId !== undefined && !isSafeModelArg(modelId))
		) {
			return { error: { code: "bad_request", message: "invalid provider or modelId" } };
		}
		if (f.prompt !== undefined && typeof f.prompt !== "string") {
			return { error: { code: "bad_request", message: "prompt must be a string" } };
		}
		const thinkingLevel = f.thinkingLevel === undefined ? undefined : f.thinkingLevel;
		if (thinkingLevel !== undefined && !isSpawnThinkingLevel(thinkingLevel)) {
			return { error: { code: "bad_request", message: "invalid thinkingLevel" } };
		}
		if (provider !== undefined || modelId !== undefined) {
			let known: boolean;
			try {
				known = await this.models.has(provider, modelId);
			} catch (error) {
				// Fail closed: only strings the registry vouches for become child arguments.
				return {
					error: {
						code: "internal",
						message: `could not check the model: ${error instanceof Error ? error.message : String(error)}`,
					},
				};
			}
			if (!known) {
				const label = provider && modelId ? `${provider}/${modelId}` : (modelId ?? provider);
				return { error: { code: "not_found", message: `unknown model ${label}` } };
			}
		}
		return { args: { provider, modelId, thinkingLevel } };
	}

	/** An app request answered with an `ack` when its spawn or resume settles. */
	private appWaiter(client: AppClient, re: string): Waiter {
		return (error, settled) => this.sendAck(client, re, error, settled?.sessionId, settled?.ackCwd);
	}

	/** A control request answered with `CtlSpawnData` when its spawn or resume settles. */
	private ctlWaiter(reply: CtlReply): Waiter {
		return (error, settled) => {
			if (error || !settled) {
				reply.fail(error ?? { code: "internal", message: "the session did not start" });
				return;
			}
			const data: CtlSpawnData = {
				sessionId: settled.sessionId,
				cwd: settled.cwd,
				...(settled.pid !== undefined ? { pid: settled.pid } : {}),
				...(settled.ackCwd?.cwdFallback ? { cwdFallback: true as const } : {}),
			};
			reply.ok(data);
		};
	}

	private spawnSession(client: AppClient, re: string, f: Record<string, unknown>): Promise<void> {
		return this.startSpawn(f, this.appWaiter(client, re), false);
	}

	/**
	 * Start a headless session; `waiter` is answered once it registers, fails or times out. App spawns
	 * (`ctl` false) must stay inside the allowed roots. Control-wire spawns (`ctl` true, hub.sock is
	 * this user's alone) need only an existing directory, and may set `--name`,
	 * `--append-system-prompt` and thread environment variables.
	 */
	private async startSpawn(f: Record<string, unknown>, waiter: Waiter, ctl: boolean): Promise<void> {
		const checked = ctl ? resolveSpawnCwd(f.cwd, this.home) : validateSpawnCwd(f.cwd, this.allowRoots, this.home);
		if ("error" in checked) return waiter(checked.error);
		let extra: Pick<SpawnArgsOptions, "name" | "appendSystemPrompt"> & { env?: Record<string, string> } = {};
		if (ctl) {
			const parsed = ctlSpawnExtras(f);
			if ("error" in parsed) return waiter(parsed.error);
			extra = parsed.args;
		} else if (f.name !== undefined && f.name !== null) {
			// Apps may name the session (an overseer started from the phone); nothing else of the ctl extras.
			if (!isLineText(f.name, SPAWN_NAME_MAX)) {
				return waiter({
					code: "bad_request",
					message: `name must be one non-blank line of at most ${SPAWN_NAME_MAX} characters`,
				});
			}
			extra = { name: f.name.trim() };
		}
		const model = await this.checkModelArgs(f);
		if ("error" in model) return waiter(model.error);
		if (this.stopping) return waiter({ code: "internal", message: "hub is shutting down" });
		let child: HeadlessChild;
		try {
			child = this.headless.spawn({ cwd: checked.cwd, ...model.args, ...extra });
		} catch (error) {
			return waiter({ code: "internal", message: `spawn failed: ${(error as Error).message}` });
		}
		const prompt = typeof f.prompt === "string" && f.prompt.trim().length > 0 ? f.prompt : undefined;
		this.trackSpawn(child, [waiter], prompt ? [prompt] : []);
		this.log(`spawned headless session pid=${child.pid ?? "?"} in ${checked.cwd}${ctl ? " (local control)" : ""}`);
	}

	/** Wait for `child` to register: then ack `waiters` with its session id and send `prompts`. */
	private trackSpawn(
		child: HeadlessChild,
		waiters: Waiter[],
		prompts: string[],
		resumeOf?: string,
		ackCwd?: AckCwd,
	): void {
		// Children spawned together boot together and share the CPU: 80 at once on a 10-core Mac all
		// register after ~18 s, a few hundred would all pass a fixed 30 s. So a deadline that fires
		// while other spawns are still pending is extended by SPAWN_GRACE_PER_PENDING_MS per other
		// pending spawn; once the burst drains, a child that never connects gets the base timeout.
		const base = this.opts.spawnTimeoutMs ?? 30_000;
		const startedAt = Date.now();
		const expire = () => {
			if (this.pendingSpawns.get(child.spawnId) !== pending) return;
			const allowed = base + this.spawnGraceMs * (this.pendingSpawns.size - 1);
			const left = startedAt + allowed - Date.now();
			if (left > 0) {
				pending.timer = setTimeout(expire, left);
				return;
			}
			this.pendingSpawns.delete(child.spawnId);
			this.forgetResume(pending);
			this.settleWaiters(pending.waiters, { code: "internal", message: "headless session did not connect in time" });
			void this.headless.end(child);
		};
		const pending: PendingSpawn = {
			waiters,
			prompts,
			child,
			timer: setTimeout(expire, base),
			...(resumeOf ? { resumeOf } : {}),
			...(ackCwd ? { ackCwd } : {}),
		};
		this.pendingSpawns.set(child.spawnId, pending);
	}

	private settleWaiters(waiters: readonly Waiter[], error?: RemoteError, settled?: SpawnSettled): void {
		for (const waiter of waiters) {
			try {
				waiter(error, settled);
			} catch (thrown) {
				this.log(`could not answer a spawn request: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
			}
		}
	}

	/** A live session as a settled spawn/resume (resumed in place, nothing started). */
	private liveSettled(entry: SessionEntry): SpawnSettled {
		const ackCwd = liveCwd(entry);
		return {
			sessionId: entry.summary.sessionId,
			...(ackCwd ? { ackCwd } : {}),
			cwd: entry.summary.cwd,
			...(entry.summary.pid ? { pid: entry.summary.pid } : {}),
		};
	}

	private forgetResume(pending: PendingSpawn): void {
		if (pending.resumeOf && this.resumes.get(pending.resumeOf)?.spawnId === pending.child.spawnId) {
			this.resumes.delete(pending.resumeOf);
		}
	}

	private onHeadlessExit(child: HeadlessChild): void {
		const pending = this.pendingSpawns.get(child.spawnId);
		if (!pending) return;
		this.pendingSpawns.delete(child.spawnId);
		clearTimeout(pending.timer);
		this.forgetResume(pending);
		const tail = child.stderrTail.trim().split("\n").pop() ?? "";
		this.settleWaiters(pending.waiters, {
			code: "internal",
			message: `headless session exited (code ${child.exitCode ?? "signal"})${tail ? `: ${oneLine(tail, 300)}` : ""}`,
		});
	}

	// ----------------------------------------------------------------------------------------
	// Session history: sessions.past, session.transcript, session.resume
	// ----------------------------------------------------------------------------------------

	/** The live (registered, non-subagent) session with this id. */
	private liveSession(sessionId: string): SessionEntry | undefined {
		const entry = this.sessions.get(sessionId);
		return entry && entry.summary.kind !== "subagent" && !entry.conn.socket.destroyed ? entry : undefined;
	}

	/** A stored session can be resumed when its file can still be read (the index parsed it). */
	private sessionReadable(path: string): boolean {
		try {
			accessSync(path, fsConstants.R_OK);
			return true;
		} catch {
			return false;
		}
	}

	private pastSession(session: IndexedSession, threadsByOverseer: Map<string, SessionSummary[]>): PastSession {
		const live = this.liveSession(session.sessionId);
		let overseer = live?.summary.overseer ? { ...live.summary.overseer } : undefined;
		if (!overseer) {
			const link = this.overseers.linkOf(session.sessionId);
			if (link) overseer = registryLink(link, undefined);
		}
		if (overseer && !overseer.name) {
			const name = this.overseerName(overseer.sessionId, threadsByOverseer.get(overseer.sessionId) ?? []);
			if (name) overseer.name = name;
		}
		const isOverseer =
			this.overseers.hasThreads(session.sessionId) || (threadsByOverseer.get(session.sessionId)?.length ?? 0) > 0;
		return {
			sessionId: session.sessionId,
			title: session.title,
			named: session.named,
			cwd: session.cwd,
			createdAt: session.createdAt,
			modifiedAt: session.modifiedAt,
			messageCount: session.messageCount,
			...(session.preview ? { preview: session.preview } : {}),
			...(session.model ? { model: session.model } : {}),
			live: live !== undefined,
			...(live
				? { liveKind: live.summary.kind === "headless" ? ("headless" as const) : ("interactive" as const) }
				: {}),
			resumable: this.sessionReadable(session.path),
			...(overseer ? { overseer } : {}),
			...(isOverseer ? { isOverseer: true as const } : {}),
		};
	}

	private async pastSessions(client: AppClient, re: string, f: Record<string, unknown>): Promise<void> {
		const t = "sessions.past";
		const bad = (message: string) => this.fail(client, t, re, { code: "bad_request", message });
		let limit = PAST_DEFAULT_LIMIT;
		if (f.limit !== undefined && f.limit !== null) {
			if (typeof f.limit !== "number" || !Number.isFinite(f.limit) || f.limit < 1) {
				return bad("limit must be a number >= 1");
			}
			limit = Math.min(PAST_MAX_LIMIT, Math.floor(f.limit));
		}
		let cursor: ReturnType<typeof decodeCursor>;
		if (f.cursor !== undefined && f.cursor !== null) {
			cursor = typeof f.cursor === "string" ? decodeCursor(f.cursor) : undefined;
			if (!cursor) return bad("invalid cursor");
		}
		if (
			f.query !== undefined &&
			f.query !== null &&
			(typeof f.query !== "string" || f.query.length > PAST_MAX_QUERY)
		) {
			return bad(`query must be a string of at most ${PAST_MAX_QUERY} characters`);
		}
		if (f.cwd !== undefined && f.cwd !== null && typeof f.cwd !== "string") return bad("cwd must be a string");
		await this.history.fresh(this.opts.historyMaxAgeMs ?? HISTORY_MAX_AGE_MS);
		const matching = this.history.list({
			query: typeof f.query === "string" ? f.query : undefined,
			cwd: typeof f.cwd === "string" ? f.cwd : undefined,
		});
		const { page, nextCursor } = pageAfter(matching, limit, cursor);
		const threadsByOverseer = this.liveThreadsByOverseer();
		this.send(client, {
			t: "sessions.past",
			re,
			sessions: page.map((session) => this.pastSession(session, threadsByOverseer)),
			...(nextCursor ? { nextCursor } : {}),
			...(this.history.indexing ? { indexing: true } : {}),
		});
	}

	private async sessionTranscript(client: AppClient, re: string, f: Record<string, unknown>): Promise<void> {
		const page = await this.transcriptPage(f);
		if ("error" in page) return this.fail(client, "session.transcript", re, page.error);
		this.send(client, { t: "session.transcript", re, ...page });
	}

	/** `session.transcript` (app and control wire): a live session's own page, else the stored file's. */
	private async transcriptPage(
		f: Record<string, unknown>,
	): Promise<{ sessionId: string; items: TranscriptItem[]; hasMore: boolean } | { error: RemoteError }> {
		const sid = str(f.sessionId);
		if (!sid) return { error: { code: "bad_request", message: "sessionId is required" } };
		if (f.before !== undefined && f.before !== null && (typeof f.before !== "string" || f.before.length === 0)) {
			return { error: { code: "bad_request", message: "before must be an item id" } };
		}
		const before = typeof f.before === "string" ? f.before : undefined;
		const limit = limitArg(f.limit);
		if (limit === null) {
			return { error: { code: "bad_request", message: "limit must be a number >= 1" } };
		}
		const reply = (items: unknown, hasMore: unknown) => ({
			sessionId: sid,
			items: Array.isArray(items) ? (items as TranscriptItem[]) : [],
			hasMore: hasMore === true,
		});
		if (this.liveSession(sid)) {
			// The session renders its own transcript, in-flight items included.
			const op: SessionOp = before
				? { op: "history", args: { before, limit } }
				: { op: "snapshot", args: { limit } };
			const live = await new Promise<{ error?: RemoteError; data?: SessionOpReplyData }>((done) =>
				this.requestSession(sid, op, (error, data) => done({ error, data })),
			);
			if (!live.error) {
				const d = (isObject(live.data) ? live.data : {}) as Record<string, unknown>;
				return reply(d.items, d.hasMore);
			}
			// Gone while asking: its file is the transcript now.
			if (live.error.code !== "session_offline") return { error: live.error };
		}
		const session = await this.history.lookup(sid);
		if (!session) return { error: { code: "not_found", message: `no session ${sid}` } };
		await this.acquireTranscriptRead();
		try {
			const page = await readStoredTranscript(session.path, { limit, before });
			return reply(page.items, page.hasMore);
		} catch (error) {
			if (error instanceof UnknownItemError) {
				return { error: { code: "not_found", message: error.message } };
			}
			const message = error instanceof Error ? error.message : String(error);
			const gone = error instanceof NotASessionError || (error as NodeJS.ErrnoException).code === "ENOENT";
			return {
				error: {
					code: gone ? "not_found" : "internal",
					message: `could not read session ${sid}: ${message}`,
				},
			};
		} finally {
			this.releaseTranscriptRead();
		}
	}

	private acquireTranscriptRead(): Promise<void> {
		if (this.transcriptReads < MAX_TRANSCRIPT_READS) {
			this.transcriptReads++;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.transcriptQueue.push(resolve));
	}

	private releaseTranscriptRead(): void {
		const next = this.transcriptQueue.shift();
		if (next) next();
		else this.transcriptReads--;
	}

	/**
	 * `session.resume`: a live session acks at once (no new process) and gets the prompt like
	 * `session.prompt` mode `auto`; any other listed session is continued by a headless
	 * `phi --mode rpc --session <file>` in its cwd, acked once it registers (same id, same file). A
	 * second resume of a session whose resume is in progress joins it.
	 */
	private resumeSession(client: AppClient, re: string, f: Record<string, unknown>): Promise<void> {
		return this.resume(f, this.appWaiter(client, re), false);
	}

	/**
	 * `session.resume` for an app (`ctl` false) or the control wire (`ctl` true, which may also pass
	 * thread environment variables to a process it starts). `waiter` is answered once.
	 */
	private async resume(f: Record<string, unknown>, waiter: Waiter, ctl: boolean): Promise<void> {
		const sid = str(f.sessionId);
		if (!sid) return waiter({ code: "bad_request", message: "sessionId is required" });
		let env: Record<string, string> | undefined;
		if (ctl) {
			const parsed = ctlEnv(f.env);
			if ("error" in parsed) return waiter(parsed.error);
			env = parsed.env;
		}
		const model = await this.checkModelArgs(f);
		if ("error" in model) return waiter(model.error);
		const prompt = typeof f.prompt === "string" && f.prompt.trim().length > 0 ? f.prompt : undefined;
		if (this.stopping) return waiter({ code: "internal", message: "hub is shutting down" });
		// Synchronous from here until the resume is registered, so concurrent resumes cannot both start.
		const live = this.liveSession(sid);
		if (live) {
			waiter(undefined, this.liveSettled(live));
			if (prompt) this.promptSession(sid, [prompt]);
			return;
		}
		const joined = this.resumes.get(sid);
		if (joined) {
			// The first request's process (and its environment) serves every joined resume.
			joined.waiters.push(waiter);
			if (prompt) joined.prompts.push(prompt);
			return;
		}
		const pending: PendingResume = { sessionId: sid, waiters: [waiter], prompts: prompt ? [prompt] : [] };
		this.resumes.set(sid, pending);
		// Whoever takes `pending` out of `resumes` (registration, exit, shutdown, this) acks its waiters.
		let error: RemoteError | undefined;
		try {
			error = await this.startResume(pending, model.args, env);
		} catch (thrown) {
			error = { code: "internal", message: thrown instanceof Error ? thrown.message : String(thrown) };
		}
		if (error && this.resumes.get(sid) === pending && !pending.spawnId) {
			this.resumes.delete(sid);
			this.settleWaiters(pending.waiters, error);
		}
	}

	/** Start the child for `pending`, or settle it as live; returns the error to ack with, if any. */
	private async startResume(
		pending: PendingResume,
		model: Omit<SpawnModelOptions, "sessionFile">,
		env?: Record<string, string>,
	): Promise<RemoteError | undefined> {
		const sid = pending.sessionId;
		const settledLive = (): boolean => {
			const live = this.liveSession(sid);
			if (!live) return false;
			this.resumes.delete(sid);
			this.settleWaiters(pending.waiters, undefined, this.liveSettled(live));
			if (pending.prompts.length > 0) this.promptSession(sid, pending.prompts);
			return true;
		};
		const graceLeft = this.startedAt + (this.opts.resumeLiveGraceMs ?? RESUME_LIVE_GRACE_MS) - Date.now();
		if (graceLeft > 0) {
			await new Promise<void>((done) => {
				const timer = setTimeout(done, graceLeft);
				pending.wake = () => {
					clearTimeout(timer);
					done();
				};
			});
			pending.wake = undefined;
		}
		if (this.stopping) return { code: "internal", message: "hub is shutting down" };
		if (settledLive()) return undefined;
		const session = await this.history.lookup(sid);
		if (this.stopping) return { code: "internal", message: "hub is shutting down" };
		if (settledLive()) return undefined;
		if (!session) return { code: "not_found", message: `no session ${sid}` };
		// Allowed roots are for fresh spawns only: this file is already on this machine, so it is
		// resumed wherever its folder is, or the nearest folder that still exists.
		const { cwd, fallback } = resolveResumeCwd(session.cwd, this.home);
		let child: HeadlessChild;
		try {
			child = this.headless.spawn({
				cwd,
				...model,
				sessionFile: session.path,
				sessionCwd: cwd,
				...(env ? { env } : {}),
			});
		} catch (error) {
			return { code: "internal", message: `spawn failed: ${(error as Error).message}` };
		}
		pending.spawnId = child.spawnId;
		this.trackSpawn(child, pending.waiters, pending.prompts, sid, {
			cwd,
			...(fallback ? { cwdFallback: true } : {}),
		});
		this.log(
			`resuming session ${sid} pid=${child.pid ?? "?"} in ${cwd}${fallback ? ` (recorded ${session.cwd || "no folder"})` : ""}`,
		);
		return undefined;
	}

	/** Send prompts to a session in order, mode `auto` (failures are logged; the request was acked). */
	private promptSession(sessionId: string, prompts: readonly string[]): void {
		for (const text of prompts) {
			this.requestSession(sessionId, { op: "prompt", args: { text, mode: "auto" } }, (error) => {
				if (error) this.log(`prompt for ${sessionId} failed: ${error.message}`);
			});
		}
	}

	// ----------------------------------------------------------------------------------------
	// Overseers: isOverseer / threadCounts, overseer.board (docs/remote-protocol.md, "Overseers")
	// ----------------------------------------------------------------------------------------

	private readonly liveSummary = (sessionId: string): SessionSummary | undefined =>
		this.liveSession(sessionId)?.summary;

	/** Live (non-subagent) sessions by the overseer their `summary.overseer` names. */
	private liveThreadsByOverseer(): Map<string, SessionSummary[]> {
		const map = new Map<string, SessionSummary[]>();
		for (const entry of this.sessions.values()) {
			const summary = entry.summary;
			const overseer = summary.overseer?.sessionId;
			if (!overseer || summary.kind === "subagent" || overseer === summary.sessionId) continue;
			const list = map.get(overseer);
			if (list) list.push(summary);
			else map.set(overseer, [summary]);
		}
		return map;
	}

	private liveThreadsOf(overseerSessionId: string): SessionSummary[] {
		const out: SessionSummary[] = [];
		for (const entry of this.sessions.values()) {
			const summary = entry.summary;
			if (
				summary.overseer?.sessionId === overseerSessionId &&
				summary.kind !== "subagent" &&
				summary.sessionId !== overseerSessionId
			)
				out.push(summary);
		}
		return out;
	}

	/** The summary apps see: an overseer's gets `isOverseer` and `threadCounts`. */
	private present(summary: SessionSummary, threadsByOverseer?: Map<string, SessionSummary[]>): SessionSummary {
		if (summary.kind === "subagent") return summary;
		const id = summary.sessionId;
		const registry = this.overseers.get(id)?.threads ?? [];
		const liveThreads = threadsByOverseer ? (threadsByOverseer.get(id) ?? []) : this.liveThreadsOf(id);
		if (registry.length === 0 && liveThreads.length === 0) return summary;
		return { ...summary, isOverseer: true, threadCounts: countThreads(registry, liveThreads, this.liveSummary) };
	}

	private presentAll(summaries: SessionSummary[]): SessionSummary[] {
		const threadsByOverseer = this.liveThreadsByOverseer();
		return summaries.map((summary) => this.present(summary, threadsByOverseer));
	}

	/** Broadcast the entry's `session.upsert` (as `present` shows it). */
	private publish(entry: SessionEntry): void {
		const summary = this.present(entry.summary);
		entry.overseerKey = summary.threadCounts ? JSON.stringify(summary.threadCounts) : "";
		this.broadcastSession(summary, { t: "session.upsert", session: summary });
	}

	/** An overseer's threads may have changed: upsert it (throttled) when its counts did. */
	private syncOverseer(overseerSessionId: string): void {
		const entry = this.liveSession(overseerSessionId);
		if (!entry) return;
		const summary = this.present(entry.summary);
		const key = summary.threadCounts ? JSON.stringify(summary.threadCounts) : "";
		if (key !== (entry.overseerKey ?? "")) this.queueUpsert(entry);
	}

	/** The overseer's name: its live summary, else its stored session's title, else a thread's link. */
	private overseerName(overseerSessionId: string, liveThreads: readonly SessionSummary[]): string | undefined {
		const live = this.liveSession(overseerSessionId);
		if (live) return live.summary.name;
		const stored = this.history.peek(overseerSessionId);
		if (stored) return stored.title;
		return liveThreads.find((summary) => summary.overseer?.name)?.overseer?.name;
	}

	/** `overseer.board` (app frame and control op). */
	private async overseerBoard(value: unknown): Promise<OverseerBoardData | { error: RemoteError }> {
		const sid = str(value);
		if (!sid || sid.length > 200) return { error: { code: "bad_request", message: "sessionId is required" } };
		if (await this.overseers.refreshOne(sid)) this.syncOverseer(sid);
		const file = this.overseers.get(sid);
		const liveThreads = this.liveThreadsOf(sid);
		if (file?.error) {
			return { error: { code: "internal", message: `overseer registry of ${sid} is unreadable: ${file.error}` } };
		}
		if (!file && liveThreads.length === 0) {
			return { error: { code: "not_found", message: `no overseer ${sid}` } };
		}
		const threads = boardThreads(file?.threads ?? [], liveThreads, this.liveSummary);
		return boardData(sid, this.overseerName(sid, liveThreads), threads);
	}

	private closeSession(client: AppClient, re: string, f: Record<string, unknown>): void {
		const t = "session.close";
		const sid = this.requireSession(client, t, re, f);
		if (!sid) return;
		const entry = this.sessions.get(sid) as SessionEntry;
		if (entry.summary.kind !== "headless") {
			this.fail(client, t, re, {
				code: "forbidden",
				message: "only headless sessions can be closed remotely",
			});
			return;
		}
		this.closeHeadless(sid, entry, {}, (error) => this.sendAck(client, re, error));
	}

	/** Ask a headless session to close, then end its process; `done` runs once. */
	private closeHeadless(
		sid: string,
		entry: SessionEntry,
		args: { overseer?: string },
		done: (error?: RemoteError) => void,
	): void {
		const child = entry.conn.headless ?? this.headless.bySessionId(sid);
		this.requestSession(sid, { op: "close", args }, (error) => {
			if (child) {
				void this.headless.end(child);
				done();
			} else if (error && error.code !== "session_offline") {
				done(error);
			} else {
				done();
			}
		});
	}

	// ----------------------------------------------------------------------------------------
	// Local socket: sessions and control clients
	// ----------------------------------------------------------------------------------------

	private onIpcConnection(socket: Socket): void {
		socket.on("error", () => {});
		let kind: "unknown" | "session" | "ctl" | "rejected" = "unknown";
		const conn: SessionConn = { socket, pending: new Map(), children: new Set() };
		const onMessage = (msg: unknown): void => {
			try {
				handle(msg);
			} catch (error) {
				// A local peer sent something the hub cannot handle: drop that peer, keep the hub.
				this.log(`dropping local connection: ${error instanceof Error ? error.message : String(error)}`);
				socket.destroy();
			}
		};
		const handle = (msg: unknown): void => {
			if (!isObject(msg)) return;
			if (kind === "unknown") {
				if (msg.t === "register") {
					kind = "session";
					this.sessionConns.add(conn);
					this.handleRegister(conn, msg);
				} else if (msg.t === "ctl") {
					kind = "ctl";
					this.ctlSockets.add(socket);
					void this.handleCtl(socket, msg as unknown as ControlToHub);
				} else {
					kind = "rejected";
					this.writeSession(conn, { t: "bye", reason: "expected register or ctl" });
					socket.end();
				}
				return;
			}
			if (kind === "rejected") return;
			if (kind === "ctl") {
				if (msg.t === "ctl") void this.handleCtl(socket, msg as unknown as ControlToHub);
				return;
			}
			this.handleSessionMessage(conn, msg);
		};
		attachNdjsonReader(socket, onMessage, undefined, { onOverflow: () => socket.destroy() });
		socket.on("close", () => {
			this.ctlSockets.delete(socket);
			if (kind !== "session") return;
			this.sessionConns.delete(conn);
			this.failPending(conn, "session disconnected");
			if (conn.sessionId) this.removeSession(conn.sessionId, conn);
			for (const childId of [...conn.children]) this.removeSession(childId, conn);
		});
	}

	private writeSession(conn: SessionConn, frame: HubToSession): void {
		if (!conn.socket.destroyed) conn.socket.write(ndjson(frame));
	}

	private failPending(conn: SessionConn, message: string): void {
		const pending = [...conn.pending.values()];
		conn.pending.clear();
		for (const p of pending) {
			clearTimeout(p.timer);
			p.callback({ code: "session_offline", message }, undefined);
		}
	}

	/** Send `op` to the session's owner; `callback` runs exactly once (reply, timeout, or disconnect). */
	private requestSession(
		sessionId: string,
		op: SessionOp,
		callback: (error: RemoteError | undefined, data: SessionOpReplyData | undefined) => void,
	): void {
		const entry = this.sessions.get(sessionId);
		if (!entry || entry.conn.socket.destroyed) {
			callback({ code: "session_offline", message: `session ${sessionId} is not connected` }, undefined);
			return;
		}
		const conn = entry.conn;
		// A subagent session is served by its parent's connection: name the target.
		const target = entry.summary.kind === "subagent" ? { sessionId } : {};
		const id = `h${++this.reqSeq}`;
		const timeoutMs = this.opts.requestTimeoutMs ?? 15_000;
		const timer = setTimeout(() => {
			if (!conn.pending.delete(id)) return;
			callback(
				{ code: "session_offline", message: `session did not answer within ${timeoutMs / 1000}s` },
				undefined,
			);
		}, timeoutMs);
		conn.pending.set(id, { callback, timer });
		this.writeSession(conn, { t: "req", id, ...target, ...op } as HubToSession);
	}

	private handleRegister(conn: SessionConn, msg: Record<string, unknown>): void {
		if (msg.v !== 1) {
			this.writeSession(conn, { t: "bye", reason: `unsupported wire version ${String(msg.v)}; expected 1` });
			conn.socket.end();
			return;
		}
		const spawnId = str(msg.spawnId);
		if (spawnId && !conn.headless) {
			const child = this.headless.get(spawnId);
			if (child) conn.headless = child;
		}
		const summary = this.normalizeSummary(msg.session, conn);
		if (!summary) {
			this.writeSession(conn, { t: "bye", reason: "register requires session.sessionId" });
			conn.socket.end();
			return;
		}
		if (!conn.headless) {
			const byPid = this.headless.byPid(summary.pid);
			if (byPid) {
				conn.headless = byPid;
				summary.kind = "headless";
			}
		}
		this.adoptSession(conn, summary);
		this.writeSession(conn, { t: "registered", hubId: this.hubId });

		if (spawnId) {
			const pending = this.pendingSpawns.get(spawnId);
			if (pending) {
				this.pendingSpawns.delete(spawnId);
				clearTimeout(pending.timer);
				this.forgetResume(pending);
				if (pending.resumeOf && pending.resumeOf !== summary.sessionId) {
					this.log(`resume of ${pending.resumeOf} registered as ${summary.sessionId}`);
				}
				const pid = pending.child.pid ?? (summary.pid || undefined);
				this.settleWaiters(pending.waiters, undefined, {
					sessionId: summary.sessionId,
					...(pending.ackCwd ? { ackCwd: pending.ackCwd } : {}),
					cwd: pending.ackCwd?.cwd ?? pending.child.cwd,
					...(pid !== undefined ? { pid } : {}),
				});
				if (pending.prompts.length > 0) this.promptSession(summary.sessionId, pending.prompts);
			}
		}
	}

	/**
	 * Make `summary` the session owned by `conn`. A new id on a connection that already owned one
	 * (/new, resume, fork) is remove(old) + add(new).
	 */
	private adoptSession(conn: SessionConn, summary: SessionSummary): void {
		const id = summary.sessionId;
		if (conn.sessionId && conn.sessionId !== id) this.replaceSession(conn.sessionId, id, conn);
		if (conn.headless) conn.headless.sessionId = id;
		const existing = this.sessions.get(id);
		if (existing && existing.conn === conn) {
			this.updateSummary(existing, summary);
			return;
		}
		if (existing) {
			// Another connection claims the same session (e.g. a reconnect raced the old socket's
			// close). The newest registration wins; the old connection no longer owns it.
			if (existing.upsertTimer) clearTimeout(existing.upsertTimer);
			if (existing.pushTimer) clearTimeout(existing.pushTimer);
			if (existing.conn.sessionId === id) existing.conn.sessionId = undefined;
		}
		conn.sessionId = id;
		const entry: SessionEntry = { conn, summary, status: summary.status, lastUpsertAt: Date.now() };
		this.sessions.set(id, entry);
		if (!existing) this.log(`session ${id} registered (${summary.kind}, ${summary.cwd})`);
		this.publish(entry);
		if (summary.overseer) this.syncOverseer(summary.overseer.sessionId);
		// A resume waiting out the startup grace: the session is live after all.
		const resume = this.resumes.get(id);
		if (resume && !resume.spawnId) resume.wake?.();
	}

	/**
	 * The process behind `conn` switched sessions (/new, /resume, /fork): subscribers of the old id
	 * get a `reset` naming its successor, then everyone gets the removal with the same pointer.
	 */
	private replaceSession(oldId: string, newId: string, conn: SessionConn): void {
		const entry = this.sessions.get(oldId);
		if (!entry || entry.conn !== conn) return;
		const frame = JSON.stringify({
			t: "session.event",
			sessionId: oldId,
			event: { type: "reset", replacedBy: newId },
		} satisfies HubFrame);
		for (const client of this.clients) {
			if (client.deviceId && client.subs.has(oldId)) client.ws.send(frame);
		}
		this.removeSession(oldId, conn, newId);
	}

	private removeSession(sessionId: string, conn: SessionConn, replacedBy?: string): void {
		const entry = this.sessions.get(sessionId);
		if (!entry || entry.conn !== conn) return;
		const isChild = entry.summary.kind === "subagent";
		if (isChild) conn.children.delete(sessionId);
		else {
			// A session's subagent threads end with it (never "replaced": the new session has its own).
			for (const childId of [...conn.children]) {
				if (this.sessions.get(childId)?.summary.parentSessionId === sessionId) this.removeSession(childId, conn);
			}
		}
		if (entry.upsertTimer) clearTimeout(entry.upsertTimer);
		if (entry.pushTimer) clearTimeout(entry.pushTimer);
		this.sessions.delete(sessionId);
		for (const client of this.clients) client.subs.delete(sessionId);
		if (!isChild) this.log(`session ${sessionId} removed${replacedBy ? ` (replaced by ${replacedBy})` : ""}`);
		this.broadcastSession(entry.summary, {
			t: "session.remove",
			sessionId,
			...(replacedBy && !isChild ? { replacedBy } : {}),
		});
		if (entry.summary.overseer) this.syncOverseer(entry.summary.overseer.sessionId);
	}

	/** `child.upsert`: a subagent session served by `conn`, under the session `conn` registered. */
	private upsertChild(conn: SessionConn, value: unknown): void {
		const parentId = conn.sessionId;
		if (!parentId || !isObject(value) || !isObject(value.subagent)) return;
		const parent = this.sessions.get(parentId);
		if (!parent || parent.conn !== conn) return;
		const childId = str(value.sessionId);
		// Child ids are derived from the parent's, so one connection can never claim another's.
		if (!childId || !childId.startsWith(`${parentId}~sa~`) || childId.length > 512) return;
		const summary = this.normalizeSummary(value, conn);
		if (!summary) return;
		summary.kind = "subagent";
		summary.parentSessionId = parentId;
		summary.subagent = value.subagent as unknown as SessionSummary["subagent"];
		delete summary.subagents;
		delete summary.commandsVersion;
		const existing = this.sessions.get(childId);
		if (existing && existing.conn === conn) {
			this.updateSummary(existing, summary);
			return;
		}
		if (existing) {
			// A stale connection still lists it; the newest one wins.
			if (existing.upsertTimer) clearTimeout(existing.upsertTimer);
			existing.conn.children.delete(childId);
		} else if (conn.children.size >= MAX_CHILDREN_PER_SESSION) {
			return;
		}
		conn.children.add(childId);
		const entry: SessionEntry = { conn, summary, status: summary.status, lastUpsertAt: Date.now() };
		this.sessions.set(childId, entry);
		this.broadcastSession(summary, { t: "session.upsert", session: summary });
	}

	private handleSessionMessage(conn: SessionConn, msg: Record<string, unknown>): void {
		switch (msg.t) {
			case "register":
				this.handleRegister(conn, msg);
				return;
			case "upsert": {
				const summary = this.normalizeSummary(msg.session, conn);
				if (!summary || !conn.sessionId) return;
				if (summary.sessionId !== conn.sessionId) {
					// Lenient: an upsert under a new id is treated like a re-register.
					this.adoptSession(conn, summary);
					return;
				}
				const entry = this.sessions.get(summary.sessionId);
				if (entry && entry.conn === conn) this.updateSummary(entry, summary);
				return;
			}
			case "child.upsert":
				this.upsertChild(conn, msg.session);
				return;
			case "child.remove": {
				const sid = str(msg.sessionId);
				if (sid && conn.children.has(sid)) this.removeSession(sid, conn);
				return;
			}
			case "event": {
				const sid = str(msg.sessionId);
				const entry = sid ? this.sessions.get(sid) : undefined;
				if (!sid || !entry || entry.conn !== conn || !isObject(msg.event)) return;
				this.onSessionEvent(entry, msg.event as unknown as LiveEvent);
				return;
			}
			case "reply": {
				const re = str(msg.re);
				const pending = re ? conn.pending.get(re) : undefined;
				if (!re || !pending) return;
				conn.pending.delete(re);
				clearTimeout(pending.timer);
				if (msg.ok === true) {
					pending.callback(undefined, msg.data as SessionOpReplyData | undefined);
				} else {
					const error = isObject(msg.error) ? msg.error : {};
					pending.callback(
						{
							code: (str(error.code) as RemoteErrorCode | undefined) ?? "internal",
							message: str(error.message) ?? "session reported an error",
						},
						undefined,
					);
				}
				return;
			}
			default:
				return;
		}
	}

	private normalizeSummary(value: unknown, conn: SessionConn): SessionSummary | undefined {
		if (!isObject(value)) return undefined;
		const sessionId = str(value.sessionId);
		if (!sessionId) return undefined;
		const cwd = str(value.cwd) ?? "";
		const now = Date.now();
		const summary = { ...value } as unknown as SessionSummary;
		summary.sessionId = sessionId;
		summary.cwd = cwd;
		summary.name = str(value.name) || basename(cwd) || sessionId.slice(0, 8);
		summary.host = str(value.host) ?? this.hostname;
		summary.pid = typeof value.pid === "number" ? value.pid : 0;
		summary.kind = conn.headless ? "headless" : value.kind === "headless" ? "headless" : "interactive";
		// Only `child.upsert` makes subagent sessions (it sets these after normalizing).
		delete summary.parentSessionId;
		delete summary.subagent;
		summary.status = value.status === "working" ? "working" : "idle";
		summary.startedAt = typeof value.startedAt === "number" ? value.startedAt : now;
		summary.lastActivityAt = typeof value.lastActivityAt === "number" ? value.lastActivityAt : now;
		// Optional fields the hub itself reads (push text, sorting) must have their declared types.
		if (summary.lastText !== undefined && typeof summary.lastText !== "string") delete summary.lastText;
		if (summary.thinkingLevel !== undefined && typeof summary.thinkingLevel !== "string")
			delete summary.thinkingLevel;
		if (summary.activity !== undefined && !isObject(summary.activity)) delete summary.activity;
		if (summary.model !== undefined && !isObject(summary.model)) delete summary.model;
		if (summary.usage !== undefined && !isObject(summary.usage)) delete summary.usage;
		if (summary.commandsVersion !== undefined && typeof summary.commandsVersion !== "string")
			delete summary.commandsVersion;
		if (summary.subagents !== undefined && !isObject(summary.subagents)) delete summary.subagents;
		if (summary.tmux !== undefined && (!isObject(summary.tmux) || typeof summary.tmux.session !== "string"))
			delete summary.tmux;
		// Overseer fields are the hub's to compute (registry + live threads), never a session's to claim.
		delete summary.isOverseer;
		delete summary.threadCounts;
		// Overseer threads (sessions.list for the control wire): well-formed or absent.
		const overseer = overseerLink(value.overseer);
		if (overseer) summary.overseer = overseer;
		else delete summary.overseer;
		if (summary.lastError !== undefined) {
			const lastError = oneLine(summary.lastError, 200);
			if (lastError) summary.lastError = lastError;
			else delete summary.lastError;
		}
		return summary;
	}

	private updateSummary(entry: SessionEntry, summary: SessionSummary): void {
		const before = entry.summary.overseer?.sessionId;
		entry.summary = summary;
		this.setStatus(entry, summary.status);
		this.queueUpsert(entry);
		if (before && before !== summary.overseer?.sessionId) this.syncOverseer(before);
		if (summary.overseer) this.syncOverseer(summary.overseer.sessionId);
	}

	/** Fan out the entry's current summary, at most once per throttle window per session. */
	private queueUpsert(entry: SessionEntry): void {
		if (entry.upsertTimer) return; // trailing send already scheduled; it reads the latest summary
		const throttle = this.opts.upsertThrottleMs ?? 500;
		const wait = entry.lastUpsertAt + throttle - Date.now();
		const fire = () => {
			entry.upsertTimer = undefined;
			if (this.sessions.get(entry.summary.sessionId) !== entry) return;
			entry.lastUpsertAt = Date.now();
			this.publish(entry);
		};
		if (wait <= 0) fire();
		else entry.upsertTimer = setTimeout(fire, wait);
	}

	private onSessionEvent(entry: SessionEntry, event: LiveEvent): void {
		if (event.type === "state" && isObject(event.state)) {
			const status: SessionStatus = event.state.status === "working" ? "working" : "idle";
			const activity = event.state.activity;
			const changed =
				entry.summary.status !== status ||
				JSON.stringify(entry.summary.activity ?? null) !== JSON.stringify(activity ?? null);
			if (changed) {
				entry.summary = { ...entry.summary, status, activity, lastActivityAt: Date.now() };
				if (!activity) delete entry.summary.activity;
				this.queueUpsert(entry);
				if (entry.summary.overseer) this.syncOverseer(entry.summary.overseer.sessionId);
			}
			this.setStatus(entry, status);
		} else if (event.type === "item.upsert" && isObject(event.item) && event.item.kind === "assistant") {
			const item = event.item as Record<string, unknown>;
			entry.lastAssistant = { text: str(item.text) ?? "", error: str(item.error) };
		}
		const sid = entry.summary.sessionId;
		const frame = JSON.stringify({ t: "session.event", sessionId: sid, event } satisfies HubFrame);
		for (const client of this.clients) {
			if (client.deviceId && client.subs.get(sid) === "active") client.ws.send(frame);
		}
	}

	// ----------------------------------------------------------------------------------------
	// Push notifications
	// ----------------------------------------------------------------------------------------

	private setStatus(entry: SessionEntry, status: SessionStatus): void {
		const previous = entry.status;
		entry.status = status;
		// Subagent threads never push: their parent's turn is what the user waits on.
		if (entry.summary.kind === "subagent") return;
		if (status === "working") {
			if (entry.pushTimer) clearTimeout(entry.pushTimer);
			entry.pushTimer = undefined;
			if (previous !== "working") entry.abortRequested = false;
			return;
		}
		if (previous !== "working") return;
		if (entry.abortRequested) {
			// An abort never pushes (the user just acted on this session).
			entry.abortRequested = false;
			return;
		}
		// Debounced: a session that immediately starts working again (queued follow-up, /loop)
		// should not buzz the phone, and the final assistant item may land just after the state.
		if (entry.pushTimer) clearTimeout(entry.pushTimer);
		entry.pushTimer = setTimeout(() => {
			entry.pushTimer = undefined;
			if (this.sessions.get(entry.summary.sessionId) === entry && entry.status === "idle") {
				this.notifyIdle(entry).catch((error: unknown) =>
					this.log(`push failed: ${error instanceof Error ? error.message : String(error)}`),
				);
			}
		}, this.opts.pushDebounceMs ?? 1000);
	}

	private async notifyIdle(entry: SessionEntry): Promise<void> {
		if (!this.pushEnabled()) return;
		const sessionId = entry.summary.sessionId;
		const last = entry.lastAssistant;
		if (last?.error === "aborted") return; // aborted (e.g. Esc in the terminal): never pushes
		const body = oneLine(last?.error || last?.text || entry.summary.lastText || "Finished", 140);
		const alert: PushAlert = { title: oneLine(entry.summary.name, 100) || "phi", body };
		const payload = { hubId: this.hubId, sessionId };
		for (const device of this.devices.list()) {
			const registration = device.push;
			if (!registration) continue;
			const focused = [...this.clients].some((c) => c.deviceId === device.id && c.focus === sessionId);
			if (focused) continue;
			const result = await this.pushSender(registration, alert, payload);
			if (result.drop) this.dropPush(device.id, registration.apnsToken, result.reason ?? String(result.status));
			else if (!result.ok) this.log(`push to ${device.id} failed: ${result.status ?? ""} ${result.reason ?? ""}`);
		}
	}

	private dropPush(deviceId: string, apnsToken: string, why: string): void {
		this.devices.update(deviceId, (d) => {
			if (d.push?.apnsToken === apnsToken) delete d.push;
		});
		this.log(`dropped push registration of ${deviceId} (${why})`);
	}

	async pushTest(deviceId?: string): Promise<PushTestResult> {
		return runPushTest(this.devices, this.pushSender, this.pushEnabled(), this.hubId, this.hostname, deviceId);
	}

	// ----------------------------------------------------------------------------------------
	// Local control (CLI, /remote)
	// ----------------------------------------------------------------------------------------

	private async handleCtl(socket: Socket, msg: ControlToHub): Promise<void> {
		const op = msg as unknown as { id?: unknown } & HubControlOp;
		const re = str(op.id) ?? "";
		let answered = false;
		const reply = (frame: HubToControl) => {
			// Session ops answer later (spawns, forwarded requests); exactly one reply per request.
			if (answered) return;
			answered = true;
			if (!socket.destroyed) socket.write(ndjson(frame));
		};
		const ok = (data?: unknown) => reply({ t: "ctl.reply", re, ok: true, ...(data !== undefined ? { data } : {}) });
		const err = (code: RemoteErrorCode, message: string) =>
			reply({ t: "ctl.reply", re, ok: false, error: { code, message } });
		const answer: CtlReply = { ok, fail: (error) => err(error.code, error.message) };
		try {
			switch (op.op) {
				case "sessions.list":
				case "session.spawn":
				case "session.prompt":
				case "session.abort":
				case "session.setModel":
				case "session.setThinking":
				case "session.close":
				case "session.snapshot":
				case "session.history":
				case "session.transcript":
				case "session.resume":
				case "overseer.board":
					return await this.handleCtlSession(op.op, op as unknown as Record<string, unknown>, answer);
				case "status":
					return ok(this.status());
				case "pair.create":
					return ok(await this.createPair());
				case "devices.list":
					return ok({ devices: this.deviceInfos() });
				case "devices.revoke":
					return this.revokeDevice(str(op.deviceId) ?? "") ? ok() : err("not_found", "no such device");
				case "push.test":
					return ok(await this.pushTest(str(op.deviceId)));
				case "shutdown":
					ok();
					setImmediate(() => (this.opts.onShutdownRequested ? this.opts.onShutdownRequested() : void this.stop()));
					return;
				default:
					return err("bad_request", `unknown control op: ${String((op as { op?: unknown }).op)}`);
			}
		} catch (error) {
			err("internal", error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Session operations of the control wire (`CtlSessionOp`, docs/remote.md "Local control for
	 * agents"). Same code paths as the app's frames; the caller is this user (hub.sock is 0600), so it
	 * sees every session, subagent threads on request, and spawns without the allowed-roots check.
	 */
	private async handleCtlSession(op: string, f: Record<string, unknown>, reply: CtlReply): Promise<void> {
		const bad = (message: string) => reply.fail({ code: "bad_request", message });
		if (op === "sessions.list") {
			const all = f.subagents === true;
			const data: CtlSessionsData = {
				sessions: this.presentAll(this.sortedSummaries().filter((summary) => all || summary.kind !== "subagent")),
			};
			return reply.ok(data);
		}
		if (op === "overseer.board") {
			const board = await this.overseerBoard(f.sessionId);
			return "error" in board ? reply.fail(board.error) : reply.ok(board);
		}
		if (op === "session.spawn") return this.startSpawn(f, this.ctlWaiter(reply), true);
		if (op === "session.resume") return this.resume(f, this.ctlWaiter(reply), true);
		if (op === "session.transcript") {
			const page = await this.transcriptPage(f);
			if ("error" in page) return reply.fail(page.error);
			return reply.ok({ items: page.items, hasMore: page.hasMore });
		}

		// Everything else acts on one live session.
		const sid = str(f.sessionId);
		if (!sid) return bad("sessionId is required");
		const entry = this.sessions.get(sid);
		if (!entry) return reply.fail({ code: "not_found", message: `no live session ${sid}` });
		if (entry.summary.kind === "subagent" && SUBAGENT_UNSUPPORTED.has(op)) {
			return bad(`${op} is not available on a subagent session`);
		}
		const forward = (sessionOp: SessionOp, onOk: (data: SessionOpReplyData | undefined) => void) =>
			this.requestSession(sid, sessionOp, (error, data) => {
				if (error) reply.fail(error);
				else onOk(data);
			});
		switch (op) {
			case "session.prompt": {
				const text = f.text;
				const mode = f.mode === undefined || f.mode === null ? "auto" : f.mode;
				if (typeof text !== "string" || !text.trim()) return bad("text is required");
				if (mode !== "auto" && mode !== "steer" && mode !== "followUp") {
					return bad("mode must be auto, steer or followUp");
				}
				return forward({ op: "prompt", args: { text, mode } }, () => reply.ok({}));
			}
			case "session.abort":
				if (entry.status === "working") entry.abortRequested = true;
				return forward({ op: "abort", args: {} }, () => reply.ok({}));
			case "session.setModel": {
				const provider = str(f.provider);
				const modelId = str(f.modelId);
				if (!provider || !modelId) return bad("provider and modelId are required");
				return forward({ op: "setModel", args: { provider, modelId } }, () => reply.ok({}));
			}
			case "session.setThinking": {
				const level = str(f.level);
				if (!level) return bad("level is required");
				return forward({ op: "setThinking", args: { level } }, () => reply.ok({}));
			}
			case "session.snapshot": {
				const limit = limitArg(f.limit);
				if (limit === null) return bad("limit must be a number >= 1");
				return forward({ op: "snapshot", args: { limit } }, (data) => {
					const d = (isObject(data) ? data : {}) as Record<string, unknown>;
					const current = this.sessions.get(sid) ?? entry;
					const snapshot: CtlSnapshotData = {
						items: Array.isArray(d.items) ? (d.items as TranscriptItem[]) : [],
						hasMore: d.hasMore === true,
						state: isObject(d.state)
							? (d.state as unknown as CtlSnapshotData["state"])
							: {
									status: current.status,
									...(current.summary.activity ? { activity: current.summary.activity } : {}),
								},
						summary: this.present(current.summary),
					};
					reply.ok(snapshot);
				});
			}
			case "session.history": {
				const before = str(f.before);
				if (!before) return bad("before is required");
				const limit = limitArg(f.limit);
				if (limit === null) return bad("limit must be a number >= 1");
				return forward({ op: "history", args: { before, limit } }, (data) => {
					const d = (isObject(data) ? data : {}) as Record<string, unknown>;
					reply.ok({ items: Array.isArray(d.items) ? d.items : [], hasMore: d.hasMore === true });
				});
			}
			case "session.close":
				return this.ctlClose(sid, entry, f.overseer, reply);
			default:
				return bad(`unknown control op: ${op}`);
		}
	}

	/**
	 * Control-wire `session.close`. A headless session closes as from the app. An interactive one
	 * closes only for its own overseer (`summary.overseer.sessionId === overseer`, checked here and
	 * again by the session against its environment); it then shuts itself down as `/quit` would.
	 */
	private ctlClose(sid: string, entry: SessionEntry, overseer: unknown, reply: CtlReply): void {
		const args = typeof overseer === "string" && overseer ? { overseer } : {};
		if (entry.summary.kind === "headless") {
			this.closeHeadless(sid, entry, args, (error) => (error ? reply.fail(error) : reply.ok({})));
			return;
		}
		if (!args.overseer || entry.summary.overseer?.sessionId !== args.overseer) {
			reply.fail({
				code: "forbidden",
				message: "an interactive session can be closed only by its own overseer",
			});
			return;
		}
		this.requestSession(sid, { op: "close", args }, (error) => {
			// Disconnected while asking: it is gone, which is what was asked.
			if (!error || (error.code === "session_offline" && entry.conn.socket.destroyed)) reply.ok({});
			else reply.fail(error);
		});
	}

	status(): HubStatus {
		return {
			hubId: this.hubId,
			name: this.hostname,
			pid: process.pid,
			version: this.version,
			port: this.port,
			binds: this.binds,
			urls: pairingUrls({
				port: this.port,
				binds: this.binds,
				magicDns: this.magicDnsCache?.name,
				explicitBinds: this.explicitBinds !== undefined,
			}),
			startedAt: this.startedAt,
			sessions: this.presentAll(this.sortedSummaries()),
			devices: this.deviceInfos(),
			apps: [...this.clients].filter((c) => c.deviceId).length,
			appConnections: this.appConnections(),
			push: this.pushEnabled(),
			allowRoots: this.allowRoots,
			history: this.history.stats(),
		};
	}

	private appConnections(): AppConnectionInfo[] {
		const out: AppConnectionInfo[] = [];
		for (const client of this.clients) {
			if (!client.deviceId) continue;
			out.push({
				conn: client.conn,
				deviceId: client.deviceId,
				name: client.deviceName ?? "",
				remote: formatAddr(client.ws.remoteAddress, client.ws.remotePort),
				local: formatAddr(client.ws.localAddress, client.ws.localPort),
				connectedAt: client.acceptedAt,
				...(client.ws.lastPongAt !== undefined ? { lastPongAt: client.ws.lastPongAt } : {}),
			});
		}
		return out;
	}

	async createPair(): Promise<PairInfo> {
		const { code, expiresAt } = this.pairCodes.create();
		const magicDns = await this.magicDns();
		const urls = pairingUrls({
			port: this.port,
			binds: this.binds,
			magicDns,
			explicitBinds: this.explicitBinds !== undefined,
		});
		return {
			code,
			expiresAt,
			hubId: this.hubId,
			name: this.hostname,
			urls,
			link: buildPairLink({ code, name: this.hostname, hubId: this.hubId, urls }),
		};
	}

	private async magicDns(): Promise<string | undefined> {
		const now = Date.now();
		if (this.magicDnsCache && now - this.magicDnsCache.at < MAGIC_DNS_CACHE_MS) return this.magicDnsCache.name;
		let name: string | undefined;
		try {
			name = await (this.opts.magicDnsLookup ?? lookupMagicDnsName)();
		} catch {
			name = undefined;
		}
		this.magicDnsCache = { at: now, name };
		return name;
	}

	deviceInfos(): DeviceInfo[] {
		const connected = new Set([...this.clients].map((c) => c.deviceId).filter(Boolean));
		return this.devices.list().map((d) => ({
			id: d.id,
			name: d.name,
			platform: d.platform,
			createdAt: d.createdAt,
			...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}),
			push: Boolean(d.push),
			connected: connected.has(d.id),
		}));
	}

	revokeDevice(deviceId: string): boolean {
		if (!this.devices.remove(deviceId)) return false;
		for (const client of this.clients) {
			if (client.deviceId !== deviceId) continue;
			// Deauthorize first: nothing more is sent to or accepted from this socket, even during the
			// closing handshake. close() drops the TCP connection if the phone does not answer in 2 s.
			client.deviceId = undefined;
			client.subs.clear();
			client.focus = null;
			client.ws.close(CLOSE_UNAUTHORIZED, "device revoked");
		}
		this.log(`revoked device ${deviceId}`);
		return true;
	}
}

/** Send a test alert to one device or to every device with a push registration. */
export async function runPushTest(
	devices: DeviceStore,
	sender: PushSender,
	enabled: boolean,
	hubId: string,
	hostname: string,
	deviceId?: string,
): Promise<PushTestResult> {
	const targets = deviceId ? devices.list().filter((d) => d.id === deviceId) : devices.list().filter((d) => d.push);
	if (deviceId && targets.length === 0) throw new Error(`no such device: ${deviceId}`);
	const results: PushTestResult["results"] = [];
	for (const device of targets) {
		if (!enabled) {
			results.push({ deviceId: device.id, name: device.name, ok: false, reason: "APNs is not configured" });
			continue;
		}
		const registration = device.push;
		if (!registration) {
			results.push({ deviceId: device.id, name: device.name, ok: false, reason: "no push registration" });
			continue;
		}
		const result = await sender(
			registration,
			{ title: "phi remote", body: `Test notification from ${hostname}` },
			{ hubId },
		);
		if (result.drop) {
			devices.update(device.id, (d) => {
				if (d.push?.apnsToken === registration.apnsToken) delete d.push;
			});
		}
		results.push({
			deviceId: device.id,
			name: device.name,
			ok: result.ok,
			...(result.status !== undefined ? { status: result.status } : {}),
			...(result.reason ? { reason: result.drop ? `${result.reason} (registration dropped)` : result.reason } : {}),
		});
	}
	return { results };
}

/** `SessionSummary.overseer` as a session sent it: a non-empty `sessionId` and optional strings, else undefined. */
function overseerLink(value: unknown): SessionSummary["overseer"] {
	if (!isObject(value)) return undefined;
	const sessionId = oneLine(value.sessionId, 200);
	if (!sessionId) return undefined;
	const name = oneLine(value.name, 200);
	const thread = oneLine(value.thread, 200);
	return { sessionId, ...(name ? { name } : {}), ...(thread ? { thread } : {}) };
}

/** Control-wire `env` (`session.spawn` / `session.resume`): absent, or an object filtered to thread variables. */
function ctlEnv(value: unknown): { env?: Record<string, string> } | { error: RemoteError } {
	if (value === undefined || value === null) return {};
	if (!isObject(value)) return { error: { code: "bad_request", message: "env must be an object of strings" } };
	const env = filterThreadEnv(value);
	return Object.keys(env).length > 0 ? { env } : {};
}

/** Single-line text without NUL, non-blank, at most `max` characters. */
function isLineText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}

/** `name`, `appendSystemPrompt` and `env` of a control-wire `session.spawn`. */
function ctlSpawnExtras(
	f: Record<string, unknown>,
):
	| { args: Pick<SpawnArgsOptions, "name" | "appendSystemPrompt"> & { env?: Record<string, string> } }
	| { error: RemoteError } {
	const bad = (message: string) => ({ error: { code: "bad_request" as const, message } });
	const present = (value: unknown) => value !== undefined && value !== null;
	if (present(f.name) && !isLineText(f.name, SPAWN_NAME_MAX)) {
		return bad(`name must be one non-blank line of at most ${SPAWN_NAME_MAX} characters`);
	}
	const systemPrompt = f.appendSystemPrompt;
	if (
		present(systemPrompt) &&
		(typeof systemPrompt !== "string" ||
			!systemPrompt.trim() ||
			systemPrompt.length > SPAWN_SYSTEM_PROMPT_MAX ||
			systemPrompt.includes("\0"))
	) {
		return bad(`appendSystemPrompt must be non-blank text of at most ${SPAWN_SYSTEM_PROMPT_MAX} characters`);
	}
	const env = ctlEnv(f.env);
	if ("error" in env) return env;
	return {
		args: {
			...(present(f.name) ? { name: (f.name as string).trim() } : {}),
			...(present(systemPrompt) ? { appendSystemPrompt: systemPrompt as string } : {}),
			...env,
		},
	};
}

/** `limit` of subscribe/history: default 120, clamped to 500 (clarification 4); null when invalid. */
function limitArg(value: unknown): number | null {
	if (value === undefined || value === null) return 120;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return null;
	return Math.min(500, Math.floor(value));
}

/**
 * A session's `commands` reply as the contract states it: well-formed entries only, descriptions on
 * one line of ≤ 160 chars, at most 500 entries.
 */
export function sanitizeCommands(value: unknown): CommandInfo[] {
	if (!Array.isArray(value)) return [];
	const commands: CommandInfo[] = [];
	for (const item of value) {
		if (commands.length >= MAX_COMMANDS) break;
		if (!isObject(item) || typeof item.name !== "string" || typeof item.source !== "string") continue;
		const name = item.name.trim();
		if (!name || /\s/.test(name) || name.length > 200 || !COMMAND_SOURCES.has(item.source)) continue;
		const description = oneLine(item.description, MAX_COMMAND_DESCRIPTION);
		const argumentHint = oneLine(item.argumentHint, 80);
		commands.push({
			name,
			...(description ? { description } : {}),
			source: item.source as CommandInfo["source"],
			...(argumentHint ? { argumentHint } : {}),
		});
	}
	return commands;
}

/** Validate prompt images; null when malformed, undefined when absent. */
function parseImages(value: unknown): PromptImage[] | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.length > 16) return null;
	const images: PromptImage[] = [];
	for (const item of value) {
		if (!isObject(item) || typeof item.mimeType !== "string" || typeof item.data !== "string") return null;
		if (!IMAGE_MIME_TYPES.has(item.mimeType)) return null;
		images.push({ mimeType: item.mimeType, data: item.data });
	}
	return images;
}
