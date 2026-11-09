/**
 * Session history for the phone (`sessions.past`, `session.transcript`, `session.resume`): an index of
 * every stored phi session on this machine, and stored transcripts read straight from session files.
 *
 * The index is built in the background when the hub starts and refreshed incrementally: a file is
 * re-read only when its size or mtime changed, and then only from the last line already folded in
 * (session files are append-only). Lines the index does not need — tool results, which are most of
 * the bytes, and every entry type besides user/assistant messages, `session_info` and
 * `model_change` — are recognized from their first bytes and never decoded. Per session it keeps
 * the listing fields plus the lower-cased user + assistant text for search (about 16 MB for 2,400
 * sessions / 2.2 GB of files), never transcripts.
 *
 * Everything here only reads: a session being written by its own phi process is never touched (unlike
 * `loadEntriesFromFile`, which repairs a missing final newline).
 */

import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	migrateSessionEntries,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "../../core/session-manager.ts";
import {
	assistantLine,
	contentParts,
	type StoredPageOptions,
	storedTranscript,
	typedUserText,
} from "../../extensions/remote/transcript.ts";
import type { TranscriptItem } from "../protocol.ts";

type FileHandle = Awaited<ReturnType<typeof open>>;

/** Bytes of a line inspected to decide whether it is needed at all. */
const PREFIX_BYTES = 256;
const CHUNK_BYTES = 1024 * 1024;
/** Search text kept per session (lower-cased user + assistant text); the largest real one is ~0.5 MB. */
const MAX_SEARCH_CHARS = 2 * 1024 * 1024;
const TITLE_MAX = 120;
/** Hand the event loop back at least this often while indexing or reading a transcript. */
const SLICE_MS = 8;
const STAT_CONCURRENCY = 64;
/** Bytes read by one refresh between garbage collections (Bun). */
const COLLECT_EVERY_BYTES = 256 * 1024 * 1024;

const TYPE_RE = /^\{"type":"([A-Za-z_]+)"/;
const ROLE_RE = /"message":\{"role":"([A-Za-z]+)"/;
const TS_RE = /"timestamp":"([^"\\]{10,40})"/;
const LINE_RE = /^\{"type":"([A-Za-z_]+)","id":"([^"\\]{1,200})","parentId":(?:null|"([^"\\]{1,200})")/;

export class NotASessionError extends Error {
	constructor(path: string) {
		super(`not a phi session file: ${path}`);
		this.name = "NotASessionError";
	}
}

export class UnknownItemError extends Error {
	constructor(itemId: string) {
		super(`no item ${itemId}`);
		this.name = "UnknownItemError";
	}
}

/** Gives the event loop a turn every `SLICE_MS` of synchronous work. */
class Slicer {
	private last = performance.now();
	async tick(): Promise<void> {
		if (performance.now() - this.last < SLICE_MS) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
		this.last = performance.now();
	}
}

/**
 * An image content block's base64 payload. Nothing here renders images (transcripts count them), so
 * the payload is dropped before parsing: an image-heavy entry parses in a fraction of the time and
 * memory. `"type":"image","data":"` cannot occur inside a JSON string (its quotes would be escaped).
 */
const IMAGE_DATA_RE = /"type":"image","data":"[^"\\]*"/g;
const IMAGE_DATA_MARK = '"type":"image","data":"';

function parseLine(line: Buffer | string): FileEntry | undefined {
	try {
		let text = typeof line === "string" ? line : line.toString("utf8");
		if (text.length > 4096 && text.includes(IMAGE_DATA_MARK))
			text = text.replace(IMAGE_DATA_RE, `${IMAGE_DATA_MARK}"`);
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as FileEntry) : undefined;
	} catch {
		return undefined;
	}
}

function isHeader(entry: FileEntry | undefined): entry is SessionHeader {
	return !!entry && entry.type === "session" && typeof (entry as { id?: unknown }).id === "string";
}

// ---------------------------------------------------------------------------------------------
// Line scanning
// ---------------------------------------------------------------------------------------------

interface LineSink {
	/** From a line's first bytes (up to 256): whether its full text is needed. */
	want(prefix: Buffer): boolean;
	/** A complete line the sink wanted, without its newline. */
	line(line: Buffer, offset: number): void;
	/** A complete line the sink did not want. */
	skipped?(prefix: Buffer, offset: number, length: number): void;
}

interface ScanResult {
	/** File offset just past the last complete line. */
	end: number;
	/** The final line when it has no newline yet (being written, or a file cut short). */
	tail?: { offset: number; line?: Buffer; prefix: Buffer };
}

/**
 * Split `[start, end)` of a file into lines, handing each to `sink`. A line is buffered only when
 * the sink wants it; skipped lines cost one 256-byte prefix copy, however long they are.
 */
async function scanLines(
	handle: FileHandle,
	start: number,
	end: number,
	sink: LineSink,
	slicer: Slicer,
	stopped?: () => boolean,
): Promise<ScanResult> {
	let pos = start;
	let lineStart = start;
	/** Bytes of the current line so far; `parts[0..owned)` are copies, the rest views of `chunk`. */
	let parts: Buffer[] = [];
	let owned = 0;
	let partsLength = 0;
	/** 0 = undecided, 1 = wanted, 2 = skipped. */
	let decided = 0;
	let prefix: Buffer | undefined;
	const joined = (): Buffer => (parts.length === 1 ? parts[0] : Buffer.concat(parts, partsLength));
	const decide = (): void => {
		const first = joined().subarray(0, PREFIX_BYTES);
		if (sink.want(first)) {
			decided = 1;
		} else {
			decided = 2;
			prefix = Buffer.from(first); // the read buffer is reused
			parts = [];
			owned = 0;
			partsLength = 0;
		}
	};
	// One read buffer for the whole scan: skipped lines (most of the bytes) are never copied.
	const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, end - start)));
	while (pos < end) {
		if (stopped?.()) break;
		const size = Math.min(chunk.length, end - pos);
		const { bytesRead } = await handle.read(chunk, 0, size, pos);
		if (bytesRead === 0) break;
		const data = chunk.subarray(0, bytesRead);
		let index = 0;
		while (index < bytesRead) {
			const newline = data.indexOf(10, index);
			const segmentEnd = newline === -1 ? bytesRead : newline;
			if (decided !== 2 && segmentEnd > index) {
				parts.push(data.subarray(index, segmentEnd));
				partsLength += segmentEnd - index;
			}
			if (decided === 0 && (partsLength >= PREFIX_BYTES || newline !== -1)) decide();
			if (newline === -1) break;
			const length = pos + newline - lineStart;
			if (decided === 1) sink.line(joined(), lineStart);
			else sink.skipped?.(prefix as Buffer, lineStart, length);
			parts = [];
			owned = 0;
			partsLength = 0;
			decided = 0;
			prefix = undefined;
			lineStart = pos + newline + 1;
			index = newline + 1;
		}
		// The line continues in the next chunk: keep copies of what this chunk holds of it.
		for (; owned < parts.length; owned++) parts[owned] = Buffer.from(parts[owned]);
		pos += bytesRead;
		await slicer.tick();
	}
	if (lineStart >= pos) return { end: lineStart };
	const line = decided === 2 ? undefined : joined();
	return {
		end: lineStart,
		tail: { offset: lineStart, line, prefix: line ? line.subarray(0, PREFIX_BYTES) : (prefix as Buffer) },
	};
}

// ---------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------

/** What the index knows about one stored session. */
export interface IndexedSession {
	path: string;
	sessionId: string;
	title: string;
	named: boolean;
	cwd: string;
	createdAt: number;
	modifiedAt: number;
	messageCount: number;
	preview?: string;
	model?: { provider: string; id: string };
	/** Written by a nested subagent run (`subagent` header marker): never listed. */
	subagent: boolean;
	/** Header version; < 3 needs the session manager's migration to render. */
	version: number;
}

function firstLine(text: string): string | undefined {
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\s+/g, " ").trim();
		if (line) return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
	}
	return undefined;
}

/** The listing fields of one session file, folded line by line (and resumable from where it stopped). */
class SessionScan implements LineSink {
	header: SessionHeader | undefined;
	/** The first parsed line was not a session header: not a phi session. */
	notSession = false;
	name: string | undefined;
	firstUser: string | undefined;
	preview: string | undefined;
	model: { provider: string; id: string } | undefined;
	messageCount = 0;
	lastEntryAt = 0;
	/** Lower-cased user + assistant text, newline separated. */
	text = "";

	want(prefix: Buffer): boolean {
		if (!this.header) return !this.notSession;
		const head = prefix.toString("latin1");
		const type = TYPE_RE.exec(head)?.[1];
		if (type === undefined) return prefix.length > 0; // unusual layout: read it to be safe
		if (type === "message") {
			const role = ROLE_RE.exec(head)?.[1];
			return role === undefined || role === "user" || role === "assistant";
		}
		return type === "session_info" || type === "model_change";
	}

	skipped(prefix: Buffer): void {
		if (!this.header) return;
		this.touch(TS_RE.exec(prefix.toString("latin1"))?.[1]);
	}

	line(line: Buffer): void {
		this.fold(parseLine(line));
	}

	/** Fold one parsed entry (the first one must be the session header). */
	fold(entry: FileEntry | undefined): void {
		if (!entry) return; // malformed line: skipped, as the session manager does
		if (!this.header) {
			if (isHeader(entry)) this.header = entry;
			else this.notSession = true;
			return;
		}
		if (entry.type === "session") return;
		this.touch((entry as { timestamp?: unknown }).timestamp);
		switch (entry.type) {
			case "session_info":
				this.name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
				return;
			case "model_change":
				if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
					this.model = { provider: entry.provider, id: entry.modelId };
				}
				return;
			case "message": {
				const message = entry.message as { role?: unknown; content?: unknown } | undefined;
				if (!message || typeof message !== "object") return;
				if (message.role === "user") {
					this.messageCount++;
					const text = typedUserText(contentParts(message.content).text);
					if (this.firstUser === undefined) this.firstUser = firstLine(text);
					this.addText(text);
				} else if (message.role === "assistant") {
					this.messageCount++;
					const assistant = message as AssistantMessage;
					const line = assistantLine(assistant);
					if (line) this.preview = line;
					if (typeof assistant.provider === "string" && typeof assistant.model === "string") {
						this.model = { provider: assistant.provider, id: assistant.model };
					}
					this.addText(contentParts(assistant.content).text);
				}
				return;
			}
			default:
				return;
		}
	}

	private touch(timestamp: unknown): void {
		if (typeof timestamp !== "string") return;
		const at = Date.parse(timestamp);
		if (Number.isFinite(at) && at > this.lastEntryAt) this.lastEntryAt = at;
	}

	private addText(text: string): void {
		if (!text || this.text.length >= MAX_SEARCH_CHARS) return;
		const lower = text.toLowerCase();
		const room = MAX_SEARCH_CHARS - this.text.length;
		this.text += this.text ? `\n${lower.slice(0, room - 1)}` : lower.slice(0, room);
	}
}

interface FileRecord {
	path: string;
	size: number;
	mtimeMs: number;
	ino: number;
	/** Offset just past the last line folded into `scan`. */
	consumed: number;
	scan: SessionScan;
	/** The last line was folded without its newline (complete JSON, newline not written yet). */
	tailWithoutNewline: boolean;
}

export interface PastQuery {
	/** Case-insensitive substring of the title, cwd or message text. */
	query?: string;
	/** Exact cwd. */
	cwd?: string;
}

export interface HistoryStats {
	files: number;
	sessions: number;
	indexing: boolean;
	/** Duration of the first complete build, ms. */
	builtInMs?: number;
	/** Duration of the last refresh, ms. */
	lastRefreshMs?: number;
	/** Characters of search text held. */
	searchChars: number;
}

export interface HistoryIndexOptions {
	sessionsDir: string;
	log?: (line: string) => void;
}

/**
 * Every stored phi session under the sessions dir (each project subdirectory, plus `.jsonl` files
 * directly in it), excluding files that are not sessions, sessions with no user/assistant message
 * and subagent runs. One refresh runs at a time; callers share it.
 */
export class SessionHistoryIndex {
	private readonly sessionsDir: string;
	private readonly log: (line: string) => void;
	private readonly files = new Map<string, FileRecord>();
	private view: { list: IndexedSession[]; byId: Map<string, IndexedSession>; text: Map<string, string> } | undefined;
	private refreshing: Promise<void> | undefined;
	private built = false;
	private builtInMs: number | undefined;
	private lastRefreshMs: number | undefined;
	private lastRefreshAt = 0;
	private stopped = false;

	constructor(options: HistoryIndexOptions) {
		this.sessionsDir = options.sessionsDir;
		this.log = options.log ?? (() => {});
	}

	/** True until the first complete build finished. */
	get indexing(): boolean {
		return !this.built;
	}

	stats(): HistoryStats {
		let searchChars = 0;
		for (const record of this.files.values()) searchChars += record.scan.text.length;
		return {
			files: this.files.size,
			sessions: this.current().list.length,
			indexing: !this.built,
			...(this.builtInMs !== undefined ? { builtInMs: Math.round(this.builtInMs) } : {}),
			...(this.lastRefreshMs !== undefined ? { lastRefreshMs: Math.round(this.lastRefreshMs) } : {}),
			searchChars,
		};
	}

	/** Stop work in progress (hub shutdown); resolves once a running refresh has unwound. */
	async close(): Promise<void> {
		this.stopped = true;
		await this.refreshing?.catch(() => undefined);
	}

	/** Refresh now (or join the refresh in progress). */
	refresh(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		this.refreshing ??= this.doRefresh().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	/**
	 * Make the index at most `maxAgeMs` old, unless the first build is still running (then answer with
	 * what it has; the caller reports `indexing`).
	 */
	async fresh(maxAgeMs: number): Promise<void> {
		if (!this.built) {
			if (!this.refreshing) void this.refresh().catch(() => undefined);
			return;
		}
		if (this.refreshing || Date.now() - this.lastRefreshAt >= maxAgeMs) await this.refresh();
	}

	/** One session by id: refreshes (or waits for the first build) when it is not known yet. */
	async lookup(sessionId: string, maxAgeMs = 0): Promise<IndexedSession | undefined> {
		const known = this.current().byId.get(sessionId);
		if (known) return known;
		if (this.refreshing) await this.refreshing.catch(() => undefined);
		const afterBuild = this.current().byId.get(sessionId);
		if (afterBuild) return afterBuild;
		if (Date.now() - this.lastRefreshAt >= maxAgeMs) await this.refresh().catch(() => undefined);
		return this.current().byId.get(sessionId);
	}

	/** One indexed session by id, as the index knows it now (no refresh). */
	peek(sessionId: string): IndexedSession | undefined {
		return this.current().byId.get(sessionId);
	}

	/** Listed sessions matching `filter`, newest `modifiedAt` first (ties: session id, descending). */
	list(filter: PastQuery = {}): IndexedSession[] {
		const view = this.current();
		const query = filter.query?.trim().toLowerCase();
		if (!query && filter.cwd === undefined) return view.list;
		return view.list.filter((session) => {
			if (filter.cwd !== undefined && session.cwd !== filter.cwd) return false;
			if (!query) return true;
			return (
				session.title.toLowerCase().includes(query) ||
				session.cwd.toLowerCase().includes(query) ||
				(view.text.get(session.path)?.includes(query) ?? false)
			);
		});
	}

	private current(): NonNullable<SessionHistoryIndex["view"]> {
		if (this.view) return this.view;
		const byId = new Map<string, IndexedSession>();
		const text = new Map<string, string>();
		for (const record of this.files.values()) {
			const session = toIndexed(record);
			if (!session || session.subagent || session.messageCount === 0) continue;
			const other = byId.get(session.sessionId);
			// Two files claiming one id (a copied file): the most recently active one is the session.
			if (
				other &&
				(other.modifiedAt > session.modifiedAt ||
					(other.modifiedAt === session.modifiedAt && other.path > session.path))
			)
				continue;
			byId.set(session.sessionId, session);
			text.set(session.path, record.scan.text);
		}
		const list = [...byId.values()].sort(comparePast);
		this.view = { list, byId, text };
		return this.view;
	}

	private async doRefresh(): Promise<void> {
		const started = performance.now();
		const slicer = new Slicer();
		const paths = await this.listFiles();
		const stats = await mapLimit(paths, STAT_CONCURRENCY, async (path) => {
			try {
				const info = await stat(path);
				return info.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino } : undefined;
			} catch {
				return undefined;
			}
		});
		const present = new Set<string>();
		const changed: { path: string; size: number; mtimeMs: number; ino: number }[] = [];
		for (const info of stats) {
			if (!info) continue;
			present.add(info.path);
			const record = this.files.get(info.path);
			if (!record || record.size !== info.size || record.mtimeMs !== info.mtimeMs || record.ino !== info.ino) {
				changed.push(info);
			}
		}
		let removed = 0;
		for (const path of this.files.keys()) {
			if (!present.has(path)) {
				this.files.delete(path);
				removed++;
			}
		}
		if (removed > 0) this.view = undefined;
		// Newest first: while the first build runs, the sessions the user most likely wants come first.
		changed.sort((a, b) => b.mtimeMs - a.mtimeMs);
		let sinceCollect = 0;
		for (const info of changed) {
			if (this.stopped) return;
			// Parsing leaves garbage at roughly the rate it reads; on Bun the heap's high-water mark is
			// what the process keeps, so collect along the way when a refresh reads a lot.
			sinceCollect += info.size - (this.files.get(info.path)?.consumed ?? 0);
			if (sinceCollect > COLLECT_EVERY_BYTES) {
				sinceCollect = 0;
				collectGarbage();
			}
			try {
				await this.scanFile(info, slicer);
			} catch (error) {
				// Unreadable now (permissions, vanished mid-scan): forget it until it changes again.
				this.files.delete(info.path);
				this.log(`history: cannot read ${info.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
			this.view = undefined;
		}
		this.lastRefreshAt = Date.now();
		this.lastRefreshMs = performance.now() - started;
		if (!this.built) {
			this.built = true;
			this.builtInMs = this.lastRefreshMs;
			// The first build parses every session once; hand that garbage back now rather than keep
			// a few hundred MB of heap in an always-on process (Bun only; a no-op elsewhere).
			collectGarbage();
			const s = this.stats();
			this.log(
				`history index: ${s.sessions} sessions from ${s.files} files in ${Math.round(this.lastRefreshMs)} ms (${Math.round(s.searchChars / 1024)} KiB search text)`,
			);
		}
	}

	private async listFiles(): Promise<string[]> {
		let entries: Dirent[];
		try {
			entries = await readdir(this.sessionsDir, { withFileTypes: true });
		} catch {
			return [];
		}
		const files: string[] = [];
		const dirs: string[] = [];
		for (const entry of entries) {
			const path = join(this.sessionsDir, entry.name);
			if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
			else if (entry.isDirectory() || entry.isSymbolicLink()) dirs.push(path);
		}
		const nested = await mapLimit(dirs, STAT_CONCURRENCY, async (dir) => {
			try {
				return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
			} catch {
				return [];
			}
		});
		return files.concat(nested.flat());
	}

	private async scanFile(
		info: { path: string; size: number; mtimeMs: number; ino: number },
		slicer: Slicer,
	): Promise<void> {
		const previous = this.files.get(info.path);
		const handle = await open(info.path, "r");
		try {
			let record = previous;
			// Append-only files grow; anything else (shrunk, replaced) is read again from the start.
			let incremental =
				!!record && record.ino === info.ino && info.size >= record.consumed && !record.scan.notSession;
			if (incremental && record && record.consumed > 0 && !record.tailWithoutNewline) {
				const probe = Buffer.alloc(1);
				await handle.read(probe, 0, 1, record.consumed - 1);
				incremental = probe[0] === 10;
			}
			if (!incremental || !record) {
				record = {
					path: info.path,
					size: 0,
					mtimeMs: 0,
					ino: info.ino,
					consumed: 0,
					scan: new SessionScan(),
					tailWithoutNewline: false,
				};
			}
			const scan = record.scan;
			const result = await scanLines(handle, record.consumed, info.size, scan, slicer, () => this.stopped);
			record.consumed = result.end;
			record.tailWithoutNewline = false;
			// A final line without its newline: fold it only if it is complete JSON (the writer may be
			// mid-line); then the newline that follows reads as an empty line.
			if (result.tail) {
				const line =
					result.tail.line ?? (await readRange(handle, result.tail.offset, info.size - result.tail.offset));
				const entry = parseLine(line);
				if (entry) {
					scan.fold(entry);
					record.consumed = info.size;
					record.tailWithoutNewline = true;
				}
			}
			record.size = info.size;
			record.mtimeMs = info.mtimeMs;
			record.ino = info.ino;
			this.files.set(info.path, record);
		} finally {
			await handle.close();
		}
	}
}

function toIndexed(record: FileRecord): IndexedSession | undefined {
	const scan = record.scan;
	const header = scan.header;
	if (!header || scan.notSession) return undefined;
	const cwd = typeof header.cwd === "string" ? header.cwd : "";
	const created = Date.parse(header.timestamp);
	const createdAt = Number.isFinite(created) ? created : record.mtimeMs;
	const modifiedAt = scan.lastEntryAt > 0 ? scan.lastEntryAt : Math.round(record.mtimeMs);
	const title = scan.name ?? scan.firstUser ?? (basename(cwd) || header.id.slice(0, 8));
	const marker = (header as { subagent?: unknown }).subagent;
	return {
		path: record.path,
		sessionId: header.id,
		title,
		named: scan.name !== undefined,
		cwd,
		createdAt,
		modifiedAt: Math.max(modifiedAt, createdAt),
		messageCount: scan.messageCount,
		...(scan.preview ? { preview: scan.preview } : {}),
		...(scan.model ? { model: scan.model } : {}),
		subagent: marker !== undefined && marker !== null && marker !== false,
		version: typeof header.version === "number" ? header.version : 1,
	};
}

/** `sessions.past` order: newest `modifiedAt` first, then session id descending. */
export function comparePast(
	a: { modifiedAt: number; sessionId: string },
	b: { modifiedAt: number; sessionId: string },
): number {
	return b.modifiedAt - a.modifiedAt || (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0);
}

/** Opaque `sessions.past` cursor: the position of the last session of a page. */
export function encodeCursor(session: { modifiedAt: number; sessionId: string }): string {
	return Buffer.from(JSON.stringify([session.modifiedAt, session.sessionId]), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { modifiedAt: number; sessionId: string } | undefined {
	if (cursor.length === 0 || cursor.length > 1024) return undefined;
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (!Array.isArray(value) || value.length !== 2) return undefined;
		const [modifiedAt, sessionId] = value;
		if (typeof modifiedAt !== "number" || !Number.isFinite(modifiedAt) || typeof sessionId !== "string")
			return undefined;
		return { modifiedAt, sessionId };
	} catch {
		return undefined;
	}
}

/** The page of `sorted` after `cursor` (or from the start), with the next cursor when more follow. */
export function pageAfter<T extends { modifiedAt: number; sessionId: string }>(
	sorted: readonly T[],
	limit: number,
	cursor?: { modifiedAt: number; sessionId: string },
): { page: T[]; nextCursor?: string } {
	let start = 0;
	if (cursor) {
		// First session strictly after the cursor position in list order.
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (comparePast(sorted[mid], cursor) <= 0) lo = mid + 1;
			else hi = mid;
		}
		start = lo;
	}
	const page = sorted.slice(start, start + limit);
	const more = start + limit < sorted.length && page.length > 0;
	return { page, ...(more ? { nextCursor: encodeCursor(page[page.length - 1]) } : {}) };
}

/** A full, synchronous collection on Bun (the compiled phi binary); nothing elsewhere. */
function collectGarbage(): void {
	try {
		(globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true);
	} catch {
		// best effort
	}
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

async function readRange(handle: FileHandle, offset: number, length: number, scratch?: Buffer): Promise<Buffer> {
	const buffer = scratch && length <= scratch.length ? scratch.subarray(0, length) : Buffer.allocUnsafe(length);
	let read = 0;
	while (read < length) {
		const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
		if (bytesRead === 0) break;
		read += bytesRead;
	}
	return read === length ? buffer : buffer.subarray(0, read);
}

// ---------------------------------------------------------------------------------------------
// Stored transcripts
// ---------------------------------------------------------------------------------------------

interface LineRef {
	offset: number;
	length: number;
	id: string;
	parentId: string | null;
	/** Parsed already (lines whose first bytes did not say enough). */
	entry?: SessionEntry;
}

export interface StoredTranscriptPage {
	items: TranscriptItem[];
	hasMore: boolean;
}

/**
 * A page of a stored session's transcript (`session.transcript`), read-only. The branch is the one
 * the session manager would resume (leaf = last entry, parents up to the root), rendered by
 * `storedTranscript`. Only the lines the page needs are parsed: one pass reads each line's id and
 * parent from its first bytes, then entries are parsed backwards from the leaf in growing windows
 * until the page is complete. Throws `NotASessionError` / `UnknownItemError`.
 */
export async function readStoredTranscript(path: string, options: StoredPageOptions): Promise<StoredTranscriptPage> {
	const slicer = new Slicer();
	const handle = await open(path, "r");
	try {
		const size = (await handle.stat()).size;
		const refs: LineRef[] = [];
		let header: SessionHeader | undefined;
		let notSession = false;
		const add = (entry: FileEntry | undefined, offset: number, length: number): void => {
			if (!entry || notSession) return;
			if (!header) {
				if (isHeader(entry)) header = entry;
				else notSession = true;
				return;
			}
			if (entry.type === "session" || typeof (entry as { id?: unknown }).id !== "string") return;
			const parentId = (entry as { parentId?: unknown }).parentId;
			refs.push({
				offset,
				length,
				id: (entry as SessionEntry).id,
				parentId: typeof parentId === "string" ? parentId : null,
				entry: entry as SessionEntry,
			});
		};
		const sink: LineSink = {
			want: (prefix) => {
				if (!header) return !notSession;
				const match = LINE_RE.exec(prefix.toString("latin1"));
				return !match || match[1] === "session";
			},
			line: (line, offset) => add(parseLine(line), offset, line.length),
			skipped: (prefix, offset, length) => {
				if (!header || notSession) return;
				const match = LINE_RE.exec(prefix.toString("latin1"));
				if (match) refs.push({ offset, length, id: match[2], parentId: match[3] ?? null });
			},
		};
		const scanned = await scanLines(handle, 0, size, sink, slicer);
		if (scanned.tail) {
			const line = scanned.tail.line ?? (await readRange(handle, scanned.tail.offset, size - scanned.tail.offset));
			add(parseLine(line), scanned.tail.offset, line.length);
		}
		if (!header || notSession) throw new NotASessionError(path);
		if ((header.version ?? 1) < CURRENT_SESSION_VERSION) {
			return await legacyTranscript(handle, size, header, options);
		}

		// The branch the session manager resumes: last entry, then parents (a later duplicate id wins).
		const byId = new Map<string, number>();
		for (let index = 0; index < refs.length; index++) byId.set(refs[index].id, index);
		const branch: number[] = [];
		let cursor: number | undefined = refs.length > 0 ? refs.length - 1 : undefined;
		while (cursor !== undefined && branch.length <= refs.length) {
			branch.push(cursor);
			const parentId = refs[cursor].parentId;
			cursor = parentId ? byId.get(parentId) : undefined;
		}
		branch.reverse();

		const total = branch.length;
		// Most entries render one item (tool results none, assistant messages one plus their calls).
		let window = Math.min(total, options.limit + 32);
		// Lines are parsed straight out of one reused buffer; only longer ones get their own.
		const scratch = Buffer.allocUnsafe(CHUNK_BYTES);
		for (;;) {
			const entries: SessionEntry[] = [];
			for (let index = total - window; index < total; index++) {
				const ref = refs[branch[index]];
				if (!ref.entry) {
					const entry = parseLine(await readRange(handle, ref.offset, ref.length, scratch));
					// A line that does not parse is not an entry for the session manager either: fall back
					// to its exact semantics.
					if (!entry || (entry as { id?: unknown }).id !== ref.id) {
						return await legacyTranscript(handle, size, header, options);
					}
					ref.entry = entry as SessionEntry;
					await slicer.tick();
				}
				entries.push(ref.entry);
			}
			const walk = storedTranscript(entries, options);
			if (walk.found && (walk.hasMore || window === total)) return { items: walk.items, hasMore: walk.hasMore };
			if (window === total) throw new UnknownItemError(options.before ?? "");
			window = Math.min(total, window * 2);
		}
	} finally {
		await handle.close();
	}
}

/** Old (v1/v2) files: load everything, migrate in memory, take the session manager's branch. */
async function legacyTranscript(
	handle: FileHandle,
	size: number,
	header: SessionHeader,
	options: StoredPageOptions,
): Promise<StoredTranscriptPage> {
	const text = (await readRange(handle, 0, size)).toString("utf8");
	const entries: FileEntry[] = [];
	for (const line of text.split("\n")) {
		const entry = line.trim() ? parseLine(line) : undefined;
		if (entry) entries.push(entry);
	}
	migrateSessionEntries(entries);
	const manager = SessionManager.inMemory(header.cwd || "/", undefined, entries);
	const walk = storedTranscript(manager.getBranch(), options);
	if (!walk.found) throw new UnknownItemError(options.before ?? "");
	return { items: walk.items, hasMore: walk.hasMore };
}
