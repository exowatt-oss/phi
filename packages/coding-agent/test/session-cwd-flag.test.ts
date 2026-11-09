/**
 * `--session <file> --session-cwd <dir>`: phi remote resumes a stored session whose folder is gone
 * (or is another machine's path) in a fallback folder. It must continue the SAME session id and
 * file with its full context, from that folder, in rpc mode where no dialog can be answered.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type Args, parseArgs } from "../src/cli/args.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager } from "../src/main.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "phi-session-cwd-")));
	tempDirs.push(dir);
	return dir;
}

function args(overrides: Partial<Args>): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [], ...overrides };
}

/** A stored session (user + assistant) recorded in `cwd`, stored under `sessionDir`. */
function storeSession(cwd: string, sessionDir: string): { id: string; path: string } {
	const sm = SessionManager.create(cwd, sessionDir);
	sm.appendMessage({ role: "user", content: "the code word is heliotrope", timestamp: Date.now() });
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "noted" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	return { id: sm.getSessionId(), path: sm.getSessionFile() as string };
}

interface RpcRun {
	code: number | null;
	state?: { sessionId: string; sessionFile: string; messageCount: number };
	stderr: string;
}

/** Run `phi --mode rpc ...` from `cwd`, ask `get_state`, then close stdin. */
function runRpc(cliArgs: string[], cwd: string, root: string): Promise<RpcRun> {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^(PI_|PHI_|FEADS_|TMUX)/.test(key)) env[key] = value;
	}
	Object.assign(env, {
		PHI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_REMOTE_DIR: join(root, "remote"),
		PI_OFFLINE: "1",
	});
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, "--mode", "rpc", ...cliArgs], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(child);
		let stdout = "";
		let stderr = "";
		let state: RpcRun["state"];
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (d: string) => {
			stderr += d;
		});
		child.stdout.on("data", (d: string) => {
			stdout += d;
			for (let nl = stdout.indexOf("\n"); nl >= 0; nl = stdout.indexOf("\n")) {
				const line = stdout.slice(0, nl);
				stdout = stdout.slice(nl + 1);
				try {
					const msg = JSON.parse(line);
					if (msg.type === "response" && msg.command === "get_state") {
						state = msg.data;
						child.stdin.end();
					}
				} catch {
					// not JSON
				}
			}
		});
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code, state, stderr }));
		child.stdin.write(`${JSON.stringify({ type: "get_state", id: "s1" })}\n`);
	});
}

describe("--session-cwd", () => {
	it("parses with --session", () => {
		expect(parseArgs(["--session", "/s/a.jsonl", "--session-cwd", "/home/u/x"])).toMatchObject({
			session: "/s/a.jsonl",
			sessionCwd: "/home/u/x",
		});
	});

	it("opens the same session id and file, with its entries, in the given folder", async () => {
		const root = tempDir();
		const gone = join(root, "deleted-worktree");
		const fallback = join(root, "fallback");
		const elsewhere = join(root, "elsewhere");
		mkdirSync(fallback);
		mkdirSync(elsewhere);
		const stored = storeSession(gone, join(root, "sessions", "proj"));
		const sm = await createSessionManager(
			args({ session: stored.path, sessionCwd: fallback }),
			elsewhere,
			undefined,
			SettingsManager.inMemory(),
		);
		expect(sm.getSessionId()).toBe(stored.id);
		expect(sm.getSessionFile()).toBe(stored.path);
		expect(sm.getCwd()).toBe(fallback);
		expect(sm.buildSessionContext().messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it(
		"rpc: continues the same session from a fallback folder when the recorded one is gone",
		{ timeout: 60_000 },
		async () => {
			const root = tempDir();
			const gone = join(root, "deleted-worktree");
			const fallback = join(root, "fallback");
			mkdirSync(fallback);
			const stored = storeSession(gone, join(root, "sessions", "proj"));
			const before = readFileSync(stored.path, "utf8");

			// Without the flag, rpc mode cannot ask where to run, so it refuses (the old resume failure).
			const refused = await runRpc(["--session", stored.path], fallback, root);
			expect(refused.code).not.toBe(0);
			expect(refused.stderr).toContain("Stored session working directory does not exist");

			const run = await runRpc(["--session", stored.path, "--session-cwd", fallback], fallback, root);
			expect(run.state).toMatchObject({ sessionId: stored.id, sessionFile: stored.path, messageCount: 2 });
			// Same file, untouched header: the recorded cwd stays as it was.
			expect(readFileSync(stored.path, "utf8").startsWith(before.split("\n")[0])).toBe(true);
		},
	);

	it(
		"rpc: a session whose recorded folder exists continues in place from any other cwd",
		{ timeout: 60_000 },
		async () => {
			const root = tempDir();
			const recorded = join(root, "project");
			const other = join(root, "other");
			mkdirSync(recorded);
			mkdirSync(other);
			const stored = storeSession(recorded, join(root, "sessions", "proj"));
			const run = await runRpc(["--session", stored.path], other, root);
			expect(run.state).toMatchObject({ sessionId: stored.id, sessionFile: stored.path, messageCount: 2 });
		},
	);
});
