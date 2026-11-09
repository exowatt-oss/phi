/**
 * `phi remote install` / `uninstall`: run the hub at login.
 *
 * - macOS: a launchd agent `~/Library/LaunchAgents/org.example.phi-remote.plist`, loaded with
 *   `launchctl bootstrap gui/$UID` (removed with `bootout`). RunAtLoad, and KeepAlive restarts it
 *   after a crash (`SuccessfulExit: false`): a deliberate `phi remote stop` (exit 0) stays stopped
 *   until the next login instead of fighting the user.
 * - Linux: a systemd user unit `~/.config/systemd/user/phi-remote.service` (Restart=on-failure).
 *
 * The program path is resolved like `session.spawn` (node + cli.js, or the compiled binary), and
 * the current PATH is captured because launchd/systemd start agents with a minimal one and the
 * headless sessions the hub spawns need the user's tools.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const LAUNCHD_LABEL = "org.example.phi-remote";
export const SYSTEMD_UNIT = "phi-remote.service";
/** Set in the service environment; an "already running" hub then exits 0 so KeepAlive does not loop. */
export const SERVICE_ENV = "PHI_REMOTE_SERVICE";

export interface ServiceSpec {
	/** Full argv: program first, then `remote serve ...`. */
	programArgs: string[];
	env: Record<string, string>;
	logPath: string;
	workingDirectory: string;
}

/** Environment captured into the service definition. */
export function serviceEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const out: Record<string, string> = { [SERVICE_ENV]: "1" };
	for (const key of ["PATH", "PI_REMOTE_DIR", "PHI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "LANG"]) {
		const value = env[key];
		if (value) out[key] = value;
	}
	return out;
}

/** Control characters cannot be represented in a plist string or a unit file line. */
function assertPrintable(spec: ServiceSpec): void {
	const values = [...spec.programArgs, spec.logPath, spec.workingDirectory, ...Object.entries(spec.env).flat()];
	for (const value of values) {
		if (/[\u0000-\u001f\u007f]/.test(value)) {
			throw new Error(`cannot write a login service for a value with control characters: ${JSON.stringify(value)}`);
		}
	}
	for (const path of [spec.programArgs[0], spec.logPath, spec.workingDirectory]) {
		if (!path || !isAbsolute(path)) throw new Error(`login service paths must be absolute: ${path}`);
	}
}

function xmlEscape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchdPlistPath(home = homedir()): string {
	return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function buildLaunchdPlist(spec: ServiceSpec): string {
	assertPrintable(spec);
	const args = spec.programArgs.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join("\n");
	const env = Object.entries(spec.env)
		.map(([k, v]) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t<string>${xmlEscape(v)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${env}
	</dict>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(spec.workingDirectory)}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>${xmlEscape(spec.logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(spec.logPath)}</string>
</dict>
</plist>
`;
}

export function systemdUnitPath(home = homedir()): string {
	return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

/**
 * Quote one argument of a systemd `ExecStart=` line: C-style quoting, `%` specifiers and `$`
 * variable references escaped (`%%`, `$$`).
 */
export function systemdQuote(arg: string): string {
	return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/** One `Environment=` assignment: quoted, `%` escaped; `$` is literal there (no expansion). */
export function systemdEnvQuote(assignment: string): string {
	return `"${assignment.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/**
 * A path for `WorkingDirectory=` / `StandardOutput=append:`: these take the rest of the line
 * verbatim (no quote removal; spaces are fine) and expand only `%` specifiers.
 */
export function systemdPath(path: string): string {
	return path.replace(/%/g, "%%");
}

export function buildSystemdUnit(spec: ServiceSpec): string {
	assertPrintable(spec);
	const env = Object.entries(spec.env)
		.map(([k, v]) => `Environment=${systemdEnvQuote(`${k}=${v}`)}`)
		.join("\n");
	return `[Unit]
Description=phi remote hub
After=network-online.target

[Service]
Type=simple
ExecStart=${spec.programArgs.map(systemdQuote).join(" ")}
WorkingDirectory=${systemdPath(spec.workingDirectory)}
${env}
Restart=on-failure
RestartSec=5
KillMode=mixed
StandardOutput=append:${systemdPath(spec.logPath)}
StandardError=append:${systemdPath(spec.logPath)}

[Install]
WantedBy=default.target
`;
}

/** Runs launchctl / systemctl. Injectable so tests never touch the machine's service manager. */
export type ServiceCommandRunner = (command: string, args: string[]) => void;

/** A failed service-manager command; `status` is its exit status when it ran. */
export class ServiceCommandError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "ServiceCommandError";
		this.status = status;
	}
}

function execRunner(command: string, args: string[]): void {
	try {
		execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
	} catch (error) {
		const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
		const status = (error as { status?: unknown }).status;
		throw new ServiceCommandError(
			`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
			typeof status === "number" ? status : undefined,
		);
	}
}

export interface ServiceDeps {
	run?: ServiceCommandRunner;
	home?: string;
	uid?: number;
	/** Waits between launchctl polls and retries (tests pass one that does not wait). */
	sleep?: (ms: number) => Promise<void>;
}

/** After `bootout`, how often and how many times to check that launchd let go of the old hub. */
export const LAUNCHD_GONE_POLL_MS = 200;
export const LAUNCHD_GONE_POLLS = 50;
/** `bootstrap` retries on a transient launchd error, and the wait before each. */
export const LAUNCHD_BOOTSTRAP_RETRIES = 5;
export const LAUNCHD_BOOTSTRAP_BACKOFF_MS = 500;

/**
 * launchd's transient bootstrap failures: 5 (EIO, the old instance is still being torn down) and
 * 37 (EALREADY, an operation on the label is in progress). Reported as `Bootstrap failed: 5: …`
 * and as the exit status.
 */
export function isTransientBootstrapError(error: unknown): boolean {
	const status = (error as { status?: unknown } | undefined)?.status;
	if (status === 5 || status === 37) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /\bfailed: (5|37):/.test(message);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function runner(deps: ServiceDeps): (command: string, args: string[], ignoreErrors?: boolean) => void {
	const exec = deps.run ?? execRunner;
	return (command, args, ignoreErrors = false) => {
		try {
			exec(command, args);
		} catch (error) {
			if (!ignoreErrors) throw error;
		}
	};
}

function uid(): number {
	return typeof process.getuid === "function" ? process.getuid() : 0;
}

export function serviceInstalled(platform = process.platform, home = homedir()): boolean {
	if (platform === "darwin") return existsSync(launchdPlistPath(home));
	if (platform === "linux") return existsSync(systemdUnitPath(home));
	return false;
}

/**
 * Write and (re)load the service. Idempotent: running it again replaces the definition and restarts
 * the hub with it (e.g. after phi moved). Returns the definition path.
 *
 * macOS: `bootout` returns before launchd has finished tearing the old instance down, and a
 * `bootstrap` in that window fails with `5: Input/output error` (leaving no hub). So wait until
 * `launchctl print` no longer finds the service, then bootstrap, retrying transient errors.
 */
export async function installService(
	spec: ServiceSpec,
	platform = process.platform,
	deps: ServiceDeps = {},
): Promise<string> {
	const run = runner(deps);
	const sleep = deps.sleep ?? defaultSleep;
	const home = deps.home ?? homedir();
	const user = deps.uid ?? uid();
	if (platform === "darwin") {
		const path = launchdPlistPath(home);
		const plist = buildLaunchdPlist(spec);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, plist, { mode: 0o644 });
		const target = `gui/${user}/${LAUNCHD_LABEL}`;
		run("launchctl", ["bootout", target], true);
		for (let poll = 0; poll < LAUNCHD_GONE_POLLS; poll++) {
			try {
				run("launchctl", ["print", target]);
			} catch {
				break; // not found: launchd let go of it
			}
			await sleep(LAUNCHD_GONE_POLL_MS);
		}
		for (let attempt = 0; ; attempt++) {
			try {
				run("launchctl", ["bootstrap", `gui/${user}`, path]);
				break;
			} catch (error) {
				if (attempt >= LAUNCHD_BOOTSTRAP_RETRIES || !isTransientBootstrapError(error)) throw error;
				await sleep(LAUNCHD_BOOTSTRAP_BACKOFF_MS);
			}
		}
		return path;
	}
	if (platform === "linux") {
		const path = systemdUnitPath(home);
		const unit = buildSystemdUnit(spec);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, unit, { mode: 0o644 });
		run("systemctl", ["--user", "daemon-reload"]);
		run("systemctl", ["--user", "enable", SYSTEMD_UNIT]);
		// `enable --now` would leave an already running instance on the old definition.
		run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
		return path;
	}
	throw new Error(`phi remote install is not supported on ${platform}; run \`phi remote serve\` yourself`);
}

/** Unload and delete the service. Returns the removed path, or undefined if none was installed. */
export function uninstallService(platform = process.platform, deps: ServiceDeps = {}): string | undefined {
	const run = runner(deps);
	const home = deps.home ?? homedir();
	const user = deps.uid ?? uid();
	if (platform === "darwin") {
		const path = launchdPlistPath(home);
		run("launchctl", ["bootout", `gui/${user}/${LAUNCHD_LABEL}`], true);
		if (!existsSync(path)) return undefined;
		unlinkSync(path);
		return path;
	}
	if (platform === "linux") {
		const path = systemdUnitPath(home);
		run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], true);
		if (!existsSync(path)) return undefined;
		unlinkSync(path);
		run("systemctl", ["--user", "daemon-reload"], true);
		return path;
	}
	throw new Error(`phi remote uninstall is not supported on ${platform}`);
}
