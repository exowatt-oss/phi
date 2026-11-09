import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import type { PhiRelease } from "./version.ts";

/** How often a session with auto-update on asks the feed for a newer release. */
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
/** A lock older than this belongs to a dead installer and may be taken over. */
const LOCK_STALE_MS = 15 * 60_000;

/**
 * Take the machine-wide installer lock, so several phi sessions that notice the
 * same release do not run the installer at once. Returns a release function, or
 * undefined when another live session holds the lock.
 */
export function tryAcquireUpdateLock(lockPath: string, now = Date.now()): (() => void) | undefined {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lockPath, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return () => {
				try {
					unlinkSync(lockPath);
				} catch {}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
			try {
				if (now - statSync(lockPath).mtimeMs < LOCK_STALE_MS) return undefined;
				unlinkSync(lockPath);
			} catch {
				// Vanished between open and stat: try once more.
			}
		}
	}
	return undefined;
}

export type AutoUpdateResult =
	| { status: "current" }
	| { status: "busy" }
	| { status: "updated"; release: PhiRelease }
	| { status: "failed"; release: PhiRelease; error: string };

/**
 * One auto-update pass: if the feed has a strictly newer release, install it
 * under the lock. The check repeats after taking the lock because another
 * session may have installed the release while this one waited.
 */
export async function autoUpdatePhi(options: {
	checkForUpdate: () => Promise<{ latest: PhiRelease } | undefined>;
	upgrade: (release: PhiRelease) => Promise<unknown>;
	lockPath: string;
}): Promise<AutoUpdateResult> {
	if (!(await options.checkForUpdate())) return { status: "current" };
	const release = tryAcquireUpdateLock(options.lockPath);
	if (!release) return { status: "busy" };
	try {
		const update = await options.checkForUpdate();
		if (!update) return { status: "current" };
		try {
			await options.upgrade(update.latest);
			return { status: "updated", release: update.latest };
		} catch (error) {
			return {
				status: "failed",
				release: update.latest,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	} finally {
		release();
	}
}
