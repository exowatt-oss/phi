/**
 * Durable, secret-free audit trail for MCP OAuth.
 *
 * Why this exists: every interesting thing OAuth does — renewing a token,
 * finding another process already renewed it, having a refresh token refused,
 * opening a browser — happened only as a transient session notice. When someone
 * reports "it keeps asking me to log in", there was nothing left on disk to
 * explain which of those it was, in which process, or in what order. With a
 * dozen phi sessions sharing one credential store, the ordering across
 * processes *is* the diagnosis.
 *
 * What is recorded: endpoints, OAuth error codes, HTTP statuses, expiry times,
 * process ids, and short salted-free SHA-256 prefixes of tokens. A fingerprint
 * is one-way and truncated, so it cannot reconstruct a credential, but it is
 * stable enough to prove "process A refreshed, then process B presented the
 * token A had already rotated away".
 *
 * Never recorded: access tokens, refresh tokens, authorization codes, PKCE
 * verifiers, client secrets. `fingerprint()` is the only way a secret-derived
 * value reaches this file.
 */

import { createHmac, randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MCP_AUTH_DIR_ENV_VAR, MCP_REMOTE_CONFIG_DIR_ENV_VAR } from "./store.ts";

/** Override the log location, or set to `off`/`0`/`false` to record nothing. */
export const AUTH_LOG_ENV_VAR = "PHI_MCP_AUTH_LOG";

export const DEFAULT_AUTH_LOG_NAME = "oauth-events.jsonl";

/** Rotate rather than grow without bound; one previous generation is kept. */
export const AUTH_LOG_MAX_BYTES = 4 * 1024 * 1024;

export type OAuthAuditEventName =
	| "token.sent"
	| "token.expired"
	| "token.adopted"
	| "unauthorized"
	| "refresh.start"
	| "refresh.ok"
	| "refresh.failed"
	| "tokens.discarded"
	| "login.waiting"
	| "login.adopted"
	| "login.timeout"
	| "login.start"
	| "login.ok"
	| "login.failed"
	| "client.registered";

export interface OAuthAuditEvent {
	event: OAuthAuditEventName;
	server: string;
	/** Resource server URL; host and path only, never a query string. */
	serverUrl?: string;
	/** md5 key of the credential store entry, so two processes can be tied together. */
	key?: string;
	/** Directory the credentials were resolved to — a stale one is its own bug. */
	dir?: string;
	/** `expired` or `unauthorized`: what triggered a recovery. */
	mode?: string;
	accessToken?: string;
	refreshToken?: string;
	/** Fingerprint of the refresh token received back, to make rotation visible. */
	newRefreshToken?: string;
	rotated?: boolean;
	expiresAt?: string;
	/** Seconds of life the server granted, as reported. */
	expiresIn?: number;
	errorCode?: string;
	status?: number;
	detail?: string;
	waitedMs?: number;
}

export interface RecordedEvent extends OAuthAuditEvent {
	ts: string;
	pid: number;
}

/**
 * One-way, truncated, and keyed: enough to correlate across processes, useless
 * as a credential.
 *
 * The key matters. A bare truncated SHA-256 of a credential is an offline
 * verifier: against a low-entropy token — a six-digit code, a short opaque
 * handle — anyone holding the log could enumerate candidates and recover the
 * real value. A machine-local secret removes that: without the key file (0600,
 * beside the credential store) the fingerprints are not checkable against
 * guesses at all. Correlation is unaffected, because every process on this
 * machine reads the same key.
 */
export function fingerprint(secret: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (!secret) return undefined;
	try {
		return createHmac("sha256", fingerprintKey(env)).update(secret).digest("hex").slice(0, 12);
	} catch {
		// A diagnostic must never be the thing that fails an operation — and this is
		// often called while a cross-process lock is held.
		return undefined;
	}
}

let cachedKey: Uint8Array | undefined;
let cachedKeyPath: string | undefined;

/** Read, or create once, the machine-local fingerprint key. */
function fingerprintKey(env: NodeJS.ProcessEnv): Uint8Array {
	const logPath = auditLogPath(env);
	// With recording off there is nowhere a key belongs: writing one would drop a
	// `.key` file in whatever the process's working directory happens to be.
	const path = logPath === undefined ? undefined : `${logPath}.key`;
	if (cachedKey && cachedKeyPath === path) return cachedKey;
	let key: Uint8Array = randomBytes(32);
	if (path !== undefined) {
		try {
			const directory = path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || ".";
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			key = readKey(path) ?? claimKey(path, key);
		} catch {
			// No usable key file: keep the per-process key. Fingerprints then correlate
			// within this process only, which is degraded but never wrong — and never a
			// known constant, which an empty or partial key file would be.
		}
	}
	cachedKey = key;
	cachedKeyPath = path;
	return key;
}

/** An existing key, or undefined if there is nothing trustworthy there yet. */
function readKey(path: string): Uint8Array | undefined {
	try {
		const key = readFileSync(path);
		// A short read means a racing creator has the file open but has not finished
		// writing it. Treating that as the key would silently weaken every
		// fingerprint, so it counts as "not there yet".
		if (key.length < 32) return undefined;
		if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
		return key;
	} catch {
		return undefined;
	}
}

/** Create the key, or adopt the one a process that got there first wrote. */
function claimKey(path: string, candidate: Uint8Array): Uint8Array {
	// The suffix is random, not just the pid: a pid is unique per namespace, and
	// two processes sharing a directory across namespaces would otherwise truncate
	// each other's staging file — which, once linked, is the published key.
	const staging = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		// Write to a private temporary file, then publish it with `link`, which is
		// atomic *and* refuses to replace an existing name. `rename` would satisfy
		// only the first half: two processes that both saw no key would each rename
		// over the other, and would then be fingerprinting under different keys
		// forever — which silently destroys the cross-process correlation this log
		// exists for.
		writeFileSync(staging, candidate, { flag: "wx", mode: 0o600 });
		// Two rounds: the first publishes or adopts; the second repairs a file that
		// exists but is not a usable key (truncated by an older phi, or a filesystem
		// that cannot hard-link) rather than leaving every process on its own key.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				linkSync(staging, path);
			} catch {
				// Somebody published first, or links are unsupported here.
			}
			const published = readKey(path);
			if (published) return published;
			if (attempt === 0) removeUnusableKey(path);
		}
		// Links are not available on this filesystem. Publishing non-atomically is
		// worse than not publishing: it is the overwrite race in a different shape.
		// A per-process key still correlates this process's own events.
		return candidate;
	} catch {
		return candidate;
	} finally {
		try {
			rmSync(staging, { force: true });
		} catch {
			// Best effort: a leftover temp file is harmless.
		}
	}
}

/**
 * Clear a key file that exists but is too short to be one.
 *
 * Checking the size and then unlinking would be a race of its own: a peer can
 * publish a real key in between, and this would delete it. Move it aside first
 * and judge what was actually moved — if it turns out to be a usable key, put it
 * straight back.
 */
function removeUnusableKey(path: string): void {
	const quarantine = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.old`;
	try {
		if (statSync(path).size >= 32) return;
		renameSync(path, quarantine);
		if (statSync(quarantine).size >= 32) {
			try {
				linkSync(quarantine, path);
			} catch {
				// Somebody published in the meantime; theirs wins either way.
			}
		}
	} catch {
		// Nothing there, or not ours to move.
	} finally {
		try {
			rmSync(quarantine, { force: true });
		} catch {
			// Best effort.
		}
	}
}

/** Resolve the log path, or undefined when logging is switched off. */
export function auditLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const configured = env[AUTH_LOG_ENV_VAR]?.trim();
	if (configured && ["off", "0", "false", "no"].includes(configured.toLowerCase())) return undefined;
	if (configured) return configured;
	const base = env[MCP_AUTH_DIR_ENV_VAR] ?? env[MCP_REMOTE_CONFIG_DIR_ENV_VAR] ?? join(homedir(), ".mcp-auth");
	return join(base, DEFAULT_AUTH_LOG_NAME);
}

/**
 * Append one event. Synchronous and best-effort by design: an OAuth failure is
 * exactly when the process may be about to exit, and a diagnostic that loses the
 * last line before a crash is the line that mattered. Never throws — a broken
 * log must not break a session.
 */
export function recordOAuthEvent(event: OAuthAuditEvent, env: NodeJS.ProcessEnv = process.env): void {
	const path = auditLogPath(env);
	if (!path) return;
	const record: RecordedEvent = { ts: new Date().toISOString(), pid: process.pid, ...event };
	try {
		const directory = path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || ".";
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		rotateIfLarge(path);
		appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		// `mode` applies only on creation, so a log that already existed with looser
		// permissions would stay readable by others. Correct it rather than trust it.
		if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
	} catch {
		// Diagnostics are never worth failing a session for.
	}
}

/** Stale rotation guards are stolen rather than obeyed: a crash must not wedge the log. */
const ROTATE_GUARD_STALE_MS = 60_000;

function rotateIfLarge(path: string): void {
	let oversized: number;
	try {
		const before = statSync(path);
		if (before.size < AUTH_LOG_MAX_BYTES) return;
		oversized = before.ino;
	} catch {
		// Missing file is the normal first-write case.
		return;
	}
	// Rotation is the one part of writing that is not idempotent, so it runs under
	// an exclusive guard. Re-checking size before the rename is not enough on its
	// own: two processes can both pass the check, and the second then renames the
	// first's *fresh* file over the generation it was meant to preserve.
	const guard = `${path}.rotating`;
	const claim = claimRotateGuard(guard);
	if (!claim) return;
	try {
		const current = statSync(path);
		if (current.size < AUTH_LOG_MAX_BYTES) return;
		// Two processes can both decide an abandoned guard is stale and both claim
		// it. Identity measured *before* the guard is the backstop: if this is no
		// longer the file this writer found oversized, somebody has already rotated,
		// and renaming now would move their fresh log over the generation it was
		// meant to preserve.
		if (current.ino !== oversized) return;
		renameSync(path, `${path}.1`);
		// The rotated generation holds the same events and needs the same
		// permissions; a log that predated this code could have arrived loose.
		if ((statSync(`${path}.1`).mode & 0o077) !== 0) chmodSync(`${path}.1`, 0o600);
	} catch {
		// Losing a rotation only means the log grows a little further.
	} finally {
		try {
			// Only if it is still ours: a stale-steal race means the guard sitting
			// there may belong to a later rotator, and removing it would let a third
			// writer in behind them.
			if (statSync(guard).ino === claim.ino) rmSync(guard, { force: true });
		} catch {
			// Next writer will treat it as stale.
		}
	}
}

/** `wx` is an atomic create-if-absent, so exactly one writer rotates. */
function claimRotateGuard(guard: string): { ino: number } | undefined {
	try {
		closeSync(openSync(guard, "wx", 0o600));
		return { ino: statSync(guard).ino };
	} catch {
		try {
			// A guard left behind by a killed process must not stop rotation forever.
			const abandoned = statSync(guard);
			if (Date.now() - abandoned.mtimeMs < ROTATE_GUARD_STALE_MS) return undefined;
			// Remove only the guard actually observed to be stale, so two processes
			// that both saw it cannot each delete the other's replacement.
			if (statSync(guard).ino !== abandoned.ino) return undefined;
			rmSync(guard, { force: true });
			closeSync(openSync(guard, "wx", 0o600));
			return { ino: statSync(guard).ino };
		} catch {
			return undefined;
		}
	}
}

export interface ReadOAuthEventsOptions {
	/** Only this server, matched case-insensitively. */
	server?: string;
	/** Most recent events to return. */
	limit?: number;
	/** Epoch milliseconds; events older than this are dropped. */
	since?: number;
	env?: NodeJS.ProcessEnv;
}

/**
 * Read back the trail, newest last. Both generations are read so a rotation in
 * the middle of the window under investigation does not hide half of it.
 */
export async function readOAuthEvents(options: ReadOAuthEventsOptions = {}): Promise<RecordedEvent[]> {
	const path = auditLogPath(options.env ?? process.env);
	if (!path) return [];
	const contents = await Promise.all([
		readFile(`${path}.1`, "utf8").catch(() => ""),
		readFile(path, "utf8").catch(() => ""),
	]);
	const events: RecordedEvent[] = [];
	// Split per generation, never across them: if the rotated file was truncated
	// mid-line, joining first would glue its remnant onto the newer file's first
	// line and lose a real event along with the damaged one.
	for (const line of contents.flatMap((generation) => generation.split("\n"))) {
		if (!line.trim()) continue;
		const parsed = parseEvent(line);
		if (!parsed) continue;
		if (options.server && parsed.server?.toLowerCase() !== options.server.toLowerCase()) continue;
		if (options.since !== undefined && Date.parse(parsed.ts) < options.since) continue;
		events.push(parsed);
	}
	return options.limit === undefined ? events : events.slice(-options.limit);
}

/** A half-written last line is normal with concurrent writers; skip it rather than failing the read. */
function parseEvent(line: string): RecordedEvent | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object") return undefined;
		const record = value as RecordedEvent;
		return typeof record.ts === "string" && typeof record.event === "string" ? record : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Origin only.
 *
 * Query and fragment obviously carry codes and verifiers, but the *path* can
 * too: a server configured as `https://host/mcp/<token>` puts a bearer in the
 * URL, and several vendors do exactly that. The origin is all this log needs to
 * tell servers apart — the credential-store key on every event identifies the
 * exact entry — so the path is dropped rather than trusted.
 */
export function safeUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}
