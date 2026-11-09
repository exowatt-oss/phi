import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { PhiRelease, PhiUpdateCheck } from "../src/extensions/updater/version.ts";

// `phi update self` on the compiled (bun-binary) distribution must go through
// the configured release feed updater and never through pi.dev / npm. `isBunBinary` is a
// module constant derived from import.meta.url, so the install method is
// mocked here; the updater's own behaviour is covered in updater-extension.test.ts.

const inspectPhiUpdate = vi.fn<() => Promise<PhiUpdateCheck>>();
const runPhiUpgrade = vi.fn<(options?: Record<string, unknown>) => Promise<string>>();

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.ts")>();
	return { ...actual, detectInstallMethod: () => "bun-binary" as const };
});
vi.mock("../src/extensions/updater/version.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/extensions/updater/version.ts")>();
	return { ...actual, inspectPhiUpdate };
});
vi.mock("../src/extensions/updater/index.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/extensions/updater/index.ts")>();
	return { ...actual, runPhiUpgrade };
});

const { APP_NAME, ENV_AGENT_DIR } = await import("../src/config.ts");
const { handlePackageCommand } = await import("../src/package-manager-cli.ts");

const current: PhiRelease = {
	version: "0.83.0-exo.38",
	releaseId: "0.83.0-exo.38+aaaaaaaaaaaa.r100.1",
	commit: "a".repeat(40),
	publishedAt: "2026-09-08T00:00:00Z",
	installer: "phi-install.sh",
};
const latest: PhiRelease = {
	...current,
	version: "0.83.0-exo.39",
	releaseId: "0.83.0-exo.39+bbbbbbbbbbbb.r101.1",
	commit: "b".repeat(40),
	publishedAt: "2026-09-12T00:00:00Z",
};

describe("phi update self on the compiled distribution", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let logSpy: MockInstance<typeof console.log>;
	let errorSpy: MockInstance<typeof console.error>;
	let fetchMock: ReturnType<typeof vi.fn>;

	const stdout = () => logSpy.mock.calls.map(([message]) => String(message)).join("\n");
	const stderr = () => errorSpy.mock.calls.map(([message]) => String(message)).join("\n");

	beforeEach(() => {
		tempDir = join(tmpdir(), `phi-self-update-binary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		mkdirSync(join(tempDir, "project"), { recursive: true });
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
		process.chdir(join(tempDir, "project"));
		inspectPhiUpdate.mockReset();
		runPhiUpgrade.mockReset();
		runPhiUpgrade.mockResolvedValue("");
		// Any fetch here would be the pi.dev version check, which must not run.
		fetchMock = vi.fn(async () => {
			throw new Error("network must not be used");
		});
		vi.stubGlobal("fetch", fetchMock);
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		process.exitCode = originalExitCode;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("installs the newer feed release through the pinned installer", async () => {
		inspectPhiUpdate.mockResolvedValue({ status: "update", current, latest });

		expect(await handlePackageCommand(["update", "self"])).toBe(true);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(runPhiUpgrade).toHaveBeenCalledExactlyOnceWith({ release: latest, inheritStdio: true });
		expect(stdout()).toContain(`Updating ${APP_NAME} ${current.releaseId} → ${latest.releaseId}`);
		expect(stdout()).toContain(`Updated ${APP_NAME} from ${current.releaseId} to ${latest.releaseId}`);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("reports up to date without reinstalling, and reinstalls with --force", async () => {
		inspectPhiUpdate.mockResolvedValue({ status: "current", current, latest: current });

		expect(await handlePackageCommand(["update", "--self"])).toBe(true);
		expect(runPhiUpgrade).not.toHaveBeenCalled();
		expect(stdout()).toContain(`${APP_NAME} is already up to date`);
		expect(process.exitCode).toBeUndefined();

		expect(await handlePackageCommand(["update", "self", "--force"])).toBe(true);
		expect(runPhiUpgrade).toHaveBeenCalledExactlyOnceWith({ release: current, inheritStdio: true });
		expect(stdout()).toContain(`Reinstalling ${APP_NAME} ${current.releaseId} (--force)`);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("fails with the installer one-liner when the binary carries no release metadata", async () => {
		inspectPhiUpdate.mockResolvedValue({ status: "unmanaged" });

		expect(await handlePackageCommand(["update", "self"])).toBe(true);

		expect(runPhiUpgrade).not.toHaveBeenCalled();
		expect(stderr()).toContain(`${APP_NAME} cannot self-update this installation`);
		expect(stderr()).toContain("http://127.0.0.1:8789/downloads/phi-install.sh");
		expect(process.exitCode).toBe(1);
	});

	it("fails with the feed error when the release feed cannot be checked", async () => {
		inspectPhiUpdate.mockResolvedValue({ status: "unavailable", current, reason: "getaddrinfo ENOTFOUND" });

		expect(await handlePackageCommand(["update", "self"])).toBe(true);

		expect(runPhiUpgrade).not.toHaveBeenCalled();
		expect(stderr()).toContain("Could not check for a phi update: getaddrinfo ENOTFOUND");
		expect(stderr()).toContain(current.releaseId);
		expect(process.exitCode).toBe(1);
	});

	it("fails with the installer fallback when the installer exits non-zero", async () => {
		inspectPhiUpdate.mockResolvedValue({ status: "update", current, latest });
		runPhiUpgrade.mockRejectedValue(new Error("installer exited with status 1"));

		expect(await handlePackageCommand(["update", "self"])).toBe(true);

		expect(stderr()).toContain("installer exited with status 1");
		expect(stderr()).toContain("run the installer yourself");
		expect(process.exitCode).toBe(1);
	});

	it("also self-updates via the feed for a bare `update` and for `update --all`", async () => {
		inspectPhiUpdate.mockResolvedValue({ status: "current", current, latest: current });

		expect(await handlePackageCommand(["update"])).toBe(true);
		expect(inspectPhiUpdate).toHaveBeenCalledOnce();

		// --all updates extension packages first (none installed here) and then self.
		expect(await handlePackageCommand(["update", "--all"])).toBe(true);
		expect(inspectPhiUpdate).toHaveBeenCalledTimes(2);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});
});
