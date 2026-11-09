/**
 * The session's connection to the local phi remote hub (`hub.sock`, NDJSON).
 *
 * Fail-open by construction: no hub means one async `stat` every 5 s on an unref'd timer and
 * nothing else; a dropped connection retries with backoff (1 s -> 30 s) while the socket file
 * exists; `bye` parks the link until the socket file is replaced by a new hub. Nothing here
 * throws into the caller, and nothing is ever printed.
 */

import { stat, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { HubToSession, SessionToHub } from "../../remote/protocol.ts";

export interface SendOptions {
	/** May be dropped (oldest first) when the outbound queue exceeds its cap. Replies never are. */
	droppable?: boolean;
	/** A queued frame with the same key is replaced in place instead of queueing another. */
	key?: string;
}

/** What the session bridge needs from a link; tests substitute a fake. */
export interface LinkLike {
	readonly connected: boolean;
	/** Whether a `register` already went out on the current connection (the hub expects it first). */
	readonly registered?: boolean;
	send(frame: SessionToHub, options?: SendOptions): void;
}

export interface HubLinkHandlers {
	/** The socket connected; the first frame sent must be `register`. */
	onConnect(): void;
	onFrame(frame: HubToSession): void;
	onDisconnect(): void;
	/** Droppable frames were dropped under backpressure and the queue has drained again. */
	onDropped(): void;
}

export interface HubLinkOptions {
	socketPath: () => string;
	watchIntervalMs?: number;
	minBackoffMs?: number;
	maxBackoffMs?: number;
	maxQueueBytes?: number;
	maxInboundBytes?: number;
}

interface Queued {
	line: string;
	bytes: number;
	droppable: boolean;
	key?: string;
}

/** Undroppable frames (replies) may overshoot the queue cap by this factor before the link drops. */
const HARD_QUEUE_FACTOR = 8;

function signatureOf(info: { ino: number; ctimeMs: number; birthtimeMs: number }): string {
	return `${info.ino}:${info.ctimeMs}:${info.birthtimeMs}`;
}

export class HubLink implements LinkLike {
	private readonly socketPath: () => string;
	private readonly watchIntervalMs: number;
	private readonly minBackoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly maxQueueBytes: number;
	private readonly maxInboundBytes: number;
	private handlers: HubLinkHandlers | undefined;
	private socket: Socket | undefined;
	private isConnected = false;
	private registeredHere = false;
	private connecting = false;
	private running = false;
	private ticking = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private backoffMs: number;
	/** Set by `bye`: stay away until the socket file changes (a new hub). */
	private byeSignature: string | undefined;
	private blockedByBye = false;
	private queue: Queued[] = [];
	private queueBytes = 0;
	private waitingDrain = false;
	private dropped = false;

	constructor(options: HubLinkOptions) {
		this.socketPath = options.socketPath;
		this.watchIntervalMs = options.watchIntervalMs ?? 5000;
		this.minBackoffMs = options.minBackoffMs ?? 1000;
		this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
		this.maxQueueBytes = options.maxQueueBytes ?? 2 * 1024 * 1024;
		this.maxInboundBytes = options.maxInboundBytes ?? 32 * 1024 * 1024;
		this.backoffMs = this.minBackoffMs;
	}

	get connected(): boolean {
		return this.isConnected;
	}

	get registered(): boolean {
		return this.isConnected && this.registeredHere;
	}

	get started(): boolean {
		return this.running;
	}

	setHandlers(handlers: HubLinkHandlers | undefined): void {
		this.handlers = handlers;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.schedule(0);
	}

	/** Check for the socket now instead of at the next watch tick (e.g. right after starting a hub). */
	poke(): void {
		if (!this.running || this.socket || this.connecting) return;
		this.backoffMs = this.minBackoffMs;
		this.schedule(0);
	}

	stop(): void {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		const wasConnected = this.isConnected;
		this.isConnected = false;
		this.resetQueue();
		if (socket) {
			// end() lets already-written frames (e.g. a final reply) leave before FIN.
			socket.end();
			setTimeout(() => socket.destroy(), 1000).unref();
		}
		if (wasConnected) this.safely(() => this.handlers?.onDisconnect());
	}

	send(frame: SessionToHub, options: SendOptions = {}): void {
		const socket = this.socket;
		if (!this.isConnected || !socket || socket.destroyed) return;
		let line: string;
		try {
			line = `${JSON.stringify(frame)}\n`;
		} catch {
			return;
		}
		if (frame.t === "register") this.registeredHere = true;
		if (!this.waitingDrain && this.queue.length === 0) {
			this.write(socket, line);
			return;
		}
		const bytes = Buffer.byteLength(line);
		if (options.key) {
			const existing = this.queue.find((entry) => entry.key === options.key);
			if (existing) {
				this.queueBytes += bytes - existing.bytes;
				existing.line = line;
				existing.bytes = bytes;
				return;
			}
		}
		this.queue.push({ line, bytes, droppable: options.droppable === true, key: options.key });
		this.queueBytes += bytes;
		while (this.queueBytes > this.maxQueueBytes) {
			const index = this.queue.findIndex((entry) => entry.droppable);
			if (index === -1) break;
			const [removed] = this.queue.splice(index, 1);
			this.queueBytes -= removed.bytes;
			this.dropped = true;
		}
		if (this.queueBytes > this.maxQueueBytes * HARD_QUEUE_FACTOR) {
			// Only replies are left and the hub still is not reading: it is wedged. Drop the
			// connection (the queue goes with it) and reconnect later rather than grow the session.
			socket.destroy();
		}
	}

	private write(socket: Socket, line: string): void {
		try {
			if (!socket.write(line)) this.waitingDrain = true;
		} catch {
			socket.destroy();
		}
	}

	private flushQueue(socket: Socket): void {
		this.waitingDrain = false;
		while (this.queue.length > 0 && !this.waitingDrain && this.socket === socket) {
			const next = this.queue.shift()!;
			this.queueBytes -= next.bytes;
			this.write(socket, next.line);
		}
		if (this.queue.length === 0 && !this.waitingDrain && this.dropped && this.socket === socket) {
			this.dropped = false;
			this.safely(() => this.handlers?.onDropped());
		}
	}

	private resetQueue(): void {
		this.queue = [];
		this.queueBytes = 0;
		this.waitingDrain = false;
		this.dropped = false;
	}

	private schedule(delayMs: number): void {
		if (!this.running) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.tick();
		}, delayMs);
		this.timer.unref?.();
	}

	private tick(): void {
		if (!this.running || this.socket || this.connecting || this.ticking) return;
		this.ticking = true;
		let path: string;
		try {
			path = this.socketPath();
		} catch {
			this.ticking = false;
			this.schedule(this.watchIntervalMs);
			return;
		}
		stat(path, (error, info) => {
			this.ticking = false;
			if (!this.running || this.socket || this.connecting) return;
			if (error || !info) {
				this.backoffMs = this.minBackoffMs;
				this.schedule(this.watchIntervalMs);
				return;
			}
			if (this.blockedByBye) {
				if (signatureOf(info) === this.byeSignature) {
					this.schedule(this.watchIntervalMs);
					return;
				}
				this.blockedByBye = false;
				this.byeSignature = undefined;
				this.backoffMs = this.minBackoffMs;
			}
			this.connect(path);
		});
	}

	private connect(path: string): void {
		this.connecting = true;
		let socket: Socket;
		try {
			socket = createConnection(path);
		} catch {
			this.connecting = false;
			this.retryLater();
			return;
		}
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		/** Bytes of `buffer` already known to hold no newline (a long line is not rescanned). */
		let scanned = 0;
		socket.on("connect", () => {
			this.connecting = false;
			if (!this.running) {
				socket.destroy();
				return;
			}
			this.socket = socket;
			this.isConnected = true;
			this.registeredHere = false;
			this.backoffMs = this.minBackoffMs;
			this.resetQueue();
			this.safely(() => this.handlers?.onConnect());
		});
		socket.on("data", (chunk: Buffer) => {
			if (this.socket !== socket) return;
			buffer += decoder.write(chunk);
			let start = 0;
			let newline = buffer.indexOf("\n", scanned);
			while (newline !== -1) {
				const line = buffer.slice(start, newline);
				start = newline + 1;
				this.handleLine(socket, line);
				if (this.socket !== socket) return;
				newline = buffer.indexOf("\n", start);
			}
			buffer = buffer.slice(start);
			scanned = buffer.length;
			// A hub that never ends its line is broken; drop it rather than buffer without bound.
			if (buffer.length > this.maxInboundBytes) socket.destroy();
		});
		socket.on("drain", () => {
			if (this.socket === socket) this.flushQueue(socket);
		});
		socket.on("error", () => {
			// `close` follows; the hub being away is the normal case.
		});
		socket.on("close", () => {
			const wasConnected = this.socket === socket && this.isConnected;
			if (this.socket === socket) {
				this.socket = undefined;
				this.isConnected = false;
				this.resetQueue();
			}
			this.connecting = false;
			if (wasConnected) this.safely(() => this.handlers?.onDisconnect());
			if (!this.running) return;
			if (this.blockedByBye) this.schedule(this.watchIntervalMs);
			else this.retryLater();
		});
	}

	private retryLater(): void {
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
		this.schedule(delay);
	}

	private handleLine(socket: Socket, line: string): void {
		if (!line.trim()) return;
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		if (!frame || typeof frame !== "object" || typeof (frame as { t?: unknown }).t !== "string") return;
		const typed = frame as HubToSession;
		if (typed.t === "bye") {
			this.blockedByBye = true;
			try {
				this.byeSignature = signatureOf(statSync(this.socketPath()));
			} catch {
				this.byeSignature = undefined;
			}
			socket.destroy();
			return;
		}
		if (!this.handlers) {
			// Between a session being replaced and its successor attaching.
			if (typed.t === "req" && typeof typed.id === "string") {
				this.send({
					t: "reply",
					re: typed.id,
					ok: false,
					error: { code: "session_offline", message: "session is restarting" },
				});
			}
			return;
		}
		this.safely(() => this.handlers?.onFrame(typed));
	}

	private safely(fn: () => void): void {
		try {
			fn();
		} catch {
			// The session must never feel the hub.
		}
	}
}
