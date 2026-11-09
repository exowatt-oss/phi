/**
 * The overseer's thread registry: one JSON file per overseer session,
 * `<agentDir>/overseer/<overseerSessionId>.json` (directory 0700, file 0600, written atomically).
 * Restored on `session_start` and re-matched against the hub, where a thread's
 * `summary.overseer.sessionId` names its overseer, so a restarted overseer finds its threads again.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummary } from "../../remote/protocol.ts";
import { launchPaths } from "./backends.ts";
import { oneLine, shortIds } from "./format.ts";
import { DEFAULT_WATCH, type ThreadBackend, type ThreadRecord, type ThreadState, type WatchConfig } from "./types.ts";

const FILE_VERSION = 1;
const BACKENDS = new Set<ThreadBackend>(["forca", "tmux", "headless", "external"]);
const STATES = new Set<ThreadState>(["running", "exited", "closed"]);

export function registryPath(agentDir: string, overseerSessionId: string): string {
	return join(agentDir, "overseer", `${overseerSessionId}.json`);
}

function normalizeWatch(value: unknown): WatchConfig {
	const watch = (value && typeof value === "object" ? value : {}) as Partial<WatchConfig>;
	const minutes = (n: unknown, fallback: number) =>
		typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
	return {
		onIdle: typeof watch.onIdle === "boolean" ? watch.onIdle : DEFAULT_WATCH.onIdle,
		stallMinutes: minutes(watch.stallMinutes, DEFAULT_WATCH.stallMinutes),
		heartbeatMinutes: minutes(watch.heartbeatMinutes, DEFAULT_WATCH.heartbeatMinutes),
	};
}

function validRecord(value: unknown): ThreadRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as ThreadRecord;
	if (
		typeof record.name !== "string" ||
		typeof record.sessionId !== "string" ||
		!record.sessionId ||
		typeof record.cwd !== "string" ||
		!BACKENDS.has(record.backend) ||
		!STATES.has(record.state)
	)
		return undefined;
	return {
		...record,
		createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
		registered: record.registered === true,
		watch: normalizeWatch(record.watch),
	};
}

/** `target` among `items`: exact name (case-insensitive), exact id, then unique id prefix. */
export function resolveTarget<T>(
	target: string,
	items: readonly T[],
	keys: { name: (item: T) => string; id: (item: T) => string; describe: (item: T) => string },
	label = "thread",
): T {
	const key = target.trim();
	if (!key) throw new Error(`target is required: a ${label} name, session id or unique id prefix.`);
	const lower = key.toLowerCase();
	const byName = items.filter((item) => keys.name(item).toLowerCase() === lower);
	if (byName.length === 1) return byName[0];
	const byId = items.filter((item) => keys.id(item).toLowerCase() === lower);
	if (byId.length === 1) return byId[0];
	const byPrefix = items.filter((item) => keys.id(item).toLowerCase().startsWith(lower));
	if (byName.length === 0 && byPrefix.length === 1) return byPrefix[0];
	const ambiguous = byName.length > 1 ? byName : byPrefix.length > 1 ? byPrefix : [];
	if (ambiguous.length > 0) {
		throw new Error(
			`Ambiguous ${label} "${target}": ${ambiguous.map(keys.describe).join("; ")}. Use a full session id or a longer prefix.`,
		);
	}
	const known = items.map(keys.describe).join("; ");
	throw new Error(`No ${label} "${target}". ${known ? `Known: ${known}.` : `There are no ${label}s.`}`);
}

/** Copy what the hub knows about a live thread into its record. */
export function applySummary(record: ThreadRecord, summary: SessionSummary, now: number): void {
	record.registered = true;
	record.lastSeenAt = now;
	record.lastStatus = summary.status;
	record.lastActivityAt = summary.lastActivityAt;
	record.pid = summary.pid;
	record.cwd = summary.cwd || record.cwd;
	if (summary.model) record.model = `${summary.model.provider}/${summary.model.id}`;
	if (summary.thinkingLevel) record.thinking = summary.thinkingLevel;
	if (summary.lastText) record.lastText = summary.lastText;
	if (summary.lastError) record.lastError = summary.lastError;
	else delete record.lastError;
	if (summary.usage?.costUsd !== undefined) record.costUsd = summary.usage.costUsd;
	if (summary.usage?.contextPercent !== undefined) record.contextPercent = summary.usage.contextPercent;
}

/** Backend of a session found in the hub but not started through this registry. */
export function backendOf(summary: SessionSummary): ThreadBackend {
	if (summary.kind === "headless") return "headless";
	if (summary.tmux) return "tmux";
	return "external";
}

export class ThreadRegistry {
	threads: ThreadRecord[] = [];
	readonly file: string;
	readonly overseerSessionId: string;
	private readonly agentDir: string;

	constructor(agentDir: string, overseerSessionId: string) {
		this.agentDir = agentDir;
		this.overseerSessionId = overseerSessionId;
		this.file = registryPath(agentDir, overseerSessionId);
	}

	/** Load the file; a missing or unreadable file leaves the registry empty. */
	load(): void {
		let parsed: { threads?: unknown };
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8")) as { threads?: unknown };
		} catch {
			this.threads = [];
			return;
		}
		const list = Array.isArray(parsed?.threads) ? parsed.threads : [];
		this.threads = list.map(validRecord).filter((record): record is ThreadRecord => record !== undefined);
	}

	/** Atomic write: temp file (0600) then rename, in a 0700 directory. */
	save(): void {
		const dir = join(this.file, "..");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		try {
			chmodSync(dir, 0o700);
		} catch {
			// best effort
		}
		const temp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
		const body = { version: FILE_VERSION, overseerSessionId: this.overseerSessionId, threads: this.threads };
		try {
			writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			chmodSync(temp, 0o600);
			renameSync(temp, this.file);
		} finally {
			try {
				unlinkSync(temp);
			} catch {
				// renamed
			}
		}
	}

	/** Threads that are not closed. */
	active(): ThreadRecord[] {
		return this.threads.filter((record) => record.state !== "closed");
	}

	bySessionId(sessionId: string): ThreadRecord | undefined {
		return this.threads.find((record) => record.sessionId === sessionId);
	}

	/** Throws when a live thread already has this name (case-insensitive). */
	assertNameFree(name: string): void {
		const taken = this.active().find((record) => record.name.toLowerCase() === name.toLowerCase());
		if (taken) {
			throw new Error(
				`A thread named "${name}" already exists (${taken.sessionId.slice(0, 8)}, ${taken.state}). Pick another name, or close it first.`,
			);
		}
	}

	add(record: ThreadRecord): void {
		this.threads = this.threads.filter((existing) => existing.sessionId !== record.sessionId);
		this.threads.push(record);
	}

	describe(record: ThreadRecord): string {
		const ids = shortIds(this.threads.map((thread) => thread.sessionId));
		return `${oneLine(record.name, 40)} (${ids.get(record.sessionId) ?? record.sessionId.slice(0, 8)}, ${record.state})`;
	}

	/**
	 * A thread by name, session id or unique id prefix. Live (non-closed) threads are searched
	 * first; closed ones only when `includeClosed` and nothing live matched.
	 */
	resolve(target: string, options: { includeClosed?: boolean } = {}): ThreadRecord {
		const keys = {
			name: (record: ThreadRecord) => record.name,
			id: (record: ThreadRecord) => record.sessionId,
			describe: (record: ThreadRecord) => this.describe(record),
		};
		try {
			return resolveTarget(target, this.active(), keys);
		} catch (error) {
			const closed = this.threads.filter((record) => record.state === "closed");
			if (!options.includeClosed || closed.length === 0 || !/^No thread/.test((error as Error).message)) throw error;
			return resolveTarget(target, closed, keys);
		}
	}

	/** A name not used by a live thread: `name`, `name-2`, `name-3`, … */
	freeName(name: string): string {
		const taken = new Set(this.active().map((record) => record.name.toLowerCase()));
		if (!taken.has(name.toLowerCase())) return name;
		for (let n = 2; ; n++) if (!taken.has(`${name}-${n}`.toLowerCase())) return `${name}-${n}`;
	}

	/**
	 * Re-match against the hub: live sessions whose `summary.overseer.sessionId` names this overseer
	 * but that the registry does not know (a lost or older registry file) are added back, silently.
	 * Transitions of known threads are the monitor's job. Returns the records added.
	 */
	/**
	 * A FORCA/tmux thread's launcher, when it is still on disk: kept on a re-added record so a
	 * later close removes the launch files. (The FORCA tab handle is not recoverable.)
	 */
	private launcherOf(sessionId: string): { launcher: string } | undefined {
		try {
			const { launcher } = launchPaths(this.agentDir, sessionId);
			return existsSync(launcher) ? { launcher } : undefined;
		} catch {
			return undefined;
		}
	}

	rematch(sessions: readonly SessionSummary[], now: number): ThreadRecord[] {
		const added: ThreadRecord[] = [];
		for (const summary of sessions) {
			if (summary.overseer?.sessionId !== this.overseerSessionId || this.bySessionId(summary.sessionId)) continue;
			const record: ThreadRecord = {
				name: this.freeName(summary.overseer.thread || summary.name),
				sessionId: summary.sessionId,
				backend: backendOf(summary),
				cwd: summary.cwd,
				...(summary.tmux ? { tmuxSession: summary.tmux.session } : {}),
				...(this.launcherOf(summary.sessionId) ?? {}),
				createdAt: summary.startedAt,
				watch: { ...DEFAULT_WATCH },
				state: "running",
				registered: true,
			};
			applySummary(record, summary, now);
			if (summary.lastError) record.notifiedError = summary.lastError;
			this.threads.push(record);
			added.push(record);
		}
		return added;
	}
}
