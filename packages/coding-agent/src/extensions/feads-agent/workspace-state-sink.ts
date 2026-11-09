import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { workspaceStateStore } from "../workspace-state/state.ts";
import type { WorkspaceStateRecord } from "../workspace-state/types.ts";
import { feadsSessionState } from "./session-state.ts";

/**
 * The durable feads sink for the workspace-state contract.
 *
 * It writes two independent things:
 *
 * 1. **Workspace binding**, whenever a record names an epic — `update(issue_id=<epic>,
 *    workspace_dir, session_id, host)`, which merges those three keys into the issue's
 *    metadata. Every `end_state` binds, because the useful question "which workspace owns
 *    this epic?" has nothing to do with how a given turn ended, and a `complete` turn is
 *    the most common one. One write per (session, epic): the values do not change within a
 *    session, so repeating it every turn would be pure noise on the board.
 * 2. **The awaiting-human pair** — the comment `[workspace-state] awaiting-human:
 *    <question>` on the session epic, plus epic status `blocked`. That status is deliberate
 *    rather than a label: Racoon's sweeper keys on feads *status*, skips `blocked` in its
 *    frequent sweep with a recorded reason, and quotes the pending question, so an owner
 *    sees what is being waited on. `complete`, `mid-work`, and `blocked-approval` write
 *    neither, because a comment per completed turn is noise.
 *
 * Transport is feads' MCP surface, not its REST API: `/api/flares` is the only board
 * mutation exposed over REST, and comments and status live behind MCP `comment` / `update`.
 * Both route by the issue id's prefix, so no board has to be selected first.
 *
 * Every failure is swallowed. A session must never fail, stall, or report differently
 * because the board was unreachable.
 */

const DEFAULT_FEADS_URL = "http://127.0.0.1:8788";
/** Bounds one MCP request; the whole sink can therefore cost at most a few of these. */
const REQUEST_TIMEOUT_MS = 4_000;
/** Cap on a response body read, so a wedged endpoint cannot stream unbounded into memory. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const PROTOCOL_VERSION = "2024-11-05";

export const AWAITING_COMMENT_PREFIX = "[workspace-state] awaiting-human:";

/**
 * How many times one epic's binding write is attempted per session.
 *
 * A bind is worth retrying — the endpoint may have been down for a turn — but not
 * indefinitely: a feads that rejects the binding parameters outright (a deployment predating
 * them) would otherwise be asked again on every turn for the life of the session.
 */
const MAX_BIND_ATTEMPTS = 3;

function mcpUrl(): string {
	return `${(process.env.FEADS_URL ?? DEFAULT_FEADS_URL).replace(/\/$/, "")}/mcp`;
}

/** Comment text for an awaiting-human record. Exact wording is contract, not preference. */
export function awaitingComment(question: string | undefined): string {
	return `${AWAITING_COMMENT_PREFIX} ${question ?? ""}`.trimEnd();
}

export interface McpSession {
	url: string;
	token: string;
	sessionId: string | undefined;
}

/**
 * Read at most MAX_RESPONSE_BYTES of a response body, then stop reading.
 *
 * Streamed off the body rather than via `response.text()`: text() buffers the whole thing
 * first, so truncating afterwards bounds what is returned but not what was allocated, and
 * a wedged endpoint could still stream unbounded into memory. Cancelling the reader also
 * releases the connection instead of waiting for an SSE stream that will not end.
 */
async function readBounded(response: Response): Promise<string> {
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let read = 0;
	let text = "";
	try {
		while (read < MAX_RESPONSE_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const take = value.subarray(0, MAX_RESPONSE_BYTES - read);
			read += take.byteLength;
			text += decoder.decode(take, { stream: true });
		}
		text += decoder.decode();
	} catch {
		// A truncated read is handled the same way as an unparseable one: not a success.
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return text;
}

async function post(session: McpSession, payload: unknown): Promise<Response> {
	return fetch(session.url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${session.token}`,
			"Content-Type": "application/json",
			// The streamable-HTTP transport rejects a client that does not accept both.
			Accept: "application/json, text/event-stream",
			...(session.sessionId ? { "mcp-session-id": session.sessionId } : {}),
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

/** Open one MCP session, or undefined when the endpoint did not complete the handshake. */
async function open(token: string): Promise<McpSession | undefined> {
	const session: McpSession = { url: mcpUrl(), token, sessionId: undefined };
	const response = await post(session, {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "phi-workspace-state", version: "1" },
		},
	});
	if (!response.ok) return undefined;
	// Drain the handshake body so the connection can be reused rather than reset.
	await readBounded(response);
	const sessionId = response.headers.get("mcp-session-id");
	if (!sessionId) return undefined;
	session.sessionId = sessionId;
	const initialized = await post(session, { jsonrpc: "2.0", method: "notifications/initialized" });
	await readBounded(initialized);
	return session;
}

async function close(session: McpSession): Promise<void> {
	await fetch(session.url, {
		method: "DELETE",
		headers: {
			Authorization: `Bearer ${session.token}`,
			Accept: "application/json, text/event-stream",
			...(session.sessionId ? { "mcp-session-id": session.sessionId } : {}),
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	}).catch(() => undefined);
}

/**
 * Whether a tools/call answered without an error.
 *
 * The body is either a JSON-RPC object or SSE frames wrapping one, and a tool failure is
 * reported two different ways (a JSON-RPC `error`, or `isError` inside the result). Both
 * are treated as failure; anything unparseable is also failure, because the sink may not
 * claim a write it cannot see.
 *
 * Which framing it is comes from `content-type`, not from the bytes: sniffing for `data:`
 * misreads a plain-JSON reply whose *content* contains that substring — a comment quoting
 * one, say — as SSE, and then finds no frames and reports failure. On the status write that
 * false negative is worse than pessimistic, because the sink then never records the epic it
 * did block and never restores it. With no `content-type` at all, JSON is tried first and
 * SSE frames second, so both framings still parse without either being guessed from content.
 */
export function callSucceeded(body: string, contentType?: string | null): boolean {
	const type = (contentType ?? "").toLowerCase();
	const frames = (): string[] =>
		body
			.split(/\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim());
	let candidates: string[];
	if (type.includes("text/event-stream")) candidates = frames();
	else if (type.includes("application/json")) candidates = [body.trim()];
	else candidates = [body.trim(), ...frames()];
	for (const candidate of candidates) {
		if (candidate.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const message = parsed as { error?: unknown; result?: { isError?: unknown } };
		if (message.error !== undefined) return false;
		if (message.result === undefined) continue;
		return message.result.isError !== true;
	}
	return false;
}

async function callTool(session: McpSession, name: string, args: Record<string, unknown>): Promise<boolean> {
	const response = await post(session, {
		jsonrpc: "2.0",
		id: Date.now(),
		method: "tools/call",
		params: { name, arguments: args },
	});
	const body = await readBounded(response);
	return response.ok && callSucceeded(body, response.headers.get("content-type"));
}

export type SinkOutcome = { blocked: boolean; error?: string };
export type BindOutcome = { bound: boolean; error?: string };

/**
 * Every queued board write, serialized. Module-level so two sink registrations in one
 * process (a session restart) cannot interleave writes to the same epic.
 */
let pendingWork: Promise<unknown> = Promise.resolve();

/**
 * The generation of the newest sink registration.
 *
 * Sinks are displaced, not stacked: a reload registers a new one, and the previous one's
 * still-queued writes hold a credential this session may no longer have (or may have lost
 * entirely, in the tokenless case). Queued work therefore checks its own generation when it
 * runs, so displacing a sink cancels its outstanding writes instead of letting them land
 * with a stale token.
 *
 * Bumping this on registration — rather than relying on the disposer — is what makes the
 * guarantee hold in practice: nothing calls the disposer on a reload, the new registration
 * is the only signal. The cost is that a write queued microseconds before a reload is
 * dropped instead of completed, which is the right trade: the alternative to dropping it is
 * either writing with a stale credential, or replaying the still-current record into the new
 * sink and commenting twice on an epic whose first comment already landed.
 */
let sinkGeneration = 0;

/**
 * Store subscription key. One sink per process: extensions reload on session replacement,
 * and two live sinks would write the same comment twice and race each other's status writes.
 */
const SUBSCRIBER_KEY = "feads-agent";

/**
 * Write an awaiting-human record to its epic: comment, then status `blocked`.
 *
 * Returns whether the status write landed, which is what the caller needs in order to
 * restore `in_progress` on the next turn — and only for a status *it* set, so a `blocked`
 * that a human or another agent put there is never silently undone.
 */
export async function publishAwaitingHuman(options: {
	token: string;
	record: WorkspaceStateRecord;
}): Promise<SinkOutcome> {
	const epic = options.record.feads?.epic;
	if (!epic) return { blocked: false, error: "record carries no feads epic" };
	let session: McpSession | undefined;
	try {
		session = await open(options.token);
		if (!session) return { blocked: false, error: "feads MCP handshake failed" };
		const commented = await callTool(session, "comment", {
			issue_id: epic,
			text: awaitingComment(options.record.question),
		});
		const blocked = await callTool(session, "update", { issue_id: epic, status: "blocked" });
		if (!commented && !blocked) return { blocked: false, error: "feads rejected the comment and the status write" };
		if (!commented) return { blocked, error: "feads rejected the comment" };
		if (!blocked) return { blocked: false, error: "feads rejected the status write" };
		return { blocked: true };
	} catch (error) {
		return { blocked: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (session) await close(session);
	}
}

/**
 * Bind an epic to the workspace, session, and host the record came from.
 *
 * Parameter names are feads', not phi's: `update` merges `workspace_dir`, `session_id`, and
 * `host` into the issue's metadata per key, so repeating the call is safe and other metadata
 * (artifact claims) survives. A feads that predates those parameters rejects the call, which
 * is reported like any other rejection and changes nothing about the turn.
 */
export async function bindWorkspace(options: { token: string; record: WorkspaceStateRecord }): Promise<BindOutcome> {
	const epic = options.record.feads?.epic;
	if (!epic) return { bound: false, error: "record carries no feads epic" };
	let session: McpSession | undefined;
	try {
		session = await open(options.token);
		if (!session) return { bound: false, error: "feads MCP handshake failed" };
		const bound = await callTool(session, "update", {
			issue_id: epic,
			workspace_dir: options.record.cwd,
			session_id: options.record.session_id,
			host: options.record.host,
		});
		return bound ? { bound: true } : { bound: false, error: "feads rejected the workspace binding" };
	} catch (error) {
		return { bound: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (session) await close(session);
	}
}

/** Return an epic this extension set to `blocked` back to `in_progress`. */
export async function restoreInProgress(options: { token: string; epic: string }): Promise<SinkOutcome> {
	let session: McpSession | undefined;
	try {
		session = await open(options.token);
		if (!session) return { blocked: true, error: "feads MCP handshake failed" };
		const restored = await callTool(session, "update", { issue_id: options.epic, status: "in_progress" });
		// blocked reports the state the epic is believed to be left in: a failed restore
		// leaves it blocked, so the next turn tries again rather than forgetting.
		return restored ? { blocked: false } : { blocked: true, error: "feads rejected the status write" };
	} catch (error) {
		return { blocked: true, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (session) await close(session);
	}
}

/**
 * Wire the sink to the emitter's store and to `agent_start`.
 *
 * Writes are serialized on one chain and awaited nowhere: a comment that lands a second
 * after the turn ends is fine, a turn that waits on the board is not. `/no-feads` is
 * honoured on both sides, so a disabled session makes no request at all.
 */
export function registerWorkspaceStateSink(pi: ExtensionAPI, options: { token: string | undefined }): () => void {
	// Registering even without a token is what makes the replacement total: a tokenless reload
	// displaces the previous sink rather than leaving it subscribed with a credential this
	// session no longer has.
	const token = options.token;
	const generation = ++sinkGeneration;
	let disposed = false;
	// The epics this sink itself moved to `blocked`; only its own writes are ever restored, so a
	// `blocked` set by a human or another agent is never silently undone. A set rather than one
	// slot: a restore that keeps failing stays queued for retry, and a second epic blocking in
	// the meantime must not evict it.
	const blockedEpics = new Set<string>();
	// Epics whose binding landed, and how many times each was attempted, so the binding write
	// happens once per (session, epic) and a rejecting endpoint is not asked forever.
	const boundEpics = new Set<string>();
	const bindAttempts = new Map<string, number>();
	const enqueue = (work: () => Promise<void>): void => {
		pendingWork = pendingWork
			// Checked when the work runs, not when it is queued: that is the whole point — a write
			// queued just before a reload must not execute with the displaced sink's token.
			.then(() => (disposed || generation !== sinkGeneration ? undefined : work()))
			.catch(() => undefined);
	};

	const unsubscribe = workspaceStateStore.subscribe(SUBSCRIBER_KEY, (record) => {
		if (!token || !record) return;
		if (feadsSessionState.current.disabled) return;
		const epic = record.feads?.epic;
		if (!epic) return;

		// Binding is unconditional in the end state: knowing the epic is enough.
		const attempts = bindAttempts.get(epic) ?? 0;
		if (!boundEpics.has(epic) && attempts < MAX_BIND_ATTEMPTS) {
			// Counted here rather than inside the queued work, so two records arriving before the
			// first bind runs cannot both queue an attempt for the same epic.
			bindAttempts.set(epic, attempts + 1);
			enqueue(async () => {
				const outcome = await bindWorkspace({ token, record });
				if (outcome.bound) boundEpics.add(epic);
				if (outcome.error) console.warn(`[feads-agent] workspace-state sink: ${outcome.error}`);
			});
		}

		if (record.end_state !== "awaiting-human") return;
		enqueue(async () => {
			const outcome = await publishAwaitingHuman({ token, record });
			if (outcome.blocked) blockedEpics.add(epic);
			if (outcome.error) console.warn(`[feads-agent] workspace-state sink: ${outcome.error}`);
		});
	});

	pi.on("agent_start", () => {
		if (!token || blockedEpics.size === 0 || feadsSessionState.current.disabled) return;
		for (const epic of [...blockedEpics]) {
			blockedEpics.delete(epic);
			enqueue(async () => {
				const outcome = await restoreInProgress({ token, epic });
				// A failed restore leaves the epic blocked on the board; remember it so the next turn
				// retries rather than stranding it on a question that is no longer pending.
				if (outcome.blocked) blockedEpics.add(epic);
				if (outcome.error) console.warn(`[feads-agent] workspace-state sink: ${outcome.error}`);
			});
		}
	});

	// Disposing cancels this sink's queued writes as well as unsubscribing it: an unsubscribed
	// sink with work still in the queue would otherwise keep writing with its old credential.
	return () => {
		disposed = true;
		unsubscribe();
	};
}

export const __testing = {
	mcpUrl,
	callTool,
	REQUEST_TIMEOUT_MS,
	MAX_RESPONSE_BYTES,
	MAX_BIND_ATTEMPTS,
	/** Await every board write the sink has queued so far. */
	drain: async (): Promise<void> => {
		await pendingWork;
		await pendingWork;
	},
};
