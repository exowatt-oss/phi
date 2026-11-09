import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	acceptWebSocket,
	computeAcceptKey,
	encodeFrame,
	OPCODE_BINARY,
	OPCODE_CLOSE,
	OPCODE_CONTINUATION,
	OPCODE_PING,
	OPCODE_PONG,
	OPCODE_TEXT,
	type WsConnection,
	type WsOptions,
} from "../src/remote/hub/ws.ts";

interface Frame {
	fin: boolean;
	opcode: number;
	payload: Buffer;
}

/** Raw client: does the handshake by hand and decodes (unmasked) server frames. */
class RawClient {
	readonly frames: Frame[] = [];
	private buf = Buffer.alloc(0);
	private waiters: (() => void)[] = [];
	ended = false;
	readonly socket: Socket;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => {
			this.buf = Buffer.concat([this.buf, chunk]);
			this.parse();
			for (const w of this.waiters.splice(0)) w();
		});
		socket.on("close", () => {
			this.ended = true;
			for (const w of this.waiters.splice(0)) w();
		});
	}

	static async open(port: number): Promise<RawClient> {
		const socket = connect(port, "127.0.0.1");
		await new Promise<void>((r) => socket.once("connect", () => r()));
		const key = Buffer.from("0123456789abcdef").toString("base64");
		socket.write(
			`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);
		const head = await new Promise<string>((resolve) => {
			let acc = Buffer.alloc(0);
			const onData = (chunk: Buffer) => {
				acc = Buffer.concat([acc, chunk]);
				const end = acc.indexOf("\r\n\r\n");
				if (end >= 0) {
					socket.off("data", onData);
					const rest = acc.subarray(end + 4);
					if (rest.length > 0) socket.unshift(rest);
					resolve(acc.subarray(0, end).toString());
				}
			};
			socket.on("data", onData);
		});
		expect(head).toContain("101 Switching Protocols");
		expect(head).toContain(`Sec-WebSocket-Accept: ${computeAcceptKey(key)}`);
		return new RawClient(socket);
	}

	private parse(): void {
		while (this.buf.length >= 2) {
			const b0 = this.buf[0];
			const b1 = this.buf[1];
			expect(b1 & 0x80).toBe(0); // server frames are never masked
			let len = b1 & 0x7f;
			let off = 2;
			if (len === 126) {
				if (this.buf.length < 4) return;
				len = this.buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (this.buf.length < 10) return;
				len = Number(this.buf.readBigUInt64BE(2));
				off = 10;
			}
			if (this.buf.length < off + len) return;
			this.frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload: this.buf.subarray(off, off + len) });
			this.buf = this.buf.subarray(off + len);
		}
	}

	send(opcode: number, payload: Buffer | string, options: { fin?: boolean; mask?: boolean } = {}): void {
		const data = typeof payload === "string" ? Buffer.from(payload) : payload;
		this.socket.write(encodeFrame(opcode, data, { fin: options.fin, mask: options.mask ?? true }));
	}

	async waitFor(predicate: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const found = this.frames.find(predicate);
			if (found) return found;
			if (this.ended || Date.now() > deadline)
				throw new Error(`no matching frame; got ${this.frames.map((f) => f.opcode)}`);
			await new Promise<void>((r) => {
				this.waiters.push(r);
				setTimeout(r, 50);
			});
		}
	}

	async waitClosed(timeoutMs = 3000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!this.ended) {
			if (Date.now() > deadline) throw new Error("socket did not close");
			await new Promise((r) => setTimeout(r, 20));
		}
	}
}

function closeCode(frame: Frame): number {
	return frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
}

let server: Server | undefined;
const raws: RawClient[] = [];

afterEach(async () => {
	for (const raw of raws.splice(0)) raw.socket.destroy();
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	server = undefined;
});

/** Echo server: text echoes as text, binary as binary. */
async function startEcho(options: WsOptions = {}) {
	const conns: WsConnection[] = [];
	const closes: { code: number; reason: string }[] = [];
	const messages: (string | Buffer)[] = [];
	server = createServer();
	server.on("upgrade", (req, socket, head) => {
		const ws = acceptWebSocket(req, socket, head, { pingIntervalMs: 0, ...options });
		if (!ws) return;
		conns.push(ws);
		ws.on("message", (data, isBinary) => {
			messages.push(data);
			if (isBinary) ws.sendBinary(data as Buffer);
			else ws.send(data as string);
		});
		ws.on("close", (code, reason) => closes.push({ code, reason }));
	});
	await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
	const port = (server!.address() as { port: number }).port;
	const open = async () => {
		const raw = await RawClient.open(port);
		raws.push(raw);
		return raw;
	};
	return { port, conns, closes, messages, open };
}

describe("phi remote hub WebSocket server", () => {
	it("computes the RFC 6455 accept key", () => {
		expect(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
	});

	it("rejects a non-websocket upgrade and an unsupported version", async () => {
		server = createServer();
		server.on("upgrade", (req, socket, head) => acceptWebSocket(req, socket, head));
		await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
		const port = (server!.address() as { port: number }).port;
		const request = (headers: string) =>
			new Promise<string>((resolve) => {
				const s = connect(port, "127.0.0.1", () => s.write(`GET / HTTP/1.1\r\nHost: x\r\n${headers}\r\n`));
				let acc = "";
				s.on("data", (d) => {
					acc += d.toString();
				});
				s.on("close", () => resolve(acc));
			});
		const key = Buffer.alloc(16).toString("base64");
		expect(
			await request(
				`Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 8\r\n`,
			),
		).toMatch(/^HTTP\/1.1 426/);
		expect(
			await request(
				`Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: short\r\nSec-WebSocket-Version: 13\r\n`,
			),
		).toMatch(/^HTTP\/1.1 400/);
	});

	it("echoes masked text and binary messages", async () => {
		const echo = await startEcho();
		const raw = await echo.open();
		raw.send(OPCODE_TEXT, "héllo");
		const text = await raw.waitFor((f) => f.opcode === OPCODE_TEXT);
		expect(text.payload.toString()).toBe("héllo");
		raw.send(OPCODE_BINARY, Buffer.from([0, 1, 2, 255]));
		const bin = await raw.waitFor((f) => f.opcode === OPCODE_BINARY);
		expect([...bin.payload]).toEqual([0, 1, 2, 255]);
	});

	it("reassembles fragmented messages with an interleaved ping", async () => {
		const echo = await startEcho();
		const raw = await echo.open();
		raw.send(OPCODE_TEXT, "frag-", { fin: false });
		raw.send(OPCODE_PING, "mid");
		raw.send(OPCODE_CONTINUATION, "men", { fin: false });
		raw.send(OPCODE_CONTINUATION, "ted", { fin: true });
		const pong = await raw.waitFor((f) => f.opcode === OPCODE_PONG);
		expect(pong.payload.toString()).toBe("mid");
		const text = await raw.waitFor((f) => f.opcode === OPCODE_TEXT);
		expect(text.payload.toString()).toBe("frag-mented");
		expect(echo.messages).toEqual(["frag-mented"]);
	});

	it("handles 16-bit and 64-bit payload lengths in both directions, split across TCP writes", async () => {
		const echo = await startEcho();
		const raw = await echo.open();
		const medium = "m".repeat(40_000); // 16-bit length
		const big = "b".repeat(200_000); // 64-bit length (> 64 KiB)
		const frame = encodeFrame(OPCODE_TEXT, Buffer.from(big), { mask: true });
		raw.send(OPCODE_TEXT, medium);
		// Dribble the big frame in small pieces to exercise partial-header and partial-payload parsing.
		for (let i = 0; i < frame.length; i += 7_001) raw.socket.write(frame.subarray(i, i + 7_001));
		await raw.waitFor((f) => f.opcode === OPCODE_TEXT && f.payload.length === big.length, 5000);
		const texts = raw.frames.filter((f) => f.opcode === OPCODE_TEXT).map((f) => f.payload.toString());
		expect(texts).toEqual([medium, big]);
	});

	it("closes 1002 on an unmasked client frame", async () => {
		const echo = await startEcho();
		const raw = await echo.open();
		raw.send(OPCODE_TEXT, "nope", { mask: false });
		const close = await raw.waitFor((f) => f.opcode === OPCODE_CLOSE);
		expect(closeCode(close)).toBe(1002);
	});

	it("closes 1002 on a stray continuation frame", async () => {
		const echo = await startEcho();
		const raw = await echo.open();
		raw.send(OPCODE_CONTINUATION, "x");
		expect(closeCode(await raw.waitFor((f) => f.opcode === OPCODE_CLOSE))).toBe(1002);
	});

	it("closes 1009 when a message (or its fragments) exceed the cap", async () => {
		const echo = await startEcho({ maxMessageBytes: 1024 });
		const raw = await echo.open();
		raw.send(OPCODE_TEXT, "a".repeat(600), { fin: false });
		raw.send(OPCODE_CONTINUATION, "a".repeat(600), { fin: true });
		expect(closeCode(await raw.waitFor((f) => f.opcode === OPCODE_CLOSE))).toBe(1009);
		const raw2 = await echo.open();
		raw2.send(OPCODE_TEXT, "a".repeat(2000));
		expect(closeCode(await raw2.waitFor((f) => f.opcode === OPCODE_CLOSE))).toBe(1009);
		expect(echo.messages).toEqual([]);
	});

	it("closes 1007 on invalid UTF-8 text", async () => {
		const echo = await startEcho();
		const raw = await echo.open();
		raw.send(OPCODE_TEXT, Buffer.from([0xc3, 0x28]));
		expect(closeCode(await raw.waitFor((f) => f.opcode === OPCODE_CLOSE))).toBe(1007);
	});

	it("echoes the client's close code and reports it", async () => {
		const echo = await startEcho();
		const raw = await echo.open();
		const payload = Buffer.alloc(2 + 3);
		payload.writeUInt16BE(4000, 0);
		payload.write("bye", 2);
		raw.send(OPCODE_CLOSE, payload);
		const close = await raw.waitFor((f) => f.opcode === OPCODE_CLOSE);
		expect(closeCode(close)).toBe(4000);
		await raw.waitClosed();
		await new Promise((r) => setTimeout(r, 50));
		expect(echo.closes).toEqual([{ code: 4000, reason: "bye" }]);
	});

	it("sends application close codes (4401) with a reason", async () => {
		const echo = await startEcho();
		const raw = await echo.open();
		await new Promise((r) => setTimeout(r, 20));
		echo.conns[0].close(4401, "unauthorized");
		const close = await raw.waitFor((f) => f.opcode === OPCODE_CLOSE);
		expect(closeCode(close)).toBe(4401);
		expect(close.payload.subarray(2).toString()).toBe("unauthorized");
	});

	it("pings on an interval and drops a client after 3 missed pongs", async () => {
		const echo = await startEcho({ pingIntervalMs: 40 });
		const raw = await echo.open();
		await raw.waitClosed(2000);
		expect(raw.frames.filter((f) => f.opcode === OPCODE_PING).length).toBeGreaterThanOrEqual(3);
		await new Promise((r) => setTimeout(r, 20));
		expect(echo.closes.length).toBe(1);
	});

	it("keeps a client that answers pings", async () => {
		const echo = await startEcho({ pingIntervalMs: 40 });
		const raw = await echo.open();
		raw.socket.on("data", () => {
			for (const f of raw.frames.splice(0)) if (f.opcode === OPCODE_PING) raw.send(OPCODE_PONG, f.payload);
		});
		await new Promise((r) => setTimeout(r, 400));
		expect(raw.ended).toBe(false);
		expect(echo.conns[0].readyState).toBe("open");
	});

	it("works with Node's built-in WebSocket client", async () => {
		const echo = await startEcho();
		const ws = new WebSocket(`ws://127.0.0.1:${echo.port}/ws`);
		await new Promise<void>((r) => ws.addEventListener("open", () => r()));
		const got = new Promise<string>((r) => ws.addEventListener("message", (e) => r(String(e.data))));
		const big = "z".repeat(100_000);
		ws.send(big);
		expect(await got).toBe(big);
		const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
		echo.conns[0].close(4426, "protocol 1 required");
		expect(await closed).toBe(4426);
	});
});
