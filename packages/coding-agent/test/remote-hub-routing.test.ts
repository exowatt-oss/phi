import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushAlert, PushResult } from "../src/remote/hub/apns.ts";
import { ControlClient } from "../src/remote/hub/control.ts";
import type { PushRegistration } from "../src/remote/hub/devices.ts";
import { Hub, HubAlreadyRunningError, type HubOptions } from "../src/remote/hub/hub.ts";
import type { ModelCatalog } from "../src/remote/hub/models.ts";
import { hubSocketPath } from "../src/remote/paths.ts";
import type { PairInfo } from "../src/remote/protocol.ts";
import { AppClient, FakeSession, postJson, sleep, summary } from "./remote-hub-helpers.ts";

interface PushCall {
	registration: PushRegistration;
	alert: PushAlert;
	payload: Record<string, unknown>;
}

let tmp: string;
let home: string;
let hub: Hub | undefined;
let pushes: PushCall[];
let pushResult: PushResult;
const cleanups: (() => void)[] = [];

const catalog: ModelCatalog = {
	list: async () => ({
		models: [{ provider: "anthropic", id: "claude-test", name: "Claude Test", reasoning: true }],
		current: { provider: "anthropic", id: "claude-test" },
		thinkingLevel: "high",
		thinkingLevels: ["off", "low", "medium", "high"],
	}),
	has: async (_provider, modelId) => modelId === undefined || modelId === "claude-test",
};

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phi-remote-hub-"));
	home = join(tmp, "home");
	mkdirSync(join(home, "project"), { recursive: true });
	vi.stubEnv("PI_REMOTE_DIR", join(tmp, "remote"));
	pushes = [];
	pushResult = { ok: true, status: 200, drop: false };
});

afterEach(async () => {
	for (const fn of cleanups.splice(0)) fn();
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
		helloTimeoutMs: 300,
		requestTimeoutMs: 400,
		upsertThrottleMs: 100,
		pushDebounceMs: 30,
		pushSender: async (registration, alert, payload) => {
			pushes.push({ registration, alert, payload });
			return pushResult;
		},
		pushEnabled: () => true,
		modelCatalog: catalog,
		log: () => {},
		...options,
	});
	await hub.start();
	return hub;
}

const base = () => `http://127.0.0.1:${hub!.port}`;

async function pairDevice(name = "Test iPhone"): Promise<{ deviceId: string; token: string }> {
	const info = await hub!.createPair();
	const res = await postJson(`${base()}/v1/pair`, { code: info.code, deviceName: name, platform: "ios" });
	expect(res.status).toBe(200);
	return res.body;
}

async function connectApp(token?: string): Promise<AppClient> {
	const app = new AppClient(`ws://127.0.0.1:${hub!.port}/v1/ws`);
	cleanups.push(() => app.close());
	if (token) await app.hello(token);
	else await app.opened();
	return app;
}

async function connectSession(): Promise<FakeSession> {
	const session = await FakeSession.connect(hubSocketPath());
	cleanups.push(() => session.close());
	return session;
}

describe("HTTP + pairing", () => {
	it("serves /v1/info", async () => {
		await startHub();
		const res = await fetch(`${base()}/v1/info`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: "test-host", hubId: hub!.hubId, hubVersion: "9.9.9", protocol: 1 });
		expect((await fetch(`${base()}/nope`)).status).toBe(404);
	});

	it("pairs with a good code once and rejects bad, reused and malformed requests", async () => {
		await startHub();
		const info = await hub!.createPair();
		expect(info.link).toContain(`code=${info.code}`);
		expect(info.link).toContain(`hubId=${hub!.hubId}`);
		expect(info.urls).toEqual([`http://127.0.0.1:${hub!.port}`]); // explicit loopback-only bind
		expect((await postJson(`${base()}/v1/pair`, { code: "ZZZZZZZZ" })).body).toEqual({ error: "invalid_code" });
		const ok = await postJson(`${base()}/v1/pair`, {
			code: `${info.code.slice(0, 4).toLowerCase()}-${info.code.slice(4)}`,
			deviceName: "Phone",
			platform: "ios",
		});
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ hubId: hub!.hubId, name: "test-host" });
		expect(ok.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const reused = await postJson(`${base()}/v1/pair`, { code: info.code });
		expect(reused).toEqual({ status: 401, body: { error: "invalid_code" } });
		const malformed = await fetch(`${base()}/v1/pair`, { method: "POST", body: "{nope" });
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toEqual({ error: "bad_request" });
	});

	it("rejects expired codes", async () => {
		await startHub({ pairCodeTtlMs: 50 });
		const info = await hub!.createPair();
		await sleep(80);
		expect(await postJson(`${base()}/v1/pair`, { code: info.code })).toEqual({
			status: 401,
			body: { error: "invalid_code" },
		});
	});

	it("rate-limits pairing attempts per IP (every attempt counts)", async () => {
		await startHub();
		const info = await hub!.createPair();
		for (let i = 0; i < 5; i++) expect((await postJson(`${base()}/v1/pair`, { code: "ZZZZZZZZ" })).status).toBe(401);
		const limited = await postJson(`${base()}/v1/pair`, { code: info.code });
		expect(limited).toEqual({ status: 429, body: { error: "rate_limited" } });
	});
});

describe("hello auth", () => {
	it("closes 4401 on a bad token", async () => {
		await startHub();
		const app = await connectApp();
		app.send({ t: "hello", token: "not-a-token", app: { version: "1", build: "1" } });
		expect((await app.closed).code).toBe(4401);
	});

	it("closes 4401 when no hello arrives in time, or the first frame is not hello", async () => {
		await startHub();
		const silent = await connectApp();
		expect((await silent.closed).code).toBe(4401);
		const eager = await connectApp();
		eager.send({ t: "sessions.list", id: "1" });
		expect((await eager.closed).code).toBe(4401);
	});

	it("closes 4426 on a protocol mismatch", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp();
		app.send({ t: "hello", token, protocol: 2 });
		expect((await app.closed).code).toBe(4426);
	});

	it("welcomes a paired device and closes its sockets when revoked", async () => {
		await startHub();
		const { token, deviceId } = await pairDevice();
		const app = new AppClient(`ws://127.0.0.1:${hub!.port}/v1/ws`);
		cleanups.push(() => app.close());
		const welcome = await app.hello(token);
		expect(welcome).toEqual({
			t: "welcome",
			host: {
				name: "test-host",
				hubId: hub!.hubId,
				hubVersion: "9.9.9",
				protocol: 1,
				features: ["history", "overseer"],
			},
			deviceId,
		});
		const ctl = await ControlClient.connect();
		cleanups.push(() => ctl.close());
		const listed = await ctl.request<{ devices: { id: string; connected: boolean }[] }>({ op: "devices.list" });
		expect(listed.devices).toEqual([expect.objectContaining({ id: deviceId, connected: true })]);
		await ctl.request({ op: "devices.revoke", deviceId });
		expect((await app.closed).code).toBe(4401);
		const again = await connectApp();
		again.send({ t: "hello", token });
		expect((await again.closed).code).toBe(4401);
	});
});

describe("routing to sessions", () => {
	it("lists sessions and fans out upserts and removes", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const session = await connectSession();
		await session.register(summary("s1"));
		expect((await app.messages.next((m) => m.t === "session.upsert")).session.sessionId).toBe("s1");
		app.send({ t: "sessions.list", id: "l1" });
		const list = await app.messages.next((m) => m.t === "sessions");
		expect(list).toEqual({ t: "sessions", re: "l1", sessions: [expect.objectContaining({ sessionId: "s1" })] });
		session.close();
		expect(await app.messages.next((m) => m.t === "session.remove")).toEqual({
			t: "session.remove",
			sessionId: "s1",
		});
	});

	it("subscribe: snapshot first, events only to subscribers, none that the snapshot already covers", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const other = await connectApp(token);
		const session = await connectSession();
		await session.register(summary("s1", { status: "working" }));

		app.send({ t: "session.subscribe", id: "sub1", sessionId: "s1" });
		const req = await session.nextReq("snapshot");
		expect(req.args).toEqual({ limit: 120 });
		const item = (id: string, text: string) => ({ id, ts: 1, kind: "assistant", text });
		// One write: an event already in the snapshot, the reply, then a newer event.
		session.send(
			{ t: "event", sessionId: "s1", event: { type: "item.upsert", item: item("a1", "old") } },
			{
				t: "reply",
				re: req.id,
				ok: true,
				data: { items: [item("a1", "old")], hasMore: true, state: { status: "working" } },
			},
			{ t: "event", sessionId: "s1", event: { type: "item.upsert", item: item("a2", "new") } },
		);
		const snapshot = await app.messages.next((m) => m.t === "session.snapshot");
		expect(snapshot).toEqual({
			t: "session.snapshot",
			re: "sub1",
			sessionId: "s1",
			items: [item("a1", "old")],
			hasMore: true,
			state: { status: "working" },
		});
		const event = await app.messages.next((m) => m.t === "session.event");
		expect(event.event.item.id).toBe("a2");
		await app.sync();
		expect(app.messages.pending((m) => m.t === "session.event")).toEqual([]);
		await other.sync();
		expect(other.messages.all.filter((m) => m.t === "session.event")).toEqual([]);

		app.send({ t: "session.unsubscribe", sessionId: "s1" });
		await app.sync();
		session.send({ t: "event", sessionId: "s1", event: { type: "item.upsert", item: item("a3", "x") } });
		await sleep(50);
		await app.sync();
		expect(app.messages.all.filter((m) => m.t === "session.event").length).toBe(1);
	});

	it("history clamps the limit and passes errors through", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const session = await connectSession();
		await session.register(summary("s1"));
		app.send({ t: "session.history", id: "h1", sessionId: "s1", before: "a9", limit: 5000 });
		const req = await session.nextReq("history");
		expect(req.args).toEqual({ before: "a9", limit: 500 });
		session.send({ t: "reply", re: req.id, ok: false, error: { code: "not_found", message: "no such item" } });
		expect(await app.messages.next((m) => m.re === "h1")).toEqual({
			t: "error",
			re: "h1",
			code: "not_found",
			message: "no such item",
		});
	});

	it("prompt: ack when the session replies; errors and timeouts become ack ok:false", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const session = await connectSession();
		await session.register(summary("s1"));

		app.send({
			t: "session.prompt",
			id: "p1",
			sessionId: "s1",
			text: "hi",
			images: [{ mimeType: "image/png", data: "AAAA" }],
		});
		const req = await session.nextReq("prompt");
		expect(req.args).toEqual({ text: "hi", mode: "auto", images: [{ mimeType: "image/png", data: "AAAA" }] });
		expect(app.messages.pending((m) => m.re === "p1")).toEqual([]); // no ack before the session answers
		session.reply(req.id, {});
		expect(await app.messages.next((m) => m.re === "p1")).toEqual({ t: "ack", re: "p1", ok: true });

		app.send({ t: "session.prompt", id: "p2", sessionId: "s1", text: "again", mode: "steer" });
		const req2 = await session.nextReq("prompt");
		session.send({ t: "reply", re: req2.id, ok: false, error: { code: "bad_request", message: "nope" } });
		expect(await app.messages.next((m) => m.re === "p2")).toEqual({
			t: "ack",
			re: "p2",
			ok: false,
			error: { code: "bad_request", message: "nope" },
		});

		app.send({ t: "session.abort", id: "p3", sessionId: "s1" });
		await session.nextReq("abort"); // never answered
		const timedOut = await app.messages.next((m) => m.re === "p3");
		expect(timedOut).toMatchObject({ t: "ack", ok: false, error: { code: "session_offline" } });

		app.send({
			t: "session.prompt",
			id: "p4",
			sessionId: "s1",
			text: "x",
			images: [{ mimeType: "image/tiff", data: "A" }],
		});
		expect(await app.messages.next((m) => m.re === "p4")).toMatchObject({
			ok: false,
			error: { code: "bad_request" },
		});
		app.send({ t: "session.prompt", id: "p5", sessionId: "nope", text: "x" });
		expect(await app.messages.next((m) => m.re === "p5")).toMatchObject({ ok: false, error: { code: "not_found" } });
	});

	it("keeps the socket open on malformed frames after auth", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		app.ws.send("{not json");
		expect(await app.messages.next((m) => m.t === "error")).toMatchObject({ code: "bad_request" });
		app.send({ id: "no-t" });
		expect(await app.messages.next((m) => m.re === "no-t")).toMatchObject({ t: "error", code: "bad_request" });
		app.send({ t: "made.up", id: "u1" });
		expect(await app.messages.next((m) => m.re === "u1")).toMatchObject({ t: "error", code: "bad_request" });
		app.send({ t: "sessions.list" });
		expect(await app.messages.next((m) => m.t === "error")).toMatchObject({ code: "bad_request" });
		await app.sync();
	});

	it("treats a new register on the same connection as a replacement: reset(replacedBy) + remove(old) + add(new)", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const bystander = await connectApp(token);
		const session = await connectSession();
		await session.register(summary("old"));
		await app.messages.next((m) => m.t === "session.upsert" && m.session.sessionId === "old");
		app.send({ t: "session.subscribe", id: "sub", sessionId: "old" });
		const snap = await session.nextReq("snapshot");
		session.reply(snap.id, { items: [], hasMore: false, state: { status: "idle" } });
		await app.messages.next((m) => m.t === "session.snapshot" && m.re === "sub");

		await session.register(summary("new"));
		// The subscriber learns the successor first, then everyone sees the removal and the new session.
		const reset = await app.messages.next((m) => m.t === "session.event");
		expect(reset).toEqual({
			t: "session.event",
			sessionId: "old",
			event: { type: "reset", replacedBy: "new" },
		});
		expect(await app.messages.next((m) => m.t === "session.remove")).toEqual({
			t: "session.remove",
			sessionId: "old",
			replacedBy: "new",
		});
		expect(
			(await app.messages.next((m) => m.t === "session.upsert" && m.session.sessionId === "new")).session,
		).toMatchObject({
			sessionId: "new",
		});
		const resetAt = app.messages.all.findIndex((m) => m.t === "session.event");
		expect(resetAt).toBeLessThan(app.messages.all.findIndex((m) => m.t === "session.remove"));
		// Not subscribed: no reset, but the same removal pointer.
		expect(await bystander.messages.next((m) => m.t === "session.remove")).toEqual({
			t: "session.remove",
			sessionId: "old",
			replacedBy: "new",
		});
		await bystander.sync();
		expect(bystander.messages.all.some((m) => m.t === "session.event")).toBe(false);

		app.send({ t: "sessions.list", id: "l" });
		const list = await app.messages.next((m) => m.t === "sessions");
		expect(list.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["new"]);
		// A plain disconnect is a removal without a successor.
		session.close();
		expect(await app.messages.next((m) => m.t === "session.remove")).toEqual({
			t: "session.remove",
			sessionId: "new",
		});
	});

	it("routes commands.list to the session, normalises the reply and reports errors as error frames", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const session = await connectSession();
		await session.register(summary("s1", { commandsVersion: "3-abc" }));
		expect(
			(await app.messages.next((m) => m.t === "session.upsert" && m.session.sessionId === "s1")).session
				.commandsVersion,
		).toBe("3-abc");

		app.send({ t: "commands.list", id: "c1", sessionId: "s1" });
		const req = await session.nextReq("commands");
		expect(req.args).toEqual({});
		const many = Array.from({ length: 600 }, (_, i) => ({ name: `p${i}`, source: "prompt" }));
		session.reply(req.id, {
			commands: [
				{ name: "new", description: "Start a new session", source: "builtin" },
				{ name: "skill:x", description: `line one\n  line two ${"y".repeat(300)}`, source: "skill" },
				{ name: "bad name", source: "extension" },
				{ name: "weird", source: "plugin" },
				{ name: 42, source: "prompt" },
				"junk",
				...many,
			],
		});
		const reply = await app.messages.next((m) => m.re === "c1");
		expect(reply.t).toBe("commands");
		expect(reply.sessionId).toBe("s1");
		expect(reply.commands).toHaveLength(500);
		expect(reply.commands[0]).toEqual({ name: "new", description: "Start a new session", source: "builtin" });
		expect(reply.commands[1].name).toBe("skill:x");
		expect(reply.commands[1].description).toHaveLength(160);
		expect(reply.commands[1].description.startsWith("line one line two y")).toBe(true);
		expect(reply.commands[2]).toEqual({ name: "p0", source: "prompt" });

		// The session does not know the op (an older phi): its bad_request comes back as an error frame.
		app.send({ t: "commands.list", id: "c2", sessionId: "s1" });
		const old = await session.nextReq("commands");
		session.send({
			t: "reply",
			re: old.id,
			ok: false,
			error: { code: "bad_request", message: "unknown op: commands" },
		});
		expect(await app.messages.next((m) => m.re === "c2")).toEqual({
			t: "error",
			re: "c2",
			code: "bad_request",
			message: "unknown op: commands",
		});

		// A garbage reply is an empty list, not a crash.
		app.send({ t: "commands.list", id: "c3", sessionId: "s1" });
		session.reply((await session.nextReq("commands")).id, { commands: "nope" });
		expect(await app.messages.next((m) => m.re === "c3")).toEqual({
			t: "commands",
			re: "c3",
			sessionId: "s1",
			commands: [],
		});

		// Unknown session, missing sessionId, missing id.
		app.send({ t: "commands.list", id: "c4", sessionId: "nope" });
		expect(await app.messages.next((m) => m.re === "c4")).toMatchObject({ t: "error", code: "not_found" });
		app.send({ t: "commands.list", id: "c5" });
		expect(await app.messages.next((m) => m.re === "c5")).toMatchObject({ t: "error", code: "bad_request" });
		app.send({ t: "commands.list", sessionId: "s1" });
		expect(await app.messages.next((m) => m.t === "error" && m.re === undefined)).toMatchObject({
			code: "bad_request",
		});

		// No answer in time: session_offline.
		app.send({ t: "commands.list", id: "c6", sessionId: "s1" });
		await session.nextReq("commands");
		expect(await app.messages.next((m) => m.re === "c6", 2000)).toMatchObject({
			t: "error",
			code: "session_offline",
		});

		// A bad commandsVersion type is dropped from the summary.
		session.send({ t: "upsert", session: summary("s1", { name: "renamed", commandsVersion: 7 as never }) });
		const upsert = await app.messages.next((m) => m.t === "session.upsert" && m.session.name === "renamed");
		expect(upsert.session).not.toHaveProperty("commandsVersion");
	});

	it("answers commands.list for a disconnected session with session_offline and needs a paired client", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const session = await connectSession();
		await session.register(summary("s1"));
		await app.messages.next((m) => m.t === "session.upsert");
		// Before hello, any frame other than hello closes the socket (4401): no listing without a token.
		const stranger = await connectApp();
		stranger.send({ t: "commands.list", id: "x", sessionId: "s1" });
		expect((await stranger.closed).code).toBe(4401);
		// The owning connection is gone but the entry is still known for a moment: offline, not found.
		session.socket.destroy();
		app.send({ t: "commands.list", id: "o1", sessionId: "s1" });
		const answer = await app.messages.next((m) => m.re === "o1");
		expect(answer.t).toBe("error");
		expect(["session_offline", "not_found"]).toContain(answer.code);
	});

	it("says bye to an unknown wire version", async () => {
		await startHub();
		const session = await connectSession();
		session.send({ t: "register", v: 99, session: summary("s1") });
		expect(await session.messages.next((m) => m.t === "bye")).toMatchObject({ t: "bye" });
		await new Promise<void>((r) => (session.socket.destroyed ? r() : session.socket.once("close", () => r())));
	});

	it("throttles session.upsert fan-out per session with a trailing edge", async () => {
		await startHub({ upsertThrottleMs: 200 });
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const session = await connectSession();
		await session.register(summary("s1"));
		await app.messages.next((m) => m.t === "session.upsert");
		for (let i = 0; i < 10; i++) session.send({ t: "upsert", session: summary("s1", { name: `n${i}` }) });
		await sleep(100);
		await app.sync();
		const early = app.messages.all.filter((m) => m.t === "session.upsert").length;
		expect(early).toBeLessThanOrEqual(2);
		const last = await app.messages.next((m) => m.t === "session.upsert" && m.session.name === "n9", 1000);
		expect(last.session.name).toBe("n9");
		await sleep(250);
		expect(app.messages.all.filter((m) => m.t === "session.upsert").length).toBeLessThanOrEqual(3);
	});

	it("only lets headless sessions be closed", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const session = await connectSession();
		await session.register(summary("s1"));
		app.send({ t: "session.close", id: "c1", sessionId: "s1" });
		expect(await app.messages.next((m) => m.re === "c1")).toMatchObject({
			t: "ack",
			ok: false,
			error: { code: "forbidden" },
		});
	});
});

describe("models, cwds and control", () => {
	it("answers models.list without a session from the hub's registry", async () => {
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		app.send({ t: "models.list", id: "m1" });
		expect(await app.messages.next((m) => m.re === "m1")).toMatchObject({
			t: "models",
			models: [{ provider: "anthropic", id: "claude-test" }],
			current: { provider: "anthropic", id: "claude-test" },
			thinkingLevel: "high",
		});
	});

	it("lists recent cwds from live and persisted sessions inside the allowed roots", async () => {
		const persisted = join(home, "persisted");
		mkdirSync(persisted);
		mkdirSync(join(tmp, "sessions", "--p--"), { recursive: true });
		writeFileSync(
			join(tmp, "sessions", "--p--", "2026-01-01T00-00-00-000Z_x.jsonl"),
			`${JSON.stringify({ type: "session", id: "x", timestamp: "t", cwd: persisted })}\n`,
		);
		mkdirSync(join(tmp, "sessions", "--q--"), { recursive: true });
		writeFileSync(
			join(tmp, "sessions", "--q--", "2026-01-01T00-00-00-000Z_y.jsonl"),
			`${JSON.stringify({ type: "session", id: "y", timestamp: "t", cwd: tmp })}\n`, // outside $HOME
		);
		await startHub();
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const session = await connectSession();
		await session.register(summary("s1", { cwd: join(home, "project") }));
		app.send({ t: "cwds.recent", id: "c1" });
		expect(await app.messages.next((m) => m.re === "c1")).toEqual({
			t: "cwds",
			re: "c1",
			cwds: [join(home, "project"), persisted],
		});
	});

	it("refuses a second hub on the same socket and reports status", async () => {
		await startHub();
		const second = new Hub({
			port: 0,
			binds: ["127.0.0.1"],
			home,
			sessionsDir: join(tmp, "sessions"),
			log: () => {},
			modelCatalog: catalog,
		});
		await expect(second.start()).rejects.toBeInstanceOf(HubAlreadyRunningError);
		const ctl = await ControlClient.connect();
		cleanups.push(() => ctl.close());
		const status = await ctl.request<{ hubId: string; port: number; binds: string[] }>({ op: "status" });
		expect(status).toMatchObject({ hubId: hub!.hubId, port: hub!.port, binds: ["127.0.0.1"] });
		const pair = await ctl.request<PairInfo>({ op: "pair.create" });
		expect(pair.code).toMatch(/^[0-9A-Z]{8}$/);
		expect(pair.link.startsWith("phiremote://pair?v=1&code=")).toBe(true);
	});
});

describe("push notifications", () => {
	async function setup() {
		await startHub();
		const { token, deviceId } = await pairDevice();
		const app = await connectApp(token);
		app.send({
			t: "push.register",
			id: "r1",
			apnsToken: "ab".repeat(32),
			env: "sandbox",
			bundleId: "dev.example.phiremote",
		});
		expect(await app.messages.next((m) => m.re === "r1")).toEqual({ t: "ack", re: "r1", ok: true });
		const session = await connectSession();
		await session.register(summary("s1", { name: "Fix the build", status: "working" }));
		return { app, session, deviceId };
	}

	const finish = (session: FakeSession, text: string, error?: string) => {
		session.send(
			{
				t: "event",
				sessionId: "s1",
				event: {
					type: "item.upsert",
					item: { id: "a1", ts: 1, kind: "assistant", text, ...(error ? { error } : {}) },
				},
			},
			{ t: "event", sessionId: "s1", event: { type: "state", state: { status: "idle" } } },
		);
	};

	it("pushes on working → idle with the session name and final text", async () => {
		const { app, session } = await setup();
		finish(session, `All green.\n${"x".repeat(300)}`);
		await vi.waitFor(() => expect(pushes.length).toBe(1), { timeout: 2000 });
		expect(pushes[0].registration).toEqual({
			apnsToken: "ab".repeat(32),
			env: "sandbox",
			bundleId: "dev.example.phiremote",
		});
		expect(pushes[0].alert.title).toBe("Fix the build");
		expect(pushes[0].alert.body.startsWith("All green. xxx")).toBe(true);
		expect(pushes[0].alert.body.length).toBeLessThanOrEqual(140);
		expect(pushes[0].payload).toEqual({ hubId: hub!.hubId, sessionId: "s1" });
		// The state change is reflected in the summary fan-out.
		await app.messages.next((m) => m.t === "session.upsert" && m.session.status === "idle");
	});

	it("does not push to a device focusing the session, nor after an abort", async () => {
		const { app, session } = await setup();
		app.send({ t: "focus", sessionId: "s1" });
		await app.sync();
		finish(session, "done");
		await sleep(150);
		expect(pushes).toEqual([]);

		app.send({ t: "focus", sessionId: null });
		session.send({ t: "upsert", session: summary("s1", { name: "Fix the build", status: "working" }) });
		await sleep(20);
		app.send({ t: "session.abort", id: "a1", sessionId: "s1" });
		const req = await session.nextReq("abort");
		session.reply(req.id, {});
		finish(session, "partial", "aborted");
		await sleep(150);
		expect(pushes).toEqual([]);
	});

	it("drops a dead push registration", async () => {
		const { deviceId, session } = await setup();
		pushResult = { ok: false, status: 400, reason: "BadDeviceToken", drop: true };
		finish(session, "done");
		await vi.waitFor(() => expect(pushes.length).toBe(1), { timeout: 2000 });
		await vi.waitFor(() => expect(hub!.deviceInfos().find((d) => d.id === deviceId)?.push).toBe(false), {
			timeout: 2000,
		});
	});
});

describe("headless sessions", () => {
	/** A stand-in for `phi --mode rpc`: registers with its spawn id, cancels nothing itself. */
	const FAKE_CHILD = `
import { connect } from "node:net";
import { join } from "node:path";
const sessionId = "headless-" + process.pid;
const base = { sessionId, name: "headless", cwd: process.cwd(), host: "h", pid: process.pid, kind: "headless", status: "idle", startedAt: 1, lastActivityAt: 2 };
const sock = connect(join(process.env.PI_REMOTE_DIR, "hub.sock"));
const queue = [];
let registered = false;
const send = (f) => (registered ? sock.write(JSON.stringify(f) + "\\n") : queue.push(f));
sock.on("connect", () => sock.write(JSON.stringify({ t: "register", v: 1, session: base, spawnId: process.env.PHI_REMOTE_SPAWN_ID }) + "\\n"));
let buf = "";
sock.setEncoding("utf8");
sock.on("data", (d) => {
	buf += d;
	let nl;
	while ((nl = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
		if (m.t === "registered") { registered = true; for (const f of queue.splice(0)) send(f); }
		if (m.t === "req") {
			send({ t: "reply", re: m.id, ok: true, data: {} });
			if (m.op === "prompt") { base.name = "prompt:" + m.args.text; send({ t: "upsert", session: base }); }
		}
	}
});
process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "hi" }) + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
	input += d;
	if (input.includes('"ui-1"') && input.includes('"cancelled":true')) { base.lastText = "ui-cancelled:" + (input.includes("ui-2") ? "both" : "one"); send({ t: "upsert", session: base }); }
});
process.stdin.on("end", () => { sock.end(); process.exit(0); });
`;

	it("spawns, acks with the registered session id, forwards the prompt, cancels UI dialogs, closes", async () => {
		const script = join(tmp, "fake-child.mjs");
		writeFileSync(script, FAKE_CHILD);
		await startHub({ invocation: { command: process.execPath, args: [script] } });
		const { token } = await pairDevice();
		const app = await connectApp(token);
		app.send({ t: "session.spawn", id: "sp1", cwd: join(home, "project"), prompt: "hello", modelId: "claude-test" });
		const ack = await app.messages.next((m) => m.re === "sp1", 10_000);
		expect(ack).toMatchObject({ t: "ack", re: "sp1", ok: true });
		expect(ack.sessionId).toMatch(/^headless-\d+$/);
		// The prompt was forwarded and the confirm dialog cancelled (the notify left alone); upserts
		// are coalesced by the throttle, so wait for the one carrying both.
		await app.messages.next(
			(m) =>
				m.t === "session.upsert" && m.session.name === "prompt:hello" && m.session.lastText === "ui-cancelled:one",
			5000,
		);
		app.send({ t: "sessions.list", id: "l" });
		const list = await app.messages.next((m) => m.t === "sessions");
		expect(list.sessions[0]).toMatchObject({ sessionId: ack.sessionId, kind: "headless" });

		app.send({ t: "session.close", id: "cl", sessionId: ack.sessionId });
		expect(await app.messages.next((m) => m.re === "cl")).toEqual({ t: "ack", re: "cl", ok: true });
		expect(await app.messages.next((m) => m.t === "session.remove", 5000)).toEqual({
			t: "session.remove",
			sessionId: ack.sessionId,
		});
	});

	it("has no cap on headless sessions: 48 concurrent spawns all ack ok and are listed", async () => {
		const script = join(tmp, "fake-child.mjs");
		writeFileSync(script, FAKE_CHILD);
		await startHub({ invocation: { command: process.execPath, args: [script] }, spawnTimeoutMs: 60_000 });
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const n = 48;
		for (let i = 0; i < n; i++) app.send({ t: "session.spawn", id: `m${i}`, cwd: join(home, "project") });
		const acks = await Promise.all(
			Array.from({ length: n }, (_, i) => app.messages.next((m) => m.t === "ack" && m.re === `m${i}`, 60_000)),
		);
		for (const ack of acks)
			expect(ack).toMatchObject({ ok: true, sessionId: expect.stringMatching(/^headless-\d+$/) });
		expect(new Set(acks.map((a) => a.sessionId)).size).toBe(n);
		app.send({ t: "sessions.list", id: "l" });
		const list = await app.messages.next((m) => m.t === "sessions");
		const listed = new Set(list.sessions.filter((s: any) => s.kind === "headless").map((s: any) => s.sessionId));
		for (const ack of acks) expect(listed.has(ack.sessionId)).toBe(true);
		expect(hub!.status().sessions.filter((s) => s.kind === "headless").length).toBe(n);
	}, 120_000);

	/**
	 * A light stand-in (perl, a few MB each) so hundreds of children fit on a laptop: registers
	 * with its spawn id and stays until the hub closes its stdin.
	 */
	const PERL_CHILD = `
use strict; use IO::Socket::UNIX;
# Like the real session link: a refused connect (full listen queue) is retried after a pause.
my $sock;
for my $try (1 .. 100) { $sock = IO::Socket::UNIX->new(Type => SOCK_STREAM(), Peer => "$ENV{PI_REMOTE_DIR}/hub.sock") and last; select(undef, undef, undef, 0.2); }
die "connect: $!" unless $sock;
my $id = "headless-$$"; my $cwd = $ENV{PWD} // "/";
print $sock qq({"t":"register","v":1,"spawnId":"$ENV{PHI_REMOTE_SPAWN_ID}","session":{"sessionId":"$id","name":"h","cwd":"/tmp","host":"h","pid":$$,"kind":"headless","status":"idle","startedAt":1,"lastActivityAt":2}}\n);
$sock->flush;
while (<STDIN>) {}
close $sock; exit 0;
`;
	const SCALE = Number(process.env.PHI_REMOTE_SCALE_CHILDREN || 0);

	it.runIf(SCALE > 0)(
		"scale: hundreds of concurrent headless children all register (PHI_REMOTE_SCALE_CHILDREN)",
		async () => {
			const script = join(tmp, "child.pl");
			writeFileSync(script, PERL_CHILD);
			await startHub({ invocation: { command: "perl", args: [script] }, spawnTimeoutMs: 120_000 });
			const { token } = await pairDevice();
			const app = await connectApp(token);
			const started = Date.now();
			for (let i = 0; i < SCALE; i++) app.send({ t: "session.spawn", id: `s${i}`, cwd: join(home, "project") });
			const acks = await Promise.all(
				Array.from({ length: SCALE }, (_, i) =>
					app.messages.next((m) => m.t === "ack" && m.re === `s${i}`, 120_000),
				),
			);
			const failed = acks.filter((a) => !a.ok);
			expect(failed).toEqual([]);
			expect(hub!.status().sessions.filter((s) => s.kind === "headless").length).toBe(SCALE);
			console.log(`${SCALE} headless children registered in ${Date.now() - started} ms`);
		},
		300_000,
	);

	it("times out a child that never connects, extending the deadline while other spawns are pending", async () => {
		const script = join(tmp, "silent-child.mjs");
		// Never connects; exits when the hub closes its stdin.
		writeFileSync(script, 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n');
		await startHub({
			invocation: { command: process.execPath, args: [script] },
			spawnTimeoutMs: 300,
			spawnGracePerPendingMs: 1000,
		});
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const cwd = join(home, "project");
		const started = Date.now();
		app.send({ t: "session.spawn", id: "alone", cwd });
		expect(await app.messages.next((m) => m.re === "alone", 3000)).toMatchObject({
			ok: false,
			error: { code: "internal", message: "headless session did not connect in time" },
		});
		expect(Date.now() - started).toBeLessThan(1500);
		// Three at once: 300 ms + 2 × 1 s each, not 300 ms.
		const burst = Date.now();
		for (const id of ["b1", "b2", "b3"]) app.send({ t: "session.spawn", id, cwd });
		await sleep(1200);
		expect(app.messages.pending((m) => m.t === "ack")).toEqual([]);
		for (const id of ["b1", "b2", "b3"]) {
			expect(await app.messages.next((m) => m.re === id, 5000)).toMatchObject({
				ok: false,
				error: { code: "internal" },
			});
		}
		expect(Date.now() - burst).toBeGreaterThanOrEqual(2200);
	});

	it("passes a valid thinkingLevel to the child as --thinking and refuses an invalid one", async () => {
		const script = join(tmp, "argv-child.mjs");
		// Registers with its argv's --thinking as the summary's thinkingLevel.
		writeFileSync(
			script,
			FAKE_CHILD.replace(
				'kind: "headless",',
				'kind: "headless", ...(process.argv.includes("--thinking") ? { thinkingLevel: process.argv[process.argv.indexOf("--thinking") + 1] } : {}),',
			),
		);
		await startHub({ invocation: { command: process.execPath, args: [script] } });
		const { token } = await pairDevice();
		const app = await connectApp(token);
		const cwd = join(home, "project");
		app.send({ t: "session.spawn", id: "th", cwd, thinkingLevel: "high" });
		const ack = await app.messages.next((m) => m.re === "th", 10_000);
		expect(ack).toMatchObject({ ok: true });
		app.send({ t: "session.spawn", id: "none", cwd });
		const plain = await app.messages.next((m) => m.re === "none", 10_000);
		expect(plain).toMatchObject({ ok: true });
		app.send({ t: "sessions.list", id: "l" });
		const list = await app.messages.next((m) => m.t === "sessions");
		const byId = new Map(list.sessions.map((s: any) => [s.sessionId, s]));
		expect((byId.get(ack.sessionId) as any).thinkingLevel).toBe("high");
		expect((byId.get(plain.sessionId) as any).thinkingLevel).toBeUndefined();
		for (const [id, bad] of [
			["b1", "bogus"],
			["b2", "--help"],
			["b3", 7],
			["b4", ""],
			["b5", null],
		] as const) {
			app.send({ t: "session.spawn", id, cwd, thinkingLevel: bad });
			expect(await app.messages.next((m) => m.re === id)).toMatchObject({
				t: "ack",
				ok: false,
				error: { code: "bad_request", message: "invalid thinkingLevel" },
			});
		}
		expect(hub!.status().sessions.filter((s) => s.kind === "headless").length).toBe(2);
	});

	it("validates cwd and model before spawning", async () => {
		const script = join(tmp, "exit3.mjs");
		writeFileSync(script, "process.exit(3);\n");
		await startHub({ invocation: { command: process.execPath, args: [script] } });
		const { token } = await pairDevice();
		const app = await connectApp(token);
		app.send({ t: "session.spawn", id: "a", cwd: tmp });
		expect(await app.messages.next((m) => m.re === "a")).toMatchObject({ ok: false, error: { code: "forbidden" } });
		app.send({ t: "session.spawn", id: "b", cwd: join(home, "missing") });
		expect(await app.messages.next((m) => m.re === "b")).toMatchObject({ ok: false, error: { code: "bad_request" } });
		app.send({ t: "session.spawn", id: "c", cwd: join(home, "project"), modelId: "no-such-model" });
		expect(await app.messages.next((m) => m.re === "c")).toMatchObject({ ok: false, error: { code: "not_found" } });
		app.send({ t: "session.spawn", id: "d", cwd: join(home, "project") });
		expect(await app.messages.next((m) => m.re === "d", 5000)).toMatchObject({
			ok: false,
			error: { code: "internal", message: expect.stringContaining("exited (code 3)") },
		});
	});
});
