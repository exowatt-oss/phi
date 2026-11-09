/**
 * Headless sessions (`session.spawn`): the hub starts `phi --mode rpc` in a directory, keeps its
 * stdio, cancels every blocking extension UI dialog (nobody is at that terminal), and logs the
 * child's stderr. The child's own remote extension registers back over hub.sock carrying
 * `PHI_REMOTE_SPAWN_ID`, which is how the hub matches it to the pending spawn.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { type RemoteError, THREAD_ENV_KEYS, THREAD_ENV_PREFIXES } from "../protocol.ts";
import type { RotatingLog } from "./files.ts";
import { attachNdjsonReader, ndjson } from "./ndjson.ts";

export const SPAWN_ID_ENV = "PHI_REMOTE_SPAWN_ID";

/** How to re-run this same phi: `[node, cli.js]` from a script install, the binary itself otherwise. */
export interface PhiInvocation {
	command: string;
	args: string[];
}

export interface ProcessInfo {
	execPath: string;
	argv: readonly string[];
	execArgv: readonly string[];
}

function isBunVirtualPath(path: string): boolean {
	return path.startsWith("/$bunfs/") || path.includes("~BUN") || path.includes("%7EBUN");
}

/**
 * Resolve the command that runs this phi. When the entry script is `cli.js`/`cli.ts` (npm install
 * or source checkout) run `[execPath, ...execArgv, script]` — execArgv keeps loaders such as tsx;
 * a compiled single binary is just `execPath`.
 */
export function resolvePhiInvocation(
	proc: ProcessInfo = { execPath: process.execPath, argv: process.argv, execArgv: process.execArgv },
): PhiInvocation {
	const script = proc.argv[1];
	if (script && !isBunVirtualPath(script) && /(^|[\\/])cli\.(js|mjs|cjs|ts)$/.test(script)) {
		const execArgv = proc.execArgv.filter((arg) => !arg.startsWith("--inspect") && !arg.startsWith("--debug"));
		return { command: proc.execPath, args: [...execArgv, resolve(script)] };
	}
	return { command: proc.execPath, args: [] };
}

/**
 * Metadata a phi session exports to its tools (docs/environment-variables.md) plus the nested
 * subagent markers. A hub started from inside an agent's shell inherits them; passed on, they would
 * make a headless child look like that agent's nested subagent (its remote extension then stays
 * off and the spawn never registers) or pin its model.
 */
const INHERITED_SESSION_ENV = [
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
	"PI_TUI_MODE",
	// The hub's own markers: a child must not believe it is the login service, must register with
	// its own spawn id only, and must not inherit `PHI_REMOTE=0` (its remote extension would stay
	// off and the spawn would never register).
	"PHI_REMOTE",
	"PHI_REMOTE_SPAWN_ID",
	"PHI_REMOTE_SERVICE",
];
/**
 * `PHI_OVERSEER_*` / `PHI_SUBAGENT_MODEL_*` belong to one overseer thread: a hub started from inside
 * a thread must not make every session it starts look like a thread of that overseer. The control
 * wire's `session.spawn` / `session.resume` set them per child (`filterThreadEnv`).
 */
const INHERITED_SESSION_ENV_PREFIXES = ["PI_SESSION_", "PI_SUBAGENT_", ...THREAD_ENV_PREFIXES];

/**
 * `env` without inherited session metadata; `spawnId` set as `PHI_REMOTE_SPAWN_ID` when given.
 * The hub keeps no secrets in its environment (device tokens and the APNs key live in memory and
 * in 0600 files), so nothing else needs removing.
 */
export function cleanChildEnv(env: NodeJS.ProcessEnv, spawnId?: string): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || INHERITED_SESSION_ENV.includes(key)) continue;
		if (INHERITED_SESSION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
		out[key] = value;
	}
	if (spawnId) out[SPAWN_ID_ENV] = spawnId;
	return out;
}

/** Longest value `filterThreadEnv` keeps. */
export const THREAD_ENV_MAX_VALUE = 4096;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The thread variables of a control-wire `env` (`session.spawn` / `session.resume`): keys in
 * THREAD_ENV_KEYS or starting with one of THREAD_ENV_PREFIXES, with string values of at most
 * THREAD_ENV_MAX_VALUE characters and no NUL. Everything else is dropped.
 */
export function filterThreadEnv(env: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!env || typeof env !== "object" || Array.isArray(env)) return out;
	for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
		if (!ENV_NAME.test(key)) continue;
		const allowed =
			(THREAD_ENV_KEYS as readonly string[]).includes(key) ||
			THREAD_ENV_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
		if (!allowed) continue;
		if (typeof value !== "string" || value.length > THREAD_ENV_MAX_VALUE || value.includes("\0")) continue;
		out[key] = value;
	}
	return out;
}

const MODEL_ARG = /^[A-Za-z0-9._:@/+-]+$/;

export function isSafeModelArg(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		!value.startsWith("-") &&
		MODEL_ARG.test(value)
	);
}

/** `session.spawn` `thinkingLevel`: one of phi's thinking levels (what `--thinking` accepts). */
export function isSpawnThinkingLevel(value: unknown): value is string {
	return typeof value === "string" && isValidThinkingLevel(value);
}

export interface SpawnModelOptions {
	provider?: string;
	modelId?: string;
	/** Passed as `--thinking`; the child clamps it to its model's supported levels. */
	thinkingLevel?: string;
	/**
	 * `session.resume`: continue this stored session file (`--session <file>`, same id, same file).
	 * Must be an absolute path; anything else is dropped, never passed on.
	 */
	sessionFile?: string;
	/**
	 * With `sessionFile`: run the session in this folder instead of its recorded cwd
	 * (`--session-cwd <dir>`; same id, same file). Must be absolute; anything else is dropped.
	 */
	sessionCwd?: string;
}

/** Longest `--name` / `--append-system-prompt` value a headless child is started with. */
export const SPAWN_NAME_MAX = 200;
export const SPAWN_SYSTEM_PROMPT_MAX = 64 * 1024;

/** Child arguments beyond the model: the control wire's `session.spawn` sets these. */
export interface SpawnArgsOptions extends SpawnModelOptions {
	/** `--name`: the session's display name. Dropped unless non-blank, ≤ SPAWN_NAME_MAX chars, no NUL. */
	name?: string;
	/** `--append-system-prompt`. Dropped unless non-blank, ≤ SPAWN_SYSTEM_PROMPT_MAX chars, no NUL. */
	appendSystemPrompt?: string;
}

function isArgText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}

/**
 * Arguments for a headless child: the invocation plus `--mode rpc`, the optional model, the
 * optional thinking level, and (control wire) `--name` / `--append-system-prompt`. A thinking level
 * that is not one of phi's is dropped, never passed on.
 */
export function buildSpawnArgs(base: PhiInvocation, options: SpawnArgsOptions = {}): string[] {
	const args = [...base.args, "--mode", "rpc"];
	const { provider, modelId, thinkingLevel, sessionFile, sessionCwd, name, appendSystemPrompt } = options;
	if (sessionFile !== undefined && isAbsolute(sessionFile) && !sessionFile.startsWith("-")) {
		args.push("--session", sessionFile);
		if (sessionCwd !== undefined && isAbsolute(sessionCwd)) args.push("--session-cwd", sessionCwd);
	}
	if (provider && modelId) args.push("--model", `${provider}/${modelId}`);
	else if (modelId) args.push("--model", modelId);
	else if (provider) args.push("--provider", provider);
	if (thinkingLevel !== undefined && isSpawnThinkingLevel(thinkingLevel)) args.push("--thinking", thinkingLevel);
	if (isArgText(name, SPAWN_NAME_MAX)) args.push("--name", name.trim());
	if (isArgText(appendSystemPrompt, SPAWN_SYSTEM_PROMPT_MAX)) args.push("--append-system-prompt", appendSystemPrompt);
	return args;
}

export function isInside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Check a requested working directory: absolute (or `~`-relative), existing, a directory, and
 * inside one of `roots` (after resolving symlinks, so a link cannot escape a root). Missing or
 * non-directory → `bad_request`; outside every root → `forbidden` (contract clarification 6).
 * Returns the resolved real path, which is what the child is started in: a symlink swapped after
 * the check cannot redirect it.
 */
export function validateSpawnCwd(
	input: unknown,
	roots: readonly string[],
	home = homedir(),
): { cwd: string } | { error: RemoteError } {
	const resolved = resolveSpawnCwd(input, home);
	if ("error" in resolved) return resolved;
	if (!roots.some((root) => isInside(resolved.cwd, realOrResolved(root)))) {
		const shown = typeof input === "string" ? expandHome(input.trim(), home) : resolved.cwd;
		return { error: { code: "forbidden", message: `${shown} is outside the allowed roots` } };
	}
	return resolved;
}

/** `~` and `~/x` expanded against `home`; absolute paths normalized; relative ones left as they are. */
function expandHome(path: string, home: string): string {
	const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
	return isAbsolute(expanded) ? resolve(expanded) : expanded;
}

/**
 * `validateSpawnCwd` without the roots check (the control wire's `session.spawn`: hub.sock is this
 * user's alone): absolute or `~`-relative, existing, a directory; returns its real path.
 */
export function resolveSpawnCwd(input: unknown, home = homedir()): { cwd: string } | { error: RemoteError } {
	if (typeof input !== "string" || input.trim().length === 0) {
		return { error: { code: "bad_request", message: "cwd is required" } };
	}
	const path = expandHome(input.trim(), home);
	if (!isAbsolute(path)) return { error: { code: "bad_request", message: "cwd must be an absolute path" } };
	let real: string;
	try {
		real = realpathSync(path);
		if (!statSync(real).isDirectory()) return { error: { code: "bad_request", message: `Not a directory: ${path}` } };
	} catch {
		return { error: { code: "bad_request", message: `No such directory: ${path}` } };
	}
	return { cwd: real };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The folder a stored session is resumed in (`session.resume`; allowed roots do not apply, the
 * file is already on this machine): (a) the recorded cwd if it is a directory; (b) the same path
 * re-rooted from another home (`/Users/<u>/X` or `/home/<u>/X` → `$HOME/X`); (c) the nearest
 * existing ancestor of the recorded cwd other than `/`; (d) `$HOME`. `fallback` is true when the
 * result is not the recorded cwd.
 */
export function resolveResumeCwd(recorded: string, home = homedir()): { cwd: string; fallback: boolean } {
	if (recorded && isAbsolute(recorded)) {
		if (isDirectory(recorded)) return { cwd: recorded, fallback: false };
		const path = resolve(recorded);
		const match = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(path);
		if (match) {
			const rerooted = resolve(join(home, match[1] ?? ""));
			if (rerooted !== path && isDirectory(rerooted)) return { cwd: rerooted, fallback: true };
		}
		for (let dir = resolve(path, ".."); dir !== resolve(dir, ".."); dir = resolve(dir, "..")) {
			if (isDirectory(dir)) return { cwd: dir, fallback: true };
		}
	}
	return { cwd: home, fallback: recorded !== home };
}

/** RPC extension UI methods that do not wait for an answer; everything else gets a cancel. */
const FIRE_AND_FORGET_UI = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

/** Answer for one stdout record of an RPC child, if it needs one. */
export function rpcAutoResponse(record: unknown): Record<string, unknown> | undefined {
	if (!record || typeof record !== "object") return undefined;
	const r = record as { type?: unknown; id?: unknown; method?: unknown };
	if (r.type !== "extension_ui_request" || typeof r.id !== "string") return undefined;
	if (typeof r.method === "string" && FIRE_AND_FORGET_UI.has(r.method)) return undefined;
	return { type: "extension_ui_response", id: r.id, cancelled: true };
}

export interface HeadlessChild {
	spawnId: string;
	cwd: string;
	proc: ChildProcess;
	pid: number | undefined;
	sessionId?: string;
	exited: boolean;
	exitCode: number | null;
	/** Last ~2 KB of stderr, for error messages when the child dies before registering. */
	stderrTail: string;
	exitPromise: Promise<void>;
}

export interface HeadlessManagerOptions {
	invocation?: PhiInvocation;
	log?: RotatingLog;
	env?: NodeJS.ProcessEnv;
	onExit?: (child: HeadlessChild) => void;
}

export class HeadlessManager {
	private readonly children = new Map<string, HeadlessChild>();
	private readonly invocation: PhiInvocation;
	private readonly log: RotatingLog | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly onExit: ((child: HeadlessChild) => void) | undefined;

	constructor(options: HeadlessManagerOptions = {}) {
		this.invocation = options.invocation ?? resolvePhiInvocation();
		this.log = options.log;
		this.env = options.env ?? process.env;
		this.onExit = options.onExit;
	}

	get size(): number {
		let n = 0;
		for (const child of this.children.values()) if (!child.exited) n++;
		return n;
	}

	get(spawnId: string): HeadlessChild | undefined {
		return this.children.get(spawnId);
	}

	bySessionId(sessionId: string): HeadlessChild | undefined {
		for (const child of this.children.values()) if (child.sessionId === sessionId && !child.exited) return child;
		return undefined;
	}

	byPid(pid: number): HeadlessChild | undefined {
		for (const child of this.children.values()) if (child.pid === pid && !child.exited) return child;
		return undefined;
	}

	/**
	 * Start a headless child in `options.cwd`. `options.env` (control wire) passes through
	 * `filterThreadEnv` and is merged after `cleanChildEnv`, so it can set thread variables but never
	 * the spawn id or anything outside the thread allowlist.
	 */
	spawn(options: SpawnArgsOptions & { cwd: string; env?: Record<string, string> }): HeadlessChild {
		const spawnId = randomUUID();
		const args = buildSpawnArgs(this.invocation, options);
		const proc = spawn(this.invocation.command, args, {
			cwd: options.cwd,
			env: { ...cleanChildEnv(this.env, spawnId), ...filterThreadEnv(options.env) },
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group: a Ctrl-C at the hub's terminal must not kill sessions mid-write; the
			// hub ends them itself. Their stdin is our pipe, so they still exit if the hub dies.
			detached: true,
		});
		let resolveExit: () => void = () => {};
		const child: HeadlessChild = {
			spawnId,
			cwd: options.cwd,
			proc,
			pid: proc.pid,
			exited: false,
			exitCode: null,
			stderrTail: "",
			exitPromise: new Promise<void>((r) => {
				resolveExit = r;
			}),
		};
		this.children.set(spawnId, child);
		const tag = spawnId.slice(0, 8);
		this.log?.write(
			`[${new Date().toISOString()} ${tag}] spawn pid=${proc.pid ?? "?"} cwd=${options.cwd}${options.sessionFile ? ` session=${options.sessionFile}` : ""}\n`,
		);

		proc.stdin?.on("error", () => {});
		if (proc.stdout) {
			attachNdjsonReader(
				proc.stdout,
				(record) => {
					const answer = rpcAutoResponse(record);
					if (answer && proc.stdin && !proc.stdin.destroyed) proc.stdin.write(ndjson(answer));
				},
				undefined,
				{ maxLineLength: 32 * 1024 * 1024 },
			);
		}
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			child.stderrTail = (child.stderrTail + chunk).slice(-2048);
			const prefix = `[${new Date().toISOString()} ${tag}] `;
			this.log?.write(
				chunk
					.split("\n")
					.filter((line, i, all) => line.length > 0 || i < all.length - 1)
					.map((line) => `${prefix}${line}\n`)
					.join(""),
			);
		});
		const finish = (code: number | null) => {
			if (child.exited) return;
			child.exited = true;
			child.exitCode = code;
			this.log?.write(`[${new Date().toISOString()} ${tag}] exit code=${code ?? "signal"}\n`);
			resolveExit();
			this.onExit?.(child);
			this.children.delete(spawnId);
		};
		proc.on("exit", (code) => finish(code));
		proc.on("error", (error) => {
			child.stderrTail = (child.stderrTail + String(error)).slice(-2048);
			finish(null);
		});
		return child;
	}

	/** Graceful stop: close stdin (RPC mode shuts down on EOF), then SIGTERM, then SIGKILL. */
	async end(child: HeadlessChild, graceMs = 5000): Promise<void> {
		if (child.exited) return;
		child.proc.stdin?.end();
		const term = setTimeout(() => signal(child, "SIGTERM"), graceMs);
		const kill = setTimeout(() => signal(child, "SIGKILL"), graceMs * 2);
		await child.exitPromise;
		clearTimeout(term);
		clearTimeout(kill);
	}

	/**
	 * Synchronous last resort for a hub that is exiting without `stopAll` (uncaught error, second
	 * Ctrl-C, `process.exit`): SIGTERM every live child. Children run in their own process group,
	 * so nothing else delivers a signal to them; one that ignores it still sees its stdin close.
	 */
	killAllSync(sig: NodeJS.Signals = "SIGTERM"): number {
		let n = 0;
		for (const child of this.children.values()) {
			if (child.exited) continue;
			signal(child, sig);
			n++;
		}
		return n;
	}

	/** Stop every child (hub shutdown). */
	async stopAll(graceMs = 3000): Promise<void> {
		const live = [...this.children.values()].filter((c) => !c.exited);
		for (const child of live) {
			child.proc.stdin?.end();
			signal(child, "SIGTERM");
		}
		const kill = setTimeout(() => {
			for (const child of live) signal(child, "SIGKILL");
		}, graceMs);
		await Promise.race([
			Promise.all(live.map((c) => c.exitPromise)),
			new Promise((r) => setTimeout(r, graceMs + 1000)),
		]);
		clearTimeout(kill);
	}
}

function signal(child: HeadlessChild, sig: NodeJS.Signals): void {
	if (child.exited) return;
	try {
		child.proc.kill(sig);
	} catch {
		// already gone
	}
}
