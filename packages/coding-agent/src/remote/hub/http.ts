/**
 * The hub's HTTP/1.1 front door, on `node:net`.
 *
 * Why not `node:http`: the compiled phi binary runs on Bun, whose `node:http` server hands the
 * `upgrade` event a socket that never delivers writes (Bun 1.3.x), so the WebSocket handshake
 * silently hangs. Plain TCP sockets behave the same on Node and Bun, and the hub serves three
 * fixed routes, so it parses requests itself:
 *
 * - Request line + headers only (no chunked bodies, no keep-alive: every response closes the
 *   connection). Heads over `maxHeaderBytes` → 431; anything malformed → 400.
 * - Bodies are read up to `maxBodyBytes` from `Content-Length`; a larger declared or actual body is
 *   reported to the handler as `tooLarge` without being buffered, `Transfer-Encoding` as
 *   `malformed`.
 * - Slowloris bounds: the head must arrive within `headersTimeoutMs`, the whole request within
 *   `requestTimeoutMs`, and the connection may not sit silent for `idleTimeoutMs`.
 * - `Upgrade: websocket` requests are handed off with the socket and any bytes already read; the
 *   WebSocket layer owns the connection from then on (no HTTP timeouts).
 */

import { createServer, type Server, type Socket } from "node:net";

export interface HttpHead {
	method: string;
	/** The request target as sent (origin-form for well-behaved clients). */
	url: string;
	/** Lower-cased names; repeated headers joined with ", ". */
	headers: Record<string, string>;
}

export interface HttpRequest extends HttpHead {
	remoteAddress: string;
	/** The body (empty when none), unless it was too large or malformed. */
	body: Buffer | undefined;
	/** Content-Length (or the bytes actually sent) exceeded `maxBodyBytes`. */
	tooLarge: boolean;
	/** A body framing this server does not accept (`Transfer-Encoding`). */
	malformed: boolean;
}

export interface HttpReply {
	/** Send a JSON response and close the connection. Later calls are ignored. */
	json(status: number, body: unknown): void;
}

export interface HttpServerOptions {
	onRequest(request: HttpRequest, reply: HttpReply): void;
	onUpgrade(head: HttpHead & { remoteAddress: string }, socket: Socket, rest: Buffer): void;
	/** Errors thrown by the handlers (the request gets a 500). */
	onError?(error: unknown): void;
	headersTimeoutMs?: number;
	requestTimeoutMs?: number;
	idleTimeoutMs?: number;
	maxHeaderBytes?: number;
	maxBodyBytes?: number;
	maxConnections?: number;
}

const STATUS_TEXT: Record<number, string> = {
	200: "OK",
	400: "Bad Request",
	401: "Unauthorized",
	404: "Not Found",
	405: "Method Not Allowed",
	426: "Upgrade Required",
	429: "Too Many Requests",
	431: "Request Header Fields Too Large",
	500: "Internal Server Error",
	503: "Service Unavailable",
};

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REQUEST_LINE = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+) ([^\s]+) HTTP\/1\.[01]$/;
const HEAD_END = Buffer.from("\r\n\r\n");

/** Parse a request head (without the final CRLF CRLF). Undefined when malformed. */
export function parseHttpHead(text: string): HttpHead | undefined {
	const lines = text.split("\r\n");
	const match = REQUEST_LINE.exec(lines[0] ?? "");
	if (!match) return undefined;
	const headers: Record<string, string> = {};
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		const colon = line.indexOf(":");
		if (colon <= 0) return undefined;
		const name = line.slice(0, colon);
		if (!TOKEN.test(name)) return undefined; // also rejects obs-fold (leading whitespace)
		const value = line.slice(colon + 1).trim();
		if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return undefined;
		const key = name.toLowerCase();
		if (key in headers) {
			// Conflicting lengths are a request-smuggling shape; refuse rather than pick one.
			if (key === "content-length" && headers[key] !== value) return undefined;
			if (key !== "content-length") headers[key] = `${headers[key]}, ${value}`;
		} else {
			headers[key] = value;
		}
	}
	return { method: match[1], url: match[2], headers };
}

function isUpgrade(head: HttpHead): boolean {
	return head.headers.upgrade !== undefined && /(^|,)\s*upgrade\s*(,|$)/i.test(head.headers.connection ?? "");
}

function writeJson(socket: Socket, status: number, body: unknown, method: string): void {
	const payload = Buffer.from(JSON.stringify(body));
	const head =
		`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\n` +
		"Content-Type: application/json\r\n" +
		`Content-Length: ${payload.length}\r\n` +
		"Cache-Control: no-store\r\n" +
		"Connection: close\r\n\r\n";
	socket.end(method === "HEAD" ? head : Buffer.concat([Buffer.from(head, "latin1"), payload]));
	// A client that never reads its response must not hold the socket open.
	setTimeout(() => socket.destroy(), 5000).unref();
}

/** Create the TCP server. Call `listen` on it; `closeAll` drops every connection still in HTTP. */
export function createHttpLiteServer(options: HttpServerOptions): Server & { closeAll(): void } {
	const headersTimeoutMs = options.headersTimeoutMs ?? 10_000;
	const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
	const idleTimeoutMs = options.idleTimeoutMs ?? 15_000;
	const maxHeaderBytes = options.maxHeaderBytes ?? 16 * 1024;
	const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024;
	const open = new Set<Socket>();

	const server = createServer((socket) => {
		open.add(socket);
		socket.on("error", () => {});
		socket.setNoDelay(true);
		let buffer: Buffer = Buffer.alloc(0);
		let head: HttpHead | undefined;
		let bodyLength = 0;
		let done = false;
		const remoteAddress = socket.remoteAddress ?? "unknown";

		const headersTimer = setTimeout(() => {
			if (!head) socket.destroy();
		}, headersTimeoutMs);
		const requestTimer = setTimeout(() => socket.destroy(), requestTimeoutMs);
		socket.setTimeout(idleTimeoutMs, () => socket.destroy());

		const stopTimers = () => {
			clearTimeout(headersTimer);
			clearTimeout(requestTimer);
			socket.setTimeout(0);
		};
		const finish = () => {
			done = true;
			buffer = Buffer.alloc(0);
			socket.removeListener("data", onData);
			// Whatever else the client sends is read and dropped until the socket closes.
			socket.on("data", () => {});
		};
		socket.on("close", () => {
			stopTimers();
			open.delete(socket);
		});

		const reply = (method: string): HttpReply => {
			let sent = false;
			return {
				json(status, body) {
					if (sent || socket.destroyed) return;
					sent = true;
					writeJson(socket, status, body, method);
				},
			};
		};

		const dispatch = (request: HttpRequest) => {
			finish();
			const r = reply(request.method);
			try {
				options.onRequest(request, r);
			} catch (error) {
				options.onError?.(error);
				r.json(500, { error: "internal" });
			}
		};

		const onData = (chunk: Buffer) => {
			if (done) return;
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			if (!head) {
				const end = buffer.indexOf(HEAD_END);
				if (end === -1) {
					if (buffer.length > maxHeaderBytes) {
						finish();
						writeJson(socket, 431, { error: "bad_request" }, "GET");
					}
					return;
				}
				if (end > maxHeaderBytes) {
					finish();
					writeJson(socket, 431, { error: "bad_request" }, "GET");
					return;
				}
				const parsed = parseHttpHead(buffer.subarray(0, end).toString("latin1"));
				buffer = buffer.subarray(end + HEAD_END.length);
				if (!parsed) {
					finish();
					writeJson(socket, 400, { error: "bad_request" }, "GET");
					return;
				}
				head = parsed;
				clearTimeout(headersTimer);
				if (isUpgrade(head)) {
					const rest = buffer;
					finish();
					stopTimers();
					open.delete(socket);
					socket.removeAllListeners("data");
					socket.removeAllListeners("timeout");
					try {
						options.onUpgrade({ ...head, remoteAddress }, socket, rest);
					} catch (error) {
						options.onError?.(error);
						socket.destroy();
					}
					return;
				}
				const base = { ...head, remoteAddress, body: undefined, tooLarge: false, malformed: false };
				if (head.headers["transfer-encoding"] !== undefined) {
					dispatch({ ...base, malformed: true });
					return;
				}
				const declared = head.headers["content-length"];
				if (declared !== undefined && !/^\d{1,15}$/.test(declared)) {
					dispatch({ ...base, malformed: true });
					return;
				}
				bodyLength = declared === undefined ? 0 : Number(declared);
				if (bodyLength > maxBodyBytes) {
					dispatch({ ...base, tooLarge: true });
					return;
				}
			}
			if (buffer.length >= bodyLength) {
				const current = head;
				dispatch({
					...current,
					remoteAddress,
					body: Buffer.from(buffer.subarray(0, bodyLength)),
					tooLarge: false,
					malformed: false,
				});
			}
		};
		socket.on("data", onData);
	}) as Server & { closeAll(): void };

	if (options.maxConnections !== undefined) server.maxConnections = options.maxConnections;
	server.closeAll = () => {
		for (const socket of open) socket.destroy();
		open.clear();
	};
	return server;
}
