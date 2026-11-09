/**
 * phi remote — on-disk locations.
 *
 * Everything lives in one directory (`~/.pi/agent/remote`, mode 0700). `PI_REMOTE_DIR` overrides
 * it (tests, or running a second hub side by side). Both the hub (`src/remote/hub/**`) and the
 * in-session extension (`src/extensions/remote/**`) resolve the socket through `hubSocketPath()`,
 * so they always agree.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Directory holding the hub socket, state files and logs. Honors `PI_REMOTE_DIR`. */
export function remoteDir(): string {
	const override = process.env.PI_REMOTE_DIR?.trim();
	if (override) {
		if (override === "~") return homedir();
		if (override.startsWith("~/")) return join(homedir(), override.slice(2));
		return resolve(override);
	}
	return join(homedir(), ".pi", "agent", "remote");
}

/** Unix socket shared by sessions (register/stream) and local control clients (CLI, `/remote`). */
export function hubSocketPath(): string {
	return join(remoteDir(), "hub.sock");
}

/** Create the remote directory (mode 0700) if needed and return it. */
export function ensureRemoteDir(): string {
	const dir = remoteDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Best effort: a directory we cannot chmod is still usable.
	}
	return dir;
}

/** `{ hubId, pid, port, binds, startedAt, version }` of the running hub (0600). */
export function hubJsonPath(): string {
	return join(remoteDir(), "hub.json");
}

/** Held (with the hub's pid) for the hub's lifetime so two concurrent starts cannot both listen. */
export function hubLockPath(): string {
	return join(remoteDir(), "hub.lock");
}

/** Stable hub id, created once and kept across restarts. */
export function hubIdPath(): string {
	return join(remoteDir(), "hub-id");
}

/** Paired devices (0600). Stores token hashes only. */
export function devicesJsonPath(): string {
	return join(remoteDir(), "devices.json");
}

/** Optional APNs configuration (0600). */
export function apnsJsonPath(): string {
	return join(remoteDir(), "apns.json");
}

/** Directory for copied APNs signing keys (0700; keys 0600). */
export function apnsKeyDir(): string {
	return join(remoteDir(), "apns");
}

/** Hub log when started detached (`phi remote start`) or by launchd/systemd. */
export function hubLogPath(): string {
	return join(remoteDir(), "hub.log");
}

/** stderr of headless sessions spawned by the hub (rotated). */
export function headlessLogPath(): string {
	return join(remoteDir(), "headless.log");
}
