/**
 * phi remote hub: subagent sessions (`child.upsert` / `child.remove` on a session connection) and
 * the `hello.features` gate that keeps them away from apps that do not know them.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlClient } from "../src/remote/hub/control.ts";
import { Hub } from "../src/remote/hub/hub.ts";
import type { ModelCatalog } from "../src/remote/hub/models.ts";
import { hubSocketPath } from "../src/remote/paths.ts";
import type { SessionSummary } from "../src/remote/protocol.ts";
import { AppClient, FakeSession, postJson, sleep, summary } from "./remote-hub-helpers.ts";

let tmp: string;
let hub: Hub | undefined;
let pushes: { sessionId: unknown }[];
const cleanups: (() => void)[] = [];

const catalog: ModelCatalog = {
	list: async () => ({ models: [], thinkingLevels: [] }),
	has: async () => true,
};

beforeEach(async () => {
	tmp = mkdtempSync(join(tmpdir(), "phi-remote-hub-sa-"));
	mkdirSync(join(tmp, "home"), { recursive: true });
	vi.stubEnv("PI_REMOTE_DIR", join(tmp, "remote"));
	pushes = [];
	hub = new Hub({
		port: 0,
		binds: ["127.0.0.1"],
		home: join(tmp, "home"),
		hostname: "test-host",
		version: "9.9.9",
		sessionsDir: join(tmp, "sessions"),
		helloTimeoutMs: 300,
		requestTimeoutMs: 400,
		upsertThrottleMs: 50,
		pushDebounceMs: 20,
		pushSender: async (_registration, _alert, payload) => {
			pushes.push({ sessionId: payload.sessionId });
			return { ok: true, status: 200, drop: false };
		},
		pushEnabled: () => true,
		modelCatalog: catalog,
		log: () => {},
	});
	await hub.start();
});

afterEach(async () => {
	for (const fn of cleanups.splice(0)) fn();
	await hub?.stop();
	hub = undefined;
	vi.unstubAllEnvs();
	rmSync(tmp, { recursive: true, force: true });
});

async function pairedApp(features?: string[]): Promise<AppClient> {
	const info = await hub!.createPair();
	const paired = await postJson(`http://127.0.0.1:${hub!.port}/v1/pair`, {
		code: info.code,
		deviceName: features ? "new app" : "old app",
		platform: "ios",
	});
	const app = new AppClient(`ws://127.0.0.1:${hub!.port}/v1/ws`);
	cleanups.push(() => app.close());
	await app.opened();
	app.send({
		t: "hello",
		token: paired.body.token,
		app: { version: "t", build: "1" },
		...(features ? { features } : {}),
	});
	await app.messages.next((m) => m.t === "welcome");
	return app;
}

async function session(): Promise<FakeSession> {
	const s = await FakeSession.connect(hubSocketPath());
	cleanups.push(() => s.close());
	return s;
}

function child(parent: string, runId: string, patch: Partial<SessionSummary> = {}): SessionSummary {
	return summary(`${parent}~sa~${runId}`, {
		name: `sub ${runId}`,
		kind: "subagent",
		parentSessionId: parent,
		status: "working",
		subagent: {
			runId,
			toolCallId: "toolu_1",
			index: 0,
			task: "reply with exactly A",
			status: "running",
			startedAt: 1,
		},
		...patch,
	});
}

describe("hub: subagent sessions", () => {
	it("shows subagent sessions only to apps whose hello has the subagents feature", async () => {
		const featured = await pairedApp(["subagents"]);
		const plain = await pairedApp();
		const s = await session();
		await s.register(summary("p1", { subagents: { running: 1, total: 1 } }));
		s.send({ t: "child.upsert", session: child("p1", "r1") });
		const up = await featured.messages.next((m) => m.t === "session.upsert" && m.session.sessionId === "p1~sa~r1");
		expect(up.session).toMatchObject({
			kind: "subagent",
			parentSessionId: "p1",
			subagent: { runId: "r1", toolCallId: "toolu_1", index: 0, status: "running" },
		});
		await plain.sync();
		expect(plain.messages.all.filter((m) => m.t === "session.upsert").map((m) => m.session.sessionId)).toEqual([
			"p1",
		]);
		expect((await plain.messages.next((m) => m.t === "session.upsert")).session.subagents).toEqual({
			running: 1,
			total: 1,
		});

		featured.send({ t: "sessions.list", id: "l1" });
		plain.send({ t: "sessions.list", id: "l2" });
		const featuredList = await featured.messages.next((m) => m.t === "sessions");
		const plainList = await plain.messages.next((m) => m.t === "sessions");
		expect(featuredList.sessions.map((x: SessionSummary) => x.sessionId).sort()).toEqual(["p1", "p1~sa~r1"]);
		expect(plainList.sessions.map((x: SessionSummary) => x.sessionId)).toEqual(["p1"]);

		// To an app without the feature the child does not exist.
		plain.send({ t: "session.subscribe", id: "s1", sessionId: "p1~sa~r1" });
		expect(await plain.messages.next((m) => m.re === "s1")).toMatchObject({ t: "error", code: "not_found" });
		plain.send({ t: "session.prompt", id: "p1", sessionId: "p1~sa~r1", text: "hi" });
		expect(await plain.messages.next((m) => m.re === "p1")).toMatchObject({
			t: "ack",
			ok: false,
			error: { code: "not_found" },
		});

		// The local status lists it (the CLI folds it into its parent).
		const ctl = await ControlClient.connect();
		cleanups.push(() => ctl.close());
		const status = await ctl.request<{ sessions: SessionSummary[] }>({ op: "status" });
		expect(status.sessions.map((x) => x.sessionId).sort()).toEqual(["p1", "p1~sa~r1"]);
	});

	it("routes subscribe/history/prompt/abort to the parent connection naming the child; refuses the rest", async () => {
		const app = await pairedApp(["subagents"]);
		const s = await session();
		await s.register(summary("p1"));
		s.send({ t: "child.upsert", session: child("p1", "r1") });
		await app.messages.next((m) => m.t === "session.upsert" && m.session.sessionId === "p1~sa~r1");

		app.send({ t: "session.subscribe", id: "sub", sessionId: "p1~sa~r1", limit: 10 });
		const snap = await s.nextReq("snapshot");
		expect(snap).toMatchObject({ sessionId: "p1~sa~r1", args: { limit: 10 } });
		s.reply(snap.id, {
			items: [{ id: "u:task", ts: 1, kind: "user", text: "reply with exactly A" }],
			hasMore: false,
			state: { status: "working" },
		});
		expect(await app.messages.next((m) => m.t === "session.snapshot")).toMatchObject({
			sessionId: "p1~sa~r1",
			items: [{ id: "u:task" }],
			state: { status: "working" },
		});
		s.send({
			t: "event",
			sessionId: "p1~sa~r1",
			event: { type: "item.upsert", item: { id: "a:1", ts: 1, kind: "assistant", text: "A" } },
		});
		expect(await app.messages.next((m) => m.t === "session.event")).toEqual({
			t: "session.event",
			sessionId: "p1~sa~r1",
			event: { type: "item.upsert", item: { id: "a:1", ts: 1, kind: "assistant", text: "A" } },
		});

		app.send({ t: "session.history", id: "h", sessionId: "p1~sa~r1", before: "a:1" });
		const history = await s.nextReq("history");
		expect(history.sessionId).toBe("p1~sa~r1");
		s.reply(history.id, { items: [], hasMore: false });
		await app.messages.next((m) => m.t === "session.history" && m.re === "h");

		app.send({ t: "session.prompt", id: "pr", sessionId: "p1~sa~r1", text: "steer", mode: "steer" });
		const prompt = await s.nextReq("prompt");
		expect(prompt).toMatchObject({ sessionId: "p1~sa~r1", args: { text: "steer", mode: "steer" } });
		s.send({ t: "reply", re: prompt.id, ok: false, error: { code: "bad_request", message: "subagent finished" } });
		expect(await app.messages.next((m) => m.re === "pr")).toEqual({
			t: "ack",
			re: "pr",
			ok: false,
			error: { code: "bad_request", message: "subagent finished" },
		});

		app.send({ t: "session.abort", id: "ab", sessionId: "p1~sa~r1" });
		const abort = await s.nextReq("abort");
		expect(abort.sessionId).toBe("p1~sa~r1");
		s.reply(abort.id);
		expect(await app.messages.next((m) => m.re === "ab")).toEqual({ t: "ack", re: "ab", ok: true });

		app.send({
			t: "session.prompt",
			id: "img",
			sessionId: "p1~sa~r1",
			text: "look",
			images: [{ mimeType: "image/png", data: "AAAA" }],
		});
		expect(await app.messages.next((m) => m.re === "img")).toMatchObject({
			ok: false,
			error: { code: "bad_request" },
		});
		for (const [t, extra] of [
			["session.close", {}],
			["models.list", {}],
			["session.setModel", { provider: "a", modelId: "b" }],
			["session.setThinking", { level: "high" }],
			["commands.list", {}],
		] as const) {
			app.send({ t, id: `x-${t}`, sessionId: "p1~sa~r1", ...extra });
			const reply = await app.messages.next((m) => m.re === `x-${t}`);
			expect(reply.ok === false ? reply.error.code : reply.code).toBe("bad_request");
		}
		// Requests for the parent itself carry no sessionId (unchanged wire).
		app.send({ t: "session.abort", id: "pa", sessionId: "p1" });
		expect((await s.nextReq("abort")).sessionId).toBeUndefined();
	});

	it("never pushes for a subagent session", async () => {
		const app = await pairedApp(["subagents"]);
		app.send({
			t: "push.register",
			id: "pr",
			apnsToken: "a".repeat(64),
			env: "sandbox",
			bundleId: "com.example.app",
		});
		await app.messages.next((m) => m.re === "pr");
		const s = await session();
		await s.register(summary("p1"));
		s.send({ t: "child.upsert", session: child("p1", "r1") });
		s.send({ t: "event", sessionId: "p1~sa~r1", event: { type: "state", state: { status: "idle" } } });
		s.send({ t: "child.upsert", session: child("p1", "r1", { status: "idle" }) });
		await sleep(120);
		expect(pushes).toEqual([]);
		s.send({ t: "event", sessionId: "p1", event: { type: "state", state: { status: "working" } } });
		s.send({ t: "event", sessionId: "p1", event: { type: "state", state: { status: "idle" } } });
		await vi.waitFor(() => expect(pushes).toEqual([{ sessionId: "p1" }]));
	});

	it("removes children on child.remove, on parent replacement (no replacedBy) and on disconnect", async () => {
		const app = await pairedApp(["subagents"]);
		const s = await session();
		await s.register(summary("p1"));
		s.send({ t: "child.upsert", session: child("p1", "r1") }, { t: "child.upsert", session: child("p1", "r2") });
		await app.messages.next((m) => m.t === "session.upsert" && m.session.sessionId === "p1~sa~r2");
		s.send({ t: "child.remove", sessionId: "p1~sa~r1" });
		expect(await app.messages.next((m) => m.t === "session.remove")).toEqual({
			t: "session.remove",
			sessionId: "p1~sa~r1",
		});

		// /new: the same connection registers a new id.
		s.send({ t: "register", v: 1, session: summary("p2") });
		const removes = [
			await app.messages.next((m) => m.t === "session.remove"),
			await app.messages.next((m) => m.t === "session.remove"),
		];
		expect(removes).toEqual([
			{ t: "session.remove", sessionId: "p1~sa~r2" },
			{ t: "session.remove", sessionId: "p1", replacedBy: "p2" },
		]);

		// A child must be named after its parent's id: p1's children are refused now.
		s.send({ t: "child.upsert", session: child("p1", "r3") }, { t: "child.upsert", session: child("p2", "r4") });
		const accepted = await app.messages.next(
			(m) => m.t === "session.upsert" && ["p1~sa~r3", "p2~sa~r4"].includes(m.session.sessionId),
		);
		expect(accepted.session.sessionId).toBe("p2~sa~r4");
		const other = await session();
		await other.register(summary("q1"));
		other.send({ t: "child.upsert", session: child("p2", "r5") });
		await app.sync();
		expect(app.messages.pending((m) => m.t === "session.upsert" && m.session.sessionId === "p2~sa~r5")).toEqual([]);

		s.close();
		const gone = [
			await app.messages.next((m) => m.t === "session.remove"),
			await app.messages.next((m) => m.t === "session.remove"),
		];
		expect(gone.map((m) => m.sessionId)).toEqual(["p2~sa~r4", "p2"]);
	});

	it("ignores child frames before register and keeps a non-child session from claiming subagent fields", async () => {
		const app = await pairedApp(["subagents"]);
		const s = await session();
		s.send({
			t: "register",
			v: 1,
			session: summary("p1", { kind: "subagent", parentSessionId: "x", subagent: { runId: "r" } as never }),
		});
		const up = await app.messages.next((m) => m.t === "session.upsert");
		expect(up.session.kind).toBe("interactive");
		expect(up.session).not.toHaveProperty("parentSessionId");
		expect(up.session).not.toHaveProperty("subagent");
		s.send({ t: "child.upsert", session: { ...child("p1", "bad"), subagent: undefined } });
		s.send({ t: "upsert", session: summary("p1", { tmux: { session: "my-smoke-name", window: "phi" } }) });
		const tmux = await app.messages.next((m) => m.t === "session.upsert" && m.session.tmux);
		expect(tmux.session.tmux).toEqual({ session: "my-smoke-name", window: "phi" });
		expect(app.messages.pending((m) => m.t === "session.upsert" && m.session.kind === "subagent")).toEqual([]);
	});
});
