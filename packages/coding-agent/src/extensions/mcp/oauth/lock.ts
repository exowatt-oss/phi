/**
 * Cross-process lock around the interactive part of an OAuth login.
 *
 * Fifteen phi sessions starting at once against a server nobody has logged into
 * yet must open ONE browser tab, not fifteen. One process wins the lock and runs
 * the flow; the others wait for its tokens to land on disk and then use them.
 *
 * Validity is decided by holder liveness, never by a wall clock. mcp-remote's
 * equivalent expires a lock after 30 minutes, which is wrong in both directions:
 * a login the user has not finished yet gets stolen, while a lock left by a
 * process that was killed 20 minutes ago still blocks everyone. Here a lock is
 * valid exactly while its holder is alive — pid reachable, and, once it has
 * published a callback port, that port still accepting connections.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { asRecord, readNumber, readString, safeJsonParse } from "../json.ts";
import type { CredentialPaths } from "./store.ts";

/** How often a waiter re-checks for tokens and for the holder still being alive. */
export const DEFAULT_LOCK_POLL_MS = 250;

/** Upper bound on waiting for somebody else's browser login before giving up. */
export const DEFAULT_LOCK_WAIT_MS = 5 * 60_000;

const PROBE_TIMEOUT_MS = 300;

/** Bound the stale-cleanup/retry cycle so a pathological race cannot spin. */
const MAX_ACQUIRE_ATTEMPTS = 8;

/**
 * How long an existing but unreadable lock is given to become readable.
 *
 * Creation is atomic (`wx`) but the record lands in a *second* write, so a live
 * lock is briefly an empty file — and `publishPort` truncates it to empty again
 * later. A waiter that read one of those windows used to conclude the lock named
 * no holder, delete it, and become a second holder: two browser prompts, two
 * client registrations, and one session left presenting tokens the other had
 * already replaced. An empty-but-present lock is therefore only broken if it
 * *stays* unreadable. The cost is bounded and one-off: a lock left empty by a
 * process that died mid-creation delays its cleanup by this much, once.
 */
const LOCK_SETTLE_MS = 2_000;

export interface LoginLockHolder {
	/** Record the callback port, so a waiter can tell a live flow from a dead one. */
	publishPort(port: number): Promise<void>;
	release(): Promise<void>;
}

export type LockAcquisition =
	| { kind: "held"; holder: LoginLockHolder }
	/** Another process finished a login while we waited; its tokens are on disk. */
	| { kind: "tokens" }
	/** Somebody is still logging in and we ran out of patience. */
	| { kind: "timeout" };

export interface AcquireLoginLockOptions {
	/** True once this server has usable tokens; ends a wait. */
	hasTokens: () => Promise<boolean>;
	signal?: AbortSignal;
	pollIntervalMs?: number;
	waitTimeoutMs?: number;
	/** Injected in tests; the real one opens a TCP connection to a loopback port. */
	probePort?: (port: number) => Promise<boolean>;
	now?: () => number;
}

interface LockRecord {
	pid?: number;
	port?: number;
	timestamp?: number;
	host?: string;
	/** Distinguishes concurrent holders inside one process; see `localHolders`. */
	agent?: string;
}

/**
 * Locks this process currently holds. One process can run several agent sessions
 * against the same server, so "the pid is mine" says nothing about whether the
 * lock is live — this set is what makes that precise, and it also identifies a
 * lock this process abandoned earlier.
 */
const localHolders = new Set<string>();

export async function acquireLoginLock(
	paths: CredentialPaths,
	options: AcquireLoginLockOptions,
): Promise<LockAcquisition> {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOCK_POLL_MS;
	const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_LOCK_WAIT_MS;
	const now = options.now ?? Date.now;
	const probePort = options.probePort ?? probeLoopbackPort;
	const deadline = now() + waitTimeoutMs;

	for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
		if (options.signal?.aborted) return { kind: "timeout" };

		const holder = await tryCreateLock(paths);
		if (holder) return { kind: "held", holder };

		const state = await readLockState(paths.lock, pollIntervalMs, options.signal);
		// A lock that vanished frees the slot: loop round and try to become the holder.
		if (state.kind === "gone") continue;
		// A lock that never became readable, or whose holder is gone, is only in the way.
		if (state.kind === "broken" || !(await isHolderAlive(state.record, probePort))) {
			await rm(paths.lock, { force: true }).catch(() => undefined);
			continue;
		}

		const outcome = await waitForHolder(paths, state.record, {
			hasTokens: options.hasTokens,
			signal: options.signal,
			pollIntervalMs,
			deadline,
			now,
			probePort,
		});
		if (outcome === "tokens") return { kind: "tokens" };
		if (outcome === "timeout") return { kind: "timeout" };
		// "retry": the holder vanished. Loop round and try to become the holder.
	}

	return (await options.hasTokens()) ? { kind: "tokens" } : { kind: "timeout" };
}

/**
 * Read-only lock status for fast control-plane polling. This deliberately avoids
 * the callback-port probe: `mcp status` must not perform network I/O.
 */
export async function isLoginInProgress(paths: CredentialPaths): Promise<boolean> {
	let raw: string;
	try {
		raw = await readFile(paths.lock, "utf8");
	} catch {
		return false;
	}
	const record = parseLockRecord(raw);
	// A newly-created lock is briefly empty while its holder writes the record.
	if (!record) return true;
	if (record.host && record.host !== hostname()) return true;
	if (record.pid === process.pid) return record.agent !== undefined && localHolders.has(record.agent);
	if (!record.pid || !Number.isInteger(record.pid) || record.pid <= 0) return false;
	return isPidAlive(record.pid);
}

/** `wx` makes creation the atomic operation, so exactly one process can win. */
async function tryCreateLock(paths: CredentialPaths): Promise<LoginLockHolder | undefined> {
	await mkdir(dirname(paths.lock), { recursive: true, mode: 0o700 }).catch(() => undefined);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(paths.lock, "wx", 0o600);
	} catch {
		return undefined;
	}

	const agent = randomUUID();
	localHolders.add(agent);
	const write = async (port: number): Promise<void> => {
		const record: LockRecord = { pid: process.pid, port, timestamp: Date.now(), host: hostname(), agent };
		await handle.truncate(0);
		await handle.write(`${JSON.stringify(record, null, 2)}\n`, 0, "utf8");
		await handle.sync().catch(() => undefined);
	};

	// Port 0 means "not listening yet", which a waiter must read as still alive.
	await write(0).catch(() => undefined);

	let released = false;
	return {
		async publishPort(port: number): Promise<void> {
			if (released) return;
			await write(port).catch(() => undefined);
		},
		async release(): Promise<void> {
			if (released) return;
			released = true;
			localHolders.delete(agent);
			await handle.close().catch(() => undefined);
			await rm(paths.lock, { force: true }).catch(() => undefined);
		},
	};
}

/** A present lock is `record` once readable, `broken` if it never becomes readable. */
type LockState = { kind: "record"; record: LockRecord } | { kind: "gone" } | { kind: "broken" };

async function readLockState(path: string, pollIntervalMs: number, signal?: AbortSignal): Promise<LockState> {
	const deadline = Date.now() + LOCK_SETTLE_MS;
	for (;;) {
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			// Missing is decisive; any other read failure is treated as unreadable.
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "gone" } : { kind: "broken" };
		}
		const record = parseLockRecord(raw);
		if (record) return { kind: "record", record };
		if (Date.now() >= deadline) return { kind: "broken" };
		// Poll faster than the caller's interval: this window is sub-millisecond in
		// practice and only widens under load.
		await sleep(Math.min(pollIntervalMs, 25), signal);
	}
}

function parseLockRecord(raw: string): LockRecord | undefined {
	const record = asRecord(safeJsonParse(raw));
	if (!record) return undefined;
	return {
		pid: readNumber(record, "pid"),
		port: readNumber(record, "port"),
		timestamp: readNumber(record, "timestamp"),
		host: readString(record, "host", "hostname"),
		agent: readString(record, "agent"),
	};
}

/**
 * Liveness, in order of confidence: a lock this process wrote is live exactly
 * while it is in `localHolders`, a lock from another machine cannot be judged, a
 * pid that no longer exists is dead, and a published callback port that refuses
 * connections means the flow that owned it is gone.
 */
async function isHolderAlive(record: LockRecord, probePort: (port: number) => Promise<boolean>): Promise<boolean> {
	if (record.pid === process.pid && (!record.host || record.host === hostname())) {
		return record.agent !== undefined && localHolders.has(record.agent);
	}
	if (record.host && record.host !== hostname()) return true;
	if (!record.pid || !Number.isInteger(record.pid) || record.pid <= 0) return false;
	if (!isPidAlive(record.pid)) return false;
	if (!record.port || record.port <= 0) return true;
	return probePort(record.port);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForHolder(
	paths: CredentialPaths,
	record: LockRecord,
	options: {
		hasTokens: () => Promise<boolean>;
		signal?: AbortSignal;
		pollIntervalMs: number;
		deadline: number;
		now: () => number;
		probePort: (port: number) => Promise<boolean>;
	},
): Promise<"tokens" | "retry" | "timeout"> {
	let current = record;
	for (;;) {
		if (options.signal?.aborted) return "timeout";
		if (await options.hasTokens()) return "tokens";

		const latest = await readLockState(paths.lock, options.pollIntervalMs, options.signal);
		// The holder released: it may have written tokens on the way out.
		if (latest.kind === "gone") return (await options.hasTokens()) ? "tokens" : "retry";
		if (latest.kind === "broken") return "retry";
		current = latest.record.pid ? latest.record : current;
		if (!(await isHolderAlive(current, options.probePort))) {
			// One last look: the holder may have written tokens and exited between polls.
			return (await options.hasTokens()) ? "tokens" : "retry";
		}
		if (options.now() >= options.deadline) return "timeout";
		await sleep(options.pollIntervalMs, options.signal);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** A loopback connect is the cheapest proof that a callback server is still up. */
function probeLoopbackPort(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const finish = (alive: boolean): void => {
			socket.destroy();
			resolve(alive);
		};
		socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}
