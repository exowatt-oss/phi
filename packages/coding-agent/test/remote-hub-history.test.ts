/**
 * phi remote hub: session history (`sessions.past`, `session.transcript`, `session.resume`) over the
 * real WebSocket, with stored sessions on disk, fake live sessions on hub.sock, and stand-in
 * headless children for resumes.
 */

import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { storedTranscript } from "../src/extensions/remote/transcript.ts";
import { Hub, type HubOptions } from "../src/remote/hub/hub.ts";
import type { ModelCatalog } from "../src/remote/hub/models.ts";
import { hubSocketPath } from "../src/remote/paths.ts";
import { AppClient, FakeSession, postJson, sleep, summary, untilHistoryIndexed } from "./remote-hub-helpers.ts";

let tmp: string;
let home: string;
let sessionsDir: string;
let hub: Hub | undefined;
const cleanups: (() => void)[] = [];

const catalog: ModelCatalog = {
	list: async () => ({ models: [], thinkingLevels: [] }),
	has: async (_provider, modelId) => modelId === undefined || modelId === "claude-test",
};

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phi-hub-history-"));
	home = join(tmp, "home");
	sessionsDir = join(tmp, "sessions");
	mkdirSync(join(home, "project"), { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
	vi.stubEnv("PI_REMOTE_DIR", join(tmp, "remote"));
	vi.stubEnv("FAKE_SPAWN_LOG", join(tmp, "spawns.log"));
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
		sessionsDir,
		helloTimeoutMs: 500,
		requestTimeoutMs: 1000,
		upsertThrottleMs: 50,
		pushSender: async () => ({ ok: true, drop: false }),
		pushEnabled: () => false,
		modelCatalog: catalog,
		historyMaxAgeMs: 0,
		resumeLiveGraceMs: 0,
		log: () => {},
		// No `tailscale status` child per pairing: its latency hid the index race below on machines with
		// Tailscale installed, while CI (no tailscale) saw it every run.
		magicDnsLookup: async () => undefined,
		...options,
	});
	await hub.start();
	return hub;
}

async function connectApp(features?: string[]): Promise<{ app: AppClient; welcome: any }> {
	const info = await hub!.createPair();
	const res = await postJson(`http://127.0.0.1:${hub!.port}/v1/pair`, { code: info.code, deviceName: "Phone" });
	const app = new AppClient(`ws://127.0.0.1:${hub!.port}/v1/ws`);
	cleanups.push(() => app.close());
	await app.opened();
	app.send({ t: "hello", token: res.body.token, ...(features ? { features } : {}) });
	const welcome = await app.messages.next((m) => m.t === "welcome");
	return { app, welcome };
}

async function connectSession(): Promise<FakeSession> {
	const session = await FakeSession.connect(hubSocketPath());
	cleanups.push(() => session.close());
	return session;
}

async function request(app: AppClient, frame: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
	const id = `r-${Math.random().toString(36).slice(2)}`;
	app.send({ ...frame, id });
	return app.messages.next((m) => m.re === id && m.t !== "pong", timeoutMs);
}

let clock = Date.parse("2026-11-01T10:00:00.000Z");

/** A stored session written by the real session manager: user, assistant (+ tool), reply. */
function storeSession(cwd: string, words: string, project = "proj"): { id: string; path: string } {
	const sm = SessionManager.create(cwd, join(sessionsDir, project));
	const ts = (): number => {
		clock += 1000;
		return clock;
	};
	sm.appendMessage({ role: "user", content: [{ type: "text", text: `Tell me about ${words}` }], timestamp: ts() });
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	sm.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text: "Looking." },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage,
		stopReason: "toolUse",
		timestamp: ts(),
	});
	sm.appendMessage({
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		content: [{ type: "text", text: "a b c" }],
		isError: false,
		timestamp: ts(),
	});
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `All about ${words}.` }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage,
		stopReason: "stop",
		timestamp: ts(),
	});
	return { id: sm.getSessionId(), path: sm.getSessionFile() as string };
}

/**
 * A stand-in for `phi --mode rpc --session <file>`: registers with the stored file's session id
 * (else headless-<pid>), logs its argv to FAKE_SPAWN_LOG, records prompts in its summary name, and
 * answers snapshot/history with a marker item.
 */
const RESUME_CHILD = `
import { connect } from "node:net";
import { join } from "node:path";
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_SPAWN_LOG, JSON.stringify({ pid: process.pid, argv, cwd: process.cwd() }) + "\\n");
const at = argv.indexOf("--session");
const file = at >= 0 ? argv[at + 1] : undefined;
const sessionId = file ? JSON.parse(readFileSync(file, "utf8").split("\\n")[0]).id : "headless-" + process.pid;
const base = { sessionId, name: "resumed", cwd: process.cwd(), host: "h", pid: process.pid, kind: "headless", status: "idle", startedAt: 1, lastActivityAt: 2 };
const delay = Number(process.env.FAKE_REGISTER_DELAY_MS || 0);
const sock = connect(join(process.env.PI_REMOTE_DIR, "hub.sock"));
const send = (f) => sock.write(JSON.stringify(f) + "\\n");
const prompts = [];
sock.on("connect", () => setTimeout(() => send({ t: "register", v: 1, session: base, spawnId: process.env.PHI_REMOTE_SPAWN_ID }), delay));
let buf = "";
sock.setEncoding("utf8");
sock.on("data", (d) => {
	buf += d;
	let nl;
	while ((nl = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
		if (m.t !== "req") continue;
		if (m.op === "snapshot" || m.op === "history") {
			send({ t: "reply", re: m.id, ok: true, data: { items: [{ id: "live:" + m.op, ts: 1, kind: "note", text: "live" }], hasMore: false, state: { status: "idle" } } });
			continue;
		}
		send({ t: "reply", re: m.id, ok: true, data: {} });
		if (m.op === "prompt") { prompts.push(m.args.text); send({ t: "upsert", session: { ...base, name: "prompts:" + prompts.join("|") } }); }
	}
});
process.stdin.resume();
process.stdin.on("end", () => { sock.end(); process.exit(0); });
`;

function spawnLog(): { pid: number; argv: string[]; cwd: string }[] {
	try {
		return readFileSync(join(tmp, "spawns.log"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

async function startResumeHub(options: Partial<HubOptions> = {}): Promise<Hub> {
	const script = join(tmp, "resume-child.mjs");
	writeFileSync(script, RESUME_CHILD);
	return startHub({ invocation: { command: process.execPath, args: [script] }, ...options });
}

describe("capability", () => {
	it("advertises history and overseer in welcome.host.features to every app, old ones included", async () => {
		await startHub();
		const { app, welcome } = await connectApp(); // an app that predates hello.features
		expect(welcome.host).toEqual({
			name: "test-host",
			hubId: hub!.hubId,
			hubVersion: "9.9.9",
			protocol: 1,
			features: ["history", "overseer"],
		});
		// Everything an old app does still works the same.
		const session = await connectSession();
		await session.register(summary("live-1", { cwd: join(home, "project") }));
		const list = await request(app, { t: "sessions.list" });
		expect(list).toMatchObject({ t: "sessions", sessions: [{ sessionId: "live-1" }] });
		expect(await request(app, { t: "nope.unknown" })).toMatchObject({ t: "error", code: "bad_request" });
		const { welcome: other } = await connectApp(["subagents"]);
		expect(other.host.features).toEqual(["history", "overseer"]);
	});
});

describe("sessions.past", () => {
	it("lists stored sessions newest first with listing fields, live flag and resumability", async () => {
		const a = storeSession(join(home, "project"), "alpacas");
		const b = storeSession(join(home, "project"), "bison");
		const outside = storeSession(join(tmp, "elsewhere"), "outsiders", "other");
		const gone = storeSession(join(home, "deleted-folder"), "ghosts", "gone");
		const empty = SessionManager.create(join(home, "project"), join(sessionsDir, "proj"));
		empty.appendSessionInfo("never persisted"); // no assistant message: no file at all
		await startHub();
		const live = await connectSession();
		await live.register(summary(b.id, { cwd: join(home, "project") }));
		const { app } = await connectApp();
		await untilHistoryIndexed(app);
		const past = await request(app, { t: "sessions.past" });
		expect(past.t).toBe("sessions.past");
		expect(past.nextCursor).toBeUndefined();
		expect(past.indexing).toBeUndefined();
		expect(past.sessions.map((s: any) => s.sessionId)).toEqual([gone.id, outside.id, b.id, a.id]);
		const byId = new Map(past.sessions.map((s: any) => [s.sessionId, s]));
		expect(byId.get(a.id)).toEqual({
			sessionId: a.id,
			title: "Tell me about alpacas",
			named: false,
			cwd: join(home, "project"),
			createdAt: expect.any(Number),
			modifiedAt: expect.any(Number),
			messageCount: 3,
			preview: "All about alpacas.",
			model: { provider: "anthropic", id: "claude-test" },
			live: false,
			resumable: true,
		});
		expect(byId.get(b.id)).toMatchObject({ live: true, liveKind: "interactive", resumable: true });
		// The folder is not consulted: outside the allowed roots or gone, it can be resumed.
		expect(byId.get(outside.id)).toMatchObject({ live: false, resumable: true });
		expect(byId.get(gone.id)).toMatchObject({ resumable: true });
	});

	it("is not resumable only when the session file can no longer be read", async () => {
		const locked = storeSession(join(home, "project"), "locked away");
		const fine = storeSession(join(home, "project"), "readable");
		await startHub();
		const { app } = await connectApp();
		await untilHistoryIndexed(app);
		const first = await request(app, { t: "sessions.past" });
		expect(first.sessions.map((s: any) => [s.sessionId, s.resumable])).toEqual([
			[fine.id, true],
			[locked.id, true],
		]);
		chmodSync(locked.path, 0o000);
		cleanups.push(() => chmodSync(locked.path, 0o600));
		const past = await request(app, { t: "sessions.past" });
		const byId = new Map(past.sessions.map((s: any) => [s.sessionId, s]));
		expect(byId.get(locked.id)).toMatchObject({ resumable: false });
		expect(byId.get(fine.id)).toMatchObject({ resumable: true });
	});

	it("pages with an opaque cursor, searches, filters by cwd, and validates arguments", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 7; i++) ids.unshift(storeSession(join(home, "project"), `topic${i}`).id);
		const other = storeSession(join(home, "other"), "zebras", "other");
		ids.unshift(other.id);
		await startHub();
		const { app } = await connectApp();
		await untilHistoryIndexed(app);
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 10; guard++) {
			const page = await request(app, { t: "sessions.past", limit: 3, ...(cursor ? { cursor } : {}) });
			expect(page.sessions.length).toBeLessThanOrEqual(3);
			seen.push(...page.sessions.map((s: any) => s.sessionId));
			cursor = page.nextCursor;
			if (!cursor) break;
		}
		expect(seen).toEqual(ids);
		const found = await request(app, { t: "sessions.past", query: "ZEBRAS" });
		expect(found.sessions.map((s: any) => s.sessionId)).toEqual([other.id]);
		const byMessageText = await request(app, { t: "sessions.past", query: "about topic3." });
		expect(byMessageText.sessions).toHaveLength(1);
		const byCwd = await request(app, { t: "sessions.past", cwd: join(home, "other") });
		expect(byCwd.sessions.map((s: any) => s.sessionId)).toEqual([other.id]);
		// The cursor applies to the filtered list.
		const firstTwo = await request(app, { t: "sessions.past", query: "topic", limit: 2 });
		const rest = await request(app, { t: "sessions.past", query: "topic", limit: 200, cursor: firstTwo.nextCursor });
		expect([...firstTwo.sessions, ...rest.sessions].map((s: any) => s.sessionId)).toEqual(ids.slice(1));
		expect((await request(app, { t: "sessions.past", limit: 5000 })).sessions).toHaveLength(8);

		for (const bad of [
			{ limit: 0 },
			{ limit: "5" },
			{ cursor: "garbage!" },
			{ cursor: 7 },
			{ query: "x".repeat(201) },
			{ query: 5 },
			{ cwd: 1 },
		]) {
			expect(await request(app, { t: "sessions.past", ...bad })).toMatchObject({ t: "error", code: "bad_request" });
		}
	});

	it("sees sessions created or extended after the hub started", async () => {
		await startHub();
		const { app } = await connectApp();
		await untilHistoryIndexed(app);
		expect((await request(app, { t: "sessions.past" })).sessions).toEqual([]);
		const s = storeSession(join(home, "project"), "late arrivals");
		const listed = await request(app, { t: "sessions.past" });
		expect(listed.sessions.map((x: any) => x.sessionId)).toEqual([s.id]);
		expect(listed.sessions[0].messageCount).toBe(3);
		const at = Date.now() + 60_000;
		appendFileSync(
			s.path,
			`${JSON.stringify({
				type: "message",
				id: "zz1",
				parentId: null,
				timestamp: new Date(at).toISOString(),
				message: { role: "user", content: "one more", timestamp: at },
			})}\n`,
		);
		expect((await request(app, { t: "sessions.past" })).sessions[0]).toMatchObject({
			messageCount: 4,
			modifiedAt: at,
		});
	});

	it("answers while the first index build is still running, with indexing: true", async () => {
		// Many sessions so the build is still going when the first request arrives.
		for (let i = 0; i < 300; i++) storeSession(join(home, "project"), `bulk${i}`, `p${i % 30}`);
		await startHub();
		const { app } = await connectApp();
		const first = await request(app, { t: "sessions.past", limit: 200 });
		if (first.indexing) expect(first.sessions.length).toBeLessThan(300);
		let last = first;
		for (let tries = 0; last.indexing && tries < 200; tries++) {
			await sleep(25);
			last = await request(app, { t: "sessions.past", limit: 200 });
		}
		expect(last.indexing).toBeUndefined();
		expect(last.sessions).toHaveLength(200);
		expect(last.nextCursor).toBeDefined();
	});
});

describe("session.transcript", () => {
	it("serves a stored session's transcript pages exactly as the session manager's branch renders them", async () => {
		const s = storeSession(join(home, "project"), "pages");
		await startHub();
		const { app } = await connectApp();
		const branch = SessionManager.open(s.path).getBranch();
		const full = storedTranscript(branch, { limit: 120 });
		const reply = await request(app, { t: "session.transcript", sessionId: s.id });
		expect(reply).toEqual({
			t: "session.transcript",
			re: reply.re,
			sessionId: s.id,
			items: full.items,
			hasMore: false,
		});
		expect(full.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
		const page = await request(app, { t: "session.transcript", sessionId: s.id, limit: 2 });
		expect(page.items).toEqual(full.items.slice(2));
		expect(page.hasMore).toBe(true);
		const older = await request(app, {
			t: "session.transcript",
			sessionId: s.id,
			before: page.items[0].id,
			limit: 2,
		});
		expect(older.items).toEqual(full.items.slice(0, 2));
		expect(older.hasMore).toBe(false);

		expect(await request(app, { t: "session.transcript", sessionId: s.id, before: "u:1" })).toMatchObject({
			t: "error",
			code: "not_found",
		});
		expect(await request(app, { t: "session.transcript", sessionId: "no-such-session" })).toMatchObject({
			t: "error",
			code: "not_found",
		});
		for (const bad of [{}, { sessionId: s.id, limit: 0 }, { sessionId: s.id, before: "" }, { sessionId: 5 }]) {
			expect(await request(app, { t: "session.transcript", ...bad })).toMatchObject({
				t: "error",
				code: "bad_request",
			});
		}
	});

	it("forwards to a live session (snapshot, or history with before)", async () => {
		const s = storeSession(join(home, "project"), "live one");
		await startHub();
		const session = await connectSession();
		await session.register(summary(s.id, { cwd: join(home, "project") }));
		const { app } = await connectApp();
		app.send({ t: "session.transcript", id: "t1", sessionId: s.id, limit: 7 });
		const req = await session.nextReq("snapshot");
		expect(req.args).toEqual({ limit: 7 });
		session.reply(req.id, {
			items: [{ id: "u:1", ts: 1, kind: "user", text: "hi" }],
			hasMore: true,
			state: { status: "idle" },
		});
		expect(await app.messages.next((m) => m.re === "t1")).toEqual({
			t: "session.transcript",
			re: "t1",
			sessionId: s.id,
			items: [{ id: "u:1", ts: 1, kind: "user", text: "hi" }],
			hasMore: true,
		});
		app.send({ t: "session.transcript", id: "t2", sessionId: s.id, before: "u:1" });
		const history = await session.nextReq("history");
		expect(history.args).toEqual({ before: "u:1", limit: 120 });
		session.send({ t: "reply", re: history.id, ok: false, error: { code: "not_found", message: "no item u:1" } });
		expect(await app.messages.next((m) => m.re === "t2")).toMatchObject({ t: "error", code: "not_found" });
		// A live session without a stored file yet is still served.
		const fresh = await connectSession();
		await fresh.register(summary("not-on-disk-yet", { cwd: join(home, "project") }));
		app.send({ t: "session.transcript", id: "t3", sessionId: "not-on-disk-yet" });
		const snap = await fresh.nextReq("snapshot");
		fresh.reply(snap.id, { items: [], hasMore: false, state: { status: "idle" } });
		expect(await app.messages.next((m) => m.re === "t3")).toMatchObject({ items: [], hasMore: false });
	});
});

describe("session.resume", () => {
	it("starts phi --mode rpc --session <file> in the session's cwd and acks with the same session id", async () => {
		const s = storeSession(join(home, "project"), "resumable");
		await startResumeHub();
		const { app } = await connectApp();
		const ack = await request(
			app,
			{ t: "session.resume", sessionId: s.id, modelId: "claude-test", thinkingLevel: "high" },
			10_000,
		);
		expect(ack).toEqual({ t: "ack", re: ack.re, ok: true, sessionId: s.id, cwd: join(home, "project") });
		const spawns = spawnLog();
		expect(spawns).toHaveLength(1);
		expect(spawns[0].argv).toEqual([
			"--mode",
			"rpc",
			"--session",
			s.path,
			"--session-cwd",
			join(home, "project"),
			"--model",
			"claude-test",
			"--thinking",
			"high",
		]);
		expect(spawns[0].cwd).toBe(realpathSync(join(home, "project")));
		const list = await request(app, { t: "sessions.list" });
		expect(list.sessions).toMatchObject([{ sessionId: s.id, kind: "headless" }]);
		const past = await request(app, { t: "sessions.past" });
		expect(past.sessions[0]).toMatchObject({ sessionId: s.id, live: true, liveKind: "headless" });
		// Now live: the transcript comes from the session itself.
		expect((await request(app, { t: "session.transcript", sessionId: s.id })).items).toEqual([
			{ id: "live:snapshot", ts: 1, kind: "note", text: "live" },
		]);
		// Resuming it again is a no-op that acks at once.
		expect(await request(app, { t: "session.resume", sessionId: s.id })).toMatchObject({ ok: true, sessionId: s.id });
		expect(spawnLog()).toHaveLength(1);
	});

	it("sends the prompt once the resumed session registers", async () => {
		const s = storeSession(join(home, "project"), "prompted");
		await startResumeHub();
		const { app } = await connectApp();
		const ack = await request(
			app,
			{ t: "session.resume", sessionId: s.id, prompt: "what was the code word?" },
			10_000,
		);
		expect(ack).toMatchObject({ ok: true, sessionId: s.id });
		await app.messages.next(
			(m) => m.t === "session.upsert" && m.session.name === "prompts:what was the code word?",
			5000,
		);
	});

	it("joins concurrent resumes of one session: one process, every request acked with its id", async () => {
		const s = storeSession(join(home, "project"), "popular");
		vi.stubEnv("FAKE_REGISTER_DELAY_MS", "300");
		await startResumeHub();
		const { app } = await connectApp();
		const { app: other } = await connectApp();
		app.send({ t: "session.resume", id: "j1", sessionId: s.id, prompt: "first" });
		other.send({ t: "session.resume", id: "j2", sessionId: s.id, prompt: "second" });
		app.send({ t: "session.resume", id: "j3", sessionId: s.id });
		const acks = await Promise.all([
			app.messages.next((m) => m.re === "j1", 10_000),
			other.messages.next((m) => m.re === "j2", 10_000),
			app.messages.next((m) => m.re === "j3", 10_000),
		]);
		for (const ack of acks) expect(ack).toMatchObject({ t: "ack", ok: true, sessionId: s.id });
		expect(spawnLog()).toHaveLength(1);
		await app.messages.next((m) => m.t === "session.upsert" && m.session.name === "prompts:first|second", 5000);
	});

	it("resumes a live session in place: ack at once, prompt delivered, no new process", async () => {
		const s = storeSession(join(home, "project"), "already running");
		await startResumeHub();
		const live = await connectSession();
		await live.register(summary(s.id, { cwd: join(home, "project") }));
		const { app } = await connectApp();
		app.send({ t: "session.resume", id: "lv", sessionId: s.id, prompt: "keep going" });
		expect(await app.messages.next((m) => m.re === "lv")).toEqual({
			t: "ack",
			re: "lv",
			ok: true,
			sessionId: s.id,
			cwd: join(home, "project"),
		});
		const req = await live.nextReq("prompt");
		expect(req.args).toEqual({ text: "keep going", mode: "auto" });
		expect(spawnLog()).toEqual([]);
	});

	it("waits out the startup grace so a session that ran before the hub re-registers instead of doubling", async () => {
		const s = storeSession(join(home, "project"), "survivor");
		await startResumeHub({ resumeLiveGraceMs: 1500 });
		const { app } = await connectApp();
		app.send({ t: "session.resume", id: "g", sessionId: s.id, prompt: "still there?" });
		await sleep(200);
		expect(app.messages.pending((m) => m.re === "g")).toEqual([]);
		// The interactive phi that owns it reconnects to the new hub.
		const live = await connectSession();
		await live.register(summary(s.id, { cwd: join(home, "project") }));
		expect(await app.messages.next((m) => m.re === "g", 3000)).toMatchObject({ ok: true, sessionId: s.id });
		expect((await live.nextReq("prompt")).args).toEqual({ text: "still there?", mode: "auto" });
		expect(spawnLog()).toEqual([]);
	});

	it("acks a resume still waiting when the hub stops exactly once", async () => {
		const s = storeSession(join(home, "project"), "interrupted");
		await startResumeHub({ resumeLiveGraceMs: 5000 });
		const { app } = await connectApp();
		app.send({ t: "session.resume", id: "st", sessionId: s.id });
		await sleep(100);
		await hub!.stop();
		await app.closed;
		expect(app.messages.all.filter((m) => m.re === "st")).toEqual([
			{ t: "ack", re: "st", ok: false, error: { code: "internal", message: "hub is shutting down" } },
		]);
		expect(spawnLog()).toEqual([]);
	});

	it("resumes a session whose folder is outside the allowed roots, in that folder", async () => {
		const outsideDir = join(tmp, "elsewhere");
		mkdirSync(outsideDir, { recursive: true });
		const s = storeSession(outsideDir, "outside", "other");
		await startResumeHub();
		const { app } = await connectApp();
		// Fresh spawns there stay refused.
		expect(await request(app, { t: "session.spawn", cwd: outsideDir })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		const ack = await request(app, { t: "session.resume", sessionId: s.id }, 10_000);
		expect(ack).toEqual({ t: "ack", re: ack.re, ok: true, sessionId: s.id, cwd: outsideDir });
		const [spawn] = spawnLog();
		expect(spawn.cwd).toBe(realpathSync(outsideDir));
		expect(spawn.argv.slice(2, 6)).toEqual(["--session", s.path, "--session-cwd", outsideDir]);
	});

	it("resumes a session whose folder is gone in the first folder that exists, and says so", async () => {
		const user = `phi-test-nobody-${process.pid}`;
		mkdirSync(join(home, "mirrored", "repo"), { recursive: true });
		mkdirSync(join(tmp, "parent"), { recursive: true });
		const cases = [
			// (b) the same path under this machine's home, from a macOS or a Linux home.
			{ recorded: `/Users/${user}/mirrored/repo`, used: join(home, "mirrored", "repo") },
			{ recorded: `/home/${user}/mirrored/repo`, used: join(home, "mirrored", "repo") },
			// (c) the nearest existing ancestor (a removed worktree, a cleaned /tmp folder).
			{ recorded: join(tmp, "parent", "worktree", "deep"), used: join(tmp, "parent") },
			// (d) $HOME: nothing but / exists, or the session never recorded a folder.
			{ recorded: `/phi-test-missing-${process.pid}/a/b`, used: home },
		];
		const stored = cases.map((c, i) => ({ ...c, ...storeSession(c.recorded, `case ${i}`, `case${i}`) }));
		// A very old session with no cwd in its header.
		const noFolder = storeSession(join(home, "project"), "no folder", "legacy");
		const [header, ...rest] = readFileSync(noFolder.path, "utf8").split("\n");
		const { cwd: _dropped, ...headerWithoutCwd } = JSON.parse(header);
		writeFileSync(noFolder.path, [JSON.stringify(headerWithoutCwd), ...rest].join("\n"));
		stored.push({ recorded: "", used: home, ...noFolder });
		await startResumeHub();
		const { app } = await connectApp();
		for (const c of stored) {
			const ack = await request(app, { t: "session.resume", sessionId: c.id }, 10_000);
			expect(ack).toEqual({ t: "ack", re: ack.re, ok: true, sessionId: c.id, cwd: c.used, cwdFallback: true });
		}
		const spawns = spawnLog();
		expect(spawns.map((sp) => sp.cwd)).toEqual(stored.map((c) => realpathSync(c.used)));
		expect(spawns.map((sp) => sp.argv.slice(2, 6))).toEqual(
			stored.map((c) => ["--session", c.path, "--session-cwd", c.used]),
		);
	});

	it("prefers the recorded folder when it exists, even when the home path also does", async () => {
		mkdirSync(join(tmp, "kept"), { recursive: true });
		const s = storeSession(join(tmp, "kept"), "kept");
		await startResumeHub();
		const { app } = await connectApp();
		const ack = await request(app, { t: "session.resume", sessionId: s.id }, 10_000);
		expect(ack).toEqual({ t: "ack", re: ack.re, ok: true, sessionId: s.id, cwd: join(tmp, "kept") });
	});

	it("acks every joined resume of a moved session with the same cwd and cwdFallback", async () => {
		const s = storeSession(join(home, "deleted-folder"), "ghost", "gone");
		vi.stubEnv("FAKE_REGISTER_DELAY_MS", "300");
		await startResumeHub();
		const { app } = await connectApp();
		app.send({ t: "session.resume", id: "m1", sessionId: s.id });
		app.send({ t: "session.resume", id: "m2", sessionId: s.id });
		for (const re of ["m1", "m2"]) {
			expect(await app.messages.next((m) => m.re === re, 10_000)).toEqual({
				t: "ack",
				re,
				ok: true,
				sessionId: s.id,
				cwd: home,
				cwdFallback: true,
			});
		}
		expect(spawnLog()).toHaveLength(1);
	});

	it("refuses what it cannot resume, as acks", async () => {
		const ok = storeSession(join(home, "project"), "fine");
		await startResumeHub();
		const { app } = await connectApp();
		const ack = (frame: Record<string, unknown>) => request(app, { t: "session.resume", ...frame }, 10_000);
		expect(await ack({ sessionId: "nope" })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await ack({})).toMatchObject({ ok: false, error: { code: "bad_request" } });
		expect(await ack({ sessionId: ok.id, modelId: "no-such-model" })).toMatchObject({
			ok: false,
			error: { code: "not_found", message: "unknown model no-such-model" },
		});
		expect(await ack({ sessionId: ok.id, modelId: "--help" })).toMatchObject({
			ok: false,
			error: { code: "bad_request" },
		});
		expect(await ack({ sessionId: ok.id, thinkingLevel: "bogus" })).toMatchObject({
			ok: false,
			error: { code: "bad_request", message: "invalid thinkingLevel" },
		});
		expect(await ack({ sessionId: ok.id, prompt: 5 })).toMatchObject({ ok: false, error: { code: "bad_request" } });
		expect(spawnLog()).toEqual([]);
	});

	it("reports a child that exits before registering to every waiter", async () => {
		const s = storeSession(join(home, "project"), "doomed");
		const script = join(tmp, "exit3.mjs");
		writeFileSync(
			script,
			'process.stderr.write("Stored session working directory does not exist\\n"); process.exit(3);\n',
		);
		await startHub({ invocation: { command: process.execPath, args: [script] } });
		const { app } = await connectApp();
		app.send({ t: "session.resume", id: "d1", sessionId: s.id });
		app.send({ t: "session.resume", id: "d2", sessionId: s.id });
		for (const re of ["d1", "d2"]) {
			expect(await app.messages.next((m) => m.re === re, 10_000)).toMatchObject({
				ok: false,
				error: { code: "internal", message: expect.stringContaining("exited (code 3)") },
			});
		}
		// The failure is over: a later resume tries again.
		app.send({ t: "session.resume", id: "d3", sessionId: s.id });
		expect(await app.messages.next((m) => m.re === "d3", 10_000)).toMatchObject({ ok: false });
	});
});
