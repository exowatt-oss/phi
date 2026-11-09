/**
 * Minimal RFC 6455 WebSocket server for the phi remote hub (no `ws` dependency).
 *
 * Scope: the server side only, no extensions (permessage-deflate is never negotiated), no
 * subprotocols. Handles the opening handshake, masked client frames, text/binary messages with
 * fragmentation (continuation frames, interleaved control frames), ping/pong, the closing
 * handshake, an inbound message size cap, keepalive pings with missed-pong detection, and a cap
 * on buffered outbound bytes so a client that stops reading cannot grow hub memory unboundedly.
 */

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_NO_STATUS = 1005;
export const CLOSE_ABNORMAL = 1006;
export const CLOSE_INVALID_PAYLOAD = 1007;
export const CLOSE_POLICY = 1008;
export const CLOSE_TOO_BIG = 1009;
export const CLOSE_TRY_AGAIN_LATER = 1013;

export interface WsOptions {
	/** Largest inbound message (after reassembly), bytes. Default 12 MiB. */
	maxMessageBytes?: number;
	/** Keepalive ping interval, ms (0 disables). Default 20 s. */
	pingIntervalMs?: number;
	/** Consecutive unanswered pings before the connection is dropped. Default 3. */
	maxMissedPongs?: number;
	/** Outbound bytes allowed to queue in the socket before the client is dropped. Default 32 MiB. */
	maxBufferedBytes?: number;
	/** How long to wait for the peer's close frame after sending ours, ms. Default 2 s. */
	closeTimeoutMs?: number;
}

/** Fragments of one message; bounds per-fragment overhead (a stream of empty continuations). */
const MAX_FRAGMENTS = 1024;

const DEFAULTS: Required<WsOptions> = {
	maxMessageBytes: 12 * 1024 * 1024,
	pingIntervalMs: 20_000,
	maxMissedPongs: 3,
	maxBufferedBytes: 32 * 1024 * 1024,
	closeTimeoutMs: 2_000,
};

export function computeAcceptKey(key: string): string {
	return createHash("sha1")
		.update(key + WS_GUID)
		.digest("base64");
}

/**
 * Encode one frame. Server frames are unmasked; pass `mask` (4 bytes) to build client frames
 * (used by tests). `fin: false` produces a fragment.
 */
export function encodeFrame(
	opcode: number,
	payload: Buffer,
	options: { fin?: boolean; mask?: Buffer | boolean } = {},
): Buffer {
	const fin = options.fin ?? true;
	const mask = options.mask === true ? randomBytes(4) : options.mask || undefined;
	const len = payload.length;
	const extLen = len < 126 ? 0 : len < 65_536 ? 2 : 8;
	const header = Buffer.alloc(2 + extLen + (mask ? 4 : 0));
	header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
	header[1] = (mask ? 0x80 : 0) | (extLen === 0 ? len : extLen === 2 ? 126 : 127);
	if (extLen === 2) header.writeUInt16BE(len, 2);
	else if (extLen === 8) header.writeBigUInt64BE(BigInt(len), 2);
	if (!mask) return Buffer.concat([header, payload]);
	mask.copy(header, 2 + extLen);
	const body = Buffer.allocUnsafe(len);
	for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
	return Buffer.concat([header, body]);
}

function closePayload(code: number, reason: string): Buffer {
	const reasonBuf = Buffer.from(reason, "utf8").subarray(0, 123);
	const buf = Buffer.alloc(2 + reasonBuf.length);
	buf.writeUInt16BE(code, 0);
	reasonBuf.copy(buf, 2);
	return buf;
}

function isValidCloseCode(code: number): boolean {
	if (code >= 3000 && code <= 4999) return true;
	return code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export type WsState = "open" | "closing" | "closed";

/**
 * Who ended a connection: `client` sent the first close frame, `server` did (this process called
 * `close()`, failed the connection or dropped a client that stopped reading), `ping-timeout` is the
 * keepalive giving up, `lost` is TCP ending or resetting without any close frame.
 */
export type WsClosedBy = "client" | "server" | "ping-timeout" | "lost";

export interface WsConnectionEvents {
	message: [data: string | Buffer, isBinary: boolean];
	close: [code: number, reason: string];
	pong: [payload: Buffer];
	/** A keepalive ping went unanswered for a whole interval (`missed` of `max` before the drop). */
	missedPong: [missed: number, max: number];
}

/**
 * One accepted WebSocket. Emits `message` (string for text, Buffer for binary), `pong`, and
 * `close` exactly once.
 */
export class WsConnection extends EventEmitter<WsConnectionEvents> {
	readonly remoteAddress: string;
	readonly remotePort: number | undefined;
	readonly localAddress: string;
	readonly localPort: number | undefined;
	/** Last pong from the peer (epoch ms), if any. */
	lastPongAt: number | undefined;
	private initiator: WsClosedBy | undefined;
	private readonly socket: Duplex;
	private readonly opts: Required<WsOptions>;
	private state: WsState = "open";
	private chunks: Buffer[] = [];
	private buffered = 0;
	private fragments: Buffer[] | undefined;
	private fragmentOpcode = 0;
	private fragmentBytes = 0;
	private closeSent = false;
	private closeEmitted = false;
	private receivedClose: { code: number; reason: string } | undefined;
	private pingTimer: NodeJS.Timeout | undefined;
	private closeTimer: NodeJS.Timeout | undefined;
	private awaitingPong = false;
	private missedPongs = 0;
	/** Set once the connection failed (protocol error, too big): later bytes are ignored. */
	private failed = false;

	constructor(socket: Duplex, head: Buffer, options: WsOptions = {}) {
		super();
		this.socket = socket;
		this.opts = { ...DEFAULTS, ...options };
		const s = socket as Socket;
		this.remoteAddress = s.remoteAddress ?? "";
		this.remotePort = s.remotePort;
		this.localAddress = s.localAddress ?? "";
		this.localPort = s.localPort;
		s.setNoDelay?.(true);
		s.setTimeout?.(0);
		s.setKeepAlive?.(true, 30_000);
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("error", () => this.finish(CLOSE_ABNORMAL, ""));
		socket.on("close", () =>
			this.finish(this.receivedClose?.code ?? CLOSE_ABNORMAL, this.receivedClose?.reason ?? ""),
		);
		socket.on("end", () => {
			// Peer half-closed: end our side too.
			socket.end();
		});
		if (this.opts.pingIntervalMs > 0) {
			this.pingTimer = setInterval(() => this.keepalive(), this.opts.pingIntervalMs);
			this.pingTimer.unref?.();
		}
		if (head.length > 0) this.onData(head);
	}

	get readyState(): WsState {
		return this.state;
	}

	/** Who ended the connection; undefined while it is open. */
	get closedBy(): WsClosedBy | undefined {
		return this.initiator;
	}

	/** Change the inbound message cap (e.g. raise it once the client has authenticated). */
	setMaxMessageBytes(bytes: number): void {
		this.opts.maxMessageBytes = bytes;
	}

	/** Bytes queued in the socket and not yet flushed to the kernel. */
	get bufferedAmount(): number {
		return (this.socket as Socket).writableLength ?? 0;
	}

	/** Send a text message. Returns false if the connection is not open (or was just dropped). */
	send(text: string): boolean {
		return this.sendFrame(OPCODE_TEXT, Buffer.from(text, "utf8"));
	}

	sendBinary(data: Buffer): boolean {
		return this.sendFrame(OPCODE_BINARY, data);
	}

	ping(payload: Buffer = Buffer.alloc(0)): boolean {
		return this.sendFrame(OPCODE_PING, payload.subarray(0, 125));
	}

	/** Start the closing handshake. The socket is destroyed if the peer does not answer in time. */
	close(code = CLOSE_NORMAL, reason = ""): void {
		if (this.state === "closed") return;
		this.initiator ??= "server";
		if (!this.closeSent) {
			this.closeSent = true;
			this.writeRaw(encodeFrame(OPCODE_CLOSE, closePayload(code, reason)));
		}
		if (this.state === "open") this.state = "closing";
		if (this.receivedClose) {
			this.socket.end();
		} else if (!this.closeTimer) {
			this.closeTimer = setTimeout(() => this.terminate(), this.opts.closeTimeoutMs);
			this.closeTimer.unref?.();
		}
		// Report the code we chose even if the peer never answers.
		this.receivedClose ??= { code, reason };
	}

	/** Drop the TCP connection immediately. */
	terminate(): void {
		this.socket.destroy();
		this.finish(this.receivedClose?.code ?? CLOSE_ABNORMAL, this.receivedClose?.reason ?? "");
	}

	private sendFrame(opcode: number, payload: Buffer): boolean {
		if (this.state !== "open") return false;
		return this.writeRaw(encodeFrame(opcode, payload));
	}

	private writeRaw(frame: Buffer): boolean {
		if (this.socket.destroyed || this.state === "closed") return false;
		this.socket.write(frame);
		if (this.bufferedAmount > this.opts.maxBufferedBytes) {
			// The client stopped reading; holding more would grow hub memory without bound.
			this.receivedClose ??= { code: CLOSE_TRY_AGAIN_LATER, reason: "client not reading" };
			this.initiator ??= "server";
			this.terminate();
			return false;
		}
		return true;
	}

	private keepalive(): void {
		if (this.state !== "open") return;
		if (this.awaitingPong) {
			this.missedPongs++;
			if (this.missedPongs >= this.opts.maxMissedPongs) {
				this.receivedClose ??= { code: CLOSE_GOING_AWAY, reason: "ping timeout" };
				this.initiator ??= "ping-timeout";
				this.terminate();
				return;
			}
			this.emit("missedPong", this.missedPongs, this.opts.maxMissedPongs);
			if ((this.state as WsState) !== "open") return;
		}
		this.awaitingPong = true;
		this.ping();
	}

	private finish(code: number, reason: string): void {
		this.state = "closed";
		this.initiator ??= "lost";
		if (this.pingTimer) clearInterval(this.pingTimer);
		if (this.closeTimer) clearTimeout(this.closeTimer);
		this.pingTimer = undefined;
		this.closeTimer = undefined;
		this.chunks = [];
		this.fragments = undefined;
		if (!this.socket.destroyed) this.socket.destroy();
		if (this.closeEmitted) return;
		this.closeEmitted = true;
		this.emit("close", code, reason);
	}

	private failConnection(code: number, reason: string): void {
		this.failed = true;
		this.chunks = [];
		this.buffered = 0;
		this.fragments = undefined;
		this.fragmentBytes = 0;
		this.close(code, reason);
		// RFC 6455 §7.1.7: after failing the connection there is nothing more to read from it.
		this.socket.end();
	}

	private onData(chunk: Buffer): void {
		if (this.state === "closed" || this.failed) return;
		this.chunks.push(chunk);
		this.buffered += chunk.length;
		// parseOne() may close the connection, which changes `state` behind TypeScript's back.
		while ((this.state as WsState) !== "closed" && this.parseOne()) {
			// keep parsing complete frames
		}
	}

	private peek(n: number): Buffer {
		if (this.chunks[0].length >= n) return this.chunks[0];
		const all = Buffer.concat(this.chunks);
		this.chunks = [all];
		return all;
	}

	private consume(n: number): Buffer {
		if (n === 0) return Buffer.alloc(0);
		const first = this.peek(n);
		const out = first.subarray(0, n);
		const rest = first.subarray(n);
		if (rest.length > 0) this.chunks[0] = rest;
		else this.chunks.shift();
		this.buffered -= n;
		return out;
	}

	/** Parse and handle one complete frame; returns false when more bytes are needed. */
	private parseOne(): boolean {
		if (this.buffered < 2) return false;
		const head = this.peek(2);
		const b0 = head[0];
		const b1 = head[1];
		const fin = (b0 & 0x80) !== 0;
		const rsv = b0 & 0x70;
		const opcode = b0 & 0x0f;
		const masked = (b1 & 0x80) !== 0;
		let len = b1 & 0x7f;
		let headerLen = 2;
		if (len === 126) headerLen += 2;
		else if (len === 127) headerLen += 8;
		if (masked) headerLen += 4;
		if (this.buffered < headerLen) return false;

		if (rsv !== 0) {
			this.failConnection(CLOSE_PROTOCOL_ERROR, "reserved bits set");
			return false;
		}
		if (!masked) {
			this.failConnection(CLOSE_PROTOCOL_ERROR, "client frames must be masked");
			return false;
		}
		const isControl = (opcode & 0x08) !== 0;
		if (isControl && (!fin || len > 125)) {
			this.failConnection(CLOSE_PROTOCOL_ERROR, "invalid control frame");
			return false;
		}
		if (![OPCODE_CONTINUATION, OPCODE_TEXT, OPCODE_BINARY, OPCODE_CLOSE, OPCODE_PING, OPCODE_PONG].includes(opcode)) {
			this.failConnection(CLOSE_PROTOCOL_ERROR, "unknown opcode");
			return false;
		}

		const header = this.peek(headerLen);
		if (len === 126) {
			len = header.readUInt16BE(2);
		} else if (len === 127) {
			const big = header.readBigUInt64BE(2);
			if (big > BigInt(this.opts.maxMessageBytes)) {
				this.failConnection(CLOSE_TOO_BIG, "message too big");
				return false;
			}
			len = Number(big);
		}
		const pending = this.fragments ? this.fragmentBytes : 0;
		if (!isControl && pending + len > this.opts.maxMessageBytes) {
			this.failConnection(CLOSE_TOO_BIG, "message too big");
			return false;
		}
		if (this.buffered < headerLen + len) return false;

		const mask = Buffer.from(header.subarray(headerLen - 4, headerLen));
		this.consume(headerLen);
		const payload = Buffer.from(this.consume(len));
		for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

		if (isControl) {
			this.handleControl(opcode, payload);
			return true;
		}
		if (this.state !== "open") return true; // ignore data after we started closing

		if (opcode === OPCODE_CONTINUATION) {
			if (!this.fragments) {
				this.failConnection(CLOSE_PROTOCOL_ERROR, "unexpected continuation frame");
				return false;
			}
			if (this.fragments.length >= MAX_FRAGMENTS) {
				this.failConnection(CLOSE_TOO_BIG, "too many fragments");
				return false;
			}
			this.fragments.push(payload);
			this.fragmentBytes += payload.length;
			if (fin) {
				const data = Buffer.concat(this.fragments);
				const op = this.fragmentOpcode;
				this.fragments = undefined;
				this.fragmentBytes = 0;
				this.deliver(op, data);
			}
			return true;
		}

		if (this.fragments) {
			this.failConnection(CLOSE_PROTOCOL_ERROR, "expected continuation frame");
			return false;
		}
		if (!fin) {
			this.fragments = [payload];
			this.fragmentOpcode = opcode;
			this.fragmentBytes = payload.length;
			return true;
		}
		this.deliver(opcode, payload);
		return true;
	}

	private deliver(opcode: number, data: Buffer): void {
		if (opcode === OPCODE_TEXT) {
			let text: string;
			try {
				text = utf8.decode(data);
			} catch {
				this.failConnection(CLOSE_INVALID_PAYLOAD, "invalid utf-8");
				return;
			}
			this.emit("message", text, false);
		} else {
			this.emit("message", data, true);
		}
	}

	private handleControl(opcode: number, payload: Buffer): void {
		if (opcode === OPCODE_PING) {
			this.sendFrame(OPCODE_PONG, payload);
			return;
		}
		if (opcode === OPCODE_PONG) {
			this.lastPongAt = Date.now();
			this.awaitingPong = false;
			this.missedPongs = 0;
			this.emit("pong", payload);
			return;
		}
		// Close
		this.initiator ??= "client";
		let code = CLOSE_NO_STATUS;
		let reason = "";
		if (payload.length === 1) {
			this.receivedClose = { code: CLOSE_PROTOCOL_ERROR, reason: "" };
			this.close(CLOSE_PROTOCOL_ERROR, "bad close payload");
			this.socket.end();
			return;
		}
		if (payload.length >= 2) {
			code = payload.readUInt16BE(0);
			try {
				reason = utf8.decode(payload.subarray(2));
			} catch {
				this.receivedClose = { code: CLOSE_INVALID_PAYLOAD, reason: "" };
				this.close(CLOSE_INVALID_PAYLOAD, "invalid utf-8");
				this.socket.end();
				return;
			}
			if (!isValidCloseCode(code)) {
				this.receivedClose = { code: CLOSE_PROTOCOL_ERROR, reason };
				this.close(CLOSE_PROTOCOL_ERROR, "invalid close code");
				this.socket.end();
				return;
			}
		}
		const peerInitiated = !this.closeSent;
		if (peerInitiated || !this.receivedClose) this.receivedClose = { code, reason };
		if (peerInitiated) {
			// Echo the peer's code (RFC 6455 §5.5.1), then end our side.
			this.closeSent = true;
			const echo = code === CLOSE_NO_STATUS ? Buffer.alloc(0) : closePayload(code, "");
			this.writeRaw(encodeFrame(OPCODE_CLOSE, echo));
		}
		this.state = "closing";
		this.socket.end();
	}
}

/**
 * Validate an HTTP upgrade request and complete the handshake. On a bad request this writes an
 * HTTP error to the socket, destroys it, and returns undefined.
 */
/** What the handshake needs from the request (a node:http IncomingMessage or the hub's own head). */
export interface UpgradeRequest {
	method?: string;
	headers: Record<string, string | string[] | undefined>;
}

export function acceptWebSocket(
	req: UpgradeRequest | IncomingMessage,
	socket: Duplex,
	head: Buffer,
	options: WsOptions = {},
): WsConnection | undefined {
	const reject = (status: number, text: string, extra = "") => {
		socket.on("error", () => {});
		socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
		// end() flushes the response first; a peer that never reads is dropped shortly after.
		setTimeout(() => socket.destroy(), 2000).unref();
		return undefined;
	};
	const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
	const connection = String(req.headers.connection ?? "").toLowerCase();
	if (req.method !== "GET" || upgrade !== "websocket" || !connection.split(/\s*,\s*/).includes("upgrade")) {
		return reject(400, "Bad Request");
	}
	if (req.headers["sec-websocket-version"] !== "13") {
		return reject(426, "Upgrade Required", "Sec-WebSocket-Version: 13\r\n");
	}
	const key = req.headers["sec-websocket-key"];
	if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) {
		return reject(400, "Bad Request");
	}
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`,
	);
	return new WsConnection(socket, head, options);
}
