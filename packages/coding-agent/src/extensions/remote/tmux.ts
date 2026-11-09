/**
 * The tmux session a phi process runs in, for its phi remote name.
 *
 * Inside tmux, `TMUX` is `<socket>,<server pid>,<session index>` and `TMUX_PANE` is the pane
 * (`%12`). One `tmux -S <socket> display-message -p -t <pane>` (no shell, 1 s timeout) reads the
 * session and window names; failures read as "not in tmux". The session name is the display name
 * unless the session has an explicit one; devbox tabs (`devbox-<profile>-<n>-<title>`) show their
 * title, and tmux's default numeric names (`0`, `1`) are no name at all.
 */

import { execFile } from "node:child_process";

export interface TmuxInfo {
	/** Raw session name. */
	session: string;
	/** Raw window name. */
	window?: string;
}

/** Runs `file args` without a shell and resolves its stdout; rejects on failure or timeout. */
export type ExecRunner = (file: string, args: string[], options: { timeoutMs: number }) => Promise<string>;

export const TMUX_QUERY_TIMEOUT_MS = 1000;
/** How often a connected session re-reads its tmux names (renames propagate). */
export const TMUX_REFRESH_MS = 30_000;
const SEPARATOR = "\u001f";
const MAX_NAME_CHARS = 200;

export const defaultExecRunner: ExecRunner = (file, args, options) =>
	new Promise((resolve, reject) => {
		try {
			const child = execFile(
				file,
				args,
				{ timeout: options.timeoutMs, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 },
				(error, stdout) => {
					if (error) reject(error);
					else resolve(String(stdout));
				},
			);
			child.stdin?.end();
		} catch (error) {
			reject(error);
		}
	});

/** The socket and pane to ask, or undefined when this process is not inside tmux. */
export function tmuxTarget(env: NodeJS.ProcessEnv = process.env): { socket: string; pane: string } | undefined {
	const tmux = env.TMUX;
	const pane = env.TMUX_PANE;
	if (!tmux || !pane || !/^%\d+$/.test(pane)) return undefined;
	const socket = tmux.split(",")[0];
	if (!socket) return undefined;
	return { socket, pane };
}

function cleanName(value: string | undefined): string | undefined {
	const name = value?.replace(/[\r\n\t]+/g, " ").trim();
	if (!name) return undefined;
	return name.length > MAX_NAME_CHARS ? name.slice(0, MAX_NAME_CHARS) : name;
}

/** Ask tmux for this pane's session and window names. Never throws. */
export async function queryTmux(
	env: NodeJS.ProcessEnv = process.env,
	run: ExecRunner = defaultExecRunner,
): Promise<TmuxInfo | undefined> {
	const target = tmuxTarget(env);
	if (!target) return undefined;
	try {
		const out = await run(
			"tmux",
			["-S", target.socket, "display-message", "-p", "-t", target.pane, `#{session_name}${SEPARATOR}#{window_name}`],
			{ timeoutMs: TMUX_QUERY_TIMEOUT_MS },
		);
		const line = out.replace(/\r?\n$/, "");
		const cut = line.indexOf(SEPARATOR);
		const session = cleanName(cut === -1 ? line : line.slice(0, cut));
		if (!session) return undefined;
		const window = cut === -1 ? undefined : cleanName(line.slice(cut + 1));
		return { session, ...(window ? { window } : {}) };
	} catch {
		return undefined;
	}
}

/** `devbox-<profile>-<n>-<title>` (devbox tabs) -> `<title>`; anything else unchanged. */
export function stripDevboxPrefix(name: string): string {
	const match = /^devbox-.+?-\d+-(.+)$/.exec(name);
	return match?.[1] ? match[1] : name;
}

/** The name a tmux session gives a phi session: none for tmux's default numeric names. */
export function tmuxDisplayName(info: TmuxInfo | undefined): string | undefined {
	if (!info) return undefined;
	const name = stripDevboxPrefix(info.session).trim();
	if (!name || /^\d+$/.test(name)) return undefined;
	return name;
}

/**
 * A session's display name: an explicit name (`/name`) always wins, then the tmux session, then
 * the first prompt line, then the cwd's basename.
 */
export function sessionDisplayName(parts: {
	explicit?: string;
	tmux?: TmuxInfo;
	firstPrompt?: string;
	cwdName: string;
}): string {
	return parts.explicit || tmuxDisplayName(parts.tmux) || parts.firstPrompt || parts.cwdName;
}

export interface TmuxNamerOptions {
	env?: NodeJS.ProcessEnv;
	run?: ExecRunner;
	now?: () => number;
	onChange?: () => void;
}

/**
 * Keeps the tmux names of this process fresh: `refresh()` queries at most once per
 * {@link TMUX_REFRESH_MS} (and never two at a time); `onChange` runs when the names changed.
 */
export class TmuxNamer {
	private info: TmuxInfo | undefined;
	private lastQueryAt = Number.NEGATIVE_INFINITY;
	private inFlight = false;
	private readonly inTmux: boolean;
	private readonly options: TmuxNamerOptions;

	constructor(options: TmuxNamerOptions = {}) {
		this.options = options;
		this.inTmux = tmuxTarget(options.env ?? process.env) !== undefined;
	}

	get current(): TmuxInfo | undefined {
		return this.info;
	}

	/** Query now unless one ran within the refresh interval (`force` skips that check). */
	refresh(force = false): void {
		if (!this.inTmux || this.inFlight) return;
		const now = (this.options.now ?? Date.now)();
		if (!force && now - this.lastQueryAt < TMUX_REFRESH_MS) return;
		this.lastQueryAt = now;
		this.inFlight = true;
		void queryTmux(this.options.env ?? process.env, this.options.run).then((info) => {
			this.inFlight = false;
			// A failed query keeps the last known names (a busy server is not a rename).
			if (!info) return;
			if (info.session === this.info?.session && info.window === this.info?.window) return;
			this.info = info;
			try {
				this.options.onChange?.();
			} catch {
				// advisory
			}
		});
	}
}
