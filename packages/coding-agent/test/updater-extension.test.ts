import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	fetchLatestPhiRelease,
	inspectPhiUpdate,
	isDifferentRelease,
	type PhiRelease,
	parseVersionsManifest,
} from "../src/extensions/updater/version.ts";
import { allowNetwork } from "./test-network-env.ts";

const current: PhiRelease = {
	version: "0.83.0-exo.1",
	releaseId: "0.83.0-exo.1+aaaaaaaaaaaa.r100.1",
	commit: "a".repeat(40),
	publishedAt: "2026-08-03T00:00:00Z",
	installer: "phi-install.sh",
};
const latest: PhiRelease = {
	...current,
	releaseId: "0.83.0-exo.1+bbbbbbbbbbbb.r101.1",
	commit: "b".repeat(40),
	publishedAt: "2026-08-03T01:00:00Z",
};

describe("phi updater manifest", () => {
	it("parses a valid versions.json manifest", () => {
		expect(parseVersionsManifest({ schemaVersion: 1, channel: "main", latest })).toEqual({
			schemaVersion: 1,
			channel: "main",
			latest,
		});
	});

	it("rejects malformed manifests", () => {
		expect(
			parseVersionsManifest({ schemaVersion: 1, channel: "main", latest: { version: "0.83.0" } }),
		).toBeUndefined();
		expect(parseVersionsManifest({ schemaVersion: 2, channel: "main", latest })).toBeUndefined();
	});

	it("detects strictly newer builds even when the package version did not change", () => {
		expect(isDifferentRelease(current, latest)).toBe(true);
		expect(isDifferentRelease(latest, latest)).toBe(false);
		expect(isDifferentRelease(undefined, latest)).toBe(false);
	});

	it("fetches versions.json from the configured feed", async () => {
		// vitest.config.ts sets PI_OFFLINE=1 for every test, and fetchLatestPhiRelease
		// returns undefined before fetching when it is set. `fetchImpl` below is a mock,
		// so opting back in reaches no network.
		allowNetwork();
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ schemaVersion: 1, channel: "main", latest }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		await expect(fetchLatestPhiRelease({ baseUrl: "https://feed.example/downloads/", fetchImpl })).resolves.toEqual(
			latest,
		);
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://feed.example/downloads/versions.json",
			expect.objectContaining({ headers: { accept: "application/json" } }),
		);
	});
});

describe("inspectPhiUpdate", () => {
	function manifestFetch(body: unknown, status = 200) {
		return vi.fn(
			async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
		);
	}

	function withInstalledRelease(release: PhiRelease | undefined, run: (packageDir: string) => Promise<void>) {
		const packageDir = mkdtempSync(join(tmpdir(), "phi-updater-"));
		if (release) writeFileSync(join(packageDir, "phi-version.json"), JSON.stringify(release));
		return run(packageDir).finally(() => rmSync(packageDir, { recursive: true, force: true }));
	}

	it("reports unmanaged when no phi-version.json sits next to the binary", async () => {
		await withInstalledRelease(undefined, async (packageDir) => {
			const fetchImpl = manifestFetch({ schemaVersion: 1, channel: "main", latest });
			await expect(inspectPhiUpdate({ packageDir, fetchImpl })).resolves.toEqual({ status: "unmanaged" });
			expect(fetchImpl).not.toHaveBeenCalled();
		});
	});

	it("reports unavailable, not unmanaged, when phi-version.json exists but is unreadable", async () => {
		const packageDir = mkdtempSync(join(tmpdir(), "phi-updater-"));
		try {
			writeFileSync(join(packageDir, "phi-version.json"), "{ not json");
			const fetchImpl = manifestFetch({ schemaVersion: 1, channel: "main", latest });
			await expect(inspectPhiUpdate({ packageDir, fetchImpl })).resolves.toEqual({
				status: "unavailable",
				current: undefined,
				reason: expect.stringContaining("installed release metadata is unreadable"),
			});
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			rmSync(packageDir, { recursive: true, force: true });
		}
	});

	it("reports unavailable under PI_OFFLINE without touching the network", async () => {
		await withInstalledRelease(current, async (packageDir) => {
			const fetchImpl = manifestFetch({ schemaVersion: 1, channel: "main", latest });
			await expect(inspectPhiUpdate({ packageDir, fetchImpl })).resolves.toEqual({
				status: "unavailable",
				current,
				reason: "PI_OFFLINE is set",
			});
			expect(fetchImpl).not.toHaveBeenCalled();
		});
	});

	it("reports unavailable with the reason when the feed fails or is malformed", async () => {
		allowNetwork();
		await withInstalledRelease(current, async (packageDir) => {
			const failing = vi.fn(async () => {
				throw new Error("getaddrinfo ENOTFOUND updates.example.invalid");
			});
			await expect(inspectPhiUpdate({ packageDir, fetchImpl: failing })).resolves.toEqual({
				status: "unavailable",
				current,
				reason: "getaddrinfo ENOTFOUND updates.example.invalid",
			});
			await expect(
				inspectPhiUpdate({ packageDir, fetchImpl: manifestFetch({ nope: true }) }),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: expect.stringContaining("versions.json"),
			});
			await expect(inspectPhiUpdate({ packageDir, fetchImpl: manifestFetch({}, 503) })).resolves.toMatchObject({
				status: "unavailable",
			});
		});
	});

	it("reports unavailable, not current, for malformed or inconsistent release metadata", async () => {
		allowNetwork();
		await withInstalledRelease(current, async (packageDir) => {
			// Non-empty strings that pass the manifest shape check but cannot be ordered.
			const garbageId = { ...latest, releaseId: "not-a-release-id" };
			await expect(
				inspectPhiUpdate({
					packageDir,
					fetchImpl: manifestFetch({ schemaVersion: 1, channel: "main", latest: garbageId }),
				}),
			).resolves.toEqual({
				status: "unavailable",
				current,
				reason: "release feed names an incomparable release: not-a-release-id",
			});
			// Release id says one commit, commit field says another.
			const mismatched = { ...latest, commit: "c".repeat(40) };
			await expect(
				inspectPhiUpdate({
					packageDir,
					fetchImpl: manifestFetch({ schemaVersion: 1, channel: "main", latest: mismatched }),
				}),
			).resolves.toMatchObject({ status: "unavailable" });
		});
		// A malformed local phi-version.json is likewise not "up to date".
		await withInstalledRelease({ ...current, releaseId: "0.83.0-exo.1" }, async (packageDir) => {
			await expect(
				inspectPhiUpdate({ packageDir, fetchImpl: manifestFetch({ schemaVersion: 1, channel: "main", latest }) }),
			).resolves.toMatchObject({
				status: "unavailable",
				reason: expect.stringContaining("installed release metadata is incomparable"),
			});
		});
	});

	it("distinguishes a newer feed release from an up-to-date install", async () => {
		allowNetwork();
		await withInstalledRelease(current, async (packageDir) => {
			const newer = manifestFetch({ schemaVersion: 1, channel: "main", latest });
			await expect(inspectPhiUpdate({ packageDir, fetchImpl: newer })).resolves.toEqual({
				status: "update",
				current,
				latest,
			});
			const same = manifestFetch({ schemaVersion: 1, channel: "main", latest: current });
			await expect(inspectPhiUpdate({ packageDir, fetchImpl: same })).resolves.toEqual({
				status: "current",
				current,
				latest: current,
			});
		});
	});
});

describe("phi upgrade shell", () => {
	// Runs the real `sh -c` script (no mocks) against URLs curl cannot fetch, to
	// pin the property Copilot flagged: a failed download must not exit 0.
	it("exits non-zero when the installer download fails instead of running an empty script", async () => {
		const { PHI_UPGRADE_SHELL_SCRIPT } = await import("../src/extensions/updater/index.ts");
		const { spawn } = await import("node:child_process");
		const run = (url: string) =>
			new Promise<{ code: number | null; stderr: string }>((resolve) => {
				const child = spawn(
					"sh",
					["-c", PHI_UPGRADE_SHELL_SCRIPT, "phi-upgrade", url, "https://feed.invalid/downloads"],
					{
						stdio: ["ignore", "ignore", "pipe"],
					},
				);
				let stderr = "";
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				child.once("exit", (code) => resolve({ code, stderr }));
			});
		// file:// keeps this offline; the path does not exist so curl fails.
		const missing = await run(`file://${join(tmpdir(), "phi-upgrade-does-not-exist.sh")}`);
		expect(missing.code).not.toBe(0);
		expect(missing.stderr).toContain("download failed");
	});

	it("runs the downloaded installer with PHI_INSTALL_BASE_URL and returns its exit status", async () => {
		const { PHI_UPGRADE_SHELL_SCRIPT } = await import("../src/extensions/updater/index.ts");
		const { spawn } = await import("node:child_process");
		const dir = mkdtempSync(join(tmpdir(), "phi-upgrade-shell-"));
		try {
			const installer = join(dir, "phi-install.sh");
			writeFileSync(installer, 'printf "%s" "$PHI_INSTALL_BASE_URL"; exit 7\n');
			const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
				const child = spawn(
					"sh",
					[
						"-c",
						PHI_UPGRADE_SHELL_SCRIPT,
						"phi-upgrade",
						`file://${installer}`,
						"https://feed.example/archive/x/downloads",
					],
					{ stdio: ["ignore", "pipe", "ignore"] },
				);
				let stdout = "";
				child.stdout.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				child.once("exit", (code) => resolve({ code, stdout }));
			});
			expect(result.code).toBe(7);
			expect(result.stdout).toBe("https://feed.example/archive/x/downloads");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("phi upgrade command", () => {
	it("runs the published installer URL through curl and sh", async () => {
		vi.resetModules();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = Object.assign(new EventEmitter(), { stdout, stderr });
		const spawn = vi.fn(() => child);
		vi.doMock("node:child_process", () => ({ spawn }));
		const {
			getPhiArchiveBaseUrl,
			PHI_UPGRADE_SHELL_SCRIPT,
			runPhiUpgrade: runMockedUpgrade,
		} = await import("../src/extensions/updater/index.ts");
		expect(getPhiArchiveBaseUrl(latest.releaseId, "https://feed.example/downloads/")).toBe(
			"https://feed.example/archive/phi/0.83.0-exo.1%2Bbbbbbbbbbbbb.r101.1/downloads",
		);
		await expect(runMockedUpgrade({ checkForUpdate: async () => undefined })).rejects.toThrow(
			"No strictly newer phi release is available",
		);
		expect(spawn).not.toHaveBeenCalled();

		const result = runMockedUpgrade({
			installerUrl: "https://feed.example/archive/phi/release/downloads/phi-install.sh",
			archiveBaseUrl: "https://feed.example/archive/phi/release/downloads",
			checkForUpdate: async () => ({ current, latest }),
		});
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		stdout.write("Installed phi\n");
		child.emit("exit", 0, null);
		await expect(result).resolves.toBe("Installed phi");
		expect(spawn).toHaveBeenCalledWith(
			"sh",
			[
				"-c",
				PHI_UPGRADE_SHELL_SCRIPT,
				"phi-upgrade",
				"https://feed.example/archive/phi/release/downloads/phi-install.sh",
				"https://feed.example/archive/phi/release/downloads",
			],
			expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
		);
		vi.doUnmock("node:child_process");
	});

	it("installs an explicit release with inherited stdio for the CLI", async () => {
		vi.resetModules();
		const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null });
		const spawn = vi.fn(() => child);
		vi.doMock("node:child_process", () => ({ spawn }));
		const {
			getPhiInstallerCommand,
			PHI_UPGRADE_SHELL_SCRIPT,
			runPhiUpgrade: runMockedUpgrade,
		} = await import("../src/extensions/updater/index.ts");
		expect(getPhiInstallerCommand("phi", "https://feed.example/downloads/")).toBe(
			"curl -fsSL https://feed.example/downloads/phi-install.sh | sh",
		);

		const checkForUpdate = vi.fn(async () => undefined);
		const result = runMockedUpgrade({
			release: latest,
			inheritStdio: true,
			archiveBaseUrl: "https://feed.example/archive/phi/release/downloads",
			checkForUpdate,
		});
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		// An explicit release skips the newer-release check entirely (CLI --force).
		expect(checkForUpdate).not.toHaveBeenCalled();
		child.emit("exit", 0, null);
		await expect(result).resolves.toBe("");
		expect(spawn).toHaveBeenCalledWith(
			"sh",
			[
				"-c",
				PHI_UPGRADE_SHELL_SCRIPT,
				"phi-upgrade",
				"https://feed.example/archive/phi/release/downloads/phi-install.sh",
				"https://feed.example/archive/phi/release/downloads",
			],
			expect.objectContaining({ stdio: ["ignore", "inherit", "inherit"] }),
		);

		await expect(
			runMockedUpgrade({ release: { ...latest, installer: "phi.msi" }, inheritStdio: true }),
		).rejects.toThrow("unsupported phi installer");
		vi.doUnmock("node:child_process");
	});
});
