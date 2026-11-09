/**
 * `phi remote ...` — run and manage the phi remote hub (see docs/remote.md).
 *
 * Dispatched from main() before any session startup, like `phi mcp` and `phi install`.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import chalk from "chalk";
import { ApnsClient, loadApnsConfig, setupApns } from "./hub/apns.ts";
import { formatDuration } from "./hub/conn-log.ts";
import { ControlClient, HubControlError } from "./hub/control.ts";
import { DeviceStore } from "./hub/devices.ts";
import { restrictFileMode, secureRemoteDir } from "./hub/files.ts";
import type { AppConnectionInfo, HubControlOp, HubStatus, PushTestResult } from "./hub/frames.ts";
import { Hub, HubAlreadyRunningError, probeHub, runPushTest } from "./hub/hub.ts";
import { displayHostname } from "./hub/network.ts";
import { installService, SERVICE_ENV, serviceEnvironment, serviceInstalled, uninstallService } from "./hub/service.ts";
import { cleanChildEnv, resolvePhiInvocation } from "./hub/spawn.ts";
import { hubIdPath, hubLogPath } from "./paths.ts";
import type { DeviceInfo, PairInfo } from "./protocol.ts";
import { colorizeQrLines, renderQrLines } from "./qr.ts";

export const REMOTE_USAGE = `Usage: phi remote <command>

Drive every phi session on this machine from the phi iPhone app (over Tailscale).

Commands:
  serve [--port N] [--bind a,b] [--allow-root dir]   Run the hub in the foreground
  start [--port N] [--bind a,b] [--allow-root dir]   Start the hub in the background
  stop                                               Stop the hub
  status [--json]                                    Hub, sessions and paired devices
  pair                                               Show a pairing QR code and wait for the phone
  devices [--json]                                   List paired devices
  revoke <device-id>                                 Unpair a device (closes its connections)
  install [--port N] [--bind a,b] [--allow-root dir] Run the hub at login (launchd / systemd --user)
  uninstall                                          Remove the login service
  push setup --key <AuthKey.p8> --key-id <id> --team-id <id> --bundle-id <id>
                                                     Enable push notifications (APNs)
  push test [--device <id>]                          Send a test notification
  ctl '<json>' | ctl -                               Send one control op to the hub (JSON argument, or
                                                     stdin with -) and print the reply data as JSON,
                                                     e.g. phi remote ctl '{"op":"sessions.list"}'

Options:
  --port N          HTTP/WebSocket port (default 7717)
  --bind a,b        Listen addresses (default 127.0.0.1 + this machine's Tailscale IPs;
                    use 0.0.0.0 to listen on every interface)
  --allow-root dir  Also allow starting sessions under dir (default: only inside $HOME)

State lives in ~/.pi/agent/remote (PI_REMOTE_DIR overrides). Docs: docs/remote.md`;

interface ParsedArgs {
	positionals: string[];
	port?: number;
	binds: string[];
	allowRoots: string[];
	json: boolean;
	help: boolean;
	device?: string;
	key?: string;
	keyId?: string;
	teamId?: string;
	bundleId?: string;
}

export function parseRemoteArgs(args: readonly string[]): ParsedArgs {
	const out: ParsedArgs = { positionals: [], binds: [], allowRoots: [], json: false, help: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = eq > 0 ? arg.slice(0, eq) : arg;
		const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
		const value = (): string => {
			if (inline !== undefined) return inline;
			const next = args[i + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value`);
			i++;
			return next;
		};
		switch (name) {
			case "--port": {
				const port = Number(value());
				if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be 0-65535");
				out.port = port;
				break;
			}
			case "--bind":
				out.binds.push(
					...value()
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
				);
				break;
			case "--allow-root":
				out.allowRoots.push(resolve(expandHome(value())));
				break;
			case "--json":
				out.json = true;
				break;
			case "-h":
			case "--help":
				out.help = true;
				break;
			case "--device":
				out.device = value();
				break;
			case "--key":
				out.key = expandHome(value());
				break;
			case "--key-id":
				out.keyId = value();
				break;
			case "--team-id":
				out.teamId = value();
				break;
			case "--bundle-id":
				out.bundleId = value();
				break;
			default:
				if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
				out.positionals.push(arg);
		}
	}
	return out;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
	return path;
}

/** `serve` flags to pass through to a background/service hub. */
function serveFlags(parsed: ParsedArgs): string[] {
	const flags: string[] = [];
	if (parsed.port !== undefined) flags.push("--port", String(parsed.port));
	if (parsed.binds.length > 0) flags.push("--bind", parsed.binds.join(","));
	for (const root of parsed.allowRoots) flags.push("--allow-root", root);
	return flags;
}

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

/** Run `phi remote <args>`; resolves to the process exit code. */
export async function runRemoteCommand(args: readonly string[]): Promise<number> {
	// A JSON argument (or `-`) is taken verbatim, never parsed as flags.
	if (args[0] === "ctl") return ctl(args.slice(1));
	let parsed: ParsedArgs;
	try {
		parsed = parseRemoteArgs(args);
	} catch (error) {
		err(chalk.red(`Error: ${(error as Error).message}`));
		err(REMOTE_USAGE);
		return 2;
	}
	const [command, ...rest] = parsed.positionals;
	if (parsed.help || !command || command === "help") {
		out(REMOTE_USAGE);
		return 0;
	}
	try {
		switch (command) {
			case "serve":
				return await serve(parsed);
			case "start":
				return await start(parsed);
			case "stop":
				return await stop();
			case "status":
				return await status(parsed);
			case "pair":
				return await pair(parsed);
			case "devices":
				return await devices(parsed);
			case "revoke":
				return await revoke(rest[0]);
			case "install":
				return await install(parsed);
			case "uninstall":
				return await uninstall();
			case "push":
				if (rest[0] === "setup") return pushSetup(parsed);
				if (rest[0] === "test") return await pushTest(parsed);
				err("Usage: phi remote push setup|test");
				return 2;
			default:
				err(chalk.red(`Unknown command: phi remote ${command}`));
				err(REMOTE_USAGE);
				return 2;
		}
	} catch (error) {
		err(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		return 1;
	}
}

// ---------------------------------------------------------------------------------------------
// serve / start / stop / status
// ---------------------------------------------------------------------------------------------

/** What `guardHubProcess` needs from a hub. */
export interface GuardedHub {
	stop(): Promise<void>;
	killChildrenSync(): void;
}

/**
 * Tie the hub's headless children to this process's life. Headless children run in their own
 * process group (a Ctrl-C at the hub's terminal must not kill them mid-write), so nothing else
 * signals them when the hub goes away:
 *
 * - SIGINT / SIGTERM / SIGHUP: graceful `stop()` (children get stdin EOF, then SIGTERM, then
 *   SIGKILL); a second signal SIGTERMs them at once and exits.
 * - Uncaught exception / unhandled rejection: log it, SIGTERM the children, exit 1 (launchd /
 *   systemd restart the hub).
 * - Any other exit path (`process.exit`): SIGTERM the children synchronously in `exit`.
 *
 * A SIGKILLed hub cannot run any of this; its children still see their stdin close, and RPC mode
 * exits on stdin EOF.
 */
export function guardHubProcess(
	hub: GuardedHub,
	onStopped: () => void,
	log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): () => void {
	let stopping = false;
	const killNow = () => hub.killChildrenSync();
	const onSignal = (signal: NodeJS.Signals) => {
		if (stopping) {
			killNow();
			process.exit(signal === "SIGINT" ? 130 : 143);
		}
		stopping = true;
		void hub.stop().finally(onStopped);
	};
	const onFatal = (error: unknown) => {
		log(`phi remote hub: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		killNow();
		process.exit(1);
	};
	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const signal of signals) process.on(signal, onSignal);
	process.on("uncaughtException", onFatal);
	process.on("unhandledRejection", onFatal);
	process.on("exit", killNow);
	return () => {
		for (const signal of signals) process.off(signal, onSignal);
		process.off("uncaughtException", onFatal);
		process.off("unhandledRejection", onFatal);
		process.off("exit", killNow);
	};
}

async function serve(parsed: ParsedArgs): Promise<number> {
	let finish: () => void = () => {};
	const done = new Promise<void>((r) => {
		finish = r;
	});
	let stopping = false;
	const shutdown = () => {
		if (stopping) return;
		stopping = true;
		void hub.stop().finally(finish);
	};
	const hub = new Hub({
		port: parsed.port,
		binds: parsed.binds.length > 0 ? parsed.binds : undefined,
		allowRoots: parsed.allowRoots,
		onShutdownRequested: shutdown,
	});
	try {
		await hub.start();
	} catch (error) {
		if (error instanceof HubAlreadyRunningError) {
			err(`${error.message}. Use \`phi remote status\` / \`phi remote stop\`.`);
			return process.env[SERVICE_ENV] ? 0 : 1;
		}
		throw error;
	}
	const unguard = guardHubProcess(hub, finish);
	const status = hub.status();
	out(
		`phi remote hub ${status.hubId} (${status.name}) listening on ${status.binds.map((b) => `${b}:${status.port}`).join(", ")}`,
	);
	out("Pair a phone with `phi remote pair`. Ctrl-C stops the hub.");
	await done;
	unguard();
	return 0;
}

/** Start a detached hub (unless one is running) and wait until it answers. */
async function ensureHub(parsed: ParsedArgs, quiet: boolean): Promise<HubStatus> {
	const running = await probeHub();
	if (running) return running;
	secureRemoteDir();
	const invocation = resolvePhiInvocation();
	const logFd = openSync(hubLogPath(), "a", 0o600);
	restrictFileMode(hubLogPath());
	let exited: number | null | undefined;
	try {
		const child = spawn(invocation.command, [...invocation.args, "remote", "serve", ...serveFlags(parsed)], {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			cwd: homedir(),
			env: cleanChildEnv(process.env),
		});
		child.on("exit", (code) => {
			exited = code;
		});
		child.unref();
	} finally {
		closeSync(logFd);
	}
	if (!quiet) out("Starting the phi remote hub...");
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		await sleep(250);
		const status = await probeHub();
		if (status) return status;
		if (exited !== undefined) break;
	}
	throw new Error(`the hub did not start; see ${hubLogPath()}`);
}

async function start(parsed: ParsedArgs): Promise<number> {
	const before = await probeHub();
	if (before) {
		out(`phi remote hub already running (pid ${before.pid}).`);
		return 0;
	}
	const status = await ensureHub(parsed, false);
	out(`phi remote hub running (pid ${status.pid}) on ${status.binds.map((b) => `${b}:${status.port}`).join(", ")}`);
	out(`Log: ${hubLogPath()}`);
	return 0;
}

async function stop(): Promise<number> {
	const client = await ControlClient.tryConnect();
	if (!client) {
		out("phi remote hub is not running.");
		return 0;
	}
	try {
		await client.request({ op: "shutdown" });
	} finally {
		client.close();
	}
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline && (await probeHub())) await sleep(200);
	out("phi remote hub stopped.");
	if (serviceInstalled())
		out("The login service will start it again at next login (`phi remote uninstall` removes it).");
	return 0;
}

async function status(parsed: ParsedArgs): Promise<number> {
	const s = await probeHub();
	if (parsed.json) {
		out(JSON.stringify(s ?? { running: false }, null, 2));
		return s ? 0 : 1;
	}
	if (!s) {
		out("phi remote hub is not running. Start it with `phi remote start` (or `phi remote install`).");
		return 1;
	}
	out(`${chalk.bold("phi remote hub")} ${s.hubId} on ${s.name} — pid ${s.pid}, v${s.version}`);
	out(`  listening  ${s.binds.map((b) => `${b}:${s.port}`).join(", ")}`);
	out(`  urls       ${s.urls.join("  ") || "(none reachable from a phone; bind a Tailscale or LAN address)"}`);
	out(`  push       ${s.push ? "configured" : "off (phi remote push setup)"}`);
	out(`  apps       ${s.apps} connected`);
	for (const app of s.appConnections ?? []) out(`    ${formatAppConnection(app, Date.now())}`);
	// Subagent threads are listed under their parent as a count.
	const sessions = s.sessions.filter((session) => session.kind !== "subagent");
	out(`  sessions   ${sessions.length}`);
	for (const session of sessions) {
		const state = session.status === "working" ? chalk.yellow("working") : chalk.dim("idle   ");
		const subagents = session.subagents
			? ` · ${session.subagents.running}/${session.subagents.total} subagents running`
			: "";
		out(`    ${state} ${session.name}  ${chalk.dim(`${session.kind} · ${session.cwd}${subagents}`)}`);
	}
	out(`  devices    ${s.devices.length}`);
	for (const device of s.devices) out(`    ${formatDevice(device)}`);
	return 0;
}

// ---------------------------------------------------------------------------------------------
// pair / devices / revoke
// ---------------------------------------------------------------------------------------------

async function pair(parsed: ParsedArgs): Promise<number> {
	await ensureHub(parsed, false);
	const client = await ControlClient.connect();
	try {
		const known = new Set(
			((await client.request<{ devices: DeviceInfo[] }>({ op: "devices.list" })).devices ?? []).map((d) => d.id),
		);
		const info = await client.request<PairInfo>({ op: "pair.create" });
		printPairInfo(info);

		let interrupted = false;
		const onSigint = () => {
			interrupted = true;
		};
		process.on("SIGINT", onSigint);
		try {
			while (!interrupted) {
				if (Date.now() >= info.expiresAt) {
					out("Pairing code expired. Run `phi remote pair` again.");
					return 1;
				}
				await sleep(1000);
				const { devices: now } = await client.request<{ devices: DeviceInfo[] }>({ op: "devices.list" });
				const added = now.find((d) => !known.has(d.id));
				if (added) {
					out(chalk.green(`Paired ${added.name}`) + chalk.dim(` (${added.id})`));
					return 0;
				}
			}
			out("Cancelled. The code stays valid until it expires.");
			return 130;
		} finally {
			process.off("SIGINT", onSigint);
		}
	} finally {
		client.close();
	}
}

export function formatPairInfo(info: PairInfo, colorQr: boolean): string[] {
	const qr = renderQrLines(info.link);
	const lines = colorQr ? colorizeQrLines(qr) : qr;
	const minutes = Math.max(1, Math.round((info.expiresAt - Date.now()) / 60_000));
	return [
		"Scan with the phi app (or the iPhone camera):",
		"",
		...lines.map((l) => `  ${l}`),
		"",
		`Code     ${info.code}  (single use, expires in ${minutes} min)`,
		`Host     ${info.name}  ·  hub ${info.hubId}`,
		...(info.urls.length > 0
			? info.urls.map((u, i) => `${i === 0 ? "URLs   " : "       "}  ${u}`)
			: ["URLs     none reachable from a phone (no Tailscale IP bound; see `phi remote status`)"]),
		`Link     ${info.link}`,
		"",
		"Waiting for the phone to pair (Ctrl-C to stop waiting)...",
	];
}

function printPairInfo(info: PairInfo): void {
	const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
	for (const line of formatPairInfo(info, color)) out(line);
}

function relativeTime(ms: number | undefined): string {
	if (!ms) return "never";
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86_400)}d ago`;
}

/** `Example iPhone  100.64.0.5:53122  #12, connected 4m05s (16:30:02), last pong 3.1s ago` */
export function formatAppConnection(app: AppConnectionInfo, now: number): string {
	const since = new Date(app.connectedAt).toLocaleTimeString([], { hour12: false });
	const pong = app.lastPongAt === undefined ? "no pong yet" : `last pong ${formatDuration(now - app.lastPongAt)} ago`;
	return `${app.name || app.deviceId}  ${app.remote}  ${chalk.dim(`#${app.conn}, connected ${formatDuration(now - app.connectedAt)} (${since}), ${pong}`)}`;
}

function formatDevice(d: DeviceInfo): string {
	const flags = [d.connected ? chalk.green("connected") : `seen ${relativeTime(d.lastSeenAt)}`, d.push ? "push" : ""]
		.filter(Boolean)
		.join(", ");
	return `${d.id}  ${d.name} (${d.platform})  ${chalk.dim(flags)}`;
}

async function listDevices(): Promise<DeviceInfo[]> {
	const client = await ControlClient.tryConnect();
	if (client) {
		try {
			return (await client.request<{ devices: DeviceInfo[] }>({ op: "devices.list" })).devices;
		} finally {
			client.close();
		}
	}
	return new DeviceStore().list().map((d) => ({
		id: d.id,
		name: d.name,
		platform: d.platform,
		createdAt: d.createdAt,
		lastSeenAt: d.lastSeenAt,
		push: Boolean(d.push),
		connected: false,
	}));
}

async function devices(parsed: ParsedArgs): Promise<number> {
	const list = await listDevices();
	if (parsed.json) {
		out(JSON.stringify(list, null, 2));
		return 0;
	}
	if (list.length === 0) {
		out("No paired devices. Pair one with `phi remote pair`.");
		return 0;
	}
	for (const d of list) out(formatDevice(d));
	return 0;
}

async function revoke(deviceId: string | undefined): Promise<number> {
	if (!deviceId) {
		err("Usage: phi remote revoke <device-id>   (ids: phi remote devices)");
		return 2;
	}
	const client = await ControlClient.tryConnect();
	if (client) {
		try {
			await client.request({ op: "devices.revoke", deviceId });
		} finally {
			client.close();
		}
	} else if (!new DeviceStore().remove(deviceId)) {
		throw new Error(`no such device: ${deviceId}`);
	}
	out(`Revoked ${deviceId}.`);
	return 0;
}

// ---------------------------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------------------------

async function install(parsed: ParsedArgs): Promise<number> {
	secureRemoteDir();
	const invocation = resolvePhiInvocation();
	const programArgs = [invocation.command, ...invocation.args, "remote", "serve", ...serveFlags(parsed)];
	// A hub started by hand would make the service instance exit as "already running".
	const running = await ControlClient.tryConnect();
	if (running) {
		try {
			await running.request({ op: "shutdown" });
		} finally {
			running.close();
		}
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && (await probeHub())) await sleep(200);
	}
	const path = await installService({
		programArgs,
		env: serviceEnvironment(),
		logPath: hubLogPath(),
		workingDirectory: homedir(),
	});
	out(`Installed ${path}`);
	out(`  runs  ${programArgs.join(" ")}`);
	out(`  log   ${hubLogPath()}`);
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const s = await probeHub();
		if (s) {
			out(`Hub running (pid ${s.pid}). Pair a phone with \`phi remote pair\`.`);
			return 0;
		}
		await sleep(300);
	}
	out(`The service is installed but the hub has not answered yet; check ${hubLogPath()}.`);
	return 1;
}

async function uninstall(): Promise<number> {
	const path = uninstallService();
	const client = await ControlClient.tryConnect();
	if (client) {
		try {
			await client.request({ op: "shutdown" });
		} finally {
			client.close();
		}
	}
	out(path ? `Removed ${path}` : "No login service was installed.");
	return 0;
}

// ---------------------------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------------------------

function pushSetup(parsed: ParsedArgs): number {
	if (!parsed.key || !parsed.keyId || !parsed.teamId || !parsed.bundleId) {
		err("Usage: phi remote push setup --key <AuthKey.p8> --key-id <id> --team-id <id> --bundle-id <id>");
		return 2;
	}
	const config = setupApns({
		keyFile: parsed.key,
		keyId: parsed.keyId,
		teamId: parsed.teamId,
		bundleId: parsed.bundleId,
	});
	out(`APNs configured for ${config.bundleId} (team ${config.teamId}, key ${config.keyId}).`);
	out(`  key copied to ${config.keyPath} (0600); the original can be deleted.`);
	out("Pushes start with the next session that finishes; try `phi remote push test`.");
	return 0;
}

async function pushTest(parsed: ParsedArgs): Promise<number> {
	let result: PushTestResult;
	const client = await ControlClient.tryConnect();
	if (client) {
		try {
			result = await client.request<PushTestResult>({ op: "push.test", deviceId: parsed.device }, 30_000);
		} finally {
			client.close();
		}
	} else {
		const apns = new ApnsClient();
		try {
			let hubId = "";
			try {
				hubId = readFileSync(hubIdPath(), "utf8").trim();
			} catch {
				hubId = "";
			}
			result = await runPushTest(
				new DeviceStore(),
				apns.send,
				loadApnsConfig() !== undefined,
				hubId,
				displayHostname(),
				parsed.device,
			);
		} finally {
			apns.close();
		}
	}
	if (result.results.length === 0) {
		out("No devices with push notifications. Allow notifications in the phi app first.");
		return 1;
	}
	let ok = true;
	for (const r of result.results) {
		ok &&= r.ok;
		out(
			`${r.ok ? chalk.green("sent") : chalk.red("failed")}  ${r.name} (${r.deviceId})${r.ok ? "" : `  ${r.status ?? ""} ${r.reason ?? ""}`}`,
		);
	}
	return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// ctl
// ---------------------------------------------------------------------------------------------

export const REMOTE_CTL_USAGE = `Usage: phi remote ctl '<json>'
       phi remote ctl -          (read the JSON from stdin)

Send one control op to the running hub over hub.sock and print the reply data as JSON on stdout
(exit 0), or the error as JSON {"code","message"} on stderr (exit 1). Examples:
  phi remote ctl '{"op":"sessions.list"}'
  phi remote ctl '{"op":"session.snapshot","sessionId":"<id>","limit":20}'
  phi remote ctl '{"op":"session.spawn","cwd":"~/src/app","prompt":"run the tests"}'

Ops and replies: docs/remote.md, "Local control for agents (overseer)".`;

/** Ops that answer only once a session has started and registered. */
const CTL_SLOW_OPS = new Set(["session.spawn", "session.resume"]);
export const CTL_SLOW_TIMEOUT_MS = 90_000;
export const CTL_TIMEOUT_MS = 15_000;

/** Write and wait until it is handed to the OS: `process.exit` follows, and a pipe may be async. */
function writeFully(stream: NodeJS.WriteStream, text: string): Promise<void> {
	return new Promise((resolve) => {
		stream.write(text, () => resolve());
	});
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return Buffer.concat(chunks).toString("utf8");
}

/** `phi remote ctl <json|->`: one control op, reply data as JSON. */
async function ctl(args: readonly string[]): Promise<number> {
	const [raw, ...extra] = args;
	if (raw === "-h" || raw === "--help") {
		out(REMOTE_CTL_USAGE);
		return 0;
	}
	if (raw === undefined || extra.length > 0) {
		err(REMOTE_CTL_USAGE);
		return 2;
	}
	const fail = async (code: string, message: string): Promise<number> => {
		await writeFully(process.stderr, `${JSON.stringify({ code, message })}\n`);
		return 1;
	};
	let request: unknown;
	try {
		request = JSON.parse(raw === "-" ? await readStdin() : raw);
	} catch (error) {
		return fail("bad_request", `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!request || typeof request !== "object" || Array.isArray(request)) {
		return fail("bad_request", 'expected a JSON object with an "op" field, e.g. {"op":"sessions.list"}');
	}
	// The frame's own `t` and `id` are set by the client.
	const { t: _t, id: _id, ...op } = request as Record<string, unknown>;
	if (typeof op.op !== "string" || !op.op) {
		return fail("bad_request", 'expected a JSON object with an "op" field, e.g. {"op":"sessions.list"}');
	}
	const client = await ControlClient.tryConnect();
	if (!client) return fail("hub_offline", "the phi remote hub is not running (start it with `phi remote start`)");
	try {
		const timeoutMs = CTL_SLOW_OPS.has(op.op) ? CTL_SLOW_TIMEOUT_MS : CTL_TIMEOUT_MS;
		const data = await client.request(op as unknown as HubControlOp, timeoutMs);
		await writeFully(process.stdout, `${JSON.stringify(data ?? {}, null, 2)}\n`);
		return 0;
	} catch (error) {
		const code = error instanceof HubControlError ? error.code : "internal";
		return fail(code, error instanceof Error ? error.message : String(error));
	} finally {
		client.close();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
