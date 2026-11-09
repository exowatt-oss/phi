/**
 * Where threads run: a visible FORCA tab, a detached tmux session, or a headless hub child.
 *
 * FORCA and tmux threads start from a launcher script (0700) that `cd`s to the thread's cwd,
 * clears the session metadata inherited from the overseer, exports the thread environment and
 * `exec`s the same phi invocation with a pre-generated `--session-id`. The prompt sits in a 0600
 * file next to it and is read with `"$(cat file)"`; no user text is ever interpolated into shell
 * code. The prompt therefore ends up in phi's argv (visible in `ps`): phi has no prompt-file input
 * that yields the same first user message (`@file` wraps the text in `<file name=…>` tags, and piped
 * stdin switches phi to print mode). Every external program runs through an argument-array
 * `Runner` with a timeout.
 */

import { execFile } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../../config.ts";
import type { PhiInvocation } from "../../remote/hub/spawn.ts";
import type { LaunchBackend, Runner, RunResult } from "./types.ts";

/** Default runner: `execFile` (no shell), bounded output, never rejects. */
export const defaultRunner: Runner = (command, args, options = {}) =>
	new Promise<RunResult>((resolve) => {
		const timeout = options.timeoutMs ?? 15_000;
		try {
			execFile(
				command,
				args,
				{
					timeout,
					maxBuffer: 4 * 1024 * 1024,
					cwd: options.cwd,
					env: options.env,
					encoding: "utf8",
					windowsHide: true,
				},
				(error, stdout, stderr) => {
					if (!error) return resolve({ code: 0, stdout, stderr });
					const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
					resolve({
						code: typeof failure.code === "number" ? failure.code : null,
						stdout: stdout ?? "",
						stderr: stderr ?? "",
						...(failure.killed
							? { error: `timed out after ${timeout} ms` }
							: typeof failure.code === "string"
								? { error: failure.code }
								: {}),
					});
				},
			);
		} catch (error) {
			resolve({ code: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) });
		}
	});

/** Absolute path of `command` on PATH, or undefined. */
export function whichOnPath(command: string, path = process.env.PATH ?? ""): string | undefined {
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, command);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}

/** POSIX single-quote a word. Works in sh, bash, zsh and tmux shell-commands. */
export function shQuote(value: string): string {
	if (value.includes("\0")) throw new Error("Shell words cannot contain NUL bytes.");
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Variables an overseer's environment may carry that must not reach a thread. */
export const UNSET_VARS = [
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
	"PI_TUI_MODE",
	"PHI_REMOTE",
	"PHI_REMOTE_SPAWN_ID",
	"PHI_REMOTE_SERVICE",
] as const;
/**
 * Set in every launcher (after the unsets): FORCA and tmux threads always run phi's own terminal UI
 * that a human reads, whether or not the overseer itself is a terminal session. Headless threads
 * never get it (the hub's env allowlist drops it and they run in RPC mode).
 */
export const LAUNCHER_TUI_ENV = { PI_TUI_MODE: "1" } as const;
/** Prefixes cleared the same way (the thread's own PHI_OVERSEER_* / PHI_SUBAGENT_MODEL_* are re-exported). */
export const UNSET_PREFIXES = ["PI_SESSION_", "PI_SUBAGENT_", "PHI_OVERSEER_", "PHI_SUBAGENT_MODEL_"] as const;

/**
 * Location overrides of the overseer's own process that a thread must share: the hub directory
 * (else a FORCA/tmux thread registers with another hub and the spawn times out), the agent
 * directory (registry, agent mail, auth) and the session directory. A FORCA tab or tmux server
 * does not inherit the overseer's environment, so the launcher exports them when set.
 */
export const CARRIED_ENV_KEYS = [
	"PI_REMOTE_DIR",
	...new Set([ENV_AGENT_DIR, "PI_CODING_AGENT_DIR", ENV_SESSION_DIR, "PI_CODING_AGENT_SESSION_DIR"]),
] as const;

/** The `CARRIED_ENV_KEYS` set (non-blank) in `env`; relative paths resolved against this process's cwd. */
export function carriedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of CARRIED_ENV_KEYS) {
		const value = env[key]?.trim();
		if (!value) continue;
		out[key] = value === "~" || value.startsWith("~/") ? value : resolve(value);
	}
	return out;
}

export interface LauncherSpec {
	sessionId: string;
	name: string;
	cwd: string;
	invocation: PhiInvocation;
	model?: string;
	thinking?: string;
	env: Record<string, string>;
	/** The overseer's environment: `CARRIED_ENV_KEYS` set there are exported too. */
	hostEnv?: NodeJS.ProcessEnv;
	promptFile: string;
	appendSystemPromptFile?: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The launcher script text. Every dynamic word is single-quoted. */
export function buildLauncherScript(spec: LauncherSpec): string {
	const args = [
		spec.invocation.command,
		...spec.invocation.args,
		"--session-id",
		spec.sessionId,
		...(spec.model ? ["--model", spec.model] : []),
		...(spec.thinking ? ["--thinking", spec.thinking] : []),
		"--name",
		spec.name,
		...(spec.appendSystemPromptFile ? ["--append-system-prompt", spec.appendSystemPromptFile] : []),
	];
	const sedExpressions = UNSET_PREFIXES.flatMap((prefix) => [
		"-e",
		shQuote(`s/^\\(${prefix}[A-Za-z0-9_]*\\)=.*/\\1/p`),
	]).join(" ");
	const lines = [
		"#!/bin/sh",
		`# phi overseer thread ${shQuote(spec.name.replace(/[\r\n]+/g, " "))} (session ${spec.sessionId}).`,
		"# Generated by the overseer; safe to delete once the thread has exited.",
		`cd ${shQuote(spec.cwd)} || exit 1`,
		`unset ${UNSET_VARS.join(" ")}`,
		`for __phi_var in $(env | sed -n ${sedExpressions}); do unset "$__phi_var"; done`,
		"unset __phi_var",
	];
	const exported = { ...(spec.hostEnv ? carriedEnv(spec.hostEnv) : {}), ...spec.env, ...LAUNCHER_TUI_ENV };
	for (const [key, value] of Object.entries(exported)) {
		if (!ENV_NAME.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
		lines.push(`export ${key}=${shQuote(value)}`);
	}
	// `--` ends phi's options, so a prompt starting with "-" stays a message.
	lines.push(`exec ${args.map(shQuote).join(" ")} -- "$(cat ${shQuote(spec.promptFile)})"`);
	return `${lines.join("\n")}\n`;
}

export interface LaunchFiles {
	launcher: string;
	promptFile: string;
	appendSystemPromptFile?: string;
}

/** Launch file paths for a session id under `<agentDir>/overseer/launch/`. */
export function launchPaths(agentDir: string, sessionId: string): LaunchFiles & { dir: string; systemFile: string } {
	const dir = join(agentDir, "overseer", "launch");
	return {
		dir,
		launcher: join(dir, `${sessionId}.sh`),
		promptFile: join(dir, `${sessionId}.prompt`),
		systemFile: join(dir, `${sessionId}.system.md`),
	};
}

function writePrivate(path: string, content: string, mode: number): void {
	writeFileSync(path, content, { mode });
	chmodSync(path, mode);
}

/**
 * Write the prompt (0600), the optional system-prompt addition (0600) and the launcher (0700) into
 * a 0700 directory. A prompt starting with "@" gets a leading space: phi reads `@path` as a file.
 */
export function writeLaunchFiles(
	agentDir: string,
	spec: Omit<LauncherSpec, "promptFile" | "appendSystemPromptFile">,
	prompt: string,
	appendSystemPrompt?: string,
): LaunchFiles {
	const paths = launchPaths(agentDir, spec.sessionId);
	mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
	chmodSync(join(agentDir, "overseer"), 0o700);
	chmodSync(paths.dir, 0o700);
	writePrivate(paths.promptFile, prompt.startsWith("@") ? ` ${prompt}` : prompt, 0o600);
	let appendSystemPromptFile: string | undefined;
	if (appendSystemPrompt?.trim()) {
		writePrivate(paths.systemFile, appendSystemPrompt, 0o600);
		appendSystemPromptFile = paths.systemFile;
	}
	writePrivate(
		paths.launcher,
		buildLauncherScript({ ...spec, promptFile: paths.promptFile, appendSystemPromptFile }),
		0o700,
	);
	return { launcher: paths.launcher, promptFile: paths.promptFile, appendSystemPromptFile };
}

/** Remove a thread's launch files (best effort). */
export function removeLaunchFiles(agentDir: string, sessionId: string): void {
	const paths = launchPaths(agentDir, sessionId);
	for (const path of [paths.launcher, paths.promptFile, paths.systemFile]) {
		try {
			unlinkSync(path);
		} catch {
			// already gone
		}
	}
}

/** `phi-<name>` with only characters tmux accepts in a session name. */
export function tmuxSessionName(name: string): string {
	const clean = name
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	return `phi-${clean || "thread"}`;
}

function parseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start === -1 || end <= start) return undefined;
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return undefined;
		}
	}
}

/** Short reason from a failed run (JSON error message, stderr, or the spawn error). */
export function runFailure(result: RunResult): string {
	const json = parseJson(result.stdout) as { error?: { message?: unknown } } | undefined;
	const message = typeof json?.error?.message === "string" ? json.error.message : undefined;
	const text = message ?? (result.stderr.trim() || result.stdout.trim() || result.error || `exit ${result.code}`);
	return text.replace(/\s+/g, " ").slice(0, 300);
}

/** Terminal handle from `forca terminal create --json` output; undefined when it failed. */
export function parseForcaHandle(stdout: string): string | undefined {
	const json = parseJson(stdout) as { ok?: unknown; result?: { terminal?: { handle?: unknown } } } | undefined;
	if (!json || json.ok === false) return undefined;
	const handle = json.result?.terminal?.handle;
	return typeof handle === "string" && handle.trim() ? handle.trim() : undefined;
}

/** `forca status --json` says the runtime is ready. */
export function parseForcaReady(stdout: string): boolean {
	const json = parseJson(stdout) as
		| { ok?: unknown; result?: { runtime?: { state?: unknown; reachable?: unknown } } }
		| undefined;
	if (!json || json.ok === false) return false;
	const runtime = json.result?.runtime;
	return runtime?.state === "ready" && runtime.reachable !== false;
}

export async function forcaReady(run: Runner, timeoutMs = 3000): Promise<{ ready: boolean; reason?: string }> {
	const result = await run("forca", ["status", "--json"], { timeoutMs });
	if (result.code === 0 && parseForcaReady(result.stdout)) return { ready: true };
	return { ready: false, reason: result.code === 0 ? "runtime not ready" : runFailure(result) };
}

export interface BackendChoiceResult {
	backend: LaunchBackend;
	/** Why auto picked this backend when it is not the first preference. */
	note?: string;
}

/**
 * Resolve `backend`: explicit choices must be available; `auto` prefers FORCA (inside FORCA,
 * `forca` on PATH, runtime ready within ~3 s), then tmux, then headless.
 */
export async function selectBackend(
	requested: string | undefined,
	deps: { env: NodeJS.ProcessEnv; which: (command: string) => string | undefined; run: Runner },
): Promise<BackendChoiceResult> {
	const choice = requested ?? "auto";
	if (choice === "headless") return { backend: "headless" };
	if (choice === "forca") {
		if (!deps.which("forca")) throw new Error('backend "forca": the forca CLI is not on PATH.');
		return { backend: "forca" };
	}
	if (choice === "tmux") {
		if (!deps.which("tmux")) throw new Error('backend "tmux": tmux is not on PATH.');
		return { backend: "tmux" };
	}
	if (choice !== "auto") throw new Error(`Unknown backend "${choice}". Use auto, forca, tmux or headless.`);
	const notes: string[] = [];
	if (deps.env.PHI_CLIENT?.trim().toLowerCase() === "forca") {
		if (deps.which("forca")) {
			const status = await forcaReady(deps.run);
			if (status.ready) return { backend: "forca" };
			notes.push(`FORCA not ready (${status.reason})`);
		} else notes.push("forca CLI not on PATH");
	}
	if (deps.which("tmux")) return { backend: "tmux", ...(notes.length ? { note: notes.join("; ") } : {}) };
	if (notes.length) notes.push("tmux not on PATH");
	return { backend: "headless", ...(notes.length ? { note: notes.join("; ") } : {}) };
}

/**
 * Open a background FORCA tab running the launcher. Tries the thread's cwd as the worktree, then
 * the active worktree (the launcher `cd`s to the cwd either way). Never focuses the tab.
 */
export async function createForcaTerminal(
	run: Runner,
	options: { cwd: string; title: string; launcher: string },
): Promise<{ handle: string; worktree: string }> {
	const command = `sh ${shQuote(options.launcher)}`;
	const failures: string[] = [];
	for (const worktree of [`path:${options.cwd}`, "active"]) {
		const result = await run(
			"forca",
			["terminal", "create", "--worktree", worktree, "--title", options.title, "--command", command, "--json"],
			{ timeoutMs: 20_000 },
		);
		const handle = result.code === 0 ? parseForcaHandle(result.stdout) : undefined;
		if (handle) return { handle, worktree };
		failures.push(`--worktree ${worktree}: ${runFailure(result)}`);
	}
	throw new Error(`forca terminal create failed (${failures.join("; ")}).`);
}

/** Start a detached tmux session running the launcher; retries once with a unique suffix. */
export async function createTmuxSession(
	run: Runner,
	options: { name: string; sessionId: string; cwd: string; launcher: string },
): Promise<string> {
	const base = tmuxSessionName(options.name);
	const command = `sh ${shQuote(options.launcher)}`;
	let last = "";
	for (const session of [base, `${base}-${options.sessionId.slice(-6)}`]) {
		const result = await run("tmux", ["new-session", "-d", "-s", session, "-c", options.cwd, command], {
			timeoutMs: 10_000,
		});
		if (result.code === 0) return session;
		last = runFailure(result);
		if (!/duplicate session/i.test(last)) break;
	}
	throw new Error(`tmux new-session failed: ${last}`);
}

/**
 * Pin a FORCA tab's title. `terminal create --title` only sets the tab's initial live title, which
 * FORCA replaces with the agent's terminal title or its synthetic agent status ("phi ready") once
 * phi runs; a rename sets the tab's custom title, which outranks both.
 */
export async function renameForcaTerminal(
	run: Runner,
	handle: string,
	title: string,
): Promise<{ ok: boolean; detail?: string }> {
	const result = await run("forca", ["terminal", "rename", "--terminal", handle, "--title", title, "--json"], {
		timeoutMs: 10_000,
	});
	const json = parseJson(result.stdout) as { ok?: unknown } | undefined;
	if (result.code === 0 && json?.ok !== false) return { ok: true };
	return { ok: false, detail: runFailure(result) };
}

/** Close a thread's FORCA tab. */
export async function closeForcaTerminal(run: Runner, handle: string): Promise<{ ok: boolean; detail?: string }> {
	const result = await run("forca", ["terminal", "close", "--terminal", handle, "--tab", "--json"], {
		timeoutMs: 20_000,
	});
	const json = parseJson(result.stdout) as { ok?: unknown } | undefined;
	if (result.code === 0 && json?.ok !== false) return { ok: true };
	return { ok: false, detail: runFailure(result) };
}

/**
 * tmux's answers when the session is not there: the launcher `exec`s phi, so a thread that exited
 * (or was closed over ctl) has already ended its tmux session, and the server with it when it was
 * the last one.
 */
const TMUX_GONE = /can't find session|session not found|no server running|error connecting to .*no such file/i;

/** Kill a thread's tmux session (exact name match); a session that is already gone counts as closed. */
export async function closeTmuxSession(
	run: Runner,
	session: string,
): Promise<{ ok: boolean; gone?: boolean; detail?: string }> {
	const result = await run("tmux", ["kill-session", "-t", `=${session}`], { timeoutMs: 10_000 });
	if (result.code === 0) return { ok: true };
	const detail = runFailure(result);
	return TMUX_GONE.test(detail) ? { ok: true, gone: true } : { ok: false, detail };
}
