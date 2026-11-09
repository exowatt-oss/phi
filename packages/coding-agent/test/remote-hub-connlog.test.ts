/**
 * phi remote hub: app-connection lines in hub.log (connect, hello ok / failed, missed pongs,
 * close with who closed it), their per-address throttle, `status.appConnections`, and the hub.log
 * size cap. No line may carry a device token.
 */

import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAppConnection } from "../src/remote/cli.ts";
import { ConnLog, formatAddr, formatDuration } from "../src/remote/hub/conn-log.ts";
import { capLogFile } from "../src/remote/hub/files.ts";
import { Hub, type HubOptions } from "../src/remote/hub/hub.ts";
import type { ModelCatalog } from "../src/remote/hub/models.ts";
import { encodeFrame, OPCODE_TEXT } from "../src/remote/hub/ws.ts";
import { AppClient, postJson, sleep } from "./remote-hub-helpers.ts";

const catalog: ModelCatalog = {
	list: async () => ({ models: [], thinkingLevels: ["off"] }),
	has: async () => true,
};

let tmp: string;
let hub: Hub | undefined;
let lines: string[];
const cleanups: (() => void)[] = [];

beforeEach(() => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), "phi-remote-connlog-")));
	mkdirSync(join(tmp, "home"), { recursive: true });
	vi.stubEnv("PI_REMOTE_DIR", join(tmp, "remote"));
	vi.stubEnv("PHI_CODING_AGENT_DIR", join(tmp, "agent"));
	lines = [];
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
	vi.unstubAllEnvs();
	rmSync(tmp, { recursive: true, force: true });
});

async function startHub(options: Partial<HubOptions> = {}): Promise<Hub> {
	hub = new Hub({
		port: 0,
		binds: ["127.0.0.1"],
		home: join(tmp, "home"),
		hostname: "test-host",
		version: "9.9.9",
		sessionsDir: join(tmp, "sessions"),
		helloTimeoutMs: 1000,
		pushSender: async () => ({ ok: true, status: 200, drop: false }),
		pushEnabled: () => false,
		modelCatalog: catalog,
		log: (line) => lines.push(line),
		...options,
	});
	await hub.start();
	return hub;
}

async function pairDevice(): Promise<{ deviceId: string; token: string }> {
	const info = await hub!.createPair();
	const res = await postJson(`http://127.0.0.1:${hub!.port}/v1/pair`, {
		code: info.code,
		deviceName: "Test iPhone",
		platform: "ios",
	});
	expect(res.status).toBe(200);
	return res.body;
}

function app(): AppClient {
	const client = new AppClient(`ws://127.0.0.1:${hub!.port}/v1/ws`);
	cleanups.push(() => client.close());
	return client;
}

/** A WebSocket client that never answers pings (Node's built-in client always does). */
async function rawClient(
	port: number,
): Promise<{ socket: Socket; sendText(text: string): void; closed: Promise<void> }> {
	const socket = connect(port, "127.0.0.1");
	cleanups.push(() => socket.destroy());
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	socket.on("error", () => {});
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	const key = Buffer.from("0123456789abcdef").toString("base64");
	socket.write(
		`GET /v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
	);
	await new Promise<void>((resolve) => {
		let acc = "";
		const onData = (chunk: Buffer) => {
			acc += chunk.toString("latin1");
			if (acc.includes("\r\n\r\n")) {
				socket.off("data", onData);
				resolve();
			}
		};
		socket.on("data", onData);
	});
	socket.resume();
	return {
		socket,
		sendText: (text) => socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(text), { mask: true })),
		closed,
	};
}

async function waitForLine(pattern: RegExp, timeoutMs = 3000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const hit = lines.find((line) => pattern.test(line));
		if (hit) return hit;
		await sleep(10);
	}
	throw new Error(`no log line matching ${pattern}; got:\n${lines.join("\n")}`);
}

const appLines = () => lines.filter((line) => line.startsWith("app "));

describe("phi remote hub: app connection log", () => {
	it("logs connect, hello ok and a client close, with addresses and timings and no token", async () => {
		await startHub();
		const { deviceId, token } = await pairDevice();
		const client = app();
		await client.opened();
		client.send({
			t: "hello",
			token,
			protocol: 1,
			app: { version: "1.7.0", build: "88" },
			device: { name: "tester's iPhone" },
		});
		await client.messages.next((m) => m.t === "welcome");

		const connected = await waitForLine(/^app #\d+ connected/);
		expect(connected).toMatch(/^app #1 connected from 127\.0\.0\.1:\d+ on 127\.0\.0\.1:\d+$/);
		expect(connected).toContain(`on 127.0.0.1:${hub!.port}`);

		const hello = await waitForLine(/hello ok/);
		expect(hello).toMatch(
			new RegExp(
				`^app #1 hello ok: ${deviceId} "tester's iPhone", app 1\\.7\\.0 \\(88\\), protocol 1, welcome in \\d+ms$`,
			),
		);

		client.ws.close(1000, "bye");
		const closed = await waitForLine(/closed by/);
		expect(closed).toMatch(
			new RegExp(`^app #1 closed by client: ${deviceId} "tester's iPhone", code 1000 "bye", after `),
		);

		for (const line of lines) expect(line).not.toContain(token);
		expect(appLines()).toHaveLength(3);
	});

	it("logs a bad token as one hello-failed line with the close code, never the token", async () => {
		await startHub();
		await pairDevice();
		const bogus = "A".repeat(43);
		const client = app();
		await client.opened();
		client.send({ t: "hello", token: bogus, app: { version: "1", build: "1" } });
		expect((await client.closed).code).toBe(4401);

		const failed = await waitForLine(/hello failed/);
		expect(failed).toMatch(
			/^app #1 hello failed from 127\.0\.0\.1:\d+: unknown device token, close 4401, after \d+ms$/,
		);
		await sleep(50);
		// The close line would only repeat the failure.
		expect(appLines().filter((line) => line.includes("closed by"))).toHaveLength(0);
		for (const line of lines) expect(line).not.toContain(bogus);
	});

	it("logs a hello timeout and a protocol mismatch", async () => {
		await startHub({ helloTimeoutMs: 100, connLogWindowMs: 0 });
		const silent = app();
		await silent.opened();
		expect((await silent.closed).code).toBe(4401);
		expect(await waitForLine(/hello failed/)).toContain("no hello in 100ms, close 4401");

		const old = app();
		await old.opened();
		old.send({ t: "hello", token: "x", protocol: 2 });
		expect((await old.closed).code).toBe(4426);
		expect(await waitForLine(/protocol mismatch/)).toMatch(/protocol mismatch \(hello 2, url \?\), close 4426/);
	});

	it("logs a server-side close (revoke) by device, even though the device is gone", async () => {
		await startHub();
		const { deviceId, token } = await pairDevice();
		const client = app();
		await client.hello(token);
		hub!.revokeDevice(deviceId);
		await client.closed;
		expect(await waitForLine(/closed by/)).toMatch(
			new RegExp(`^app #1 closed by server: ${deviceId} "Test iPhone", code 4401 "device revoked", after `),
		);
	});

	it("logs missed pongs and the ping-timeout drop", async () => {
		await startHub({ pingIntervalMs: 40, connLogWindowMs: 0 });
		const { deviceId, token } = await pairDevice();
		const raw = await rawClient(hub!.port);
		raw.sendText(JSON.stringify({ t: "hello", token, app: { version: "2", build: "3" } }));
		await waitForLine(/hello ok/);
		await raw.closed;
		expect(await waitForLine(/missed pong 1\/3/)).toMatch(
			new RegExp(
				`^app #1 missed pong 1/3 \\(${deviceId} "Test iPhone"\\) from 127\\.0\\.0\\.1:\\d+, last pong never$`,
			),
		);
		await waitForLine(/missed pong 2\/3/);
		expect(await waitForLine(/closed by/)).toMatch(
			new RegExp(`^app #1 closed by ping-timeout: ${deviceId} "Test iPhone", code 1001 "ping timeout", after `),
		);
		for (const line of lines) expect(line).not.toContain(token);
	});

	it("throttles a reconnect storm from one address to one line per kind per window", async () => {
		await startHub({ connLogWindowMs: 400, maxPendingAuth: 100 });
		await pairDevice();
		const attempt = async () => {
			const client = app();
			await client.opened();
			client.send({ t: "hello", token: "nope" });
			await client.closed;
		};
		for (let i = 0; i < 10; i++) await attempt();
		// Failures: one line per window; connects: a burst of 4 (an app may race two URLs).
		expect(appLines().filter((line) => line.includes("connected from"))).toHaveLength(4);
		expect(appLines().filter((line) => line.includes("hello failed"))).toHaveLength(1);

		await sleep(450);
		await attempt();
		const failed = appLines().filter((line) => line.includes("hello failed"));
		expect(failed).toHaveLength(2);
		expect(failed[1]).toMatch(/\(\+9 suppressed\)$/);
		expect(appLines().filter((line) => line.includes("connected from"))[4]).toMatch(/\(\+6 suppressed\)$/);
	});

	it("reports authenticated app connections in status", async () => {
		await startHub({ pingIntervalMs: 50 });
		const { deviceId, token } = await pairDevice();
		const client = app();
		await client.hello(token);
		const unauth = app();
		await unauth.opened();
		await sleep(150);
		const status = hub!.status();
		expect(status.apps).toBe(1);
		expect(status.appConnections).toHaveLength(1);
		const info = status.appConnections![0];
		expect(info).toMatchObject({ conn: 1, deviceId, name: "Test iPhone" });
		expect(info.remote).toMatch(/^127\.0\.0\.1:\d+$/);
		expect(info.local).toBe(`127.0.0.1:${hub!.port}`);
		expect(info.lastPongAt).toBeGreaterThan(info.connectedAt - 1);
		const text = formatAppConnection(info, info.connectedAt + 65_000);
		expect(text).toContain("Test iPhone");
		expect(text).toContain(info.remote);
		expect(text).toContain("connected 1m05s");
		expect(text).toContain("last pong");
	});
});

describe("ConnLog", () => {
	it("folds repeats per kind and address and reports the count on the next line", () => {
		let now = 0;
		const out: string[] = [];
		const log = new ConnLog((line) => out.push(line), { windowMs: 1000, now: () => now });
		expect(log.line("fail", "1.1.1.1", "a")).toBe(true);
		expect(log.line("fail", "1.1.1.1", "a")).toBe(false);
		expect(log.line("fail", "1.1.1.1", "a")).toBe(false);
		expect(log.line("fail", "2.2.2.2", "b")).toBe(true);
		expect(log.line("connect", "1.1.1.1", "c")).toBe(true);
		now = 999;
		expect(log.line("fail", "1.1.1.1", "a")).toBe(false);
		now = 1000;
		expect(log.line("fail", "1.1.1.1", "a")).toBe(true);
		expect(out).toEqual(["a", "b", "c", "a (+3 suppressed)"]);
	});

	it("lets a small burst of connects, hellos and closes through", () => {
		const out: string[] = [];
		const log = new ConnLog((line) => out.push(line), { windowMs: 1000, now: () => 0 });
		for (let i = 0; i < 6; i++) log.line("hello", "1.1.1.1", `h${i}`);
		expect(out).toEqual(["h0", "h1", "h2", "h3"]);
	});

	it("stays bounded under a scan from many addresses", () => {
		const log = new ConnLog(() => {}, { windowMs: 60_000, now: () => 0 });
		for (let i = 0; i < 5000; i++) log.line("fail", `10.0.${i >> 8}.${i & 255}`, "x");
		expect((log as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(1024);
	});

	it("formats addresses and durations", () => {
		expect(formatAddr("::ffff:100.64.0.5", 5123)).toBe("100.64.0.5:5123");
		expect(formatAddr("fd7a:115c::1", 7717)).toBe("[fd7a:115c::1]:7717");
		expect(formatDuration(42)).toBe("42ms");
		expect(formatDuration(12_345)).toBe("12.3s");
		expect(formatDuration(245_000)).toBe("4m05s");
		expect(formatDuration(7_380_000)).toBe("2h03m");
	});
});

describe("capLogFile (hub.log is the hub's stderr)", () => {
	it("copies to .1 and truncates once past the cap, only when the fd is that file", () => {
		const path = join(tmp, "hub.log");
		writeFileSync(path, "x".repeat(2000), { mode: 0o600 });
		const fd = openSync(path, "a");
		const other = openSync(join(tmp, "other.log"), "a");
		try {
			expect(capLogFile(path, 1000, other)).toBe(false);
			expect(capLogFile(path, 5000, fd)).toBe(false);
			expect(capLogFile(path, 1000, fd)).toBe(true);
			expect(readFileSync(`${path}.1`, "utf8")).toHaveLength(2000);
			expect(readFileSync(path, "utf8")).toBe("");
			writeFileSync(fd, "after\n");
			expect(readFileSync(path, "utf8")).toBe("after\n");
		} finally {
			closeSync(fd);
			closeSync(other);
		}
	});
});
