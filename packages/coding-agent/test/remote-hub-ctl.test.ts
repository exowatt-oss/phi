/**
 * phi remote hub: session control on the local control wire (`ctl` frames, the overseer's API) —
 * a real hub on a temp PI_REMOTE_DIR and port 0, driven through ControlClient, with fake sessions
 * on hub.sock and stand-in headless children for spawns and resumes. Also `phi remote ctl` and the
 * spawn helpers (args, thread env).
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { ctlRequest } from "../src/extensions/remote/control.ts";
import { runRemoteCommand } from "../src/remote/cli.ts";
import { ControlClient, HubControlError } from "../src/remote/hub/control.ts";
import { Hub, type HubOptions } from "../src/remote/hub/hub.ts";
import type { ModelCatalog } from "../src/remote/hub/models.ts";
import {
	buildSpawnArgs,
	cleanChildEnv,
	filterThreadEnv,
	resolveSpawnCwd,
	THREAD_ENV_MAX_VALUE,
} from "../src/remote/hub/spawn.ts";
import { hubSocketPath } from "../src/remote/paths.ts";
import type { CtlSessionsData, CtlSnapshotData, CtlSpawnData, SessionSummary } from "../src/remote/protocol.ts";
import { FakeSession, sleep, summary } from "./remote-hub-helpers.ts";

let tmp: string;
let home: string;
let hub: Hub | undefined;
const cleanups: (() => void)[] = [];

const catalog: ModelCatalog = {
	list: async () => ({ models: [], thinkingLevels: [] }),
	has: async (_provider, modelId) => modelId === undefined || modelId === "claude-test",
};

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phi-hub-ctl-"));
	home = join(tmp, "home");
	mkdirSync(join(home, "project"), { recursive: true });
	mkdirSync(join(tmp, "outside"), { recursive: true });
	mkdirSync(join(tmp, "sessions"), { recursive: true });
	vi.stubEnv("PI_REMOTE_DIR", join(tmp, "remote"));
	vi.stubEnv("FAKE_SPAWN_LOG", join(tmp, "spawns.log"));
});

afterEach(async () => {
	for (const fn of cleanups.splice(0)) fn();
	await hub?.stop();
	hub = undefined;
	rmSync(tmp, { recursive: true, force: true });
});

/**
 * A stand-in for `phi --mode rpc [--session <file>]`: logs its argv, cwd and PHI_/FOO/PATH env to
 * FAKE_SPAWN_LOG, registers with its spawn id (and the stored file's session id when resuming),
 * records prompts in its summary name, answers snapshot with one user item per prompt, and exits
 * when the hub closes its stdin. FAKE_EXIT_EARLY: exit 4 before connecting.
 */
const CHILD = String.raw`
import { connect } from "node:net";
import { join } from "node:path";
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PHI_") || k === "FOO" || k === "PATH"));
appendFileSync(process.env.FAKE_SPAWN_LOG, JSON.stringify({ pid: process.pid, argv, cwd: process.cwd(), env }) + "\n");
if (process.env.FAKE_EXIT_EARLY) { process.stderr.write("boom: no model\n"); process.exit(4); }
const at = argv.indexOf("--session");
const file = at >= 0 ? argv[at + 1] : undefined;
const sessionId = file ? JSON.parse(readFileSync(file, "utf8").split("\n")[0]).id : "headless-" + process.pid;
const overseer = process.env.PHI_OVERSEER_SESSION_ID ? { sessionId: process.env.PHI_OVERSEER_SESSION_ID, thread: process.env.PHI_OVERSEER_THREAD } : undefined;
const base = { sessionId, name: "headless", cwd: process.cwd(), host: "h", pid: process.pid, kind: "headless", status: "idle", startedAt: 1, lastActivityAt: 2, ...(overseer ? { overseer } : {}) };
const delay = Number(process.env.FAKE_REGISTER_DELAY_MS || 0);
const sock = connect(join(process.env.PI_REMOTE_DIR, "hub.sock"));
const send = (f) => sock.write(JSON.stringify(f) + "\n");
const prompts = [];
sock.on("connect", () => setTimeout(() => send({ t: "register", v: 1, session: base, spawnId: process.env.PHI_REMOTE_SPAWN_ID }), delay));
let buf = "";
sock.setEncoding("utf8");
sock.on("data", (d) => {
	buf += d;
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
		if (m.t !== "req") continue;
		if (m.op === "snapshot") {
			send({ t: "reply", re: m.id, ok: true, data: { items: prompts.map((text, i) => ({ id: "u" + i, ts: i, kind: "user", text })), hasMore: false, state: { status: "idle" } } });
			continue;
		}
		send({ t: "reply", re: m.id, ok: true, data: {} });
		if (m.op === "prompt") { prompts.push(m.args.text); send({ t: "upsert", session: { ...base, name: "prompts:" + prompts.join("|") } }); }
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
		sessionsDir: join(tmp, "sessions"),
		requestTimeoutMs: 1000,
		upsertThrottleMs: 20,
		pushSender: async () => ({ ok: true, drop: false }),
		pushEnabled: () => false,
		modelCatalog: catalog,
		historyMaxAgeMs: 0,
		resumeLiveGraceMs: 0,
		invocation: { command: process.execPath, args: [script] },
		log: () => {},
		...options,
	});
	await hub.start();
	return hub;
}

async function control(): Promise<ControlClient> {
	const client = await ControlClient.connect();
	cleanups.push(() => client.close());
	return client;
}

async function connectSession(): Promise<FakeSession> {
	const session = await FakeSession.connect(hubSocketPath());
	cleanups.push(() => session.close());
	return session;
}

/** The request's error as `{ code, message }` (fails the test if it succeeds). */
async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(HubControlError);
		return { code: (error as HubControlError).code, message: (error as Error).message };
	}
	throw new Error("expected the request to fail");
}

function spawnLog(): { pid: number; argv: string[]; cwd: string; env: Record<string, string> }[] {
	try {
		return readFileSync(join(tmp, "spawns.log"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function child(parent: string, runId: string): SessionSummary {
	return summary(`${parent}~sa~${runId}`, {
		name: `sub ${runId}`,
		kind: "subagent",
		parentSessionId: parent,
		status: "working",
		subagent: { runId, task: "do a thing", status: "running", startedAt: 1 },
	});
}

describe("ctl sessions.list", () => {
	it("lists live sessions with their overseer link and last error; subagent threads only on request", async () => {
		await startHub();
		const ctl = await control();
		const session = await connectSession();
		await session.register(
			summary("t1", {
				overseer: { sessionId: "ov-1", name: "boss", thread: "fix-tests" },
				lastError: "429 rate limited\nretry later",
				lastActivityAt: 10,
			}),
		);
		session.send({ t: "child.upsert", session: child("t1", "r1") });
		const other = await connectSession();
		// Malformed overseer links and errors are dropped, never passed on.
		await other.register(
			summary("s2", { overseer: { name: "no id" } as never, lastError: 7 as never, lastActivityAt: 5 }),
		);
		await vi.waitFor(() => expect(hub!.status().sessions).toHaveLength(3));

		const plain = await ctl.request<CtlSessionsData>({ op: "sessions.list" });
		expect(plain.sessions.map((s) => s.sessionId)).toEqual(["t1", "s2"]);
		expect(plain.sessions[0]).toMatchObject({
			overseer: { sessionId: "ov-1", name: "boss", thread: "fix-tests" },
			lastError: "429 rate limited retry later",
		});
		expect(plain.sessions[1]).not.toHaveProperty("overseer");
		expect(plain.sessions[1]).not.toHaveProperty("lastError");

		const all = await ctl.request<CtlSessionsData>({ op: "sessions.list", subagents: true });
		expect(all.sessions.map((s) => s.sessionId).sort()).toEqual(["s2", "t1", "t1~sa~r1"]);
		expect(all.sessions.find((s) => s.kind === "subagent")).toMatchObject({ parentSessionId: "t1" });
	});
});

describe("ctl session.spawn", () => {
	it("replies after the child registers, with its id, folder and pid, then delivers the prompt", async () => {
		await startHub();
		vi.stubEnv("FAKE_REGISTER_DELAY_MS", "300");
		const ctl = await control();
		const started = Date.now();
		const reply = await ctl.request<CtlSpawnData>(
			{
				op: "session.spawn",
				cwd: join(tmp, "outside"), // outside $HOME: no allowed-roots check on the control wire
				prompt: "run the tests",
				modelId: "claude-test",
				thinkingLevel: "high",
				name: "fix-tests",
				appendSystemPrompt: "You are thread fix-tests.\nReport when done.",
			},
			20_000,
		);
		expect(Date.now() - started).toBeGreaterThanOrEqual(300);
		const spawned = spawnLog();
		expect(spawned).toHaveLength(1);
		expect(reply).toEqual({
			sessionId: `headless-${spawned[0].pid}`,
			cwd: realpathSync(join(tmp, "outside")),
			pid: spawned[0].pid,
		});
		expect(spawned[0].cwd).toBe(realpathSync(join(tmp, "outside")));
		expect(spawned[0].argv).toEqual([
			"--mode",
			"rpc",
			"--model",
			"claude-test",
			"--thinking",
			"high",
			"--name",
			"fix-tests",
			"--append-system-prompt",
			"You are thread fix-tests.\nReport when done.",
		]);
		// Already listed when the reply arrives; the prompt follows the registration.
		const list = await ctl.request<CtlSessionsData>({ op: "sessions.list" });
		expect(list.sessions.map((s) => s.sessionId)).toContain(reply.sessionId);
		await vi.waitFor(
			() =>
				expect(hub!.status().sessions.find((s) => s.sessionId === reply.sessionId)?.name).toBe(
					"prompts:run the tests",
				),
			{ timeout: 5000 },
		);
		const snapshot = await ctl.request<CtlSnapshotData>({ op: "session.snapshot", sessionId: reply.sessionId });
		expect(snapshot.items).toEqual([{ id: "u0", ts: 0, kind: "user", text: "run the tests" }]);
	});

	it("passes only thread variables from env, after scrubbing the hub's own", async () => {
		// A hub started from inside a thread must not hand its overseer link to every child.
		vi.stubEnv("PHI_OVERSEER_SESSION_ID", "hub-own");
		vi.stubEnv("PHI_SUBAGENT_MODEL_DEFAULT", "hub/model");
		await startHub();
		const ctl = await control();
		const plain = await ctl.request<CtlSpawnData>({ op: "session.spawn", cwd: join(home, "project") }, 20_000);
		const threaded = await ctl.request<CtlSpawnData>(
			{
				op: "session.spawn",
				cwd: "~/project",
				env: {
					PHI_OVERSEER_SESSION_ID: "ov-1",
					PHI_OVERSEER_NAME: "boss",
					PHI_OVERSEER_THREAD: "t1",
					PHI_SUBAGENT_MODEL_DEFAULT: "gateway/example-medium:max",
					PHI_SUBAGENT_MODEL_ALLOW: "gateway/example-medium:*,anthropic/claude-sonnet-5:medium",
					PHI_REMOTE_SPAWN_ID: "forged",
					PHI_REMOTE: "0",
					PATH: "/nowhere",
					FOO: "bar",
					PHI_OVERSEER_HUGE: "x".repeat(THREAD_ENV_MAX_VALUE + 1),
					PHI_OVERSEER_NUMBER: 5 as never,
				},
			},
			20_000,
		);
		const byPid = new Map(spawnLog().map((entry) => [entry.pid, entry]));
		const plainEnv = byPid.get(plain.pid!)!.env;
		expect(plainEnv.PHI_OVERSEER_SESSION_ID).toBeUndefined();
		expect(plainEnv.PHI_SUBAGENT_MODEL_DEFAULT).toBeUndefined();
		const env = byPid.get(threaded.pid!)!.env;
		expect(env).toMatchObject({
			PHI_OVERSEER_SESSION_ID: "ov-1",
			PHI_OVERSEER_NAME: "boss",
			PHI_OVERSEER_THREAD: "t1",
			PHI_SUBAGENT_MODEL_DEFAULT: "gateway/example-medium:max",
			PHI_SUBAGENT_MODEL_ALLOW: "gateway/example-medium:*,anthropic/claude-sonnet-5:medium",
		});
		expect(env.PHI_REMOTE_SPAWN_ID).not.toBe("forged"); // it registered with the hub's own id
		expect(env.PHI_REMOTE).toBeUndefined();
		expect(env.PATH).toBe(process.env.PATH);
		expect(env.FOO).toBeUndefined();
		expect(env.PHI_OVERSEER_HUGE).toBeUndefined();
		expect(env.PHI_OVERSEER_NUMBER).toBeUndefined();
		// The thread reports its overseer back in its summary.
		const list = await ctl.request<CtlSessionsData>({ op: "sessions.list" });
		expect(list.sessions.find((s) => s.sessionId === threaded.sessionId)?.overseer).toEqual({
			sessionId: "ov-1",
			thread: "t1",
		});
	});

	it("validates the folder, model, name, system prompt and env before starting anything", async () => {
		await startHub();
		const ctl = await control();
		writeFileSync(join(home, "file.txt"), "x");
		const cases: [Record<string, unknown>, string, string][] = [
			[{}, "bad_request", "cwd is required"],
			[{ cwd: "relative/dir" }, "bad_request", "cwd must be an absolute path"],
			[{ cwd: join(home, "missing") }, "bad_request", "No such directory"],
			[{ cwd: join(home, "file.txt") }, "bad_request", "Not a directory"],
			[{ cwd: home, modelId: "no-such-model" }, "not_found", "unknown model"],
			[{ cwd: home, thinkingLevel: "bogus" }, "bad_request", "invalid thinkingLevel"],
			[{ cwd: home, name: "  " }, "bad_request", "name must be"],
			[{ cwd: home, name: "two\nlines" }, "bad_request", "name must be"],
			[{ cwd: home, name: "x".repeat(201) }, "bad_request", "name must be"],
			[{ cwd: home, appendSystemPrompt: 3 }, "bad_request", "appendSystemPrompt must be"],
			[{ cwd: home, env: "PHI_OVERSEER_SESSION_ID=x" }, "bad_request", "env must be an object"],
		];
		for (const [args, code, message] of cases) {
			const error = await failure(ctl.request({ op: "session.spawn", ...args } as never));
			expect(error.code).toBe(code);
			expect(error.message).toContain(message);
		}
		expect(spawnLog()).toEqual([]);
	});

	it("reports a child that exits before registering", async () => {
		await startHub();
		vi.stubEnv("FAKE_EXIT_EARLY", "1");
		const ctl = await control();
		const error = await failure(ctl.request({ op: "session.spawn", cwd: home }, 20_000));
		expect(error).toEqual({ code: "internal", message: "headless session exited (code 4): boom: no model" });
	});

	it("times out a child that never registers", async () => {
		await startHub({ spawnTimeoutMs: 300 });
		vi.stubEnv("FAKE_REGISTER_DELAY_MS", "5000");
		const ctl = await control();
		const error = await failure(ctl.request({ op: "session.spawn", cwd: home }, 5000));
		expect(error).toEqual({ code: "internal", message: "headless session did not connect in time" });
	});
});

describe("ctl requests forwarded to a live session", () => {
	it("prompt, abort, setModel, setThinking and history reach the session; its errors pass through", async () => {
		await startHub();
		const ctl = await control();
		const session = await connectSession();
		await session.register(summary("s1", { status: "working" }));

		const prompted = ctl.request({ op: "session.prompt", sessionId: "s1", text: "/compact", mode: "followUp" });
		const prompt = await session.nextReq("prompt");
		expect(prompt).toMatchObject({ args: { text: "/compact", mode: "followUp" } });
		expect(prompt).not.toHaveProperty("sessionId");
		session.reply(prompt.id, {});
		expect(await prompted).toEqual({});

		const defaulted = ctl.request({ op: "session.prompt", sessionId: "s1", text: "hello" });
		const auto = await session.nextReq("prompt");
		expect(auto.args).toEqual({ text: "hello", mode: "auto" });
		session.reply(auto.id, {});
		await defaulted;

		const aborted = ctl.request({ op: "session.abort", sessionId: "s1" });
		session.reply((await session.nextReq("abort")).id, {});
		expect(await aborted).toEqual({});

		const model = ctl.request({ op: "session.setModel", sessionId: "s1", provider: "anthropic", modelId: "x" });
		const setModel = await session.nextReq("setModel");
		expect(setModel.args).toEqual({ provider: "anthropic", modelId: "x" });
		session.send({
			t: "reply",
			re: setModel.id,
			ok: false,
			error: { code: "not_found", message: "no model anthropic/x" },
		});
		expect(await failure(model)).toEqual({ code: "not_found", message: "no model anthropic/x" });

		const thinking = ctl.request({ op: "session.setThinking", sessionId: "s1", level: "low" });
		const setThinking = await session.nextReq("setThinking");
		expect(setThinking.args).toEqual({ level: "low" });
		session.reply(setThinking.id, {});
		expect(await thinking).toEqual({});

		const history = ctl.request({ op: "session.history", sessionId: "s1", before: "u:9", limit: 9999 });
		const historyReq = await session.nextReq("history");
		expect(historyReq.args).toEqual({ before: "u:9", limit: 500 });
		session.reply(historyReq.id, { items: [{ id: "u:1", ts: 1, kind: "user", text: "old" }], hasMore: true });
		expect(await history).toEqual({ items: [{ id: "u:1", ts: 1, kind: "user", text: "old" }], hasMore: true });

		// A session that does not answer times out as session_offline.
		const silent = ctl.request({ op: "session.abort", sessionId: "s1" });
		await session.nextReq("abort");
		expect((await failure(silent)).code).toBe("session_offline");
	});

	it("refuses bad arguments and unknown sessions without forwarding", async () => {
		await startHub();
		const ctl = await control();
		const session = await connectSession();
		await session.register(summary("s1"));
		session.send({ t: "child.upsert", session: child("s1", "r1") });
		await vi.waitFor(() => expect(hub!.status().sessions).toHaveLength(2));
		const cases: [Record<string, unknown>, string, string][] = [
			[{ op: "session.prompt", sessionId: "nope", text: "hi" }, "not_found", "no live session nope"],
			[{ op: "session.prompt", text: "hi" }, "bad_request", "sessionId is required"],
			[{ op: "session.prompt", sessionId: "s1" }, "bad_request", "text is required"],
			[{ op: "session.prompt", sessionId: "s1", text: "  " }, "bad_request", "text is required"],
			[{ op: "session.prompt", sessionId: "s1", text: "hi", mode: "now" }, "bad_request", "mode must be"],
			[{ op: "session.setModel", sessionId: "s1", provider: "anthropic" }, "bad_request", "provider and modelId"],
			[{ op: "session.setThinking", sessionId: "s1" }, "bad_request", "level is required"],
			[{ op: "session.history", sessionId: "s1" }, "bad_request", "before is required"],
			[{ op: "session.snapshot", sessionId: "s1", limit: 0 }, "bad_request", "limit must be"],
			[{ op: "session.setModel", sessionId: "s1~sa~r1", provider: "a", modelId: "b" }, "bad_request", "subagent"],
			[{ op: "session.close", sessionId: "s1~sa~r1" }, "bad_request", "subagent"],
			[{ op: "session.bogus", sessionId: "s1" }, "bad_request", "unknown control op"],
		];
		for (const [op, code, message] of cases) {
			const error = await failure(ctl.request(op as never));
			expect(error.code).toBe(code);
			expect(error.message).toContain(message);
		}
		await sleep(50);
		expect(session.messages.pending((m) => m.t === "req")).toEqual([]);
		// A subagent thread takes prompts (served by its parent's connection).
		const steer = ctl.request({ op: "session.prompt", sessionId: "s1~sa~r1", text: "faster" });
		const req = await session.nextReq("prompt");
		expect(req.sessionId).toBe("s1~sa~r1");
		session.reply(req.id, {});
		expect(await steer).toEqual({});
	});

	it("snapshot replies with items, hasMore, state and the session's summary", async () => {
		await startHub();
		const ctl = await control();
		const session = await connectSession();
		await session.register(summary("s1", { name: "Fix the build", status: "working", lastError: "boom" }));
		const pending = ctl.request<CtlSnapshotData>({ op: "session.snapshot", sessionId: "s1", limit: 20 });
		const req = await session.nextReq("snapshot");
		expect(req.args).toEqual({ limit: 20 });
		session.reply(req.id, {
			items: [{ id: "a:1", ts: 1, kind: "assistant", text: "working on it" }],
			hasMore: true,
			state: { status: "working", activity: { tool: "bash", summary: "bash  make" } },
		});
		const snapshot = await pending;
		expect(snapshot).toEqual({
			items: [{ id: "a:1", ts: 1, kind: "assistant", text: "working on it" }],
			hasMore: true,
			state: { status: "working", activity: { tool: "bash", summary: "bash  make" } },
			summary: expect.objectContaining({ sessionId: "s1", name: "Fix the build", lastError: "boom" }),
		});
		// A session that sends no state: the hub's view of it.
		const bare = ctl.request<CtlSnapshotData>({ op: "session.snapshot", sessionId: "s1" });
		const bareReq = await session.nextReq("snapshot");
		expect(bareReq.args).toEqual({ limit: 120 });
		session.reply(bareReq.id, {});
		expect(await bare).toMatchObject({ items: [], hasMore: false, state: { status: "working" } });
	});
});

describe("ctl session.close", () => {
	it("closes an interactive session only for its own overseer, forwarding the overseer id", async () => {
		await startHub();
		const ctl = await control();
		const thread = await connectSession();
		await thread.register(summary("t1", { overseer: { sessionId: "ov-1", thread: "fix" } }));
		const plain = await connectSession();
		await plain.register(summary("s2"));

		expect(await failure(ctl.request({ op: "session.close", sessionId: "t1" }))).toEqual({
			code: "forbidden",
			message: "an interactive session can be closed only by its own overseer",
		});
		expect((await failure(ctl.request({ op: "session.close", sessionId: "t1", overseer: "ov-2" }))).code).toBe(
			"forbidden",
		);
		expect((await failure(ctl.request({ op: "session.close", sessionId: "s2", overseer: "ov-1" }))).code).toBe(
			"forbidden",
		);
		await sleep(50);
		expect(thread.messages.pending((m) => m.t === "req")).toEqual([]);
		expect(plain.messages.pending((m) => m.t === "req")).toEqual([]);

		const closing = ctl.request({ op: "session.close", sessionId: "t1", overseer: "ov-1" });
		const req = await thread.nextReq("close");
		expect(req.args).toEqual({ overseer: "ov-1" });
		thread.reply(req.id, {});
		expect(await closing).toEqual({});

		// The session is the final judge: its refusal passes through.
		const refused = ctl.request({ op: "session.close", sessionId: "t1", overseer: "ov-1" });
		const again = await thread.nextReq("close");
		thread.send({
			t: "reply",
			re: again.id,
			ok: false,
			error: { code: "forbidden", message: "only headless sessions can be closed remotely" },
		});
		expect((await failure(refused)).code).toBe("forbidden");

		// Gone while asking is closed.
		const gone = ctl.request({ op: "session.close", sessionId: "t1", overseer: "ov-1" });
		await thread.nextReq("close");
		thread.close();
		expect(await gone).toEqual({});
	});

	it("closes a headless session it started, which then leaves the list", async () => {
		await startHub();
		const ctl = await control();
		const spawned = await ctl.request<CtlSpawnData>({ op: "session.spawn", cwd: home }, 20_000);
		expect(await ctl.request({ op: "session.close", sessionId: spawned.sessionId })).toEqual({});
		await vi.waitFor(
			async () => {
				const list = await ctl.request<CtlSessionsData>({ op: "sessions.list" });
				expect(list.sessions.map((s) => s.sessionId)).not.toContain(spawned.sessionId);
			},
			{ timeout: 5000 },
		);
	});
});

describe("ctl session.transcript and session.resume", () => {
	let clock = Date.parse("2026-11-01T10:00:00.000Z");

	function storeSession(cwd: string, words: string): { id: string; path: string } {
		const sm = SessionManager.create(cwd, join(tmp, "sessions", "proj"));
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		clock += 1000;
		sm.appendMessage({ role: "user", content: [{ type: "text", text: `Tell me about ${words}` }], timestamp: clock });
		clock += 1000;
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `All about ${words}.` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage,
			stopReason: "stop",
			timestamp: clock,
		});
		return { id: sm.getSessionId(), path: sm.getSessionFile() as string };
	}

	it("reads a stored transcript, resumes it headless with thread env, and then reads it live", async () => {
		const stored = storeSession(join(home, "project"), "otters");
		await startHub();
		const ctl = await control();
		const page = await ctl.request<{ items: { kind: string; text: string }[]; hasMore: boolean }>({
			op: "session.transcript",
			sessionId: stored.id,
		});
		expect(page.hasMore).toBe(false);
		expect(page.items.map((item) => [item.kind, item.text])).toEqual([
			["user", "Tell me about otters"],
			["assistant", "All about otters."],
		]);
		expect((await failure(ctl.request({ op: "session.transcript", sessionId: "nope" }))).code).toBe("not_found");

		const resumed = await ctl.request<CtlSpawnData>(
			{
				op: "session.resume",
				sessionId: stored.id,
				prompt: "and beavers?",
				env: { PHI_OVERSEER_SESSION_ID: "ov-9", FOO: "bar" },
			},
			20_000,
		);
		const spawned = spawnLog();
		expect(spawned).toHaveLength(1);
		expect(resumed).toEqual({ sessionId: stored.id, cwd: join(home, "project"), pid: spawned[0].pid });
		expect(spawned[0].argv).toEqual([
			"--mode",
			"rpc",
			"--session",
			stored.path,
			"--session-cwd",
			join(home, "project"),
		]);
		expect(spawned[0].env.PHI_OVERSEER_SESSION_ID).toBe("ov-9");
		expect(spawned[0].env.FOO).toBeUndefined();
		await vi.waitFor(
			() => expect(hub!.status().sessions.find((s) => s.sessionId === stored.id)?.name).toBe("prompts:and beavers?"),
			{ timeout: 5000 },
		);
		// Live now: the transcript comes from the session, and a second resume starts nothing.
		const live = await ctl.request<{ items: unknown[] }>({ op: "session.transcript", sessionId: stored.id });
		expect(live.items).toEqual([{ id: "u0", ts: 0, kind: "user", text: "and beavers?" }]);
		expect(await ctl.request({ op: "session.resume", sessionId: stored.id })).toEqual({
			sessionId: stored.id,
			cwd: realpathSync(join(home, "project")), // where it runs, as the session reports it
			pid: spawned[0].pid,
		});
		expect(spawnLog()).toHaveLength(1);
		expect((await failure(ctl.request({ op: "session.resume", sessionId: "nope" }))).code).toBe("not_found");
		expect((await failure(ctl.request({ op: "session.resume", sessionId: stored.id, env: [] as never }))).code).toBe(
			"bad_request",
		);
	});

	it("reports cwdFallback when the stored folder is gone", async () => {
		const gone = join(home, "project", "removed-worktree");
		mkdirSync(gone);
		const stored = storeSession(gone, "moles");
		rmSync(gone, { recursive: true });
		await startHub();
		const ctl = await control();
		expect(await ctl.request<CtlSpawnData>({ op: "session.resume", sessionId: stored.id }, 20_000)).toMatchObject({
			sessionId: stored.id,
			cwd: join(home, "project"),
			cwdFallback: true,
		});
	});
});

describe("ctl from the session side and the CLI", () => {
	it("ctlRequest rejects with the hub's error code", async () => {
		await startHub();
		const error = await ctlRequest({ op: "session.abort", sessionId: "nope" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HubControlError);
		expect(error).toMatchObject({ code: "not_found", message: "no live session nope" });
	});

	/** Run `phi remote ctl ...` in-process, capturing stdout and stderr. */
	async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		let stdout = "";
		let stderr = "";
		const capture = (sink: (text: string) => void) =>
			((chunk: unknown, ...rest: unknown[]) => {
				sink(String(chunk));
				const callback = rest.find((value) => typeof value === "function") as (() => void) | undefined;
				callback?.();
				return true;
			}) as typeof process.stdout.write;
		const out = vi.spyOn(process.stdout, "write").mockImplementation(
			capture((text) => {
				stdout += text;
			}),
		);
		const err = vi.spyOn(process.stderr, "write").mockImplementation(
			capture((text) => {
				stderr += text;
			}),
		);
		try {
			const code = await runRemoteCommand(["ctl", ...args]);
			return { code, stdout, stderr };
		} finally {
			out.mockRestore();
			err.mockRestore();
		}
	}

	it("phi remote ctl prints reply data as JSON, errors as JSON on stderr", async () => {
		const offline = await cli('{"op":"sessions.list"}');
		expect(offline.code).toBe(1);
		expect(JSON.parse(offline.stderr)).toMatchObject({ code: "hub_offline" });

		await startHub();
		const session = await connectSession();
		await session.register(summary("s1", { overseer: { sessionId: "ov-1" } }));
		const listed = await cli('{"op":"sessions.list"}');
		expect(listed.code).toBe(0);
		expect(listed.stderr).toBe("");
		expect(JSON.parse(listed.stdout)).toMatchObject({
			sessions: [{ sessionId: "s1", overseer: { sessionId: "ov-1" } }],
		});

		const missing = await cli('{"op":"session.snapshot","sessionId":"nope"}');
		expect(missing.code).toBe(1);
		expect(missing.stdout).toBe("");
		expect(JSON.parse(missing.stderr)).toEqual({ code: "not_found", message: "no live session nope" });

		const status = await cli('{"op":"status","t":"ignored","id":"ignored"}');
		expect(status.code).toBe(0);
		expect(JSON.parse(status.stdout)).toMatchObject({ hubId: hub!.hubId });

		expect(JSON.parse((await cli("{not json")).stderr)).toMatchObject({ code: "bad_request" });
		expect(JSON.parse((await cli('{"sessionId":"s1"}')).stderr)).toMatchObject({ code: "bad_request" });
		expect(JSON.parse((await cli("[1]")).stderr)).toMatchObject({ code: "bad_request" });
		expect((await cli()).code).toBe(2);
		expect((await cli("{}", "extra")).code).toBe(2);
		expect((await cli("--help")).code).toBe(0);
	});
});

describe("spawn helpers", () => {
	it("passes name and appendSystemPrompt as --name / --append-system-prompt, dropping unusable values", () => {
		const base = { command: "/bin/phi", args: [] };
		expect(buildSpawnArgs(base, { name: " fix-tests ", appendSystemPrompt: "--be terse" })).toEqual([
			"--mode",
			"rpc",
			"--name",
			"fix-tests",
			"--append-system-prompt",
			"--be terse",
		]);
		expect(buildSpawnArgs(base, { modelId: "m", thinkingLevel: "low", name: "n" })).toEqual([
			"--mode",
			"rpc",
			"--model",
			"m",
			"--thinking",
			"low",
			"--name",
			"n",
		]);
		for (const bad of ["", "   ", "a\0b", "x".repeat(201)]) {
			expect(buildSpawnArgs(base, { name: bad })).toEqual(["--mode", "rpc"]);
		}
		for (const bad of ["", "   ", "a\0b", "y".repeat(64 * 1024 + 1)]) {
			expect(buildSpawnArgs(base, { appendSystemPrompt: bad })).toEqual(["--mode", "rpc"]);
		}
	});

	it("filters thread env to the allowlist with short string values", () => {
		expect(
			filterThreadEnv({
				PHI_OVERSEER_SESSION_ID: "a",
				PHI_OVERSEER_NAME: "b",
				PHI_OVERSEER_THREAD: "c",
				PHI_OVERSEER_EXTRA: "d",
				PHI_SUBAGENT_MODEL_DEFAULT: "e",
				PHI_SUBAGENT_MODEL_ALLOW: "",
				PHI_SUBAGENT_MODEL_: "bare prefix",
				PHI_OVERSEER_NUL: "x\0y",
				PHI_OVERSEER_LONG: "z".repeat(THREAD_ENV_MAX_VALUE + 1),
				PHI_OVERSEER_MAX: "z".repeat(THREAD_ENV_MAX_VALUE),
				phi_overseer_lower: "f",
				PHI_REMOTE_SPAWN_ID: "g",
				PI_SUBAGENT_ID: "h",
				PATH: "/x",
				PHI_OVERSEER_OBJ: { a: 1 },
			}),
		).toEqual({
			PHI_OVERSEER_SESSION_ID: "a",
			PHI_OVERSEER_NAME: "b",
			PHI_OVERSEER_THREAD: "c",
			PHI_OVERSEER_EXTRA: "d",
			PHI_SUBAGENT_MODEL_DEFAULT: "e",
			PHI_SUBAGENT_MODEL_ALLOW: "",
			PHI_OVERSEER_MAX: "z".repeat(THREAD_ENV_MAX_VALUE),
		});
		for (const value of [undefined, null, "PHI_OVERSEER_SESSION_ID=a", ["PHI_OVERSEER_SESSION_ID"], 3]) {
			expect(filterThreadEnv(value)).toEqual({});
		}
	});

	it("scrubs thread variables inherited by the hub from its children", () => {
		expect(
			cleanChildEnv({
				A: "1",
				PHI_OVERSEER_SESSION_ID: "x",
				PHI_OVERSEER_THREAD: "t",
				PHI_SUBAGENT_MODEL_DEFAULT: "m",
				PHI_SUBAGENTS: "kept",
			}),
		).toEqual({ A: "1", PHI_SUBAGENTS: "kept" });
	});

	it("resolves a control-wire cwd anywhere, but only an existing directory", () => {
		expect(resolveSpawnCwd(join(tmp, "outside"), home)).toEqual({ cwd: realpathSync(join(tmp, "outside")) });
		expect(resolveSpawnCwd("~/project", home)).toEqual({ cwd: realpathSync(join(home, "project")) });
		expect(resolveSpawnCwd("~", home)).toEqual({ cwd: realpathSync(home) });
		expect(resolveSpawnCwd(join(tmp, "nope"), home)).toMatchObject({ error: { code: "bad_request" } });
		expect(resolveSpawnCwd("rel", home)).toMatchObject({ error: { code: "bad_request" } });
		expect(resolveSpawnCwd(undefined, home)).toMatchObject({ error: { code: "bad_request" } });
	});
});
