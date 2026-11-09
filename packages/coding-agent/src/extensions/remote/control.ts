/**
 * Local control of the phi remote hub for the `/remote` command: is it up, start it, and one-shot
 * `ctl` requests (pairing codes, device list) over the hub socket.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { HubControlError } from "../../remote/hub/control.ts";
import { restrictFileMode, secureRemoteDir } from "../../remote/hub/files.ts";
import { cleanChildEnv, resolvePhiInvocation } from "../../remote/hub/spawn.ts";
import { hubLogPath, hubSocketPath } from "../../remote/paths.ts";
import type { ControlOp, HubToControl } from "../../remote/protocol.ts";

/**
 * argv to run this same phi: `[node, cli.js]` when running from source or an npm install,
 * `[binary]` for the compiled binary (whose virtual `/$bunfs/...` script must not be re-run).
 * Same resolution as the hub's (`resolvePhiInvocation`), without node flags.
 */
export function phiInvocation(argv: readonly string[] = process.argv, execPath = process.execPath): string[] {
	const invocation = resolvePhiInvocation({ execPath, argv, execArgv: [] });
	return [invocation.command, ...invocation.args];
}

/** True when something accepts connections on the hub socket. */
export function canConnect(path = hubSocketPath(), timeoutMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const socket = createConnection(path);
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

/** Start `phi remote serve` detached, logging to hub.log. */
export function spawnHub(): void {
	// Same command as the session (node + cli.js with its loader flags, or the compiled binary).
	const { command, args } = resolvePhiInvocation();
	let log: number | undefined;
	try {
		secureRemoteDir();
		log = openSync(hubLogPath(), "a", 0o600);
		restrictFileMode(hubLogPath());
	} catch {
		log = undefined;
	}
	try {
		const child = spawn(command, [...args, "remote", "serve"], {
			detached: true,
			stdio: ["ignore", log ?? "ignore", log ?? "ignore"],
			// Not this session's metadata: the hub passes its environment on to headless children.
			env: cleanChildEnv(process.env),
			cwd: homedir(),
		});
		child.on("error", () => undefined);
		child.unref();
	} finally {
		if (log !== undefined) closeSync(log);
	}
}

/** Make sure a hub is listening: start one if not, then wait up to `timeoutMs` for its socket. */
export async function ensureHub(timeoutMs = 5000): Promise<"running" | "started" | "failed"> {
	if (await canConnect()) return "running";
	spawnHub();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		if (await canConnect()) return "started";
	}
	return "failed";
}

/**
 * One `ctl` request on its own connection; resolves with `data`. Rejects with a `HubControlError`
 * carrying the hub's error `code` (`not_found`, `bad_request`, `forbidden`, `session_offline`,
 * `internal`) and message, or with a plain `Error` when the hub cannot be reached or does not answer.
 */
export function ctlRequest<T = unknown>(op: ControlOp, timeoutMs = 5000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = randomUUID();
		const socket = createConnection(hubSocketPath());
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let settled = false;
		const finish = (error: Error | undefined, data?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(data as T);
		};
		const timer = setTimeout(() => finish(new Error("the phi remote hub did not answer")), timeoutMs);
		socket.once("connect", () => socket.write(`${JSON.stringify({ t: "ctl", id, ...op })}\n`));
		socket.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				let frame: HubToControl;
				try {
					frame = JSON.parse(line) as HubToControl;
				} catch {
					continue;
				}
				if (!frame || frame.t !== "ctl.reply" || frame.re !== id) continue;
				if (frame.ok) finish(undefined, frame.data);
				else {
					const message = frame.error?.message || frame.error?.code || "request failed";
					finish(new HubControlError(frame.error?.code || "internal", message));
				}
				return;
			}
		});
		socket.once("error", (error) => finish(error));
		socket.once("close", () => finish(new Error("the phi remote hub closed the connection")));
	});
}
