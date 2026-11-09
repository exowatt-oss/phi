import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoUpdatePhi, tryAcquireUpdateLock } from "../src/extensions/updater/auto-update.ts";
import type { PhiRelease } from "../src/extensions/updater/version.ts";

const latest: PhiRelease = {
	version: "1.4.0-exo.15",
	releaseId: "1.4.0-exo.15+bbbbbbbbbbbb.r101.1",
	commit: "b".repeat(40),
	publishedAt: "2026-11-07T00:00:00Z",
	installer: "phi-install.sh",
};

const dirs: string[] = [];
function lockPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "phi-auto-update-"));
	dirs.push(dir);
	return join(dir, "phi-auto-update.lock");
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tryAcquireUpdateLock", () => {
	it("is exclusive until released", () => {
		const path = lockPath();
		const release = tryAcquireUpdateLock(path);
		expect(release).toBeTypeOf("function");
		expect(tryAcquireUpdateLock(path)).toBeUndefined();
		release?.();
		expect(existsSync(path)).toBe(false);
		expect(tryAcquireUpdateLock(path)).toBeTypeOf("function");
	});

	it("takes over a stale lock left by a dead installer", () => {
		const path = lockPath();
		writeFileSync(path, "12345");
		const old = (Date.now() - 20 * 60_000) / 1000;
		utimesSync(path, old, old);
		expect(tryAcquireUpdateLock(path)).toBeTypeOf("function");
	});
});

describe("autoUpdatePhi", () => {
	it("does nothing when the feed has nothing newer", async () => {
		const upgrade = vi.fn();
		await expect(
			autoUpdatePhi({ checkForUpdate: async () => undefined, upgrade, lockPath: lockPath() }),
		).resolves.toEqual({ status: "current" });
		expect(upgrade).not.toHaveBeenCalled();
	});

	it("installs the newer release and releases the lock", async () => {
		const path = lockPath();
		const upgrade = vi.fn(async () => "ok");
		await expect(
			autoUpdatePhi({ checkForUpdate: async () => ({ latest }), upgrade, lockPath: path }),
		).resolves.toEqual({ status: "updated", release: latest });
		expect(upgrade).toHaveBeenCalledWith(latest);
		expect(existsSync(path)).toBe(false);
	});

	it("leaves the install to the session holding the lock", async () => {
		const path = lockPath();
		const held = tryAcquireUpdateLock(path);
		const upgrade = vi.fn();
		await expect(
			autoUpdatePhi({ checkForUpdate: async () => ({ latest }), upgrade, lockPath: path }),
		).resolves.toEqual({ status: "busy" });
		expect(upgrade).not.toHaveBeenCalled();
		held?.();
	});

	it("re-checks under the lock so a release another session installed is not reinstalled", async () => {
		const check = vi.fn().mockResolvedValueOnce({ latest }).mockResolvedValueOnce(undefined);
		const upgrade = vi.fn();
		await expect(autoUpdatePhi({ checkForUpdate: check, upgrade, lockPath: lockPath() })).resolves.toEqual({
			status: "current",
		});
		expect(upgrade).not.toHaveBeenCalled();
	});

	it("reports a failed install and still releases the lock", async () => {
		const path = lockPath();
		await expect(
			autoUpdatePhi({
				checkForUpdate: async () => ({ latest }),
				upgrade: async () => {
					throw new Error("installer exited with status 1");
				},
				lockPath: path,
			}),
		).resolves.toEqual({ status: "failed", release: latest, error: "installer exited with status 1" });
		expect(existsSync(path)).toBe(false);
	});
});
