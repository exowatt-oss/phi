import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registryPath, ThreadRegistry } from "../src/extensions/overseer/registry.ts";
import {
	DEFAULT_WATCH,
	OVERSEER_BOARD_ENTRY,
	OVERSEER_EVENT_TYPE,
	type ThreadRecord,
} from "../src/extensions/overseer/types.ts";
import { HubControlError } from "../src/remote/hub/control.ts";
import type { SessionSummary } from "../src/remote/protocol.ts";
import { FakeHub, fakeRunner, type Mounted, mountOverseer, summary, testDeps } from "./overseer-helpers.ts";

const OVERSEER = "0190aaaa-0000-7000-8000-00000000beef";
const THREAD_ID = "0190bbbb-1111-7000-8000-000000000001";
/** `summary.overseer` of a session this overseer started. */
const MINE = { sessionId: OVERSEER };

let root: string;
let agentDir: string;
let work: string;
const mounted: Mounted[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "phi-overseer-manager-"));
	agentDir = join(root, "agent");
	work = join(root, "work");
	mkdirSync(work, { recursive: true });
});

afterEach(async () => {
	for (const m of mounted.splice(0)) await m.fire("session_shutdown");
	rmSync(root, { recursive: true, force: true });
});

async function mount(
	hub: FakeHub,
	deps: Parameters<typeof testDeps>[2] = {},
	extra: Partial<Parameters<typeof mountOverseer>[0]> = {},
) {
	const m = await mountOverseer({
		deps: testDeps(hub, agentDir, deps),
		sessionId: OVERSEER,
		cwd: work,
		sessionName: "boss",
		models: ["gateway/example-medium", "anthropic/claude-opus-5-5"],
		...extra,
	});
	mounted.push(m);
	await m.fire("session_start");
	return m;
}

function seed(records: ThreadRecord[]): void {
	const registry = new ThreadRegistry(agentDir, OVERSEER);
	registry.threads = records;
	registry.save();
}

function record(name: string, sessionId: string, extra: Partial<ThreadRecord> = {}): ThreadRecord {
	return {
		name,
		sessionId,
		backend: "headless",
		cwd: "/tmp",
		createdAt: 0,
		watch: { ...DEFAULT_WATCH },
		state: "running",
		registered: true,
		...extra,
	};
}

function stored(): ThreadRecord[] {
	return (JSON.parse(readFileSync(registryPath(agentDir, OVERSEER), "utf8")) as { threads: ThreadRecord[] }).threads;
}

describe("overseer extension gating", () => {
	it("registers the manager tool and command in top-level sessions only", async () => {
		const hub = new FakeHub();
		const m = await mount(hub);
		expect([...m.extension.tools.keys()]).toEqual(["overseer"]);
		expect(m.extension.commands.has("threads")).toBe(true);
		expect(m.extension.messageRenderers.has(OVERSEER_EVENT_TYPE)).toBe(true);
		// Nothing touches the hub until the tool is used.
		expect(hub.connects).toBe(0);

		for (const env of [{ PI_SUBAGENT_ID: "x" }, { PHI_OVERSEER: "0" }]) {
			const off = await mountOverseer({ deps: testDeps(hub, agentDir, { env }), cwd: work });
			expect(off.extension.tools.size).toBe(0);
			expect(off.extension.handlers.size).toBe(0);
		}
		const asThread = await mountOverseer({
			deps: testDeps(hub, agentDir, { env: { PHI_OVERSEER_SESSION_ID: OVERSEER, PHI_OVERSEER_THREAD: "api" } }),
			cwd: work,
		});
		expect([...asThread.extension.tools.keys()].sort()).toEqual(["overseer", "report_to_overseer"]);
	});
});

describe("overseer spawn", () => {
	it("spawns a headless thread through the hub with the thread env and pinned model", async () => {
		const hub = new FakeHub();
		hub.handlers["session.spawn"] = () => ({ sessionId: THREAD_ID, cwd: work, pid: 777 });
		const m = await mount(hub);
		const result = await m.call({
			action: "spawn",
			name: "api",
			prompt: "Add filters. Done when tests pass.",
			model: "gateway/example-medium:max",
			backend: "headless",
			subagentModels: { default: "gateway/example-medium:max", allow: ["gateway/*"] },
			appendSystemPrompt: "Be terse.",
			watch: { stallMinutes: 30 },
		});
		const spawn = hub.ops("session.spawn")[0];
		expect(spawn).toMatchObject({
			cwd: realpathSync(work),
			prompt: "Add filters. Done when tests pass.",
			provider: "gateway",
			modelId: "example-medium",
			thinkingLevel: "max",
			name: "api",
			appendSystemPrompt: "Be terse.",
			env: {
				PHI_OVERSEER_SESSION_ID: OVERSEER,
				PHI_OVERSEER_NAME: "boss",
				PHI_OVERSEER_THREAD: "api",
				PHI_SUBAGENT_MODEL_DEFAULT: "gateway/example-medium:max",
				PHI_SUBAGENT_MODEL_ALLOW: "gateway/*",
			},
		});
		expect(result.text.split("\n")[0]).toBe(
			`Started thread "api" (${THREAD_ID}) · headless pid 777 · gateway/example-medium:max · ${work}`,
		);
		expect(result.text).toContain("watching: idle on · stall 30m · heartbeat off".replace("watching", "Watching"));
		expect(stored()).toMatchObject([
			{
				name: "api",
				sessionId: THREAD_ID,
				backend: "headless",
				pid: 777,
				model: "gateway/example-medium",
				thinking: "max",
				state: "running",
			},
		]);
		expect(statSync(registryPath(agentDir, OVERSEER)).mode & 0o777).toBe(0o600);
		expect(m.statuses.at(-1)).toBe("threads 1 idle");
	});

	it("inherits this session's model and thinking when none is given", async () => {
		const hub = new FakeHub();
		hub.handlers["session.spawn"] = () => ({ sessionId: THREAD_ID, cwd: work });
		const m = await mount(hub, {}, { thinking: "high" });
		await m.call({ action: "spawn", name: "api", prompt: "go", backend: "headless" });
		expect(hub.ops("session.spawn")[0]).toMatchObject({
			provider: "anthropic",
			modelId: "claude-opus-5-5",
			thinkingLevel: "high",
		});
	});

	it("spawns in a FORCA tab via a launcher and waits for the session to register", async () => {
		const hub = new FakeHub();
		let lists = 0;
		hub.handlers["sessions.list"] = () => {
			lists++;
			return {
				sessions:
					lists >= 4
						? [
								summary({
									sessionId: THREAD_ID,
									status: "working",
									lastActivityAt: 1_000_000,
									overseer: { sessionId: OVERSEER, thread: "api" },
								}),
							]
						: [],
			};
		};
		const run = fakeRunner([
			{
				match: (c) => c.args[0] === "status",
				result: { stdout: JSON.stringify({ ok: true, result: { runtime: { state: "ready" } } }) },
			},
			{
				match: (c) => c.args[1] === "create",
				result: { stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "term_api" } } }) },
			},
		]);
		const m = await mount(hub, {
			env: { PHI_CLIENT: "forca" },
			which: (c) => (c === "forca" ? "/bin/forca" : undefined),
			run,
		});
		const result = await m.call({
			action: "spawn",
			name: "api",
			prompt: "go",
			model: "gateway/example-medium",
			thinking: "high",
		});
		expect(result.text).toContain(
			`Started thread "api" (${THREAD_ID}) · forca tab term_api · gateway/example-medium:high`,
		);
		const launcher = join(agentDir, "overseer", "launch", `${THREAD_ID}.sh`);
		expect(statSync(launcher).mode & 0o777).toBe(0o700);
		const script = readFileSync(launcher, "utf8");
		expect(script).toContain(
			`exec '/opt/phi/bin/phi' '--session-id' '${THREAD_ID}' '--model' 'gateway/example-medium' '--thinking' 'high' '--name' 'api' --`,
		);
		expect(script).toContain(`export PHI_OVERSEER_SESSION_ID='${OVERSEER}'`);
		const create = run.calls.find((c) => c.args[1] === "create")!;
		expect(create.args).toEqual([
			"terminal",
			"create",
			"--worktree",
			`path:${realpathSync(work)}`,
			"--title",
			"api",
			"--command",
			`sh '${launcher}'`,
			"--json",
		]);
		// Once phi registered, the tab title is pinned (FORCA would show "phi ready" otherwise).
		const rename = run.calls.filter((c) => c.args[1] === "rename");
		expect(rename.map((c) => [c.command, ...c.args])).toEqual([
			["forca", "terminal", "rename", "--terminal", "term_api", "--title", "api", "--json"],
		]);
		expect(run.calls.indexOf(rename[0])).toBeGreaterThan(run.calls.indexOf(create));
		expect(stored()[0]).toMatchObject({
			terminal: "term_api",
			launcher,
			registered: true,
			lastStatus: "working",
			backend: "forca",
		});
		expect(hub.ops("session.spawn")).toEqual([]);
	});

	it("reports a thread that never registers with its launcher and terminal, keeping the record", async () => {
		const hub = new FakeHub();
		const run = fakeRunner([
			{
				match: (c) => c.args[1] === "create",
				result: { stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "term_x" } } }) },
			},
		]);
		const m = await mount(hub, { which: (c) => (c === "forca" ? "/bin/forca" : undefined), run });
		await expect(m.call({ action: "spawn", name: "slow", prompt: "go", backend: "forca" })).rejects.toThrow(
			/did not register with the phi remote hub within 60 s\. FORCA terminal term_x: inspect with `forca terminal read --terminal term_x --screen`\. Launcher: .*\.sh\. The record is kept/,
		);
		expect(stored()[0]).toMatchObject({ name: "slow", registered: false, state: "running", terminal: "term_x" });
		await expect(m.call({ action: "spawn", name: "slow", prompt: "go", backend: "forca" })).rejects.toThrow(
			/already exists/,
		);
	});

	it("frees the name when a tmux thread dies before registering", async () => {
		const hub = new FakeHub();
		const run = fakeRunner([
			{ match: (c) => c.args[0] === "has-session", result: { code: 1, stderr: "can't find session" } },
		]);
		const m = await mount(hub, { which: (c) => (c === "tmux" ? "/bin/tmux" : undefined), run });
		await expect(m.call({ action: "spawn", name: "dead", prompt: "go" })).rejects.toThrow(
			/exited before registering: its tmux session phi-dead is gone/,
		);
		expect(run.calls[0].args.slice(0, 5)).toEqual(["new-session", "-d", "-s", "phi-dead", "-c"]);
		expect(stored()[0]).toMatchObject({ name: "dead", state: "closed", tmuxSession: "phi-dead" });
	});

	it("validates before launching anything", async () => {
		const hub = new FakeHub();
		const run = fakeRunner();
		const m = await mount(hub, { run });
		await expect(
			m.call({ action: "spawn", name: "x", prompt: "go", model: "gateway/example-mediumm" }),
		).rejects.toThrow(/Unknown model "gateway\/example-mediumm". Close matches: gateway\/example-medium/);
		await expect(m.call({ action: "spawn", name: "x" })).rejects.toThrow(/needs "prompt"/);
		await expect(m.call({ action: "spawn", prompt: "go" })).rejects.toThrow(/needs "name"/);
		await expect(m.call({ action: "spawn", name: "x", prompt: "go", cwd: "/no/such/dir" })).rejects.toThrow(
			/cwd does not exist/,
		);
		expect(hub.calls).toEqual([]);
		expect(run.calls).toEqual([]);
	});

	it("starts the hub when it is not running and fails clearly when it cannot", async () => {
		const hub = new FakeHub();
		hub.down = true;
		let started = 0;
		hub.handlers["session.spawn"] = () => ({ sessionId: THREAD_ID, cwd: work });
		const m = await mount(hub, {
			startHub: async () => {
				started++;
				hub.down = false;
				return "started";
			},
		});
		await m.call({ action: "spawn", name: "api", prompt: "go", backend: "headless" });
		expect(started).toBe(1);

		const dead = new FakeHub();
		dead.down = true;
		const m2 = await mount(dead);
		await expect(m2.call({ action: "spawn", name: "api2", prompt: "go", backend: "headless" })).rejects.toThrow(
			/phi remote hub is not running and could not be started .*See \/tmp\/hub\.log/,
		);
	});

	it("explains an old hub that lacks overseer control", async () => {
		const hub = new FakeHub();
		hub.handlers["sessions.list"] = () => {
			throw new HubControlError("bad_request", "unknown control op: sessions.list");
		};
		const m = await mount(hub);
		await expect(m.call({ action: "spawn", name: "api", prompt: "go", backend: "headless" })).rejects.toThrow(
			/does not support "sessions\.list" \(it predates overseer control\)/,
		);
	});
});

describe("overseer thread control", () => {
	async function withThreads(
		records: ThreadRecord[],
		live: SessionSummary[],
		deps: Parameters<typeof testDeps>[2] = {},
	) {
		seed(records);
		const hub = new FakeHub();
		hub.sessions = live;
		const m = await mount(hub, deps);
		return { hub, m };
	}

	it("sends framed messages, slash commands raw, with the requested mode", async () => {
		const { hub, m } = await withThreads([record("api", THREAD_ID)], [summary({ sessionId: THREAD_ID })]);
		const sent = await m.call({ action: "send", target: "api", message: "Use v2 of the schema.\nThen rerun." });
		expect(hub.ops("session.prompt")[0]).toMatchObject({
			sessionId: THREAD_ID,
			text: "[overseer boss (0190aaaa)]\nUse v2 of the schema.\nThen rerun.",
			mode: "auto",
		});
		expect(sent.text).toContain("Its reply arrives as an [overseer] update");
		expect(stored()[0].awaitingReplySince).toBeDefined();
		await m.call({ action: "send", target: "0190bbbb", message: "/compact keep decisions", mode: "followUp" });
		expect(hub.ops("session.prompt")[1]).toMatchObject({ text: "/compact keep decisions", mode: "followUp" });
		await expect(m.call({ action: "send", target: "nobody", message: "hi" })).rejects.toThrow(
			/No thread "nobody"\. Known: api/,
		);
		await expect(m.call({ action: "send", target: "api" })).rejects.toThrow(/needs "message"/);
	});

	it("refuses to send to an exited thread and points at resume", async () => {
		const { m } = await withThreads([record("api", THREAD_ID, { state: "exited" })], []);
		await expect(m.call({ action: "send", target: "api", message: "hi" })).rejects.toThrow(/has exited\. Resume it/);
	});

	it("aborts and switches model and thinking", async () => {
		const { hub, m } = await withThreads(
			[record("api", THREAD_ID)],
			[summary({ sessionId: THREAD_ID, status: "working", lastActivityAt: 1_000_000 })],
		);
		await m.call({ action: "abort", target: "api" });
		expect(hub.ops("session.abort")).toHaveLength(1);
		const changed = await m.call({ action: "model", target: "api", model: "anthropic/claude-opus-5-5:xhigh" });
		expect(hub.ops("session.setModel")[0]).toMatchObject({ provider: "anthropic", modelId: "claude-opus-5-5" });
		expect(hub.ops("session.setThinking")[0]).toMatchObject({ level: "xhigh" });
		expect(changed.text).toBe('"api" now runs anthropic/claude-opus-5-5:xhigh (applies from its next turn).');
		await m.call({ action: "model", target: "api", thinking: "low" });
		expect(hub.ops("session.setModel")).toHaveLength(1);
		expect(hub.ops("session.setThinking")[1]).toMatchObject({ level: "low" });
		await expect(m.call({ action: "model", target: "api" })).rejects.toThrow(/needs "model"/);
	});

	it("keeps the label of the model a running turn started on when the model is switched", async () => {
		const sonnet = { provider: "anthropic", id: "claude-sonnet-5" };
		const OTHER_ID = "0190cccc-2222-7000-8000-000000000002";
		const { hub, m } = await withThreads(
			[record("b", THREAD_ID), record("idle", OTHER_ID)],
			[
				summary({ sessionId: THREAD_ID, status: "working", model: sonnet, thinkingLevel: "medium" }),
				summary({ sessionId: OTHER_ID, status: "idle", model: sonnet, thinkingLevel: "medium" }),
			],
		);
		await m.call({ action: "model", target: "b", thinking: "low" });
		await m.call({ action: "model", target: "idle", thinking: "low" });
		expect(hub.ops("session.setThinking").map((op) => op.level)).toEqual(["low", "low"]);
		expect(stored().map((thread) => [thread.name, thread.thinking, thread.turnModel])).toEqual([
			["b", "low", "anthropic/claude-sonnet-5:medium"],
			// Idle: its next turn runs on the new model, so nothing is pinned.
			["idle", "low", undefined],
		]);
	});

	it("closes a FORCA thread: abort, ctl close with the overseer id, wait, close the tab", async () => {
		const run = fakeRunner([
			{ match: (c) => c.command === "forca", result: { stdout: JSON.stringify({ ok: true, result: {} }) } },
		]);
		const launcher = join(agentDir, "overseer", "launch", `${THREAD_ID}.sh`);
		const { hub, m } = await withThreads(
			[record("api", THREAD_ID, { backend: "forca", terminal: "term_api", launcher })],
			[summary({ sessionId: THREAD_ID, status: "working", lastActivityAt: 1_000_000, overseer: MINE })],
			{ run },
		);
		hub.handlers["session.close"] = () => {
			hub.sessions = [];
			return {};
		};
		const result = await m.call({ action: "close", target: "api" });
		expect(hub.calls.map((c) => c.op).filter((op) => op !== "sessions.list")).toEqual([
			"session.abort",
			"session.close",
		]);
		expect(hub.ops("session.close")[0]).toMatchObject({ sessionId: THREAD_ID, overseer: OVERSEER });
		expect(run.calls.map((c) => [c.command, ...c.args])).toEqual([
			["forca", "terminal", "close", "--terminal", "term_api", "--tab", "--json"],
		]);
		expect(result.text).toBe(
			`Closed "api": aborted its turn; session closed; FORCA tab term_api closed. Resume it later with overseer {action:"resume", target:"${THREAD_ID}"}.`,
		);
		expect(stored()[0]).toMatchObject({ state: "closed" });
		// The launch files and the tab are gone: the record forgets them.
		expect(stored()[0]).not.toHaveProperty("launcher");
		expect(stored()[0]).not.toHaveProperty("terminal");
		expect(m.statuses.at(-1)).toBeUndefined();
	});

	it("keeps only a tab that could not be closed on the closed record", async () => {
		const run = fakeRunner([{ match: (c) => c.command === "forca", result: { code: 1, stderr: "runtime offline" } }]);
		const launcher = join(agentDir, "overseer", "launch", `${THREAD_ID}.sh`);
		const { hub, m } = await withThreads(
			[record("api", THREAD_ID, { backend: "forca", terminal: "term_api", launcher, turnModel: "x/y:low" })],
			[summary({ sessionId: THREAD_ID, overseer: MINE })],
			{ run },
		);
		hub.handlers["session.close"] = () => {
			hub.sessions = [];
			return {};
		};
		const result = await m.call({ action: "close", target: "api" });
		expect(result.text).toContain("session closed; FORCA tab close failed: runtime offline");
		const closed = stored()[0];
		expect(closed).toMatchObject({ state: "closed", terminal: "term_api" });
		expect(closed).not.toHaveProperty("launcher");
		expect(closed).not.toHaveProperty("turnModel");
	});

	it("still closes the terminal when an older hub refuses the ctl close", async () => {
		const run = fakeRunner();
		const { hub, m } = await withThreads(
			[record("api", THREAD_ID, { backend: "tmux", tmuxSession: "phi-api" })],
			[summary({ sessionId: THREAD_ID, overseer: MINE })],
			{ run },
		);
		hub.handlers["session.close"] = () => {
			throw new HubControlError("forbidden", "not your thread");
		};
		const result = await m.call({ action: "close", target: "api" });
		expect(run.calls.map((c) => [c.command, ...c.args])).toEqual([["tmux", "kill-session", "-t", "=phi-api"]]);
		expect(result.text).toContain(
			"ctl close refused: hub session.close: forbidden: not your thread; tmux phi-api killed",
		);
		expect(stored()[0].state).toBe("closed");
	});

	it("reports a tmux session that ended with its phi as already ended, not as a failed kill", async () => {
		const run = fakeRunner([
			{
				match: (c) => c.command === "tmux",
				result: { code: 1, stderr: "no server running on /tmp/tmux-1001/default" },
			},
		]);
		const { m } = await withThreads(
			[record("api", THREAD_ID, { backend: "tmux", tmuxSession: "phi-api" })],
			[summary({ sessionId: THREAD_ID, overseer: MINE })],
			{ run },
		);
		const result = await m.call({ action: "close", target: "api" });
		expect(result.text).toContain("session closed; tmux phi-api already ended");
		expect(result.text).not.toContain("kill failed");
		expect(stored()[0].state).toBe("closed");
		expect(stored()[0]).not.toHaveProperty("tmuxSession");
	});

	it("closes a headless thread through the hub only, and fails loudly when nothing closed it", async () => {
		const run = fakeRunner();
		const { hub, m } = await withThreads(
			[record("api", THREAD_ID), record("web", "0190cccc-2")],
			[
				summary({ sessionId: THREAD_ID, kind: "headless", overseer: MINE }),
				summary({ sessionId: "0190cccc-2", kind: "headless", overseer: MINE }),
			],
			{ run },
		);
		await m.call({ action: "close", target: "api" });
		expect(hub.ops("session.close")).toHaveLength(1);
		expect(run.calls).toEqual([]);
		hub.handlers["session.close"] = () => {
			throw new HubControlError("internal", "boom");
		};
		await expect(m.call({ action: "close", target: "web" })).rejects.toThrow(
			/Could not close "web": ctl close refused/,
		);
		expect(stored()[1].state).toBe("running");
	});

	it("only stops watching an adopted interactive session it does not own", async () => {
		const { hub, m } = await withThreads(
			[record("theirs", THREAD_ID, { adopted: true, backend: "external" })],
			[summary({ sessionId: THREAD_ID, status: "working", lastActivityAt: 1_000_000 })],
		);
		const result = await m.call({ action: "close", target: "theirs" });
		expect(hub.ops("session.close")).toEqual([]);
		expect(hub.ops("session.abort")).toHaveLength(1);
		expect(result.text).toContain("was not closed");
		expect(stored()[0].state).toBe("closed");
	});

	it("never ends an adopted headless session it does not own (phone, other overseer)", async () => {
		const { hub, m } = await withThreads(
			[
				record("phone", THREAD_ID, { adopted: true, backend: "headless" }),
				record("other", "0190cccc-2", { adopted: true, backend: "headless" }),
				record("gone", "0190dddd-3", { adopted: true, backend: "headless" }),
			],
			[
				summary({ sessionId: THREAD_ID, kind: "headless", status: "working", lastActivityAt: 1_000_000 }),
				summary({ sessionId: "0190cccc-2", kind: "headless", overseer: { sessionId: "0190ffff-other" } }),
			],
		);
		const phone = await m.call({ action: "close", target: "phone" });
		expect(phone.text).toContain("aborted its turn");
		expect(phone.text).toContain("headless session this overseer did not start");
		await m.call({ action: "close", target: "other" });
		await m.call({ action: "close", target: "gone" });
		expect(hub.ops("session.close")).toEqual([]);
		expect(hub.ops("session.abort")).toHaveLength(1);
		expect(stored().map((t) => t.state)).toEqual(["closed", "closed", "closed"]);
	});

	it("abort persists the cleared reply expectation", async () => {
		const { m } = await withThreads(
			[record("api", THREAD_ID, { awaitingReplySince: 5 })],
			[summary({ sessionId: THREAD_ID, status: "working", lastActivityAt: 1_000_000, overseer: MINE })],
		);
		await m.call({ action: "abort", target: "api" });
		expect(stored()[0].awaitingReplySince).toBeUndefined();
	});

	it("re-adds live threads carrying this overseer's id when the registry is lost", async () => {
		const hub = new FakeHub();
		const launch = join(agentDir, "overseer", "launch");
		mkdirSync(launch, { recursive: true });
		writeFileSync(join(launch, "0190cccc-2.sh"), "#!/bin/sh\n");
		hub.sessions = [
			summary({ sessionId: THREAD_ID, kind: "headless", overseer: { sessionId: OVERSEER, thread: "api" } }),
			summary({ sessionId: "0190cccc-2", overseer: { sessionId: OVERSEER, thread: "web" } }),
			summary({ sessionId: "0190dddd-3", name: "not mine", overseer: { sessionId: "0190ffff-other" } }),
		];
		// A session with history: session_start re-matches once on a short connection.
		const m = await mountOverseer({
			deps: testDeps(hub, agentDir),
			sessionId: OVERSEER,
			cwd: work,
			sessionName: "boss",
		});
		mounted.push(m);
		(m.ctx.sessionManager as unknown as { getLeafId: () => string }).getLeafId = () => "leaf-1";
		await m.fire("session_start");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stored().map((t) => [t.name, t.sessionId, t.backend, t.adopted, t.state])).toEqual([
			["api", THREAD_ID, "headless", undefined, "running"],
			["web", "0190cccc-2", "external", undefined, "running"],
		]);
		expect(stored()[1].launcher).toBe(join(launch, "0190cccc-2.sh"));
		expect(stored()[0].launcher).toBeUndefined();
		expect(hub.closed).toBeGreaterThan(0);
	});

	it("list re-adds live threads of this overseer missing from the registry", async () => {
		const hub = new FakeHub();
		const m = await mount(hub);
		expect(hub.connects).toBe(0);
		hub.sessions = [
			summary({ sessionId: THREAD_ID, kind: "headless", overseer: { sessionId: OVERSEER, thread: "api" } }),
			summary({ sessionId: "0190dddd-3", name: "not mine" }),
		];
		const board = await m.call({ action: "list" });
		expect(board.text).toContain("api");
		expect(board.text).not.toContain("not mine");
		expect(stored().map((t) => t.name)).toEqual(["api"]);
		const empty = new FakeHub();
		empty.down = true;
		const fresh = await mount(empty, {}, { sessionId: "0190aaaa-9999-7000-8000-000000000000" });
		const none = await fresh.call({ action: "list" });
		expect(none.text).not.toContain("hub");
	});

	it("resumes a closed thread headless with its env and model", async () => {
		const run = fakeRunner([
			{ match: (c) => c.command === "forca", result: { stdout: JSON.stringify({ ok: true, result: {} }) } },
		]);
		const launch = join(agentDir, "overseer", "launch");
		mkdirSync(launch, { recursive: true });
		writeFileSync(join(launch, `${THREAD_ID}.sh`), "#!/bin/sh\n");
		const { hub, m } = await withThreads(
			[
				record("api", THREAD_ID, {
					state: "closed",
					backend: "forca",
					terminal: "term_api",
					tmuxSession: "phi-api",
					launcher: join(launch, `${THREAD_ID}.sh`),
					model: "gateway/example-medium",
					thinking: "max",
					subagentModels: { default: "gateway/example-medium:max" },
				}),
			],
			[],
			{ run },
		);
		hub.handlers["session.resume"] = () => ({ sessionId: THREAD_ID, cwd: "/tmp", pid: 99 });
		const result = await m.call({ action: "resume", target: "api", prompt: "continue with step 3" });
		expect(hub.ops("session.resume")[0]).toMatchObject({
			sessionId: THREAD_ID,
			prompt: "continue with step 3",
			provider: "gateway",
			modelId: "example-medium",
			thinkingLevel: "max",
			env: {
				PHI_OVERSEER_SESSION_ID: OVERSEER,
				PHI_OVERSEER_THREAD: "api",
				PHI_SUBAGENT_MODEL_DEFAULT: "gateway/example-medium:max",
			},
		});
		expect(result.text).toContain(`Resumed "api" (${THREAD_ID}) headless (pid 99)`);
		expect(result.text).toContain("its old FORCA tab term_api was closed");
		// The old tab (unique handle) is closed once; a tmux name may be another thread's now: never killed.
		expect(run.calls.map((c) => [c.command, ...c.args])).toEqual([
			["forca", "terminal", "close", "--terminal", "term_api", "--tab", "--json"],
		]);
		const resumed = stored()[0];
		expect(resumed).toMatchObject({ state: "running", backend: "headless", pid: 99 });
		expect(resumed.terminal).toBeUndefined();
		expect(resumed.tmuxSession).toBeUndefined();
		expect(resumed.launcher).toBeUndefined();
		expect(existsSync(join(launch, `${THREAD_ID}.sh`))).toBe(false);

		// A later close acts on the headless session only: no stale tab or tmux kill.
		hub.sessions = [summary({ sessionId: THREAD_ID, kind: "headless", overseer: MINE })];
		const closed = await m.call({ action: "close", target: "api" });
		expect(closed.text).not.toMatch(/FORCA|tmux/);
		expect(run.calls).toHaveLength(1);
		hub.sessions = [];
		await m.call({ action: "resume", target: "api" });
		expect(run.calls).toHaveLength(1);

		hub.sessions = [summary({ sessionId: THREAD_ID })];
		await expect(m.call({ action: "resume", target: "api" })).rejects.toThrow(/is live already/);
	});

	it("adopts a live session by name and watches it without old news", async () => {
		const { m } = await withThreads(
			[],
			[
				summary({ sessionId: OVERSEER, name: "boss" }),
				summary({
					sessionId: "0190dddd-1",
					name: "phone job",
					kind: "headless",
					lastError: "old error",
					status: "working",
					lastActivityAt: 5,
				}),
			],
		);
		await expect(m.call({ action: "adopt", target: "boss" })).rejects.toThrow(/No session "boss"/);
		const result = await m.call({ action: "adopt", target: "phone job", watch: { heartbeatMinutes: 10 } });
		expect(result.text).toContain(
			'Adopted "phone job" (0190dddd-1, headless, working) · watching: idle on · stall 15m · heartbeat 10m.',
		);
		expect(stored()[0]).toMatchObject({
			adopted: true,
			backend: "headless",
			notifiedError: "old error",
			notifiedStallAt: 5,
		});
	});

	it("changes watch settings for one or all threads", async () => {
		const { m } = await withThreads([record("api", THREAD_ID), record("web", "0190cccc-2")], []);
		const one = await m.call({ action: "watch", target: "api", watch: { onIdle: false, stallMinutes: 0 } });
		expect(one.text).toBe("Watch updated:\napi: idle off · stall off · heartbeat off");
		const all = await m.call({ action: "watch", target: "all", watch: { heartbeatMinutes: 5 } });
		expect(all.text).toBe(
			"Watch updated:\napi: idle off · stall off · heartbeat 5m\nweb: idle on · stall 15m · heartbeat 5m",
		);
		expect((await m.call({ action: "watch" })).text.startsWith("Watch settings:")).toBe(true);
	});

	it("lists the board, every hub session, and reads transcripts", async () => {
		const { hub, m } = await withThreads(
			[
				record("api", THREAD_ID, {
					model: "gateway/example-medium",
					thinking: "max",
					createdAt: 1_000_000 - 120_000,
				}),
				record("gone", "0190cccc-2", { state: "exited" }),
				record("old", "0190eeee-3", { state: "closed" }),
			],
			[
				summary({
					sessionId: THREAD_ID,
					status: "working",
					lastActivityAt: 1_000_000 - 8_000,
					activity: { tool: "bash", summary: "npm test" },
					usage: { costUsd: 0.4231, contextPercent: 31.4 },
					model: { provider: "gateway", id: "example-medium" },
					thinkingLevel: "max",
					overseer: { sessionId: OVERSEER, thread: "api" },
				}),
				summary({ sessionId: OVERSEER, name: "boss" }),
			],
		);
		const board = await m.call({ action: "list" });
		expect(board.text.split("\n")).toEqual([
			"NAME  ID        BACKEND   STATUS   HEALTH  MODEL                       COST   CTX  AGE  QUIET",
			"api   0190bbbb  headless  working  ok      gateway/example-medium:max  $0.42  31%  2m   8s",
			"  ⚒ bash npm test",
			"gone  0190cccc  headless  exited   exited  -                           -      -    16m  -",
			"(1 closed thread not shown; resume one by name or id)",
		]);
		const all = await m.call({ action: "list", all: true });
		expect(all.text).toContain("thread api");
		expect(all.text).toContain("(this overseer)");

		hub.handlers["session.snapshot"] = () => ({
			items: [{ id: "1", ts: Number.NaN, kind: "assistant", text: "working on it" }],
			hasMore: true,
			state: { status: "working", activity: { tool: "bash", summary: "npm test" } },
			summary: hub.sessions[0],
		});
		const read = await m.call({ action: "read", target: "api", limit: 5 });
		expect(hub.ops("session.snapshot")[0]).toMatchObject({ sessionId: THREAD_ID, limit: 5 });
		expect(read.text).toContain(
			`api (${THREAD_ID}) · working · gateway/example-medium:max · ⚒ bash npm test · quiet 8s`,
		);
		expect(read.text).toContain("assistant: working on it");

		hub.handlers["session.transcript"] = () => ({
			items: [{ id: "1", ts: Number.NaN, kind: "user", text: "hello" }],
			hasMore: false,
		});
		const old = await m.call({ action: "read", target: "old" });
		expect(hub.ops("session.transcript")[0]).toMatchObject({ sessionId: "0190eeee-3", limit: 20 });
		expect(old.text).toBe("old (0190eeee-3) · not live (stored transcript)\nuser: hello");
	});

	it("restores the registry on session_start and reports what changed while away", async () => {
		seed([
			record("api", THREAD_ID, { lastStatus: "working", pid: 5 }),
			record("web", "0190cccc-2", { lastStatus: "working", pid: 6 }),
		]);
		const hub = new FakeHub();
		hub.sessions = [summary({ sessionId: THREAD_ID, status: "idle", lastText: "finished while you were away" })];
		const m = await mount(hub);
		// session_start polls once; the batch goes out after the coalescing window.
		await new Promise((resolve) => setTimeout(resolve, 3_200));
		expect(m.sent).toHaveLength(1);
		const message = m.sent[0];
		expect(message.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(message.message).toMatchObject({ customType: OVERSEER_EVENT_TYPE, display: true });
		const content = String(message.message.content);
		expect(content.split("\n")[0]).toBe("[overseer] 2 thread updates");
		expect(content).toContain("── web · exited");
		expect(content).toContain("── api · idle");
		expect(content).toContain("finished while you were away");
		expect(stored().map((t) => t.state)).toEqual(["running", "exited"]);
	}, 10_000);

	it("/threads appends the board as a transcript entry", async () => {
		const { m } = await withThreads([record("api", THREAD_ID)], [summary({ sessionId: THREAD_ID })]);
		const command = m.extension.commands.get("threads")!;
		await command.handler("", m.ctx as never);
		expect(m.entries[0].type).toBe(OVERSEER_BOARD_ENTRY);
		expect(String((m.entries[0].data as { text: string }).text)).toMatch(/^NAME +ID/);
		expect(existsSync(registryPath(agentDir, OVERSEER))).toBe(true);
	});
});
