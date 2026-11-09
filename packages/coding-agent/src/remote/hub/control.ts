/**
 * Local control client for hub.sock (`ctl` frames): used by `phi remote` subcommands. The in-session
 * `/remote` command speaks the same frames (types in ../protocol.ts).
 */

import { connect, type Socket } from "node:net";
import { hubSocketPath } from "../paths.ts";
import type { HubControlOp } from "./frames.ts";
import { attachNdjsonReader, ndjson } from "./ndjson.ts";

export class HubControlError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

interface Waiter {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class ControlClient {
	private readonly socket: Socket;
	private readonly waiters = new Map<string, Waiter>();
	private seq = 0;
	private closed = false;

	private constructor(socket: Socket) {
		this.socket = socket;
		attachNdjsonReader(socket, (msg) => {
			if (!msg || typeof msg !== "object") return;
			const m = msg as {
				t?: unknown;
				re?: unknown;
				ok?: unknown;
				data?: unknown;
				error?: { code?: string; message?: string };
			};
			if (m.t !== "ctl.reply" || typeof m.re !== "string") return;
			const waiter = this.waiters.get(m.re);
			if (!waiter) return;
			this.waiters.delete(m.re);
			clearTimeout(waiter.timer);
			if (m.ok === true) waiter.resolve(m.data);
			else waiter.reject(new HubControlError(m.error?.code ?? "internal", m.error?.message ?? "hub error"));
		});
		const failAll = () => {
			this.closed = true;
			for (const waiter of this.waiters.values()) {
				clearTimeout(waiter.timer);
				waiter.reject(new HubControlError("session_offline", "hub connection closed"));
			}
			this.waiters.clear();
		};
		socket.on("close", failAll);
		socket.on("error", failAll);
	}

	/** Connect to the hub socket; rejects when no hub is listening. */
	static connect(socketPath = hubSocketPath(), timeoutMs = 1500): Promise<ControlClient> {
		return new Promise((resolve, reject) => {
			const socket = connect(socketPath);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("timed out connecting to the phi remote hub"));
			}, timeoutMs);
			socket.once("connect", () => {
				clearTimeout(timer);
				resolve(new ControlClient(socket));
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	/** Connect if a hub is running, else undefined. */
	static async tryConnect(socketPath = hubSocketPath()): Promise<ControlClient | undefined> {
		try {
			return await ControlClient.connect(socketPath);
		} catch {
			return undefined;
		}
	}

	request<T = unknown>(op: HubControlOp, timeoutMs = 10_000): Promise<T> {
		if (this.closed) return Promise.reject(new HubControlError("session_offline", "hub connection closed"));
		const id = `c${++this.seq}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(id);
				reject(new HubControlError("session_offline", "the hub did not answer"));
			}, timeoutMs);
			this.waiters.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
			this.socket.write(ndjson({ t: "ctl", id, ...op }));
		});
	}

	close(): void {
		this.closed = true;
		this.socket.end();
		this.socket.destroy();
	}
}
