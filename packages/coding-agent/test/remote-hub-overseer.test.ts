/**
 * phi remote hub: overseers on the phone (docs/remote-protocol.md, "Overseers") — the "overseer"
 * capability, `isOverseer` / `threadCounts` on summaries (live and from the registry files), the
 * `session.upsert` on a registry change, `PastSession.overseer` / `isOverseer`, `overseer.board`
 * (app frame and ctl op), `session.spawn` `name`, and old-client compatibility. A real hub on a temp
 * PI_REMOTE_DIR and port 0; registry files in a temp overseer dir.
 */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { ControlClient, HubControlError } from "../src/remote/hub/control.ts";
import { Hub, type HubOptions } from "../src/remote/hub/hub.ts";
import type { ModelCatalog } from "../src/remote/hub/models.ts";
import { OverseerIndex, parseRegistry } from "../src/remote/hub/overseers.ts";
import { hubSocketPath } from "../src/remote/paths.ts";
import type { OverseerBoardData, SessionSummary } from "../src/remote/protocol.ts";
import { AppClient, FakeSession, postJson, sleep, summary, untilHistoryIndexed } from "./remote-hub-helpers.ts";

let tmp: string;
let home: string;
let sessionsDir: string;
let overseerDir: string;
let hub: Hub | undefined;
const cleanups: (() => void)[] = [];

const catalog: ModelCatalog = {
	list: async () => ({ models: [], thinkingLevels: [] }),
	has: async () => true,
};

const O = "01aaaaaa-0000-7000-8000-000000000001";

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phi-hub-overseer-"));
	home = join(tmp, "home");
	sessionsDir = join(tmp, "sessions");
	overseerDir = join(tmp, "overseer");
	mkdirSync(join(home, "project"), { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
	vi.stubEnv("PI_REMOTE_DIR", join(tmp, "remote"));
	vi.stubEnv("FAKE_SPAWN_LOG", join(tmp, "spawns.log"));
});

afterEach(async () => {
	for (const fn of cleanups.splice(0)) fn();
	await hub?.stop();
	hub = undefined;
	vi.unstubAllEnvs();
	rmSync(tmp, { recursive: true, force: true });
});

/** Logs its argv, registers with its spawn id, exits when stdin closes. */
const CHILD = String.raw`
import { connect } from "node:net";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_SPAWN_LOG, JSON.stringify({ argv }) + "\n");
const base = { sessionId: "headless-" + process.pid, name: "headless", cwd: process.cwd(), host: "h", pid: process.pid, kind: "headless", status: "idle", startedAt: 1, lastActivityAt: 2 };
const sock = connect(join(process.env.PI_REMOTE_DIR, "hub.sock"));
const send = (f) => sock.write(JSON.stringify(f) + "\n");
sock.on("connect", () => send({ t: "register", v: 1, session: base, spawnId: process.env.PHI_REMOTE_SPAWN_ID }));
let buf = "";
sock.setEncoding("utf8");
sock.on("data", (d) => {
	buf += d;
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
		if (m.t === "req") send({ t: "reply", re: m.id, ok: true, data: {} });
	}
});
process.stdin.resume();
process.stdin.on("end", () => { sock.end(); process.exit(0); });
`;

async function startHub(options: Partial<HubOptions> = {}): Promise<Hub> {
	const script = join(tmp, "child.mjs");
	writeFileSync(script, CHILD);
	hub = new Hub({
		port: 0,
		binds: ["127.0.0.1"],
		home,
		hostname: "test-host",
		version: "9.9.9",
		sessionsDir,
		overseerDir,
		overseerPollMs: 100,
		helloTimeoutMs: 500,
		requestTimeoutMs: 1000,
		upsertThrottleMs: 20,
		pushSender: async () => ({ ok: true, drop: false }),
		pushEnabled: () => false,
		modelCatalog: catalog,
		historyMaxAgeMs: 0,
		resumeLiveGraceMs: 0,
		invocation: { command: process.execPath, args: [script] },
		log: () => {},
		magicDnsLookup: async () => undefined, // no `tailscale status` child per pairing (as in CI)
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

async function connectSession(s: SessionSummary): Promise<FakeSession> {
	const session = await FakeSession.connect(hubSocketPath());
	cleanups.push(() => session.close());
	await session.register(s);
	return session;
}

async function ctl(): Promise<ControlClient> {
	const client = await ControlClient.connect();
	cleanups.push(() => client.close());
	return client;
}

async function request(app: AppClient, frame: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
	const id = `r-${Math.random().toString(36).slice(2)}`;
	app.send({ ...frame, id });
	return app.messages.next((m) => m.re === id && m.t !== "pong", timeoutMs);
}

function record(sessionId: string, name: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name,
		sessionId,
		backend: "headless",
		cwd: join(home, "project"),
		createdAt: 1000,
		watch: { onIdle: true, stallMinutes: 15, heartbeatMinutes: 0 },
		state: "running",
		registered: true,
		...patch,
	};
}

/** Atomic write, as the overseer's registry does (temp file, then rename). */
function writeRegistry(overseerId: string, threads: unknown[]): void {
	mkdirSync(overseerDir, { recursive: true });
	const file = join(overseerDir, `${overseerId}.json`);
	const temp = `${file}.${Math.random().toString(16).slice(2)}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ version: 1, overseerSessionId: overseerId, threads }, null, 2)}\n`);
	renameSync(temp, file);
}

const threadOf = (name: string) => ({ overseer: { sessionId: O, name: "Overseer · ship", thread: name } });

/** The next `session.upsert` of `id` whose session matches; resolves with the session. */
async function upsertFor(
	app: AppClient,
	id: string,
	predicate: (s: any) => boolean = () => true,
	timeoutMs = 3000,
): Promise<any> {
	const frame = await app.messages.next(
		(m) => m.t === "session.upsert" && m.session.sessionId === id && predicate(m.session),
		timeoutMs,
	);
	return frame.session;
}

describe("capability", () => {
	it('advertises "overseer" in welcome.host.features', async () => {
		await startHub();
		const { welcome } = await connectApp();
		expect(welcome.host.features).toContain("overseer");
		expect(welcome.host.features).toContain("history");
	});
});

describe("isOverseer / threadCounts", () => {
	it("are computed from live threads and follow their status, error and departure", async () => {
		await startHub();
		const { app } = await connectApp();
		await connectSession(summary(O, { name: "Overseer · ship" }));
		const plain = await upsertFor(app, O);
		expect(plain.isOverseer).toBeUndefined();
		expect(plain.threadCounts).toBeUndefined();

		const t1 = await connectSession(summary("t1", { kind: "headless", ...threadOf("tests") }));
		const counted = await upsertFor(app, O, (s) => s.isOverseer === true);
		expect(counted.threadCounts).toEqual({ total: 1, working: 0, idle: 1, error: 0, exited: 0, closed: 0 });

		t1.send({ t: "event", sessionId: "t1", event: { type: "state", state: { status: "working" } } });
		const working = await upsertFor(app, O, (s) => s.threadCounts?.working === 1);
		expect(working.threadCounts).toEqual({ total: 1, working: 1, idle: 0, error: 0, exited: 0, closed: 0 });

		t1.send({
			t: "upsert",
			session: summary("t1", {
				kind: "headless",
				status: "idle",
				lastError: "529 overloaded",
				...threadOf("tests"),
			}),
		});
		const errored = await upsertFor(app, O, (s) => s.threadCounts?.error === 1);
		expect(errored.threadCounts).toEqual({ total: 1, working: 0, idle: 0, error: 1, exited: 0, closed: 0 });

		// sessions.list agrees; the thread itself is not an overseer.
		const list = await request(app, { t: "sessions.list" });
		const byId = new Map(list.sessions.map((s: SessionSummary) => [s.sessionId, s]));
		expect((byId.get(O) as SessionSummary).threadCounts?.error).toBe(1);
		expect((byId.get("t1") as SessionSummary).isOverseer).toBeUndefined();

		// The only thread is gone and no registry lists it: no longer an overseer.
		t1.close();
		const gone = await upsertFor(app, O, (s) => s.isOverseer === undefined);
		expect(gone.threadCounts).toBeUndefined();
	});

	it("are computed from the registry file, live status beating registry state", async () => {
		writeRegistry(O, [
			record("t-live", "live one", { state: "closed", lastStatus: "idle" }),
			record("t-exited", "exited one", { state: "exited", createdAt: 2000 }),
			record("t-closed", "closed one", { state: "closed", createdAt: 3000 }),
			record("t-lost", "not registered", { state: "running", createdAt: 4000 }),
		]);
		await startHub();
		const { app } = await connectApp();
		await connectSession(summary("t-live", { kind: "headless", status: "working", ...threadOf("live one") }));
		await connectSession(summary(O, { name: "Overseer · ship" }));
		const list = await request(app, { t: "sessions.list" });
		const overseer = list.sessions.find((s: SessionSummary) => s.sessionId === O);
		expect(overseer.isOverseer).toBe(true);
		expect(overseer.threadCounts).toEqual({ total: 4, working: 1, idle: 0, error: 0, exited: 2, closed: 1 });
		// The control wire and `status` see the same fields.
		const client = await ctl();
		const data = await client.request<{ sessions: SessionSummary[] }>({ op: "sessions.list" });
		expect(data.sessions.find((s) => s.sessionId === O)?.threadCounts?.total).toBe(4);
		expect(hub!.status().sessions.find((s) => s.sessionId === O)?.isOverseer).toBe(true);
	});

	it("ignores isOverseer / threadCounts a session claims for itself", async () => {
		await startHub();
		const { app } = await connectApp();
		await connectSession(
			summary("liar", {
				isOverseer: true,
				threadCounts: { total: 9, working: 9, idle: 0, error: 0, exited: 0, closed: 0 },
			} as Partial<SessionSummary>),
		);
		const list = await request(app, { t: "sessions.list" });
		expect(list.sessions[0].isOverseer).toBeUndefined();
		expect(list.sessions[0].threadCounts).toBeUndefined();
	});

	it("sends a session.upsert for the overseer when its registry file changes", async () => {
		// Long poll: the change must arrive through fs.watch (of a directory that exists at start;
		// one created later is picked up by the poll).
		mkdirSync(overseerDir, { recursive: true });
		await startHub({ overseerPollMs: 60_000 });
		const { app } = await connectApp();
		await connectSession(summary(O, { name: "Overseer · ship" }));
		await upsertFor(app, O);
		await sleep(50);
		writeRegistry(O, [record("t-a", "a", { state: "exited" })]);
		const first = await upsertFor(app, O, (s) => s.isOverseer === true, 4000);
		expect(first.threadCounts).toEqual({ total: 1, working: 0, idle: 0, error: 0, exited: 1, closed: 0 });
		writeRegistry(O, [record("t-a", "a", { state: "closed" }), record("t-b", "b", { createdAt: 5000 })]);
		const second = await upsertFor(app, O, (s) => s.threadCounts?.total === 2, 4000);
		expect(second.threadCounts).toEqual({ total: 2, working: 0, idle: 0, error: 0, exited: 1, closed: 1 });
		rmSync(join(overseerDir, `${O}.json`));
		await upsertFor(app, O, (s) => s.isOverseer === undefined, 4000);
	});

	it("also picks up a registry change through the poll", async () => {
		await startHub({ overseerPollMs: 100 });
		const { app } = await connectApp();
		await connectSession(summary(O));
		await upsertFor(app, O);
		writeRegistry(O, [record("t-a", "a")]);
		const counted = await upsertFor(app, O, (s) => s.isOverseer === true);
		expect(counted.threadCounts.exited).toBe(1);
	});
});

describe("sessions.past", () => {
	let clock = Date.parse("2026-11-05T10:00:00.000Z");
	function store(cwd: string, words: string, name?: string): string {
		const sm = SessionManager.create(cwd, join(sessionsDir, "proj"));
		clock += 1000;
		sm.appendMessage({ role: "user", content: [{ type: "text", text: words }], timestamp: clock });
		if (name) sm.appendSessionInfo(name);
		clock += 1000;
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: clock,
		});
		return sm.getSessionId();
	}

	it("links threads to their overseer from the registry files and marks overseers", async () => {
		const cwd = join(home, "project");
		const overseerId = store(cwd, "Act as overseer", "Overseer · ship it");
		const threadId = store(cwd, "run the tests");
		const loneId = store(cwd, "unrelated");
		writeRegistry(overseerId, [record(threadId, "tests", { state: "exited" })]);
		await startHub();
		const { app } = await connectApp();
		await sleep(200); // first registry scan
		await untilHistoryIndexed(app);
		const past = await request(app, { t: "sessions.past" });
		const byId = new Map<string, any>(past.sessions.map((s: any) => [s.sessionId, s]));
		expect(byId.get(threadId).overseer).toEqual({
			sessionId: overseerId,
			name: "Overseer · ship it",
			thread: "tests",
		});
		expect(byId.get(threadId).isOverseer).toBeUndefined();
		expect(byId.get(overseerId).isOverseer).toBe(true);
		expect(byId.get(overseerId).overseer).toBeUndefined();
		expect(byId.get(loneId).overseer).toBeUndefined();
		expect(byId.get(loneId).isOverseer).toBeUndefined();
	});

	it("prefers a live thread's own overseer link", async () => {
		const cwd = join(home, "project");
		const threadId = store(cwd, "live thread");
		await startHub();
		const { app } = await connectApp();
		await connectSession(summary(threadId, { cwd, ...threadOf("live") }));
		await untilHistoryIndexed(app);
		const past = await request(app, { t: "sessions.past" });
		const entry = past.sessions.find((s: any) => s.sessionId === threadId);
		expect(entry.overseer).toEqual({ sessionId: O, name: "Overseer · ship", thread: "live" });
		expect(entry.live).toBe(true);
	});
});

describe("overseer.board", () => {
	it("merges the registry with live summaries: live, exited, closed, and live threads not yet registered", async () => {
		writeRegistry(O, [
			record("t-run", "runner", {
				model: "anthropic/old-model",
				thinking: "low",
				lastText: "registry text",
				lastError: "old error",
				costUsd: 0.5,
				subagentModels: { default: "anthropic/claude-haiku-4-5", allow: ["anthropic/claude-haiku-4-5"] },
			}),
			record("t-ex", "gone", { state: "exited", exitedAt: 5000, createdAt: 2000, lastText: "bye" }),
			record("t-cl", "done", { state: "closed", closedAt: 6000, createdAt: 3000, backend: "tmux", adopted: true }),
		]);
		await startHub();
		const { app } = await connectApp();
		await connectSession(summary(O, { name: "Overseer · ship" }));
		const runner = await connectSession(
			summary("t-run", {
				kind: "headless",
				status: "working",
				activity: { tool: "bash", summary: "npm test" },
				model: { provider: "anthropic", id: "claude-haiku-4-5" },
				thinkingLevel: "off",
				lastText: "live text",
				usage: { costUsd: 0.75, contextPercent: 12 },
				lastActivityAt: 7000,
				...threadOf("runner"),
			}),
		);
		await connectSession(summary("t-new", { kind: "headless", startedAt: 9000, ...threadOf("fresh") }));
		const board = await request(app, { t: "overseer.board", sessionId: O });
		expect(board.t).toBe("overseer.board");
		expect(board.sessionId).toBe(O);
		expect(board.name).toBe("Overseer · ship");
		expect(board.threads.map((t: any) => [t.name, t.state, t.live])).toEqual([
			["runner", "running", true],
			["gone", "exited", false],
			["done", "closed", false],
			["fresh", "running", true],
		]);
		const [run, ex, cl, fresh] = board.threads;
		expect(run).toMatchObject({
			backend: "headless",
			status: "working",
			activity: "bash npm test",
			model: "anthropic/claude-haiku-4-5",
			thinking: "off",
			lastText: "live text",
			costUsd: 0.75,
			contextPercent: 12,
			lastActivityAt: 7000,
			createdAt: 1000,
			subagentModels: { default: "anthropic/claude-haiku-4-5", allow: ["anthropic/claude-haiku-4-5"] },
		});
		expect(run.lastError).toBeUndefined(); // live summary without an error: the error is gone
		expect(ex).toMatchObject({ backend: "headless", lastText: "bye", exitedAt: 5000, createdAt: 2000 });
		expect(ex.status).toBeUndefined();
		expect(cl).toMatchObject({ backend: "tmux", adopted: true, closedAt: 6000 });
		expect(fresh).toMatchObject({ backend: "headless", status: "idle", createdAt: 9000 });

		// The runner leaves: still on the board from the registry, not live.
		runner.close();
		await upsertFor(app, O, (s) => s.threadCounts?.working === 0);
		const after = await request(app, { t: "overseer.board", sessionId: O });
		expect(after.threads[0]).toMatchObject({
			name: "runner",
			state: "running",
			live: false,
			lastText: "registry text",
		});
		expect(after.threads[0].status).toBeUndefined();
		expect(after.threads[0].lastError).toBe("old error");
	});

	it("shows a thread closed in the registry as closed, and refreshes the file on request", async () => {
		writeRegistry(O, [record("t-1", "one"), record("t-2", "two", { createdAt: 2000 })]);
		await startHub({ overseerPollMs: 60_000 });
		const { app } = await connectApp();
		writeRegistry(O, [
			record("t-1", "one", { state: "closed", closedAt: 9 }),
			record("t-2", "two", { createdAt: 2000 }),
		]);
		const board = await request(app, { t: "overseer.board", sessionId: O });
		expect(board.threads.map((t: any) => t.state)).toEqual(["closed", "running"]);
	});

	it("answers not_found for an unknown overseer and internal for a corrupt registry file", async () => {
		await startHub();
		const { app } = await connectApp();
		expect(await request(app, { t: "overseer.board", sessionId: "nobody" })).toMatchObject({
			t: "error",
			code: "not_found",
		});
		expect(await request(app, { t: "overseer.board", sessionId: "../etc/passwd" })).toMatchObject({
			t: "error",
			code: "not_found",
		});
		expect(await request(app, { t: "overseer.board" })).toMatchObject({ t: "error", code: "bad_request" });
		mkdirSync(overseerDir, { recursive: true });
		writeFileSync(join(overseerDir, `${O}.json`), '{"version":1,"threads":[{"name":"half');
		const corrupt = await request(app, { t: "overseer.board", sessionId: O });
		expect(corrupt).toMatchObject({ t: "error", code: "internal" });
		expect(corrupt.message).toMatch(/unreadable/);
		// The hub is fine and answers the next request.
		await app.sync();
		// An empty registry (no threads yet) is a known overseer with an empty board.
		writeRegistry(O, []);
		expect(await request(app, { t: "overseer.board", sessionId: O })).toMatchObject({ threads: [] });
	});

	it("keeps a corrupt file's last good threads for counts", async () => {
		writeRegistry(O, [record("t-1", "one")]);
		await startHub();
		const { app } = await connectApp();
		await connectSession(summary(O));
		await upsertFor(app, O, (s) => s.isOverseer === true);
		writeFileSync(join(overseerDir, `${O}.json`), "{ not json");
		await sleep(300);
		const list = await request(app, { t: "sessions.list" });
		expect(list.sessions[0].threadCounts.total).toBe(1);
	});

	it("is a control op with the same data", async () => {
		writeRegistry(O, [record("t-1", "one", { state: "exited" })]);
		await startHub();
		const client = await ctl();
		const board = await client.request<OverseerBoardData>({ op: "overseer.board", sessionId: O });
		expect(board).toMatchObject({ sessionId: O, threads: [{ name: "one", state: "exited", live: false }] });
		await expect(client.request({ op: "overseer.board", sessionId: "nobody" })).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(client.request({ op: "overseer.board", sessionId: "nobody" })).rejects.toBeInstanceOf(
			HubControlError,
		);
	});
});

describe("session.spawn name", () => {
	function spawnArgs(): string[][] {
		return readFileSync(join(tmp, "spawns.log"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).argv as string[]);
	}

	it("passes an app's name as --name", async () => {
		await startHub();
		const { app } = await connectApp();
		const ack = await request(app, {
			t: "session.spawn",
			cwd: join(home, "project"),
			name: "  Overseer · refactor the auth flow  ",
		});
		expect(ack).toMatchObject({ t: "ack", ok: true });
		const argv = spawnArgs()[0];
		expect(argv[argv.indexOf("--name") + 1]).toBe("Overseer · refactor the auth flow");
	});

	it("refuses a name with a newline or over 200 characters", async () => {
		await startHub();
		const { app } = await connectApp();
		for (const name of ["two\nlines", "x".repeat(201), "   ", 42]) {
			const ack = await request(app, { t: "session.spawn", cwd: join(home, "project"), name });
			expect(ack).toMatchObject({ t: "ack", ok: false, error: { code: "bad_request" } });
		}
	});

	it("an old app (no features, no name) spawns and lists exactly as before", async () => {
		await startHub();
		const { app } = await connectApp();
		const ack = await request(app, { t: "session.spawn", cwd: join(home, "project"), prompt: "hi" });
		expect(ack).toMatchObject({ t: "ack", ok: true });
		expect(spawnArgs()[0]).not.toContain("--name");
		// Appending `appendSystemPrompt` / `env` stays a control-wire privilege.
		const ack2 = await request(app, {
			t: "session.spawn",
			cwd: join(home, "project"),
			appendSystemPrompt: "x",
			env: { PHI_OVERSEER_SESSION_ID: "o" },
		});
		expect(ack2).toMatchObject({ t: "ack", ok: true });
		const argv2 = spawnArgs()[1];
		expect(argv2).not.toContain("--append-system-prompt");
		const list = await request(app, { t: "sessions.list" });
		for (const s of list.sessions) {
			expect(s.isOverseer).toBeUndefined();
			expect(s.threadCounts).toBeUndefined();
		}
	});
});

describe("registry parsing", () => {
	it("skips malformed records, sorts by createdAt, and rejects non-registries", () => {
		const threads = parseRegistry(
			JSON.stringify({
				threads: [
					record("b", "second", { createdAt: 2 }),
					{ name: "no id" },
					record("a", "first", { createdAt: 1, backend: "nope" }),
					record("c", "first", { createdAt: 1, lastText: "line\none" }),
				],
			}),
		);
		expect(threads.map((t) => t.sessionId)).toEqual(["c", "b"]);
		expect(threads[0].lastText).toBe("line one");
		expect(parseRegistry("{}")).toEqual([]);
		expect(() => parseRegistry("[]")).toThrow(/object/);
		expect(() => parseRegistry('{"threads":3}')).toThrow(/array/);
		expect(() => parseRegistry("{")).toThrow(/JSON/);
	});

	it("re-reads a file only when it changes and ignores temp files", async () => {
		writeRegistry(O, [record("t-1", "one")]);
		writeFileSync(join(overseerDir, `${O}.json.abcd.tmp`), "{ partial");
		const index = new OverseerIndex({ dir: overseerDir });
		expect([...(await index.refresh())]).toEqual([O]);
		expect(index.linkOf("t-1")).toEqual({ overseerSessionId: O, thread: "one" });
		expect((await index.refresh()).size).toBe(0);
		expect(index.hasThreads(O)).toBe(true);
		await index.close();
	});
});
