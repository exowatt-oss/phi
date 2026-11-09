/**
 * `cwds.recent`: working directories of recent persisted sessions, read cheaply.
 *
 * phi stores sessions as `<agentDir>/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`; the first
 * line of each file is the `{ type: "session", cwd, ... }` header. We rank the per-project
 * directories by mtime (a new session file bumps it), then read only the header of the newest
 * file in each, instead of parsing whole sessions.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

const HEADER_BYTES = 4096;

function readHeaderCwd(file: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buf = Buffer.alloc(HEADER_BYTES);
		const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
		const text = buf.subarray(0, n).toString("utf8");
		const nl = text.indexOf("\n");
		const header = JSON.parse(nl === -1 ? text : text.slice(0, nl)) as { type?: string; cwd?: unknown };
		return header.type === "session" && typeof header.cwd === "string" ? header.cwd : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function isExistingDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Up to `limit` existing cwds of the most recently created persisted sessions, newest first. */
export function readRecentSessionCwds(sessionsDir: string, limit = 20): string[] {
	if (!existsSync(sessionsDir)) return [];
	let dirs: { path: string; mtimeMs: number }[] = [];
	try {
		for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(sessionsDir, entry.name);
			try {
				dirs.push({ path, mtimeMs: statSync(path).mtimeMs });
			} catch {
				// vanished
			}
		}
	} catch {
		return [];
	}
	dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
	dirs = dirs.slice(0, limit * 3);

	const out: string[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		if (out.length >= limit) break;
		let newest: string | undefined;
		try {
			// File names start with an ISO timestamp, so the lexically largest is the newest.
			for (const name of readdirSync(dir.path)) {
				if (name.endsWith(".jsonl") && (!newest || name > newest)) newest = name;
			}
		} catch {
			continue;
		}
		if (!newest) continue;
		const cwd = readHeaderCwd(join(dir.path, newest));
		if (!cwd || seen.has(cwd) || !isExistingDir(cwd)) continue;
		seen.add(cwd);
		out.push(cwd);
	}
	return out;
}

/** Merge live session cwds (already ordered) with persisted ones; dedupe, existing dirs, max `limit`. */
export function mergeRecentCwds(live: readonly string[], persisted: readonly string[], limit = 20): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const cwd of [...live, ...persisted]) {
		if (out.length >= limit) break;
		if (!cwd || seen.has(cwd)) continue;
		seen.add(cwd);
		if (isExistingDir(cwd)) out.push(cwd);
	}
	return out;
}
