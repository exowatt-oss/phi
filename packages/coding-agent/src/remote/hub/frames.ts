/**
 * WebSocket frame shapes of the public phi remote protocol v1 (docs/remote-protocol.md), as the
 * hub sees them, plus hub-only additions to the local control wire. Domain types come from
 * `../protocol.ts` (read-only shared contract).
 */

import type {
	CommandInfo,
	ControlOp,
	DeviceInfo,
	LiveEvent,
	LiveState,
	ModelsPayload,
	OverseerBoardData,
	PastSession,
	PromptImage,
	PromptMode,
	RemoteError,
	RemoteErrorCode,
	SessionSummary,
	TranscriptItem,
} from "../protocol.ts";

// ------------------------------------------------------------------------------------------
// Client -> hub
// ------------------------------------------------------------------------------------------

export type ClientFrame =
	| {
			t: "hello";
			token: string;
			app?: { version?: string; build?: string };
			device?: { name?: string };
			/** Optional; when present and not 1 the hub closes with 4426. */
			protocol?: number;
	  }
	| { t: "ping"; id: string }
	| { t: "sessions.list"; id: string }
	| { t: "session.subscribe"; id: string; sessionId: string; limit?: number }
	| { t: "session.unsubscribe"; sessionId: string }
	| { t: "session.history"; id: string; sessionId: string; before: string; limit?: number }
	| {
			t: "session.prompt";
			id: string;
			sessionId: string;
			text: string;
			images?: PromptImage[];
			mode?: PromptMode;
	  }
	| { t: "session.abort"; id: string; sessionId: string }
	| { t: "models.list"; id: string; sessionId: string }
	| { t: "session.setModel"; id: string; sessionId: string; provider: string; modelId: string }
	| { t: "session.setThinking"; id: string; sessionId: string; level: string }
	| { t: "commands.list"; id: string; sessionId: string }
	| { t: "cwds.recent"; id: string }
	| {
			t: "session.spawn";
			id: string;
			cwd: string;
			prompt?: string;
			provider?: string;
			modelId?: string;
			thinkingLevel?: string;
			/** Overseers (v1 addition): one line, ≤ 200 chars, passed as `--name`. */
			name?: string;
	  }
	| { t: "session.close"; id: string; sessionId: string }
	// Session history (v1 addition; hubs advertise it with welcome.host.features "history").
	| { t: "sessions.past"; id: string; limit?: number; cursor?: string; query?: string; cwd?: string }
	| { t: "session.transcript"; id: string; sessionId: string; before?: string; limit?: number }
	| {
			t: "session.resume";
			id: string;
			sessionId: string;
			prompt?: string;
			provider?: string;
			modelId?: string;
			thinkingLevel?: string;
	  }
	// Overseers (v1 addition; hubs advertise it with welcome.host.features "overseer").
	| { t: "overseer.board"; id: string; sessionId: string }
	| { t: "push.register"; id: string; apnsToken: string; env: "sandbox" | "production"; bundleId: string }
	| { t: "push.unregister"; id: string }
	| { t: "focus"; sessionId: string | null };

// ------------------------------------------------------------------------------------------
// Hub -> client
// ------------------------------------------------------------------------------------------

export interface HostInfo {
	name: string;
	hubId: string;
	hubVersion: string;
	protocol: 1;
	/** Optional protocol additions this hub implements (v1 additions), e.g. "history". */
	features?: string[];
}

export type HubFrame =
	| { t: "welcome"; host: HostInfo; deviceId: string }
	| { t: "pong"; re: string }
	| { t: "ack"; re: string; ok: boolean; error?: RemoteError; sessionId?: string; cwd?: string; cwdFallback?: true }
	| { t: "error"; re?: string; code: RemoteErrorCode; message: string }
	| { t: "sessions"; re: string; sessions: SessionSummary[] }
	| { t: "session.upsert"; session: SessionSummary }
	/** `replacedBy`: the same phi process now runs that session (/new, /resume, /fork). */
	| { t: "session.remove"; sessionId: string; replacedBy?: string }
	| {
			t: "session.snapshot";
			re: string;
			sessionId: string;
			items: TranscriptItem[];
			hasMore: boolean;
			state: LiveState;
	  }
	| { t: "session.history"; re: string; sessionId: string; items: TranscriptItem[]; hasMore: boolean }
	| { t: "session.event"; sessionId: string; event: LiveEvent }
	| ({ t: "models"; re: string } & ModelsPayload)
	| { t: "commands"; re: string; sessionId: string; commands: CommandInfo[] }
	| { t: "cwds"; re: string; cwds: string[] }
	| { t: "sessions.past"; re: string; sessions: PastSession[]; nextCursor?: string; indexing?: boolean }
	| { t: "session.transcript"; re: string; sessionId: string; items: TranscriptItem[]; hasMore: boolean }
	| ({ t: "overseer.board"; re: string } & OverseerBoardData);

/** WebSocket close codes from the contract. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_PROTOCOL_MISMATCH = 4426;

// ------------------------------------------------------------------------------------------
// Hub-only additions to the local control wire (additive; protocol.ts is the shared base)
// ------------------------------------------------------------------------------------------

/** `push.test`: send a test alert to one device (or every device with a push registration). */
export type HubControlOp = ControlOp | { op: "push.test"; deviceId?: string };

/** `status` reply data. */
export interface HubStatus {
	hubId: string;
	name: string;
	pid: number;
	version: string;
	port: number;
	binds: string[];
	urls: string[];
	startedAt: number;
	sessions: SessionSummary[];
	devices: DeviceInfo[];
	apps: number;
	/** The authenticated app connections behind `apps`; absent from older hubs. */
	appConnections?: AppConnectionInfo[];
	push: boolean;
	allowRoots: string[];
	/** Session history index (`sessions.past`); absent from older hubs. */
	history?: {
		files: number;
		sessions: number;
		indexing: boolean;
		builtInMs?: number;
		lastRefreshMs?: number;
		searchChars: number;
	};
}

/** One authenticated app connection in `status`. */
export interface AppConnectionInfo {
	/** Per-hub connection number, as in hub.log (`app #12 ...`). */
	conn: number;
	deviceId: string;
	name: string;
	/** `ip:port` of the phone. */
	remote: string;
	/** `ip:port` of the hub address it connected to. */
	local: string;
	/** Epoch ms of the WebSocket upgrade. */
	connectedAt: number;
	/** Epoch ms of the last keepalive pong, if any yet. */
	lastPongAt?: number;
}

/** `push.test` reply data. */
export interface PushTestResult {
	results: { deviceId: string; name: string; ok: boolean; status?: number; reason?: string }[];
}
