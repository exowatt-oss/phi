/**
 * Test helpers for the phi remote hub: a fake phi session on hub.sock, a WebSocket app client
 * (Node's built-in WebSocket), and a raw-frame client for WS framing tests.
 */

import { connect, type Socket } from "node:net";
import type { SessionSummary } from "../src/remote/protocol.ts";

type Predicate = (msg: any) => boolean;

/** Buffered message queue with `next(predicate)` that waits for a matching message. */
export class MessageQueue {
	readonly all: any[] = [];
	private buffer: any[] = [];
	private waiters: {
		predicate: Predicate;
		resolve: (m: any) => void;
		reject: (e: Error) => void;
		timer: NodeJS.Timeout;
	}[] = [];

	push(msg: any): void {
		this.all.push(msg);
		const idx = this.waiters.findIndex((w) => w.predicate(msg));
		if (idx >= 0) {
			const [w] = this.waiters.splice(idx, 1);
			clearTimeout(w.timer);
			w.resolve(msg);
			return;
		}
		this.buffer.push(msg);
	}

	next(predicate: Predicate = () => true, timeoutMs = 3000): Promise<any> {
		const idx = this.buffer.findIndex(predicate);
		if (idx >= 0) return Promise.resolve(this.buffer.splice(idx, 1)[0]);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w.timer !== timer);
				reject(new Error(`timed out waiting for message; got ${JSON.stringify(this.all.slice(-5))}`));
			}, timeoutMs);
			this.waiters.push({ predicate, resolve, reject, timer });
		});
	}

	/** Messages buffered (not yet consumed) that match. */
	pending(predicate: Predicate = () => true): any[] {
		return this.buffer.filter(predicate);
	}
}

export function summary(sessionId: string, patch: Partial<SessionSummary> = {}): SessionSummary {
	return {
		sessionId,
		name: `session ${sessionId}`,
		cwd: "/tmp",
		host: "test-host",
		pid: 4242,
		kind: "interactive",
		status: "idle",
		startedAt: 1,
		lastActivityAt: 2,
		...patch,
	};
}

/** A fake phi session speaking the internal NDJSON wire. */
export class FakeSession {
	readonly socket: Socket;
	readonly messages = new MessageQueue();
	private buffer = "";

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			this.buffer += chunk;
			let nl = this.buffer.indexOf("\n");
			while (nl !== -1) {
				const line = this.buffer.slice(0, nl);
				this.buffer = this.buffer.slice(nl + 1);
				if (line.trim()) this.messages.push(JSON.parse(line));
				nl = this.buffer.indexOf("\n");
			}
		});
	}

	static connect(path: string): Promise<FakeSession> {
		return new Promise((resolve, reject) => {
			const socket = connect(path);
			socket.once("connect", () => resolve(new FakeSession(socket)));
			socket.once("error", reject);
		});
	}

	send(...frames: unknown[]): void {
		this.socket.write(frames.map((f) => `${JSON.stringify(f)}\n`).join(""));
	}

	async register(s: SessionSummary, spawnId?: string): Promise<void> {
		this.send({ t: "register", v: 1, session: s, ...(spawnId ? { spawnId } : {}) });
		await this.messages.next((m) => m.t === "registered");
	}

	nextReq(op?: string): Promise<any> {
		return this.messages.next((m) => m.t === "req" && (op === undefined || m.op === op));
	}

	reply(re: string, data?: unknown): void {
		this.send({ t: "reply", re, ok: true, ...(data !== undefined ? { data } : {}) });
	}

	close(): void {
		this.socket.end();
		this.socket.destroy();
	}
}

/** An app client using Node's built-in WebSocket. */
export class AppClient {
	readonly ws: WebSocket;
	readonly messages = new MessageQueue();
	readonly closed: Promise<{ code: number; reason: string }>;

	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.addEventListener("message", (e) => this.messages.push(JSON.parse(String(e.data))));
		this.closed = new Promise((resolve) => {
			this.ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }));
		});
	}

	opened(): Promise<void> {
		if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.ws.addEventListener("open", () => resolve(), { once: true });
			this.ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
		});
	}

	send(frame: unknown): void {
		this.ws.send(JSON.stringify(frame));
	}

	async hello(token: string): Promise<any> {
		await this.opened();
		this.send({ t: "hello", token, app: { version: "test", build: "1" } });
		return this.messages.next((m) => m.t === "welcome");
	}

	/** Round-trip a ping so everything the hub sent before it has arrived. */
	async sync(): Promise<void> {
		const id = `sync-${Math.random()}`;
		this.send({ t: "ping", id });
		await this.messages.next((m) => m.t === "pong" && m.re === id);
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			// ignore
		}
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until the hub's first session history index build is done, the way an app does: re-request
 * `sessions.past` until it no longer says `indexing: true`. `hub.start()` starts that build in the
 * background without awaiting it, so a test that needs every stored session listed waits here.
 */
export async function untilHistoryIndexed(app: AppClient, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const id = `indexed-${Math.random().toString(36).slice(2)}`;
		app.send({ t: "sessions.past", id, limit: 1 });
		const past = await app.messages.next((m) => m.re === id && m.t !== "pong");
		if (past.t !== "sessions.past") throw new Error(`sessions.past failed: ${JSON.stringify(past)}`);
		if (!past.indexing) return;
		if (Date.now() > deadline) throw new Error(`history index still building after ${timeoutMs} ms`);
		await sleep(10);
	}
}

export async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
	const res = await fetch(url, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
