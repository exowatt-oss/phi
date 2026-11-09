import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/extensions/loop/check.ts";
import { captureRepoSnapshot, computeRepoDelta, listCommitsBetween } from "../src/extensions/loop/repository-state.ts";
import {
	addUsage,
	budgetExceeded,
	emptyUsageTotals,
	formatDurationMs,
	formatUsd,
	usageFromAssistantMessage,
} from "../src/extensions/loop/usage.ts";

const execFile = promisify(execFileCallback);
const sh = (command: string) =>
	process.platform === "win32" ? `node -e "${command.replaceAll('"', '\\"')}"` : command;

describe("runCheck", () => {
	it.each([
		["true", "satisfied"],
		["false", "unsatisfied"],
		["exit 2", "error"],
	] as const)("handles %s", async (command, verdict) =>
		expect(
			(await runCheck({ command: sh(command), cwd: process.cwd(), timeoutMs: 2000, maxOutputBytes: 1000 })).verdict,
		).toBe(verdict),
	);
	it("bounds output and keeps its tail", async () => {
		const result = await runCheck({
			command: "printf '0123456789END'",
			cwd: process.cwd(),
			timeoutMs: 2000,
			maxOutputBytes: 5,
		});
		expect(result.truncated).toBe(true);
		expect(result.stdoutTail.endsWith("END")).toBe(true);
	});
	it("times out", async () => {
		const start = Date.now();
		const result = await runCheck({ command: "sleep 5", cwd: process.cwd(), timeoutMs: 200, maxOutputBytes: 100 });
		expect(result.verdict).toBe("error");
		expect(result.timedOut).toBe(true);
		expect(Date.now() - start).toBeLessThan(4000);
	});
	it("handles missing command and abort", async () => {
		expect(
			(
				await runCheck({
					command: "definitely-not-a-real-cmd-xyz",
					cwd: process.cwd(),
					timeoutMs: 1000,
					maxOutputBytes: 100,
				})
			).verdict,
		).toBe("error");
		const controller = new AbortController();
		controller.abort();
		expect(
			(
				await runCheck({
					command: "sleep 5",
					cwd: process.cwd(),
					timeoutMs: 1000,
					maxOutputBytes: 100,
					signal: controller.signal,
				})
			).verdict,
		).toBe("error");
	});
	it("preserves shell quoting", async () =>
		expect(
			(
				await runCheck({ command: 'echo "a -- b"', cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 100 })
			).stdoutTail.trim(),
		).toBe("a -- b"));
});

describe("repository state", () => {
	it("captures changes and commits", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loop-"));
		try {
			await execFile("git", ["init", "-q"], { cwd: dir });
			await execFile("git", ["config", "user.email", "test@example.com"], { cwd: dir });
			await execFile("git", ["config", "user.name", "Test"], { cwd: dir });
			await writeFile(join(dir, "a"), "one\n");
			await execFile("git", ["add", "a"], { cwd: dir });
			await execFile("git", ["commit", "-qm", "first"], { cwd: dir });
			const clean = await captureRepoSnapshot(dir);
			expect(clean?.stagedCount).toBe(0);
			await writeFile(join(dir, "a"), "one\ntwo\n");
			await writeFile(join(dir, "new"), "new\n");
			const dirty = await captureRepoSnapshot(dir);
			expect(dirty?.untrackedCount).toBe(1);
			expect(dirty?.numstat.filesChanged).toBeGreaterThan(0);
			expect(computeRepoDelta(dirty, dirty, [])?.mixedChanges).toBe(true);
			await execFile("git", ["add", "."], { cwd: dir });
			await execFile("git", ["commit", "-qm", "second"], { cwd: dir });
			const after = await captureRepoSnapshot(dir);
			expect(await listCommitsBetween(dir, clean!.head, after!.head)).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("returns undefined outside git", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loop-nogit-"));
		expect(await captureRepoSnapshot(dir)).toBeUndefined();
		await rm(dir, { recursive: true, force: true });
	});
});

describe("usage", () => {
	it("accounts defensively", () => {
		const a = emptyUsageTotals();
		expect(addUsage(a, { input: 2, costUsd: 1 }).input).toBe(2);
		expect(usageFromAssistantMessage({ usage: { input: NaN, output: 3, cost: { total: 2 } } }).output).toBe(3);
		expect(budgetExceeded({ ...a, costUsd: 1, evaluatorCostUsd: 1 }, 2)).toBe(true);
		expect(formatUsd(2.41)).toBe("$2.41");
		expect(formatDurationMs(18 * 60 * 1000 + 42 * 1000)).toBe("18m 42s");
		expect(formatDurationMs(101 * 60 * 1000)).toBe("1h 41m");
	});
});
