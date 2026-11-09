/**
 * Small file helpers for the hub's state files. Every file the hub writes is 0600 and written
 * atomically (temp file + rename) so a crash never leaves half a `devices.json`.
 */

import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	existsSync,
	fstatSync,
	lstatSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	apnsJsonPath,
	apnsKeyDir,
	devicesJsonPath,
	ensureRemoteDir,
	headlessLogPath,
	hubIdPath,
	hubJsonPath,
	hubLockPath,
	hubLogPath,
} from "../paths.ts";

export function readJsonFile<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Write `content` atomically with mode 0600. */
export function writePrivateFile(path: string, content: string): void {
	const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
	// `wx`: never write through a file (or symlink) someone placed at the temp name.
	writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
	try {
		chmodSync(tmp, 0o600);
		writeFileSync(tmp, content);
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw error;
	}
}

export function writeJsonFile(path: string, value: unknown): void {
	writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Tighten an existing file to 0600 (a log or state file created earlier with a looser mode). */
export function restrictFileMode(path: string): void {
	try {
		chmodSync(path, 0o600);
	} catch {
		// absent, or not ours: nothing to tighten
	}
}

/**
 * Create the remote directory if needed and tighten everything the hub keeps in it: the directory
 * and `apns/` to 0700, every state file, key and log to 0600. Covers files that already existed
 * with looser modes (an older phi, a permissive umask, launchd creating `hub.log`).
 */
export function secureRemoteDir(): string {
	const dir = ensureRemoteDir();
	for (const path of [
		hubJsonPath(),
		hubIdPath(),
		hubLockPath(),
		devicesJsonPath(),
		apnsJsonPath(),
		hubLogPath(),
		headlessLogPath(),
		`${headlessLogPath()}.1`,
	]) {
		restrictFileMode(path);
	}
	const keys = apnsKeyDir();
	try {
		if (lstatSync(keys).isDirectory()) {
			chmodSync(keys, 0o700);
			for (const name of readdirSync(keys)) restrictFileMode(join(keys, name));
		}
	} catch {
		// no key directory yet
	}
	return dir;
}

export function removeFile(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// already gone
	}
}

/** Append-only log that rotates to `<path>.1` once it passes `maxBytes`. Never throws. */
export class RotatingLog {
	readonly path: string;
	private readonly maxBytes: number;
	private size: number;

	constructor(path: string, maxBytes = 5 * 1024 * 1024) {
		this.path = path;
		this.maxBytes = maxBytes;
		this.size = existsSync(path) ? safeSize(path) : 0;
		restrictFileMode(path);
		restrictFileMode(`${path}.1`);
	}

	write(text: string): void {
		try {
			if (this.size > this.maxBytes) {
				renameSync(this.path, `${this.path}.1`);
				this.size = 0;
			}
			appendFileSync(this.path, text, { mode: 0o600 });
			this.size += Buffer.byteLength(text);
		} catch {
			// Logging must never take the hub down.
		}
	}
}

/**
 * Bound a log file that is some process's open stderr (hub.log under launchd / systemd / `phi
 * remote start`, all opened for append). It cannot be renamed like RotatingLog does, because the
 * writer keeps its descriptor; once past `maxBytes` it is copied to `<path>.1` and truncated
 * (logrotate's copytruncate), and append-mode writes continue at the new end. Only acts when `fd`
 * really is that file. Returns whether it rotated. Never throws.
 */
export function capLogFile(path: string, maxBytes: number, fd = 2): boolean {
	try {
		const file = statSync(path);
		if (file.size <= maxBytes) return false;
		const out = fstatSync(fd);
		if (out.ino !== file.ino || out.dev !== file.dev) return false;
		copyFileSync(path, `${path}.1`);
		restrictFileMode(`${path}.1`);
		truncateSync(path, 0);
		return true;
	} catch {
		return false;
	}
}

function safeSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
