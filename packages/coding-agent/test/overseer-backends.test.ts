import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	buildLauncherScript,
	carriedEnv,
	closeForcaTerminal,
	closeTmuxSession,
	createForcaTerminal,
	createTmuxSession,
	defaultRunner,
	parseForcaHandle,
	parseForcaReady,
	removeLaunchFiles,
	renameForcaTerminal,
	selectBackend,
	shQuote,
	tmuxSessionName,
	writeLaunchFiles,
} from "../src/extensions/overseer/backends.ts";
import { fakeRunner } from "./overseer-helpers.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "phi-overseer-backends-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const NASTY_NAME = `it's "x" $(touch PWNED) \`id\`; rm -rf ~ & echo`;

describe("overseer launcher", () => {
	it("single-quotes any word for sh", () => {
		for (const word of ["plain", "it's", "a b", "$(id)", "`id`", "line1\nline2", "", "'", "\\", "--flag"]) {
			const result = spawnSync("sh", ["-c", `printf '%s' ${shQuote(word)}`], { encoding: "utf8" });
			expect(result.stdout).toBe(word);
		}
		expect(() => shQuote("a\0b")).toThrow(/NUL/);
	});

	it("runs phi with exact args and env, never evaluating user text", () => {
		const work = join(dir, `work dir 'q' $HOME`);
		mkdirSync(work);
		const agentDir = join(dir, "agent");
		const dump = join(dir, "dump.cjs");
		writeFileSync(
			dump,
			`require("node:fs").writeFileSync(process.env.DUMP_FILE, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PI_|PHI_|KEEP_)/.test(k)))}));`,
		);
		const marker = join(dir, "PWNED");
		const prompt = `-starts with a dash\nline "two" with 'quotes'\n$(touch ${marker}) and \`touch ${marker}\` and $HOME\n\n`;
		const files = writeLaunchFiles(
			agentDir,
			{
				sessionId: "0190bbbb-1111-7000-8000-000000000001",
				name: NASTY_NAME,
				cwd: work,
				invocation: { command: process.execPath, args: [dump] },
				model: "gateway/example-medium",
				thinking: "max",
				env: {
					PHI_OVERSEER_SESSION_ID: "0190aaaa-0000-7000-8000-00000000beef",
					PHI_OVERSEER_NAME: "boss's $(id)",
					PHI_OVERSEER_THREAD: NASTY_NAME,
					PHI_SUBAGENT_MODEL_DEFAULT: "gateway/example-medium:max",
				},
			},
			prompt,
			"extra 'system' text $(id)",
		);
		expect(statSync(join(agentDir, "overseer", "launch")).mode & 0o777).toBe(0o700);
		expect(statSync(files.launcher).mode & 0o777).toBe(0o700);
		expect(statSync(files.promptFile).mode & 0o777).toBe(0o600);
		expect(statSync(files.appendSystemPromptFile!).mode & 0o777).toBe(0o600);
		expect(readFileSync(files.launcher, "utf8")).not.toContain('line "two"');

		const out = join(dir, "out.json");
		const result = spawnSync("sh", [files.launcher], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				DUMP_FILE: out,
				KEEP_ME: "1",
				PI_SESSION_ID: "parent",
				PI_SESSION_FILE: "/parent.jsonl",
				PI_SUBAGENT_ID: "child",
				PI_SUBAGENT_WORKER_CAP: "4",
				PI_PROVIDER: "p",
				PI_MODEL: "m",
				PI_REASONING_LEVEL: "high",
				PHI_REMOTE: "0",
				PHI_REMOTE_SPAWN_ID: "spawn",
				PHI_OVERSEER_SESSION_ID: "stale",
				PHI_SUBAGENT_MODEL_ALLOW: "stale/*",
				PI_TUI_MODE: "stale",
			},
		});
		expect(result.status).toBe(0);
		const dumped = JSON.parse(readFileSync(out, "utf8")) as {
			argv: string[];
			cwd: string;
			env: Record<string, string>;
		};
		expect(dumped.argv).toEqual([
			"--session-id",
			"0190bbbb-1111-7000-8000-000000000001",
			"--model",
			"gateway/example-medium",
			"--thinking",
			"max",
			"--name",
			NASTY_NAME,
			"--append-system-prompt",
			files.appendSystemPromptFile,
			"--",
			// $(cat) drops trailing newlines only.
			prompt.replace(/\n+$/, ""),
		]);
		expect(dumped.cwd).toBe(realpathSync(work));
		expect(dumped.env).toEqual({
			KEEP_ME: "1",
			PHI_OVERSEER_SESSION_ID: "0190aaaa-0000-7000-8000-00000000beef",
			PHI_OVERSEER_NAME: "boss's $(id)",
			PHI_OVERSEER_THREAD: NASTY_NAME,
			PHI_SUBAGENT_MODEL_DEFAULT: "gateway/example-medium:max",
			// FORCA / tmux threads always run phi's own terminal UI.
			PI_TUI_MODE: "1",
		});
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(join(work, "PWNED"))).toBe(false);

		removeLaunchFiles(agentDir, "0190bbbb-1111-7000-8000-000000000001");
		expect(existsSync(files.launcher)).toBe(false);
		expect(existsSync(files.promptFile)).toBe(false);
	});

	it("exports the overseer's hub, agent and session dir overrides so the thread joins the same hub", () => {
		const agentDir = join(dir, "agent");
		const dump = join(dir, "dump.cjs");
		writeFileSync(
			dump,
			`require("node:fs").writeFileSync(process.env.DUMP_FILE, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PI_|PHI_)/.test(k)))));`,
		);
		const hostEnv = {
			PI_REMOTE_DIR: "/tmp/test hub 'x'",
			[ENV_AGENT_DIR]: agentDir,
			PI_CODING_AGENT_SESSION_DIR: "~/sessions",
			PI_SESSION_ID: "overseer-own",
			UNRELATED: "no",
		};
		expect(carriedEnv({ PI_REMOTE_DIR: "rel/hub", PI_CODING_AGENT_DIR: "  " })).toEqual({
			PI_REMOTE_DIR: join(process.cwd(), "rel/hub"),
		});
		const files = writeLaunchFiles(
			agentDir,
			{
				sessionId: "s-carry",
				name: "n",
				cwd: dir,
				invocation: { command: process.execPath, args: [dump] },
				env: { PHI_OVERSEER_SESSION_ID: "ovs" },
				hostEnv,
			},
			"go",
		);
		const out = join(dir, "carry.json");
		// The tab's own environment (FORCA / tmux server) has no overrides, or other ones.
		const result = spawnSync("sh", [files.launcher], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, DUMP_FILE: out, PI_REMOTE_DIR: "/real/hub" },
		});
		expect(result.status).toBe(0);
		expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
			PI_REMOTE_DIR: "/tmp/test hub 'x'",
			[ENV_AGENT_DIR]: agentDir,
			PI_CODING_AGENT_SESSION_DIR: "~/sessions",
			PHI_OVERSEER_SESSION_ID: "ovs",
			PI_TUI_MODE: "1",
		});
		// Without overrides in the overseer's env, only the terminal-mode flag is exported.
		const plain = buildLauncherScript({
			sessionId: "s",
			name: "n",
			cwd: dir,
			invocation: { command: "phi", args: [] },
			env: {},
			hostEnv: { HOME: "/h" },
			promptFile: "/p",
		});
		expect(plain.split("\n").filter((line) => line.startsWith("export "))).toEqual(["export PI_TUI_MODE='1'"]);
	});

	it("keeps a prompt that starts with @ a message, and omits optional flags", () => {
		const files = writeLaunchFiles(
			join(dir, "agent"),
			{ sessionId: "s1", name: "n", cwd: dir, invocation: { command: "/bin/phi", args: ["--x"] }, env: {} },
			"@src/app.ts explain",
		);
		expect(readFileSync(files.promptFile, "utf8")).toBe(" @src/app.ts explain");
		const script = readFileSync(files.launcher, "utf8");
		expect(script).toContain(
			`exec '/bin/phi' '--x' '--session-id' 's1' '--name' 'n' -- "$(cat '${files.promptFile}')"`,
		);
		expect(script).not.toContain("--model");
		expect(script).not.toContain("--append-system-prompt");
		expect(() =>
			buildLauncherScript({
				sessionId: "s",
				name: "n",
				cwd: dir,
				invocation: { command: "phi", args: [] },
				env: { "BAD NAME": "x" },
				promptFile: "/p",
			}),
		).toThrow(/Invalid environment variable name/);
	});
});

describe("overseer backend selection", () => {
	const ready = JSON.stringify({ id: "x", ok: true, result: { runtime: { state: "ready", reachable: true } } });
	const which = (available: string[]) => (command: string) =>
		available.includes(command) ? `/bin/${command}` : undefined;

	it("auto prefers a ready FORCA inside FORCA, then tmux, then headless", async () => {
		const forcaReady = fakeRunner([{ match: (c) => c.command === "forca", result: { stdout: ready } }]);
		expect(
			await selectBackend("auto", {
				env: { PHI_CLIENT: "forca" },
				which: which(["forca", "tmux"]),
				run: forcaReady,
			}),
		).toEqual({
			backend: "forca",
		});
		expect(forcaReady.calls).toEqual([
			{ command: "forca", args: ["status", "--json"], options: { timeoutMs: 3000 } },
		]);

		const notReady = fakeRunner([
			{
				match: (c) => c.command === "forca",
				result: { stdout: JSON.stringify({ ok: true, result: { runtime: { state: "starting" } } }) },
			},
		]);
		expect(
			await selectBackend(undefined, {
				env: { PHI_CLIENT: "forca" },
				which: which(["forca", "tmux"]),
				run: notReady,
			}),
		).toEqual({
			backend: "tmux",
			note: "FORCA not ready (runtime not ready)",
		});
		const failing = fakeRunner([{ match: () => true, result: { code: null, error: "timed out after 3000 ms" } }]);
		expect(
			await selectBackend("auto", { env: { PHI_CLIENT: "forca" }, which: which(["forca"]), run: failing }),
		).toEqual({
			backend: "headless",
			note: "FORCA not ready (timed out after 3000 ms); tmux not on PATH",
		});
		// Outside FORCA the forca CLI is not consulted.
		const untouched = fakeRunner();
		expect(await selectBackend("auto", { env: {}, which: which(["forca", "tmux"]), run: untouched })).toEqual({
			backend: "tmux",
		});
		expect(await selectBackend("auto", { env: {}, which: which([]), run: untouched })).toEqual({
			backend: "headless",
		});
		expect(untouched.calls).toEqual([]);
	});

	it("explicit backends must be available", async () => {
		const run = fakeRunner();
		expect(await selectBackend("headless", { env: {}, which: which([]), run })).toEqual({ backend: "headless" });
		await expect(selectBackend("forca", { env: {}, which: which([]), run })).rejects.toThrow(
			/forca CLI is not on PATH/,
		);
		await expect(selectBackend("tmux", { env: {}, which: which([]), run })).rejects.toThrow(/tmux is not on PATH/);
		expect(await selectBackend("tmux", { env: {}, which: which(["tmux"]), run })).toEqual({ backend: "tmux" });
		await expect(selectBackend("screen", { env: {}, which: which([]), run })).rejects.toThrow(/Unknown backend/);
	});

	it("parses FORCA JSON", () => {
		expect(
			parseForcaHandle(
				JSON.stringify({
					id: "1",
					ok: true,
					result: { terminal: { handle: "term_abc", worktreeId: "w", title: "t" } },
				}),
			),
		).toBe("term_abc");
		expect(
			parseForcaHandle(
				`warning: something\n${JSON.stringify({ ok: true, result: { terminal: { handle: "term_x" } } })}\n`,
			),
		).toBe("term_x");
		expect(parseForcaHandle(JSON.stringify({ ok: false, error: { code: "x", message: "nope" } }))).toBeUndefined();
		expect(parseForcaHandle("not json")).toBeUndefined();
		expect(parseForcaReady(ready)).toBe(true);
		expect(
			parseForcaReady(JSON.stringify({ ok: true, result: { runtime: { state: "ready", reachable: false } } })),
		).toBe(false);
	});
});

describe("overseer terminals", () => {
	it("creates a FORCA tab in the cwd worktree, falling back to the active one, never focused", async () => {
		const run = fakeRunner([
			{
				match: (c) => c.args.includes("path:/repo/sub dir"),
				result: {
					code: 1,
					stdout: JSON.stringify({ ok: false, error: { code: "not_found", message: "no worktree matches" } }),
				},
			},
			{
				match: (c) => c.args.includes("active"),
				result: { stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "term_42" } } }) },
			},
		]);
		const created = await createForcaTerminal(run, {
			cwd: "/repo/sub dir",
			title: "api",
			launcher: "/agent/launch/x y.sh",
		});
		expect(created).toEqual({ handle: "term_42", worktree: "active" });
		expect(run.calls.map((c) => c.args)).toEqual([
			[
				"terminal",
				"create",
				"--worktree",
				"path:/repo/sub dir",
				"--title",
				"api",
				"--command",
				"sh '/agent/launch/x y.sh'",
				"--json",
			],
			[
				"terminal",
				"create",
				"--worktree",
				"active",
				"--title",
				"api",
				"--command",
				"sh '/agent/launch/x y.sh'",
				"--json",
			],
		]);
		expect(run.calls.every((c) => c.command === "forca" && !c.args.includes("--focus"))).toBe(true);

		const broken = fakeRunner([{ match: () => true, result: { code: 1, stderr: "Orca is not running" } }]);
		await expect(createForcaTerminal(broken, { cwd: "/r", title: "t", launcher: "/l.sh" })).rejects.toThrow(
			/forca terminal create failed \(--worktree path:\/r: Orca is not running; --worktree active: Orca is not running\)/,
		);
	});

	it("creates a detached tmux session, retrying a duplicate name once", async () => {
		expect(tmuxSessionName("API: v2.fix")).toBe("phi-API-v2-fix");
		expect(tmuxSessionName("§§§")).toBe("phi-thread");
		const run = fakeRunner([
			{ match: (c) => c.args[3] === "phi-api", result: { code: 1, stderr: "duplicate session: phi-api" } },
		]);
		const session = await createTmuxSession(run, {
			name: "api",
			sessionId: "0190-abcdef123456",
			cwd: "/w",
			launcher: "/l.sh",
		});
		expect(session).toBe("phi-api-123456");
		expect(run.calls.map((c) => [c.command, ...c.args])).toEqual([
			["tmux", "new-session", "-d", "-s", "phi-api", "-c", "/w", "sh '/l.sh'"],
			["tmux", "new-session", "-d", "-s", "phi-api-123456", "-c", "/w", "sh '/l.sh'"],
		]);
	});

	it("pins a FORCA tab title with terminal rename (argv, no shell) and reports a failure", async () => {
		const run = fakeRunner([
			{ match: (c) => c.command === "forca", result: { stdout: JSON.stringify({ ok: true, result: {} }) } },
		]);
		expect(await renameForcaTerminal(run, "term_42", "api $(x)")).toEqual({ ok: true });
		expect(run.calls.map((c) => [c.command, ...c.args])).toEqual([
			["forca", "terminal", "rename", "--terminal", "term_42", "--title", "api $(x)", "--json"],
		]);
		const failing = fakeRunner([
			{
				match: () => true,
				result: { code: 1, stdout: JSON.stringify({ ok: false, error: { message: "terminal_handle_stale" } }) },
			},
		]);
		expect(await renameForcaTerminal(failing, "term_x", "api")).toEqual({
			ok: false,
			detail: "terminal_handle_stale",
		});
	});

	it("closes FORCA tabs and tmux sessions", async () => {
		const run = fakeRunner([
			{ match: (c) => c.command === "forca", result: { stdout: JSON.stringify({ ok: true, result: {} }) } },
		]);
		expect(await closeForcaTerminal(run, "term_42")).toEqual({ ok: true });
		expect(await closeTmuxSession(run, "phi-api")).toEqual({ ok: true });
		expect(run.calls.map((c) => [c.command, ...c.args])).toEqual([
			["forca", "terminal", "close", "--terminal", "term_42", "--tab", "--json"],
			["tmux", "kill-session", "-t", "=phi-api"],
		]);
		// Already gone (the launcher exec'd phi, which exited): closed, not a failure.
		for (const stderr of [
			"can't find session: phi-x",
			"no server running on /tmp/tmux-1001/default",
			"error connecting to /tmp/tmux-1001/default (No such file or directory)",
		]) {
			const gone = fakeRunner([{ match: () => true, result: { code: 1, stderr } }]);
			expect(await closeTmuxSession(gone, "phi-x")).toEqual({ ok: true, gone: true });
		}
		const failing = fakeRunner([{ match: () => true, result: { code: 1, stderr: "permission denied" } }]);
		expect(await closeTmuxSession(failing, "phi-x")).toEqual({ ok: false, detail: "permission denied" });
	});

	it("the default runner never throws and reports failures", async () => {
		expect(await defaultRunner("sh", ["-c", "printf ok"])).toEqual({ code: 0, stdout: "ok", stderr: "" });
		expect((await defaultRunner("sh", ["-c", "echo bad >&2; exit 3"])).code).toBe(3);
		expect((await defaultRunner("/nonexistent/binary-xyz", [])).error).toBe("ENOENT");
		expect((await defaultRunner("sh", ["-c", "sleep 5"], { timeoutMs: 100 })).error).toMatch(/timed out/);
	});
});
