/**
 * phi remote: conformance and hardening requirements, one block per area.
 *
 *  A  network exposure (binds, unauthenticated surface, body caps, slowloris, frame caps, fuzz)
 *  B  auth (tokens, revocation, pairing codes, rate limit, logs, file modes, atomic writes)
 *  C  spawn containment (cwd checks, argv without a shell, env scrub, model validation, child cleanup)
 *  D  login service generation (escaping, absolute paths, idempotent install/uninstall)
 */

import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken, newDeviceToken } from "../src/remote/hub/devices.ts";
import { writePrivateFile } from "../src/remote/hub/files.ts";
import { parseHttpHead } from "../src/remote/hub/http.ts";
import { defaultBindAddresses, Hub, type HubOptions, requestTarget } from "../src/remote/hub/hub.ts";
import type { ModelCatalog } from "../src/remote/hub/models.ts";
import { attachNdjsonReader } from "../src/remote/hub/ndjson.ts";
import { CROCKFORD_ALPHABET, generatePairCode, PairCodes } from "../src/remote/hub/pairing.ts";
import {
	buildLaunchdPlist,
	buildSystemdUnit,
	installService,
	isTransientBootstrapError,
	LAUNCHD_BOOTSTRAP_BACKOFF_MS,
	LAUNCHD_BOOTSTRAP_RETRIES,
	LAUNCHD_GONE_POLL_MS,
	LAUNCHD_GONE_POLLS,
	ServiceCommandError,
	type ServiceSpec,
	uninstallService,
} from "../src/remote/hub/service.ts";
import { buildSpawnArgs, cleanChildEnv, HeadlessManager, validateSpawnCwd } from "../src/remote/hub/spawn.ts";
import { encodeFrame, OPCODE_CONTINUATION, OPCODE_TEXT } from "../src/remote/hub/ws.ts";
import { hubSocketPath } from "../src/remote/paths.ts";
import { AppClient, postJson, sleep } from "./remote-hub-helpers.ts";

// Wrap timingSafeEqual so the constant-time comparison can be observed.
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

let tmp: string;
let home: string;
let hub: Hub | undefined;
let logLines: string[];
const cleanups: (() => void)[] = [];

const catalog: ModelCatalog = {
	list: async () => ({ models: [], thinkingLevels: ["off"] }),
	has: async (provider, modelId) =>
		(provider === undefined || provider === "anthropic") && (modelId === undefined || modelId === "claude-test"),
};

beforeEach(() => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), "phi-remote-hard-")));
	home = join(tmp, "home");
	mkdirSync(join(home, "project"), { recursive: true });
	vi.stubEnv("PI_REMOTE_DIR", join(tmp, "remote"));
	logLines = [];
});

afterEach(async () => {
	for (const fn of cleanups.splice(0)) {
		try {
			fn();
		} catch {
			// best effort
		}
	}
	await hub?.stop();
	hub = undefined;
	rmSync(tmp, { recursive: true, force: true });
});

async function startHub(options: Partial<HubOptions> = {}): Promise<Hub> {
	hub = new Hub({
		port: 0,
		binds: ["127.0.0.1"],
		home,
		hostname: "test-host",
		version: "9.9.9",
		sessionsDir: join(tmp, "sessions"),
		helloTimeoutMs: 1000,
		requestTimeoutMs: 500,
		pushSender: async () => ({ ok: true, status: 200, drop: false }),
		pushEnabled: () => false,
		modelCatalog: catalog,
		log: (line) => logLines.push(line),
		...options,
	});
	await hub.start();
	return hub;
}

const base = () => `http://127.0.0.1:${hub!.port}`;

async function pairDevice(): Promise<{ deviceId: string; token: string; code: string }> {
	const info = await hub!.createPair();
	const res = await postJson(`${base()}/v1/pair`, { code: info.code, deviceName: "Test iPhone", platform: "ios" });
	expect(res.status).toBe(200);
	return { ...res.body, code: info.code };
}

async function connectApp(token?: string): Promise<AppClient> {
	const app = new AppClient(`ws://127.0.0.1:${hub!.port}/v1/ws`);
	cleanups.push(() => app.close());
	if (token) await app.hello(token);
	else await app.opened();
	return app;
}

async function hubAlive(): Promise<void> {
	const res = await fetch(`${base()}/v1/info`);
	expect(res.status).toBe(200);
}

/** A raw TCP client: write bytes, collect everything, notice when the server closes. */
class Raw {
	readonly socket: Socket;
	data = Buffer.alloc(0);
	closedAt: number | undefined;
	readonly openedAt = Date.now();
	private readonly closed: Promise<void>;

	constructor(port: number) {
		this.socket = connect(port, "127.0.0.1");
		this.socket.on("data", (chunk: Buffer) => {
			this.data = Buffer.concat([this.data, chunk]);
		});
		this.socket.on("error", () => {});
		this.closed = new Promise((resolve) =>
			this.socket.on("close", () => {
				this.closedAt = Date.now();
				resolve();
			}),
		);
		cleanups.push(() => this.socket.destroy());
	}

	write(data: string | Buffer): void {
		if (!this.socket.destroyed) this.socket.write(data);
	}

	/** Resolves true when the server closed the connection within `ms`. */
	async waitClosed(ms: number): Promise<boolean> {
		await Promise.race([this.closed, sleep(ms)]);
		return this.closedAt !== undefined;
	}

	text(): string {
		return this.data.toString("latin1");
	}
}

/** Open an upgraded WebSocket by hand (raw frames), optionally authenticated with `token`. */
async function rawWebSocket(token?: string): Promise<Raw> {
	const raw = new Raw(hub!.port);
	await new Promise<void>((resolve) => raw.socket.once("connect", () => resolve()));
	raw.write(
		"GET /v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
			`Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
	);
	await waitFor(() => raw.text().includes("\r\n\r\n"));
	expect(raw.text()).toContain("101 Switching Protocols");
	if (token) {
		raw.write(encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify({ t: "hello", token })), { mask: true }));
		await waitFor(() => raw.text().includes('"welcome"'));
	}
	return raw;
}

/** Close code of the first close frame the server sent on a raw socket, if any. */
function serverCloseCode(raw: Raw): number | undefined {
	const data = raw.data;
	const start = data.indexOf("\r\n\r\n") + 4;
	let offset = start;
	while (offset + 2 <= data.length) {
		const opcode = data[offset] & 0x0f;
		let len = data[offset + 1] & 0x7f;
		let header = 2;
		if (len === 126) {
			len = data.readUInt16BE(offset + 2);
			header = 4;
		} else if (len === 127) {
			len = Number(data.readBigUInt64BE(offset + 2));
			header = 10;
		}
		if (opcode === 0x8) return len >= 2 ? data.readUInt16BE(offset + header) : 1005;
		offset += header + len;
	}
	return undefined;
}

async function waitFor<T>(probe: () => T | undefined | false | null, timeoutMs = 3000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out");
		await sleep(10);
	}
}

function iface(address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo {
	return {
		address,
		family,
		internal,
		netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
		mac: "00:00:00:00:00:00",
		cidr: null,
		...(family === "IPv6" ? { scopeid: 0 } : {}),
	} as NetworkInterfaceInfo;
}

// =============================================================================================
// A. Network exposure
// =============================================================================================

describe("A. network exposure", () => {
	const ifaces = {
		lo0: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
		en0: [iface("192.0.2.20", "IPv4"), iface("fe80::1", "IPv6")],
		utun4: [iface("100.127.254.253", "IPv4"), iface("fd7a:115c:a1e0::1", "IPv6")],
		utun5: [iface("100.128.0.1", "IPv4"), iface("100.63.255.255", "IPv4")],
	};

	it("binds 127.0.0.1 plus local Tailscale IPv4s by default: no wildcard, no IPv6, no LAN", async () => {
		expect(defaultBindAddresses(ifaces)).toEqual(["127.0.0.1", "100.127.254.253"]);
		// A real hub with those interfaces listens on loopback (and on the Tailscale address only if
		// this machine happens to have it); nothing else is even attempted.
		await startHub({ binds: undefined, interfaces: () => ifaces });
		expect(hub!.binds).toContain("127.0.0.1");
		for (const bind of hub!.binds) expect(["127.0.0.1", "100.127.254.253"]).toContain(bind);
		const attempted = logLines.filter((line) => line.startsWith("cannot listen on"));
		expect(attempted.every((line) => line.startsWith("cannot listen on 100.127.254.253:"))).toBe(true);
		for (const line of logLines) expect(line).not.toMatch(/0\.0\.0\.0|::|192\.168|100\.128|100\.63/);
	});

	it("only listens on a wildcard or IPv6 when --bind says so", async () => {
		await startHub({ binds: ["127.0.0.1"] });
		expect(hub!.binds).toEqual(["127.0.0.1"]);
		expect(hub!.status().binds).not.toContain("0.0.0.0");
	});

	it("reveals only name/hubId/version/protocol without auth; every other path is 404", async () => {
		await startHub();
		const info = (await (await fetch(`${base()}/v1/info`)).json()) as Record<string, unknown>;
		expect(Object.keys(info).sort()).toEqual(["hubId", "hubVersion", "name", "protocol"]);
		expect(info).toEqual({ name: "test-host", hubId: hub!.hubId, hubVersion: "9.9.9", protocol: 1 });

		for (const path of [
			"/",
			"/v1",
			"/v1/",
			"/v1/info/",
			"/v1/info/x",
			"/v1/INFO",
			"/v1/devices",
			"/v1/sessions",
			"/v1/status",
			"/v1/ws/x",
			"/v2/info",
			"/../etc/passwd",
			"/favicon.ico",
			"/hub.json",
		]) {
			for (const method of ["GET", "POST", "PUT", "DELETE"]) {
				const res = await fetch(`${base()}${path}`, { method, body: method === "GET" ? undefined : "{}" });
				expect([path, method, res.status]).toEqual([path, method, 404]);
				expect(await res.json()).toEqual({ error: "not_found" });
			}
		}
		// Unpaired /v1/pair answers say nothing about the hub.
		const bad = await postJson(`${base()}/v1/pair`, { code: "ZZZZZZZZ" });
		expect(bad).toEqual({ status: 401, body: { error: "invalid_code" } });
	});

	it("survives request targets that `new URL()` rejects (a crash used to take the hub down)", async () => {
		await startHub();
		expect(requestTarget("//")).toBeUndefined();
		expect(requestTarget("http://[")).toBeUndefined();
		expect(requestTarget("/v1/ws?v=1")?.query.get("v")).toBe("1");
		for (const target of ["//", "//v1/info", "http://[", "*", "/v1/info?%zz", "/%", "//[::1"]) {
			const raw = new Raw(hub!.port);
			raw.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
			await raw.waitClosed(1000);
			// Upgrade requests go through a different handler.
			const up = new Raw(hub!.port);
			up.write(
				`GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
					"Sec-WebSocket-Key: " +
					Buffer.from("0123456789abcdef").toString("base64") +
					"\r\nSec-WebSocket-Version: 13\r\n\r\n",
			);
			await up.waitClosed(1000);
			expect(up.text()).not.toContain("101 Switching");
			await hubAlive();
		}
	});

	it("caps request bodies: /v1/pair over 16 KiB is refused, other routes never buffer a body", async () => {
		await startHub({ pairRateLimit: { limit: 100, windowMs: 60_000 } });
		const big = await postJson(`${base()}/v1/pair`, { code: "ABCDEFGH", pad: "x".repeat(20_000) });
		expect(big).toEqual({ status: 400, body: { error: "bad_request" } });
		// A declared 1 GB body is refused from the headers alone.
		const raw = new Raw(hub!.port);
		raw.write(
			"POST /v1/pair HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000000000\r\n\r\n{",
		);
		await waitFor(() => raw.text().includes("\r\n\r\n"));
		expect(raw.text()).toMatch(/^HTTP\/1\.1 400/);
		// Malformed bodies are 400 (clarification 5), including JSON without a string code.
		expect(await postJson(`${base()}/v1/pair`, { deviceName: "x" })).toEqual({
			status: 400,
			body: { error: "bad_request" },
		});
		const notJson = await fetch(`${base()}/v1/pair`, { method: "POST", body: "{nope" });
		expect([notJson.status, await notJson.json()]).toEqual([400, { error: "bad_request" }]);
		await hubAlive();
	});

	it("times out idle and slowloris HTTP connections, but not authenticated WebSockets", async () => {
		await startHub({ httpTimeouts: { idleMs: 300, headersMs: 600, requestMs: 800 } });
		const { token } = await pairDevice();

		const silent = new Raw(hub!.port);
		expect(await silent.waitClosed(2000)).toBe(true);
		expect(silent.closedAt! - silent.openedAt).toBeLessThan(1500);

		// Trickles a header byte every 100 ms: never idle, but the headers never finish.
		const slow = new Raw(hub!.port);
		const header = "GET /v1/info HTTP/1.1\r\nHost: x\r\nX-Pad: ";
		let i = 0;
		const trickle = setInterval(() => slow.write(i < header.length ? header[i++] : "a"), 100);
		cleanups.push(() => clearInterval(trickle));
		expect(await slow.waitClosed(3000)).toBe(true);
		clearInterval(trickle);
		expect(slow.closedAt! - slow.openedAt).toBeLessThan(2500);

		// A slow /v1/pair body is cut off by the request timeout too.
		const slowBody = new Raw(hub!.port);
		slowBody.write("POST /v1/pair HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{");
		const drip = setInterval(() => slowBody.write(" "), 100);
		cleanups.push(() => clearInterval(drip));
		expect(await slowBody.waitClosed(3000)).toBe(true);
		clearInterval(drip);

		// An authenticated WebSocket that is quiet for longer than the idle timeout stays open.
		const app = await connectApp(token);
		await sleep(700);
		await app.sync();
	});

	it("enforces the 12 MiB WebSocket message cap from the frame header, before buffering", async () => {
		await startHub();
		const { token } = await pairDevice();

		// Authenticated: a header announcing 12 MiB + 1 is refused at once (1009), with no payload sent.
		const big = await rawWebSocket(token);
		const header = Buffer.alloc(14);
		header[0] = 0x81;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(12 * 1024 * 1024 + 1), 2);
		big.write(header);
		expect(await big.waitClosed(3000)).toBe(true);
		expect(serverCloseCode(big)).toBe(1009);

		// Exactly at the cap is fine once authenticated (fragmented, as a phone would stream an image).
		const ok = await connectApp(token);
		const pad = "x".repeat(12 * 1024 * 1024 - 200);
		ok.send({ t: "ping", id: "big", pad });
		await ok.messages.next((m) => m.t === "pong" && m.re === "big", 10_000);

		// Fragments add up: two continuation fragments that pass the cap together are refused.
		const frag = await rawWebSocket(token);
		frag.write(encodeFrame(OPCODE_TEXT, Buffer.alloc(8 * 1024 * 1024, 0x20), { fin: false, mask: true }));
		const second = Buffer.alloc(14);
		second[0] = 0x80 | OPCODE_CONTINUATION;
		second[1] = 0x80 | 127;
		second.writeBigUInt64BE(BigInt(5 * 1024 * 1024), 2);
		frag.write(second);
		expect(await frag.waitClosed(3000)).toBe(true);
		expect(serverCloseCode(frag)).toBe(1009);

		// Before hello the cap is far lower: an unauthenticated socket cannot make the hub hold 12 MiB.
		const preBig = await rawWebSocket();
		const h = Buffer.alloc(14); // header + 64-bit length + mask key
		h[0] = 0x81;
		h[1] = 0x80 | 127;
		h.writeBigUInt64BE(BigInt(1024 * 1024), 2);
		preBig.write(h);
		expect(await preBig.waitClosed(3000)).toBe(true);
		expect(serverCloseCode(preBig)).toBe(1009);

		// Endless empty continuation frames are bounded too.
		const empties = await rawWebSocket(token);
		empties.write(encodeFrame(OPCODE_TEXT, Buffer.from("{"), { fin: false, mask: true }));
		const many: Buffer[] = [];
		for (let n = 0; n < 2000; n++)
			many.push(encodeFrame(OPCODE_CONTINUATION, Buffer.alloc(0), { fin: false, mask: true }));
		empties.write(Buffer.concat(many));
		expect(await empties.waitClosed(3000)).toBe(true);
		expect(serverCloseCode(empties)).toBe(1009);
		await hubAlive();
	});

	it("caps how many sockets may wait unauthenticated", async () => {
		await startHub({ maxPendingAuth: 4, helloTimeoutMs: 5000 });
		const waiting: AppClient[] = [];
		for (let n = 0; n < 4; n++) waiting.push(await connectApp());
		const extra = new AppClient(`ws://127.0.0.1:${hub!.port}/v1/ws`);
		cleanups.push(() => extra.close());
		await expect(extra.opened()).rejects.toThrow();
		// Authenticating one frees a slot.
		const { token } = await pairDevice();
		waiting[0].send({ t: "hello", token });
		await waiting[0].messages.next((m) => m.t === "welcome");
		const next = await connectApp();
		expect(next.ws.readyState).toBe(WebSocket.OPEN);
	});

	it("fuzz: random bytes on the WebSocket and the local socket never take the hub down", async () => {
		// Push enabled with no debounce: a working -> idle with junk item text reaches the push path.
		await startHub({ helloTimeoutMs: 200, pushEnabled: () => true, pushDebounceMs: 0 });
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const deadline = Date.now() + 3000;
		let rounds = 0;
		while (Date.now() < deadline) {
			rounds++;
			const kind = rounds % 4;
			const ws = await rawWebSocket(kind === 0 ? token : undefined);
			if (kind === 1) {
				ws.write(crypto.randomBytes(1 + crypto.randomInt(4096)));
			} else {
				// Well-formed masked frames with random opcodes, flags and payloads.
				for (let n = 0; n < 20; n++) {
					const payload = crypto.randomBytes(crypto.randomInt(300));
					const frame = encodeFrame(crypto.randomInt(16), payload, { fin: crypto.randomInt(2) === 1, mask: true });
					frame[0] |= crypto.randomInt(8) === 0 ? 0x70 : 0; // sometimes RSV bits
					ws.write(frame);
				}
				ws.write(
					encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify({ t: "session.prompt", id: 7, images: [{}] })), {
						mask: true,
					}),
				);
			}
			// The local socket too: garbage lines, broken JSON, valid-but-wrong frames.
			const local = connect(hubSocketPath());
			local.on("error", () => {});
			local.write(
				Buffer.concat([
					crypto.randomBytes(crypto.randomInt(2048)),
					Buffer.from('\n{"t":"register","v":1,"session":{"sessionId":"f","cwd":5,"lastText":7}}\n'),
					Buffer.from(
						'{"t":"event","sessionId":"f","event":{"type":"item.upsert","item":{"kind":"assistant","text":9}}}\n',
					),
					Buffer.from('{"t":"event","sessionId":"f","event":{"type":"state","state":{"status":"working"}}}\n'),
					Buffer.from('{"t":"event","sessionId":"f","event":{"type":"state","state":{"status":"idle"}}}\n'),
					crypto.randomBytes(512),
					Buffer.from("\n"),
				]),
			);
			await sleep(5);
			local.destroy();
			ws.socket.destroy();
		}
		expect(rounds).toBeGreaterThan(20);
		await hubAlive();
		await app.sync();
	});

	it("fuzz: the NDJSON reader takes random bytes in random chunks without throwing", async () => {
		const deadline = Date.now() + 1500;
		let values = 0;
		while (Date.now() < deadline) {
			const stream = new PassThrough();
			attachNdjsonReader(
				stream,
				() => values++,
				() => {},
				{ maxLineLength: 4096, onOverflow: () => {} },
			);
			for (let n = 0; n < 50; n++) {
				const chunk =
					crypto.randomInt(3) === 0
						? Buffer.from(`${JSON.stringify({ n, s: "\u2028" })}\n`)
						: crypto.randomBytes(crypto.randomInt(1, 2000));
				stream.write(chunk);
			}
			stream.end();
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(values).toBeGreaterThan(0);
	});

	it("NDJSON reader scans a long line once (no quadratic rescans)", async () => {
		const stream = new PassThrough();
		const got: unknown[] = [];
		attachNdjsonReader(stream, (value) => got.push(value));
		const line = JSON.stringify({ blob: "y".repeat(8 * 1024 * 1024) });
		// Count the characters the newline search covers instead of timing it: wall-clock
		// bounds flake on loaded CI runners. A plain wrapper, not vi.spyOn: a spy records every
		// call's `this`, which retains each flattened multi-MiB buffer and exhausts the heap.
		let scannedChars = 0;
		const realIndexOf = String.prototype.indexOf;
		String.prototype.indexOf = function (this: string, search: string, position?: number) {
			if (search === "\n") scannedChars += Math.max(0, this.length - Math.max(0, position ?? 0));
			return realIndexOf.call(this, search, position);
		};
		try {
			for (let offset = 0; offset < line.length; offset += 16 * 1024)
				stream.write(line.slice(offset, offset + 16 * 1024));
			stream.write("\n");
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			String.prototype.indexOf = realIndexOf;
		}
		expect(got).toHaveLength(1);
		// 512 chunks of an 8 MiB line: a rescan per chunk would cover ~2 GiB; one pass covers ~8 MiB.
		expect(scannedChars).toBeLessThan(2 * line.length);
	});
});

// =============================================================================================
// B. Auth
// =============================================================================================

describe("B. auth", () => {
	it("issues 32-byte base64url tokens and stores only their SHA-256", async () => {
		await startHub();
		const { token, deviceId } = await pairDevice();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(token, "base64url")).toHaveLength(32);
		const stored = readFileSync(join(tmp, "remote", "devices.json"), "utf8");
		expect(stored).not.toContain(token);
		expect(JSON.parse(stored)).toEqual([expect.objectContaining({ id: deviceId, tokenSha256: hashToken(token) })]);
		const tokens = new Set(Array.from({ length: 500 }, () => newDeviceToken()));
		expect(tokens.size).toBe(500);
	});

	it("compares token hashes in constant time and rejects anything else", async () => {
		await startHub();
		const { token } = await pairDevice();
		const spy = vi.mocked(crypto.timingSafeEqual);
		spy.mockClear();
		const app = await connectApp(token);
		await app.sync();
		expect(spy).toHaveBeenCalled();
		for (const bad of [token.slice(0, -1), `${token}A`, token.toUpperCase(), "", "x".repeat(600), 42]) {
			const other = await connectApp();
			other.send({ t: "hello", token: bad });
			expect((await other.closed).code).toBe(4401);
		}
	});

	it("revoking a device closes all of its sockets at once and the token stops working", async () => {
		await startHub();
		const { token, deviceId } = await pairDevice();
		const first = await connectApp(token);
		const second = await connectApp(token);
		const bystander = await connectApp((await pairDevice()).token);
		const started = Date.now();
		expect(hub!.revokeDevice(deviceId)).toBe(true);
		// Nothing is answered after the revocation, even before the closing handshake completes.
		first.send({ t: "ping", id: "after-revoke" });
		const [a, b] = await Promise.all([first.closed, second.closed]);
		expect(a.code).toBe(4401);
		expect(b.code).toBe(4401);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(first.messages.all.some((m) => m.re === "after-revoke")).toBe(false);
		const again = await connectApp();
		again.send({ t: "hello", token });
		expect((await again.closed).code).toBe(4401);
		await bystander.sync();
	});

	it("pairing codes: Crockford alphabet, single use, 10-minute TTL by default", async () => {
		expect(CROCKFORD_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
		for (let n = 0; n < 2000; n++) expect(generatePairCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
		const codes = new PairCodes();
		const now = Date.now();
		const { code, expiresAt } = codes.create(now);
		expect(expiresAt - now).toBe(10 * 60 * 1000);
		expect(codes.redeem(code, expiresAt - 1)).toBe(true);
		expect(codes.redeem(code, expiresAt - 1)).toBe(false);
		const late = codes.create(now);
		expect(codes.redeem(late.code, late.expiresAt)).toBe(false);

		await startHub({ pairCodeTtlMs: 1000, pairRateLimit: { limit: 100, windowMs: 60_000 } });
		const info = await hub!.createPair();
		const pretty = `${info.code.slice(0, 4).toLowerCase()}-${info.code.slice(4, 6)} ${info.code.slice(6)}`;
		expect((await postJson(`${base()}/v1/pair`, { code: pretty })).status).toBe(200);
		expect((await postJson(`${base()}/v1/pair`, { code: info.code })).status).toBe(401);
		const expiring = await hub!.createPair();
		await sleep(1100);
		expect((await postJson(`${base()}/v1/pair`, { code: expiring.code })).status).toBe(401);
	});

	it("rate limits /v1/pair to 5 attempts per minute per IP, counting every attempt", async () => {
		await startHub();
		const good = await hub!.createPair();
		const attempts = [
			await fetch(`${base()}/v1/pair`, { method: "POST", body: "{not json" }),
			await fetch(`${base()}/v1/pair`, { method: "POST", body: JSON.stringify({ deviceName: "no code" }) }),
			await fetch(`${base()}/v1/pair`, { method: "POST", body: JSON.stringify({ code: "ZZZZZZZZ" }) }),
			await fetch(`${base()}/v1/pair`, {
				method: "POST",
				body: JSON.stringify({ code: (await hub!.createPair()).code }),
			}),
			await fetch(`${base()}/v1/pair`, { method: "POST", body: JSON.stringify({ code: "YYYYYYYY" }) }),
		];
		expect(attempts.map((r) => r.status)).toEqual([400, 400, 401, 200, 401]);
		// The sixth attempt is refused even with a valid code, which stays unspent.
		const sixth = await postJson(`${base()}/v1/pair`, { code: good.code });
		expect(sixth).toEqual({ status: 429, body: { error: "rate_limited" } });
		expect(hub!.deviceInfos()).toHaveLength(1);
	});

	it("never writes pairing codes, tokens or token hashes to the log", async () => {
		await startHub();
		const { token, code, deviceId } = await pairDevice();
		await postJson(`${base()}/v1/pair`, { code: "ZZZZZZZZ" });
		await postJson(`${base()}/v1/pair`, { code });
		const app = await connectApp(token);
		const bad = await connectApp();
		bad.send({ t: "hello", token: `${token}x` });
		await bad.closed;
		app.close();
		await app.closed;
		hub!.revokeDevice(deviceId);
		const minted = await hub!.createPair();
		await hub!.stop();
		hub = undefined;
		const log = logLines.join("\n");
		expect(logLines.length).toBeGreaterThan(2);
		for (const secret of [token, code, minted.code, hashToken(token), token.slice(0, 16)]) {
			expect(log).not.toContain(secret);
		}
	});

	it("tightens the remote dir, state files, keys and logs even if they existed with loose modes", async () => {
		const previous = process.umask(0);
		cleanups.push(() => process.umask(previous));
		const dir = join(tmp, "remote");
		mkdirSync(join(dir, "apns"), { recursive: true, mode: 0o777 });
		chmodSync(dir, 0o777);
		chmodSync(join(dir, "apns"), 0o777);
		const files = ["devices.json", "hub.json", "hub-id", "apns.json", "hub.log", "headless.log", "apns/AuthKey_X.p8"];
		for (const name of files) {
			writeFileSync(
				join(dir, name),
				name === "devices.json" ? "[]" : name === "hub-id" ? "abcdef0123456789\n" : "{}",
				{
					mode: 0o666,
				},
			);
			chmodSync(join(dir, name), 0o666);
		}
		await startHub();
		const mode = (path: string) => statSync(path).mode & 0o777;
		expect(mode(dir)).toBe(0o700);
		expect(mode(join(dir, "apns"))).toBe(0o700);
		for (const name of files) expect([name, mode(join(dir, name))]).toEqual([name, 0o600]);
		expect(mode(hubSocketPath())).toBe(0o600);
		expect(mode(join(dir, "hub.lock"))).toBe(0o600);

		// New writes under umask 0 are private and atomic (temp file + rename; no leftovers).
		const before = statSync(join(dir, "devices.json")).ino;
		await pairDevice();
		expect(mode(join(dir, "devices.json"))).toBe(0o600);
		expect(statSync(join(dir, "devices.json")).ino).not.toBe(before);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		await hub!.stop();
		hub = undefined;
		expect(mode(join(dir, "headless.log"))).toBe(0o600);
	});

	it("writePrivateFile replaces a looser file atomically and cleans up after a failed rename", () => {
		const previous = process.umask(0);
		cleanups.push(() => process.umask(previous));
		const target = join(tmp, "state.json");
		writeFileSync(target, "old", { mode: 0o644 });
		writePrivateFile(target, "new");
		expect(readFileSync(target, "utf8")).toBe("new");
		expect(statSync(target).mode & 0o777).toBe(0o600);
		const blocked = join(tmp, "blocked");
		mkdirSync(join(blocked, "child"), { recursive: true });
		expect(() => writePrivateFile(blocked, "x")).toThrow();
		expect(readdirSync(tmp).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});

// =============================================================================================
// C. Spawn containment
// =============================================================================================

/** A stand-in for phi: records argv, cwd and environment to `probe.json` in its cwd. */
function writeProbeScript(): string {
	const path = join(tmp, "probe.mjs");
	writeFileSync(
		path,
		`import { writeFileSync } from "node:fs";
writeFileSync("probe.json", JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), env: process.env }));
`,
	);
	return path;
}

describe("C. spawn containment", () => {
	it("accepts only existing directories inside the allowed roots, after resolving symlinks", () => {
		const outside = join(tmp, "outside");
		const sibling = join(tmp, "home2"); // shares the "home" prefix
		mkdirSync(outside);
		mkdirSync(sibling);
		mkdirSync(join(home, "..dots"));
		mkdirSync(join(home, "project", "nested"), { recursive: true });
		writeFileSync(join(home, "file.txt"), "x");
		symlinkSync(outside, join(home, "escape"));
		symlinkSync(join(home, "project"), join(home, "alias"));
		symlinkSync(join(home, "missing-target"), join(home, "dangling"));
		const roots = [home];
		const code = (input: unknown) => {
			const result = validateSpawnCwd(input, roots, home);
			return "error" in result ? result.error.code : "ok";
		};
		expect(code(join(home, "project"))).toBe("ok");
		expect(code(join(home, "project", "nested", "..", ".."))).toBe("ok"); // = home itself
		expect(code(join(home, "..dots"))).toBe("ok");
		expect(code("~/project")).toBe("ok");
		expect(validateSpawnCwd(join(home, "alias"), roots, home)).toEqual({ cwd: join(home, "project") });
		expect(code(`${home}/project/../../outside`)).toBe("forbidden");
		expect(code(`${home}/../home2`)).toBe("forbidden");
		expect(code(sibling)).toBe("forbidden");
		expect(code(join(home, "escape"))).toBe("forbidden");
		expect(code(join(home, "escape", "."))).toBe("forbidden");
		expect(code("/")).toBe("forbidden");
		expect(code(join(home, "dangling"))).toBe("bad_request");
		expect(code(join(home, "nope"))).toBe("bad_request");
		expect(code(join(home, "file.txt"))).toBe("bad_request");
		expect(code("project")).toBe("bad_request");
		expect(code("./project")).toBe("bad_request");
		expect(code("~user/project")).toBe("bad_request");
		expect(code("")).toBe("bad_request");
		expect(code(42)).toBe("bad_request");
		expect(validateSpawnCwd(outside, [home, outside], home)).toEqual({ cwd: outside });
	});

	it("starts children without a shell, with exact argv, and a scrubbed environment", async () => {
		const probe = writeProbeScript();
		const weird = join(home, "dir with spaces; $(touch pwned) `touch pwned2` & | > x");
		mkdirSync(weird);
		const manager = new HeadlessManager({
			invocation: { command: process.execPath, args: [probe] },
			env: {
				PATH: process.env.PATH,
				HOME: home,
				PI_REMOTE_DIR: join(tmp, "remote"),
				PI_SESSION_ID: "parent",
				PI_SESSION_FILE: "/parent.jsonl",
				PI_SESSION_SOMETHING_NEW: "x",
				PI_SUBAGENT_ID: "child-run",
				PI_SUBAGENT_DEPTH: "1",
				PI_MODEL: "pinned",
				PHI_REMOTE: "0",
				PHI_REMOTE_SERVICE: "1",
				PHI_REMOTE_SPAWN_ID: "stale",
			},
		});
		const checked = validateSpawnCwd(weird, [home], home);
		expect(checked).toEqual({ cwd: weird });
		const child = manager.spawn({ cwd: weird, provider: "anthropic", modelId: "claude-test" });
		await child.exitPromise;
		const seen = JSON.parse(readFileSync(join(weird, "probe.json"), "utf8"));
		expect(seen.argv).toEqual([probe, "--mode", "rpc", "--model", "anthropic/claude-test"]);
		expect(seen.cwd).toBe(weird);
		expect(seen.env.PHI_REMOTE_SPAWN_ID).toBe(child.spawnId);
		expect(seen.env.PI_REMOTE_DIR).toBe(join(tmp, "remote"));
		for (const key of [
			"PI_SESSION_ID",
			"PI_SESSION_FILE",
			"PI_SESSION_SOMETHING_NEW",
			"PI_SUBAGENT_ID",
			"PI_SUBAGENT_DEPTH",
			"PI_MODEL",
			"PHI_REMOTE",
			"PHI_REMOTE_SERVICE",
		]) {
			expect([key, seen.env[key]]).toEqual([key, undefined]);
		}
		expect(existsSync(join(weird, "pwned"))).toBe(false);
		expect(existsSync(join(home, "pwned"))).toBe(false);
		expect(existsSync(join(weird, "pwned2"))).toBe(false);
		expect(buildSpawnArgs({ command: "phi", args: [] }, { modelId: "x" })).toEqual(["--mode", "rpc", "--model", "x"]);
		expect(cleanChildEnv({ PI_SESSION_ID: "a", KEEP: "b" }, "id")).toEqual({ KEEP: "b", PHI_REMOTE_SPAWN_ID: "id" });
	});

	it("validates provider/model against the registry before they become arguments (fail closed)", async () => {
		const probe = writeProbeScript();
		let registryDown = false;
		await startHub({
			invocation: { command: process.execPath, args: [probe] },
			spawnTimeoutMs: 2000,
			modelCatalog: {
				list: catalog.list,
				has: async (provider, modelId) => {
					if (registryDown) throw new Error("registry unavailable");
					return catalog.has(provider, modelId);
				},
			},
		});
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const cwd = join(home, "project");
		const spawnAck = async (id: string, extra: Record<string, unknown>) => {
			app.send({ t: "session.spawn", id, cwd, ...extra });
			return app.messages.next((m) => m.t === "ack" && m.re === id);
		};
		expect((await spawnAck("s1", { provider: "anthropic", modelId: "nope" })).error.code).toBe("not_found");
		expect((await spawnAck("s2", { modelId: "--help" })).error.code).toBe("bad_request");
		expect((await spawnAck("s3", { provider: "a b" })).error.code).toBe("bad_request");
		expect((await spawnAck("s4", { modelId: 7 })).error.code).toBe("bad_request");
		registryDown = true;
		expect((await spawnAck("s5", { provider: "anthropic", modelId: "claude-test" })).error.code).toBe("internal");
		// None of those ever started a process.
		expect(existsSync(join(cwd, "probe.json"))).toBe(false);
		expect(logLines.some((line) => line.startsWith("spawned headless"))).toBe(false);
		// cwd failures map to the contract codes.
		expect((await spawnAck("s6", { cwd: join(tmp, "outside-nowhere") })).error.code).toBe("bad_request");
		expect((await spawnAck("s7", { cwd: "/" })).error.code).toBe("forbidden");
	});

	const guardScript = (mode: string, childMode: "ignore-eof" | "exit-on-eof") => `
import { writeFileSync } from "node:fs";
const { Hub } = await import(${JSON.stringify(join(SRC, "remote/hub/hub.ts"))});
const { guardHubProcess } = await import(${JSON.stringify(join(SRC, "remote/cli.ts"))});
const child = ${JSON.stringify(join(tmp, `child-${childMode}.mjs`))};
const hub = new Hub({
	port: 0,
	binds: ["127.0.0.1"],
	home: ${JSON.stringify(home)},
	sessionsDir: ${JSON.stringify(join(tmp, "sessions"))},
	hostname: "guard",
	version: "0",
	log: () => {},
	pushSender: async () => ({ ok: true, drop: false }),
	pushEnabled: () => false,
	modelCatalog: { list: async () => ({ models: [], thinkingLevels: [] }), has: async () => true },
	invocation: { command: process.execPath, args: [child] },
});
await hub.start();
guardHubProcess(hub, () => process.exit(0), () => {});
const spawned = hub.headless.spawn({ cwd: ${JSON.stringify(home)} });
await new Promise((r) => setTimeout(r, 300));
writeFileSync(${JSON.stringify(join(tmp, "child.pid"))}, String(spawned.pid));
const mode = ${JSON.stringify(mode)};
if (mode === "uncaught") setTimeout(() => { throw new Error("boom"); }, 50);
if (mode === "rejection") setTimeout(() => { Promise.reject(new Error("boom")); }, 50);
if (mode === "exit") setTimeout(() => process.exit(3), 50);
setInterval(() => {}, 1000);
`;

	async function runGuarded(
		mode: "signal" | "uncaught" | "rejection" | "exit",
		childMode: "ignore-eof" | "exit-on-eof",
		signals: NodeJS.Signals[] = [],
	): Promise<{ childPid: number; childAlive: boolean }> {
		writeFileSync(
			join(tmp, "child-ignore-eof.mjs"),
			'process.stdin.resume(); process.stdin.on("end", () => {}); setInterval(() => {}, 1000);\n',
		);
		writeFileSync(
			join(tmp, "child-exit-on-eof.mjs"),
			'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); setInterval(() => {}, 1000);\n',
		);
		const script = join(tmp, `guard-${mode}-${childMode}.mjs`);
		writeFileSync(script, guardScript(mode, childMode));
		rmSync(join(tmp, "child.pid"), { force: true });
		// UNIX socket paths are capped at ~104 bytes on macOS. Keep the hub's
		// socket separate from the long descriptive fixture directory.
		const socketDir = mkdtempSync(join(tmpdir(), "phi-sock-"));
		cleanups.push(() => rmSync(socketDir, { recursive: true, force: true }));
		const hubProc = spawn(process.execPath, [script], {
			env: { ...process.env, PI_REMOTE_DIR: socketDir },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		hubProc.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		cleanups.push(() => hubProc.kill("SIGKILL"));
		const exited = new Promise<void>((resolve) => hubProc.on("exit", () => resolve()));
		const childPid = Number(
			await waitFor(
				() => existsSync(join(tmp, "child.pid")) && readFileSync(join(tmp, "child.pid"), "utf8"),
				10_000,
			).catch(() => {
				throw new Error(`hub script did not start: ${stderr}`);
			}),
		);
		cleanups.push(() => {
			try {
				process.kill(childPid, "SIGKILL");
			} catch {
				// gone
			}
		});
		for (const signal of signals) {
			hubProc.kill(signal);
			await sleep(20);
		}
		await Promise.race([exited, sleep(8000)]);
		const alive = () => {
			try {
				process.kill(childPid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const deadline = Date.now() + 5000;
		while (alive() && Date.now() < deadline) await sleep(50);
		return { childPid, childAlive: alive() };
	}

	it("kills headless children when the hub stops on SIGTERM / SIGINT / SIGHUP", async () => {
		expect((await runGuarded("signal", "ignore-eof", ["SIGTERM"])).childAlive).toBe(false);
		expect((await runGuarded("signal", "ignore-eof", ["SIGINT", "SIGINT"])).childAlive).toBe(false);
		expect((await runGuarded("signal", "ignore-eof", ["SIGHUP"])).childAlive).toBe(false);
	}, 60_000);

	it("kills headless children when the hub dies of an uncaught error, a rejection or process.exit", async () => {
		expect((await runGuarded("uncaught", "ignore-eof")).childAlive).toBe(false);
		expect((await runGuarded("rejection", "ignore-eof")).childAlive).toBe(false);
		expect((await runGuarded("exit", "ignore-eof")).childAlive).toBe(false);
	}, 60_000);

	it("a SIGKILLed hub still ends its children: their stdin closes (RPC mode exits on EOF)", async () => {
		expect((await runGuarded("signal", "exit-on-eof", ["SIGKILL"])).childAlive).toBe(false);
	}, 30_000);
});

// =============================================================================================
// D. Login service generation
// =============================================================================================

describe("D. launchd / systemd", () => {
	const nasty: ServiceSpec = {
		programArgs: [
			"/Users/A B/<&>\"'/bin/node",
			"/opt/phi & co/dist/cli.js",
			"remote",
			"serve",
			"--allow-root",
			"/tmp/100% $HOME \\x",
		],
		env: { PATH: "/usr/bin:/a b/$X/%p", PHI_REMOTE_SERVICE: "1", PI_REMOTE_DIR: "/r&d/<remote>" },
		logPath: "/Users/A B/.pi/agent/remote/hub 100%.log",
		workingDirectory: "/Users/A B",
	};

	it("writes a plist that round-trips every value (XML escaping)", () => {
		const plist = buildLaunchdPlist(nasty);
		expect(plist).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;|quot;)/);
		if (process.platform !== "darwin") return;
		const file = join(tmp, "test.plist");
		writeFileSync(file, plist);
		execFileSync("plutil", ["-lint", file]);
		const parsed = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
		expect(parsed.ProgramArguments).toEqual(nasty.programArgs);
		expect(parsed.EnvironmentVariables).toEqual(nasty.env);
		expect(parsed.StandardOutPath).toBe(nasty.logPath);
		expect(parsed.StandardErrorPath).toBe(nasty.logPath);
		expect(parsed.WorkingDirectory).toBe(nasty.workingDirectory);
		expect(parsed.KeepAlive).toEqual({ SuccessfulExit: false });
	});

	/** systemd's word splitting for ExecStart=/Environment=: quotes, C escapes, then specifiers. */
	function systemdWords(value: string, dollar: boolean): string[] {
		const words: string[] = [];
		let i = 0;
		while (i < value.length) {
			while (value[i] === " ") i++;
			if (i >= value.length) break;
			let word = "";
			const quoted = value[i] === '"';
			if (quoted) i++;
			while (i < value.length && (quoted ? value[i] !== '"' : value[i] !== " ")) {
				if (value[i] === "\\") {
					word += value[i + 1];
					i += 2;
				} else word += value[i++];
			}
			if (quoted) i++;
			word = word.replace(/%%/g, "%");
			words.push(dollar ? word.replace(/\$\$/g, "$") : word);
		}
		return words;
	}

	it("writes a unit whose ExecStart, Environment and paths parse back exactly", () => {
		const unit = buildSystemdUnit(nasty);
		const line = (key: string) =>
			unit
				.split("\n")
				.filter((l) => l.startsWith(`${key}=`))
				.map((l) => l.slice(key.length + 1));
		expect(systemdWords(line("ExecStart")[0], true)).toEqual(nasty.programArgs);
		expect(line("Environment").map((v) => systemdWords(v, false)[0])).toEqual(
			Object.entries(nasty.env).map(([k, v]) => `${k}=${v}`),
		);
		// WorkingDirectory= and StandardOutput=append: are not unquoted: no quotes, only %%.
		expect(line("WorkingDirectory")).toEqual(["/Users/A B"]);
		expect(line("StandardOutput")).toEqual(["append:/Users/A B/.pi/agent/remote/hub 100%%.log"]);
		expect(line("StandardError")).toEqual(["append:/Users/A B/.pi/agent/remote/hub 100%%.log"]);
		expect(unit).not.toContain("$$X"); // `$` is literal in Environment=
	});

	it("refuses relative program/log paths and control characters", () => {
		expect(() => buildLaunchdPlist({ ...nasty, programArgs: ["node", "cli.js"] })).toThrow(/absolute/);
		expect(() => buildSystemdUnit({ ...nasty, logPath: "hub.log" })).toThrow(/absolute/);
		expect(() => buildSystemdUnit({ ...nasty, env: { PATH: "/bin\nExecStartPre=/bin/evil" } })).toThrow(/control/);
		expect(() => buildLaunchdPlist({ ...nasty, workingDirectory: "/a\u0000b" })).toThrow(/control/);
	});

	it("install and uninstall are idempotent and only talk to the service manager through the runner", async () => {
		for (const platform of ["darwin", "linux"] as const) {
			const fakeHome = join(tmp, `svc-${platform}`);
			const calls: string[] = [];
			const run = (command: string, args: string[]) => {
				calls.push(`${command} ${args.join(" ")}`);
				if (args[0] === "bootout" || args[0] === "print" || args.includes("disable")) throw new Error("not loaded");
			};
			const deps = { run, home: fakeHome, uid: 501, sleep: async () => {} };
			const first = await installService(nasty, platform, deps);
			const content = readFileSync(first, "utf8");
			const second = await installService(nasty, platform, deps);
			expect(second).toBe(first);
			expect(readFileSync(second, "utf8")).toBe(content);
			expect(first.startsWith(fakeHome)).toBe(true);
			if (platform === "darwin") {
				expect(calls).toEqual([
					"launchctl bootout gui/501/org.example.phi-remote",
					"launchctl print gui/501/org.example.phi-remote",
					`launchctl bootstrap gui/501 ${first}`,
					"launchctl bootout gui/501/org.example.phi-remote",
					"launchctl print gui/501/org.example.phi-remote",
					`launchctl bootstrap gui/501 ${first}`,
				]);
			} else {
				expect(calls).toEqual([
					"systemctl --user daemon-reload",
					"systemctl --user enable phi-remote.service",
					"systemctl --user restart phi-remote.service",
					"systemctl --user daemon-reload",
					"systemctl --user enable phi-remote.service",
					"systemctl --user restart phi-remote.service",
				]);
			}
			expect(uninstallService(platform, deps)).toBe(first);
			expect(existsSync(first)).toBe(false);
			expect(uninstallService(platform, deps)).toBeUndefined();
		}
	});

	it("macOS: waits for launchd to let go of the old hub, then retries a transient bootstrap failure", async () => {
		const fakeHome = join(tmp, "svc-upgrade");
		const calls: string[] = [];
		const slept: number[] = [];
		let stillLoaded = 2; // `print` finds the old instance twice after bootout
		let bootstrapFailures = 1; // then the first bootstrap still hits EIO
		const run = (command: string, args: string[]) => {
			calls.push(`${command} ${args[0]}`);
			if (args[0] === "print") {
				if (stillLoaded-- > 0) return;
				throw new ServiceCommandError("launchctl print failed: Could not find service", 113);
			}
			if (args[0] === "bootstrap" && bootstrapFailures-- > 0) {
				throw new ServiceCommandError("launchctl bootstrap failed: Bootstrap failed: 5: Input/output error", 5);
			}
		};
		const deps = { run, home: fakeHome, uid: 501, sleep: async (ms: number) => void slept.push(ms) };
		const path = await installService(nasty, "darwin", deps);
		expect(existsSync(path)).toBe(true);
		expect(calls).toEqual([
			"launchctl bootout",
			"launchctl print",
			"launchctl print",
			"launchctl print",
			"launchctl bootstrap",
			"launchctl bootstrap",
		]);
		expect(slept).toEqual([LAUNCHD_GONE_POLL_MS, LAUNCHD_GONE_POLL_MS, LAUNCHD_BOOTSTRAP_BACKOFF_MS]);

		// Error 37 is transient too; anything else fails at once; retries are bounded.
		expect(
			isTransientBootstrapError(
				new Error("launchctl bootstrap failed: Bootstrap failed: 37: Operation already in progress"),
			),
		).toBe(true);
		const fatal = vi.fn((_command: string, args: string[]) => {
			if (args[0] === "print") throw new Error("not found");
			if (args[0] === "bootstrap") throw new ServiceCommandError("Bootstrap failed: 119: Service is disabled", 119);
		});
		await expect(installService(nasty, "darwin", { ...deps, run: fatal })).rejects.toThrow(/119/);
		expect(fatal.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(1);
		const stuck = vi.fn((_command: string, args: string[]) => {
			if (args[0] === "print") throw new Error("not found");
			if (args[0] === "bootstrap") throw new ServiceCommandError("Bootstrap failed: 5: Input/output error", 5);
		});
		await expect(installService(nasty, "darwin", { ...deps, run: stuck })).rejects.toThrow(/5: Input\/output/);
		expect(stuck.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(
			LAUNCHD_BOOTSTRAP_RETRIES + 1,
		);
		// launchd never letting go is bounded too: at most LAUNCHD_GONE_POLLS checks, then bootstrap.
		const lingering = vi.fn((_command: string, _args: string[]) => {});
		await installService(nasty, "darwin", { ...deps, run: lingering });
		expect(lingering.mock.calls.filter(([, args]) => args[0] === "print")).toHaveLength(LAUNCHD_GONE_POLLS);
	});
});

// =============================================================================================
// F. HTTP front door (node:net, so it behaves the same on Node and in the Bun-compiled binary)
// =============================================================================================

describe("F. HTTP front door", () => {
	it("parses request heads strictly", () => {
		expect(parseHttpHead("GET /v1/info HTTP/1.1\r\nHost: x\r\nX-A: 1\r\nx-a: 2")).toEqual({
			method: "GET",
			url: "/v1/info",
			headers: { host: "x", "x-a": "1, 2" },
		});
		expect(parseHttpHead("GET /v1/info HTTP/1.1")).toEqual({ method: "GET", url: "/v1/info", headers: {} });
		for (const bad of [
			"GET /v1/info",
			"GET  /v1/info HTTP/1.1",
			"GET /v1/info HTTP/2.0",
			"GET /v1/info HTTP/1.1\r\n folded: x",
			"GET /v1/info HTTP/1.1\r\nno-colon",
			"GET /v1/info HTTP/1.1\r\nBad Name: x",
			"GET /v1/info HTTP/1.1\r\nX: a\u0000b",
			"POST /v1/pair HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6",
		]) {
			expect([bad, parseHttpHead(bad)]).toEqual([bad, undefined]);
		}
	});

	async function rawRequest(text: string | Buffer): Promise<string> {
		const raw = new Raw(hub!.port);
		raw.write(text);
		await raw.waitClosed(3000);
		return raw.text();
	}

	it("answers malformed, oversized, chunked and smuggling-shaped requests without crashing", async () => {
		await startHub({ pairRateLimit: { limit: 100, windowMs: 60_000 } });
		expect(await rawRequest("BROKEN\r\n\r\n")).toMatch(/^HTTP\/1\.1 400 /);
		expect(await rawRequest(`GET /v1/info HTTP/1.1\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`)).toMatch(
			/^HTTP\/1\.1 431 /,
		);
		expect(await rawRequest(`GET /v1/info HTTP/1.1\r\nX-Big: ${"a".repeat(20_000)}`)).toMatch(/^HTTP\/1\.1 431 /);
		const chunked = await rawRequest(
			'POST /v1/pair HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n1a\r\n{"code":"AAAAAAAA"}\r\n0\r\n\r\n',
		);
		expect(chunked).toMatch(/^HTTP\/1\.1 400 /);
		expect(chunked).toContain('{"error":"bad_request"}');
		expect(await rawRequest("POST /v1/pair HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}")).toMatch(
			/^HTTP\/1\.1 400 /,
		);
		expect(await rawRequest("POST /v1/pair HTTP/1.1\r\nContent-Length: -1\r\n\r\n")).toMatch(/^HTTP\/1\.1 400 /);
		// HEAD gets headers only; every response closes the connection.
		const head = await rawRequest("HEAD /v1/info HTTP/1.1\r\nHost: x\r\n\r\n");
		expect(head).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
		expect(head).toContain("Connection: close");
		expect(head.endsWith("\r\n\r\n")).toBe(true);
		// A second, pipelined request on the same connection is never answered.
		const piped = await rawRequest("GET /v1/info HTTP/1.1\r\n\r\nGET /v1/nope HTTP/1.1\r\n\r\n");
		expect(piped.match(/HTTP\/1\.1 /g)).toHaveLength(1);
		// The body arrives in pieces: still one request.
		const raw = new Raw(hub!.port);
		const info = await hub!.createPair();
		const body = JSON.stringify({ code: info.code, deviceName: "split" });
		raw.write(`POST /v1/pair HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 5)}`);
		await sleep(50);
		raw.write(body.slice(5));
		await raw.waitClosed(3000);
		expect(raw.text()).toMatch(/^HTTP\/1\.1 200 /);
		await hubAlive();
	});

	const bunAvailable = (() => {
		try {
			execFileSync("bun", ["--version"], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	})();

	// The compiled phi binary runs on Bun. Bun's node:http hands `upgrade` a socket that never
	// delivers writes, which is why the hub has its own HTTP layer; this keeps it that way.
	it.skipIf(!bunAvailable)(
		"pairs and opens a WebSocket against a hub running under Bun",
		async () => {
			const script = join(tmp, "bun-hub.ts");
			writeFileSync(
				script,
				`const { Hub } = await import(${JSON.stringify(join(SRC, "remote/hub/hub.ts"))});
const hub = new Hub({
	port: 0,
	binds: ["127.0.0.1"],
	home: ${JSON.stringify(home)},
	sessionsDir: ${JSON.stringify(join(tmp, "sessions"))},
	hostname: "bun-host",
	version: "0",
	log: () => {},
	pushSender: async () => ({ ok: true, drop: false }),
	pushEnabled: () => false,
	modelCatalog: { list: async () => ({ models: [], thinkingLevels: [] }), has: async () => true },
});
await hub.start();
const pair = await hub.createPair();
console.log(JSON.stringify({ port: hub.port, code: pair.code }));
setInterval(() => {}, 1000);
`,
			);
			const proc = spawn("bun", [script], {
				env: { ...process.env, PI_REMOTE_DIR: join(tmp, "remote-bun") },
				stdio: ["ignore", "pipe", "pipe"],
			});
			cleanups.push(() => proc.kill("SIGKILL"));
			let out = "";
			let errOut = "";
			proc.stdout.on("data", (chunk) => {
				out += chunk;
			});
			proc.stderr.on("data", (chunk) => {
				errOut += chunk;
			});
			const line = await waitFor(() => out.split("\n").find((l) => l.startsWith("{")), 20_000).catch(() => {
				throw new Error(`bun hub did not start: ${errOut}`);
			});
			const { port, code } = JSON.parse(line) as { port: number; code: string };
			const paired = await postJson(`http://127.0.0.1:${port}/v1/pair`, { code, deviceName: "bun" });
			expect(paired.status).toBe(200);
			const app = new AppClient(`ws://127.0.0.1:${port}/v1/ws`);
			cleanups.push(() => app.close());
			const welcome = await app.hello(paired.body.token);
			expect(welcome.host.name).toBe("bun-host");
			app.send({ t: "ping", id: "b1" });
			await app.messages.next((m) => m.t === "pong" && m.re === "b1");
		},
		30_000,
	);
});
