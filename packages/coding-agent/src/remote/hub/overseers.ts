/**
 * The hub's read-only view of the overseer registry files, `<agentDir>/overseer/<overseerSessionId>.json`
 * (written atomically by `extensions/overseer/registry.ts`). Feeds `SessionSummary.isOverseer` /
 * `threadCounts`, `PastSession.overseer` / `isOverseer` (an inverse index: thread -> overseer) and
 * `overseer.board`.
 *
 * Cheap and robust: async fs only, files re-read only when their mtime / size / inode change, one
 * refresh at a time, files above a size cap and malformed records skipped. A file that does not
 * parse keeps its last good threads for counts and links, and is reported as corrupt to
 * `overseer.board`. Never throws into the hub.
 */

import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
	BoardThread,
	OverseerBoardData,
	OverseerLink,
	SessionStatus,
	SessionSummary,
	ThreadCounts,
} from "../protocol.ts";

/** A registry file larger than this is not read (a real one holds a few KiB per thread). */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Records kept per file. */
const MAX_THREADS = 2000;
const BACKENDS = new Set(["forca", "tmux", "headless", "external"]);
const STATES = new Set(["running", "exited", "closed"]);

/** The registry fields the hub uses (a subset of the overseer's `ThreadRecord`). */
export interface RegistryThread {
	name: string;
	sessionId: string;
	backend: BoardThread["backend"];
	adopted?: boolean;
	cwd: string;
	model?: string;
	thinking?: string;
	state: BoardThread["state"];
	createdAt: number;
	lastStatus?: SessionStatus;
	lastActivityAt?: number;
	lastText?: string;
	lastError?: string;
	costUsd?: number;
	contextPercent?: number;
	exitedAt?: number;
	closedAt?: number;
	subagentModels?: { default?: string; allow?: string[] };
}

interface RegistryFile {
	/** mtime / size / inode: the file is re-read when this changes. */
	key: string;
	/** Last good parse (kept when the file later turns corrupt). */
	threads: RegistryThread[];
	/** Set while the current file content does not parse. */
	error?: string;
}

export interface OverseerIndexOptions {
	/** `<agentDir>/overseer`. */
	dir: string;
	log?: (line: string) => void;
}

function text(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = value.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").trim();
	if (!line) return undefined;
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function subagentModels(value: unknown): RegistryThread["subagentModels"] {
	if (!value || typeof value !== "object") return undefined;
	const v = value as { default?: unknown; allow?: unknown };
	const def = text(v.default, 200);
	const allow = Array.isArray(v.allow)
		? v.allow
				.slice(0, 50)
				.map((item) => text(item, 200))
				.filter((item): item is string => item !== undefined)
		: undefined;
	if (!def && !allow) return undefined;
	return { ...(def ? { default: def } : {}), ...(allow ? { allow } : {}) };
}

/** One registry record, or undefined when it lacks what the overseer itself requires. */
export function parseRegistryThread(value: unknown): RegistryThread | undefined {
	if (!value || typeof value !== "object") return undefined;
	const r = value as Record<string, unknown>;
	const sessionId = typeof r.sessionId === "string" && r.sessionId.length <= 200 ? r.sessionId : "";
	if (
		!sessionId ||
		typeof r.name !== "string" ||
		typeof r.cwd !== "string" ||
		!BACKENDS.has(r.backend as string) ||
		!STATES.has(r.state as string)
	)
		return undefined;
	const optional = {
		model: text(r.model, 200),
		thinking: text(r.thinking, 40),
		lastStatus: r.lastStatus === "working" || r.lastStatus === "idle" ? (r.lastStatus as SessionStatus) : undefined,
		lastActivityAt: num(r.lastActivityAt),
		lastText: text(r.lastText, 200),
		lastError: text(r.lastError, 200),
		costUsd: num(r.costUsd),
		contextPercent: num(r.contextPercent),
		exitedAt: num(r.exitedAt),
		closedAt: num(r.closedAt),
		subagentModels: subagentModels(r.subagentModels),
	};
	const thread: RegistryThread = {
		name: text(r.name, 200) ?? sessionId.slice(0, 8),
		sessionId,
		backend: r.backend as RegistryThread["backend"],
		...(r.adopted === true ? { adopted: true } : {}),
		cwd: r.cwd,
		state: r.state as RegistryThread["state"],
		createdAt: num(r.createdAt) ?? 0,
	};
	for (const [key, value] of Object.entries(optional)) {
		if (value !== undefined) (thread as unknown as Record<string, unknown>)[key] = value;
	}
	return thread;
}

/** Parse a registry file body; throws a short message when it is not a registry. */
export function parseRegistry(body: string): RegistryThread[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("not valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
	const list = (parsed as { threads?: unknown }).threads;
	if (list === undefined) return [];
	if (!Array.isArray(list)) throw new Error("threads is not an array");
	const threads: RegistryThread[] = [];
	for (const item of list) {
		const thread = parseRegistryThread(item);
		if (!thread) continue;
		// The overseer keeps one record per session id; a hand-edited duplicate keeps the last.
		const at = threads.findIndex((existing) => existing.sessionId === thread.sessionId);
		if (at >= 0) threads.splice(at, 1);
		threads.push(thread);
		if (threads.length >= MAX_THREADS) break;
	}
	// Registry order is creation order; sort stably in case a file was edited by hand.
	return threads
		.map((thread, index) => ({ thread, index }))
		.sort((a, b) => a.thread.createdAt - b.thread.createdAt || a.index - b.index)
		.map(({ thread }) => thread);
}

/** `<id>.json` -> id; temp files (`<id>.json.<hex>.tmp`) and anything else -> undefined. */
function overseerIdOf(file: string): string | undefined {
	if (!file.endsWith(".json") || file.startsWith(".")) return undefined;
	const id = file.slice(0, -".json".length);
	return id && id.length <= 200 ? id : undefined;
}

export class OverseerIndex {
	readonly dir: string;
	private readonly log: (line: string) => void;
	private readonly files = new Map<string, RegistryFile>();
	/** thread session id -> link (rebuilt on change). */
	private links = new Map<string, { overseerSessionId: string; thread: string; closed: boolean; createdAt: number }>();
	private running: Promise<Set<string>> | undefined;
	private again = false;
	private watcher: FSWatcher | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private debounceTimer: NodeJS.Timeout | undefined;
	private closed = false;
	private lastError = "";

	constructor(options: OverseerIndexOptions) {
		this.dir = options.dir;
		this.log = options.log ?? (() => {});
	}

	/**
	 * Re-scan the directory: stat every registry file, read the changed ones. Resolves with the ids
	 * of overseers whose threads (or readability) changed. Concurrent calls share one scan, and a
	 * call made during a scan schedules one more.
	 */
	refresh(): Promise<Set<string>> {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		const run = async (): Promise<Set<string>> => {
			const changed = new Set<string>();
			do {
				this.again = false;
				for (const id of await this.scan()) changed.add(id);
			} while (this.again && !this.closed);
			return changed;
		};
		this.running = run().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	/** Re-read one overseer's file if it changed (for `overseer.board`). True when it changed. */
	async refreshOne(overseerSessionId: string): Promise<boolean> {
		if (!overseerIdOf(`${overseerSessionId}.json`) || /[/\\]/.test(overseerSessionId)) return false;
		const changed = await this.readFile(`${overseerSessionId}.json`);
		if (changed) this.rebuildLinks();
		return changed;
	}

	private async scan(): Promise<Set<string>> {
		const changed = new Set<string>();
		let names: string[];
		try {
			names = await readdir(this.dir);
			this.lastError = "";
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") this.logOnce(`overseer registry scan failed: ${code ?? error}`);
			names = [];
		}
		const present = new Set<string>();
		for (const name of names) {
			if (this.closed) break;
			const id = overseerIdOf(name);
			if (!id) continue;
			present.add(id);
			if (await this.readFile(name)) changed.add(id);
		}
		for (const id of [...this.files.keys()]) {
			if (!present.has(id)) {
				this.files.delete(id);
				changed.add(id);
			}
		}
		if (changed.size > 0) this.rebuildLinks();
		return changed;
	}

	/** Stat `name` and read it when its key changed; true when the parsed result changed. */
	private async readFile(name: string): Promise<boolean> {
		const id = overseerIdOf(name) as string;
		const path = join(this.dir, name);
		const previous = this.files.get(id);
		let key: string;
		let size: number;
		try {
			const info = await stat(path);
			if (!info.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
			key = `${info.mtimeMs}:${info.size}:${info.ino}`;
			size = info.size;
		} catch {
			if (!previous) return false;
			this.files.delete(id);
			return true;
		}
		if (previous?.key === key) return false;
		let threads: RegistryThread[] | undefined;
		let error: string | undefined;
		if (size > MAX_FILE_BYTES) {
			error = `registry file is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MiB`;
		} else {
			try {
				threads = parseRegistry(await readFile(path, "utf8"));
			} catch (thrown) {
				const code = (thrown as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					if (!previous) return false;
					this.files.delete(id);
					return true;
				}
				error = thrown instanceof Error ? thrown.message : String(thrown);
			}
		}
		const next: RegistryFile = { key, threads: threads ?? previous?.threads ?? [], ...(error ? { error } : {}) };
		this.files.set(id, next);
		if (error && previous?.error !== error) this.log(`overseer registry ${id} is unreadable: ${error}`);
		return (
			!previous || previous.error !== next.error || JSON.stringify(previous.threads) !== JSON.stringify(next.threads)
		);
	}

	private rebuildLinks(): void {
		const links = new Map<
			string,
			{ overseerSessionId: string; thread: string; closed: boolean; createdAt: number }
		>();
		for (const [overseerSessionId, file] of this.files) {
			for (const thread of file.threads) {
				if (thread.sessionId === overseerSessionId) continue;
				const candidate = {
					overseerSessionId,
					thread: thread.name,
					closed: thread.state === "closed",
					createdAt: thread.createdAt,
				};
				const existing = links.get(thread.sessionId);
				// Adopted by two overseers: an open record beats a closed one, then the newest.
				if (
					!existing ||
					(existing.closed && !candidate.closed) ||
					(existing.closed === candidate.closed && candidate.createdAt > existing.createdAt)
				)
					links.set(thread.sessionId, candidate);
			}
		}
		this.links = links;
	}

	private logOnce(line: string): void {
		if (line === this.lastError) return;
		this.lastError = line;
		this.log(line);
	}

	/** The registry of one overseer: undefined when it has no file. */
	get(overseerSessionId: string): { threads: readonly RegistryThread[]; error?: string } | undefined {
		return this.files.get(overseerSessionId);
	}

	/** Overseers with a registry file listing at least one thread. */
	hasThreads(overseerSessionId: string): boolean {
		return (this.files.get(overseerSessionId)?.threads.length ?? 0) > 0;
	}

	/** The overseer whose registry lists this session (inverse index). */
	linkOf(threadSessionId: string): { overseerSessionId: string; thread: string } | undefined {
		const link = this.links.get(threadSessionId);
		return link ? { overseerSessionId: link.overseerSessionId, thread: link.thread } : undefined;
	}

	/**
	 * Watch the directory (debounced) and poll every `pollMs` as a fallback (fs.watch misses events on
	 * some file systems, and the directory may not exist yet). `onChange` gets the changed ids.
	 */
	watch(onChange: (ids: Set<string>) => void, options: { debounceMs?: number; pollMs?: number } = {}): void {
		const debounceMs = options.debounceMs ?? 150;
		const run = () => {
			if (this.closed) return;
			this.refresh().then(
				(ids) => {
					if (ids.size > 0 && !this.closed) onChange(ids);
				},
				(error: unknown) => this.logOnce(`overseer registry refresh failed: ${String(error)}`),
			);
		};
		const ensureWatcher = () => {
			if (this.watcher || this.closed) return;
			try {
				this.watcher = watch(this.dir, { persistent: false }, () => {
					if (this.debounceTimer) return;
					this.debounceTimer = setTimeout(() => {
						this.debounceTimer = undefined;
						run();
					}, debounceMs);
					this.debounceTimer.unref?.();
				});
				this.watcher.on("error", () => {
					this.watcher?.close();
					this.watcher = undefined;
				});
			} catch {
				this.watcher = undefined; // no directory yet; the poll retries
			}
		};
		ensureWatcher();
		this.pollTimer = setInterval(() => {
			ensureWatcher();
			run();
		}, options.pollMs ?? 5000);
		this.pollTimer.unref?.();
		run();
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.watcher?.close();
		this.watcher = undefined;
		await this.running?.catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------------------------
// Merging the registry with live summaries (live beats registry)
// ---------------------------------------------------------------------------------------------

function activityLine(summary: SessionSummary): string | undefined {
	const activity = summary.activity;
	if (!activity || typeof activity.tool !== "string") return undefined;
	return text(typeof activity.summary === "string" ? `${activity.tool} ${activity.summary}` : activity.tool, 200);
}

function backendOf(summary: SessionSummary): BoardThread["backend"] {
	if (summary.kind === "headless") return "headless";
	if (summary.tmux) return "tmux";
	return "external";
}

/**
 * Thread counts of one overseer. `live` maps every live session id to its summary; `extraLive` are
 * live sessions naming this overseer in `summary.overseer` that the registry does not list.
 */
export function countThreads(
	registry: readonly RegistryThread[],
	liveThreads: readonly SessionSummary[],
	live: (sessionId: string) => SessionSummary | undefined,
): ThreadCounts {
	const counts: ThreadCounts = { total: 0, working: 0, idle: 0, error: 0, exited: 0, closed: 0 };
	const seen = new Set<string>();
	const addLive = (summary: SessionSummary) => {
		if (summary.status === "working") counts.working++;
		else if (summary.lastError) counts.error++;
		else counts.idle++;
	};
	for (const thread of registry) {
		seen.add(thread.sessionId);
		counts.total++;
		const summary = live(thread.sessionId);
		if (summary) addLive(summary);
		else if (thread.state === "closed") counts.closed++;
		else counts.exited++;
	}
	for (const summary of liveThreads) {
		if (seen.has(summary.sessionId)) continue;
		seen.add(summary.sessionId);
		counts.total++;
		addLive(summary);
	}
	return counts;
}

/** `overseer.board` threads: registry order, then live threads the registry does not list yet. */
export function boardThreads(
	registry: readonly RegistryThread[],
	liveThreads: readonly SessionSummary[],
	live: (sessionId: string) => SessionSummary | undefined,
): BoardThread[] {
	const out: BoardThread[] = [];
	const seen = new Set<string>();
	const merge = (base: BoardThread, summary: SessionSummary | undefined): BoardThread => {
		if (!summary) return base;
		const activity = summary.status === "working" ? activityLine(summary) : undefined;
		const model = summary.model ? `${summary.model.provider}/${summary.model.id}` : base.model;
		const lastText = text(summary.lastText, 200) ?? base.lastText;
		const merged: BoardThread = {
			...base,
			cwd: summary.cwd || base.cwd,
			live: true,
			status: summary.status,
			...(model ? { model } : {}),
			...(summary.thinkingLevel ? { thinking: summary.thinkingLevel } : {}),
			...(activity ? { activity } : {}),
			...(lastText ? { lastText } : {}),
			lastActivityAt: summary.lastActivityAt,
		};
		// A live summary without an error means the error is gone.
		delete merged.lastError;
		if (summary.lastError) merged.lastError = summary.lastError;
		if (summary.usage?.costUsd !== undefined) merged.costUsd = summary.usage.costUsd;
		if (summary.usage?.contextPercent !== undefined) merged.contextPercent = summary.usage.contextPercent;
		return merged;
	};
	for (const thread of registry) {
		seen.add(thread.sessionId);
		const base: BoardThread = {
			name: thread.name,
			sessionId: thread.sessionId,
			backend: thread.backend,
			...(thread.adopted ? { adopted: true } : {}),
			cwd: thread.cwd,
			...(thread.model ? { model: thread.model } : {}),
			...(thread.thinking ? { thinking: thread.thinking } : {}),
			state: thread.state,
			live: false,
			...(thread.lastText ? { lastText: thread.lastText } : {}),
			...(thread.lastError ? { lastError: thread.lastError } : {}),
			...(thread.costUsd !== undefined ? { costUsd: thread.costUsd } : {}),
			...(thread.contextPercent !== undefined ? { contextPercent: thread.contextPercent } : {}),
			createdAt: thread.createdAt,
			...(thread.lastActivityAt !== undefined ? { lastActivityAt: thread.lastActivityAt } : {}),
			...(thread.exitedAt !== undefined ? { exitedAt: thread.exitedAt } : {}),
			...(thread.closedAt !== undefined ? { closedAt: thread.closedAt } : {}),
			...(thread.subagentModels ? { subagentModels: thread.subagentModels } : {}),
		};
		out.push(merge(base, live(thread.sessionId)));
	}
	const extra = liveThreads
		.filter((summary) => !seen.has(summary.sessionId))
		.sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId));
	for (const summary of extra) {
		const base: BoardThread = {
			name: summary.overseer?.thread || summary.name,
			sessionId: summary.sessionId,
			backend: backendOf(summary),
			cwd: summary.cwd,
			state: "running",
			live: true,
			createdAt: summary.startedAt,
		};
		out.push(merge(base, summary));
	}
	return out;
}

/** Board reply data; `name` is the overseer's name when known. */
export function boardData(sessionId: string, name: string | undefined, threads: BoardThread[]): OverseerBoardData {
	return { sessionId, ...(name ? { name } : {}), threads };
}

/** `PastSession.overseer` / `SessionSummary`-style link from a registry entry. */
export function registryLink(
	link: { overseerSessionId: string; thread: string },
	overseerName: string | undefined,
): OverseerLink {
	return {
		sessionId: link.overseerSessionId,
		...(overseerName ? { name: overseerName } : {}),
		...(link.thread ? { thread: link.thread } : {}),
	};
}
