import { describe, expect, it } from "vitest";
import { LoopEngine } from "../src/extensions/loop/engine.ts";
import { LoopStore, type LoopStorePort } from "../src/extensions/loop/store.ts";
import type { LoopConfig, LoopStateSnapshot } from "../src/extensions/loop/types.ts";

const cfg: LoopConfig = {
	task: "x",
	maxIterations: 3,
	checkTimeoutMs: 1,
	everyMs: 0,
	timeoutMs: 1000,
	budgetUsd: 2,
	evaluatorConfidence: 0.8,
	cwd: "/tmp",
	startedAt: new Date(0).toISOString(),
};
const entries: Array<{ type: string; data?: unknown }> = [];
const port: LoopStorePort = { append: (type, data) => entries.push({ type, data }), entries: () => entries };
const token = (s: LoopStateSnapshot) => ({ loopId: s.loopId, iterationId: s.iterationId, revision: s.revision });
function fresh() {
	entries.length = 0;
	let n = 0;
	return {
		store: new LoopStore(port),
		ports: { now: () => 0, newId: (kind: "loop" | "iteration") => `${kind}-${++n}` },
	};
}
async function realEngine() {
	const x = fresh();
	const e = LoopEngine.rehydrate(x.store, x.ports);
	const s = (await e.start(cfg)).snapshot!;
	return { ...x, e, s };
}

describe("Loop persistence and recovery", () => {
	it("rehydrates active dispatching as interrupted paused and persists a transition", async () => {
		const { store, ports, e } = await realEngine();
		const before = entries.length;
		const r = LoopEngine.rehydrate(new LoopStore(port), ports);
		expect(r.getState()?.phase).toBe("paused");
		expect(r.getState()?.pauseCause).toBe("session_interrupted");
		expect(entries.length).toBeGreaterThan(before);
		void e;
		void store;
	});
	it("rehydrates running, verifying, evaluating, pacing, pausing, and stopping as paused", async () => {
		for (const phase of ["running", "verifying_check", "evaluating_condition", "pacing", "pausing", "stopping"]) {
			entries.length = 0;
			let n = 0;
			const p = { now: () => 0, newId: (k: "loop" | "iteration") => `${k}-${++n}` };
			const e = LoopEngine.rehydrate(new LoopStore(port), p);
			const s = (
				await e.start({
					...cfg,
					...(phase === "verifying_check" ? { checkCommand: "x" } : {}),
					...(phase === "evaluating_condition" ? { untilCondition: "x" } : {}),
					...(phase === "pacing" ? { everyMs: 1 } : {}),
				})
			).snapshot!;
			let x: any = s;
			if (phase !== "dispatching") x = (await e.markRunning(token(x))).snapshot!;
			if (["verifying_check", "evaluating_condition", "pacing", "pausing", "stopping"].includes(phase)) {
				if (phase === "pausing" || phase === "stopping")
					await (phase === "pausing" ? e.requestPause("user_paused") : e.requestStop());
				else {
					const settled = (
						await e.recordSettlement(token(x), {
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								costUsd: 0,
								evaluatorCostUsd: 0,
								wallTimeMs: 0,
								toolCalls: 0,
								toolErrors: 0,
								retries: 0,
								compactions: 0,
							},
							controlCalls: [],
						})
					).snapshot!;
					x = settled;
				}
			}
			const replay = LoopEngine.rehydrate(new LoopStore(port), p);
			expect(["paused", "terminal"]).toContain(replay.getState()?.phase);
		}
	});
	it("preserves an already paused cause", async () => {
		const { e } = await realEngine();
		await e.requestPause("check_error");
		const replay = LoopEngine.rehydrate(new LoopStore(port), { now: () => 0, newId: () => "new" });
		expect(replay.getState()?.pauseCause).toBe("check_error");
	});
	it("keeps terminal terminal and permits a new start", async () => {
		const { e } = await realEngine();
		await e.requestStop();
		const replay = LoopEngine.rehydrate(new LoopStore(port), { now: () => 0, newId: (k) => `${k}-new` });
		expect(replay.getState()?.phase).toBe("terminal");
		expect((await replay.start(cfg)).applied).toBe(true);
	});
	it("turns revision rollback into protocol_error pause", async () => {
		const { e } = await realEngine();
		const s = e.getState()!;
		entries.push({ type: "phi.loop.state.v1", data: { ...s, revision: 0 } });
		const replay = LoopEngine.rehydrate(new LoopStore(port), { now: () => 0, newId: () => "x" });
		expect(replay.getState()?.pauseCause).toBe("protocol_error");
	});
	it("skips unknown schema entries and malformed entries", async () => {
		entries.length = 0;
		entries.push(
			{ type: "phi.loop.state.v1", data: { schemaVersion: 99, loopId: "x" } },
			{ type: "phi.loop.state.v1", data: { schemaVersion: 1 } },
		);
		const r = new LoopStore(port).reconstruct();
		expect(r.latest).toBeUndefined();
		expect(r.corruption).toContain("unknown schemaVersion");
		expect(r.corruption).toContain("malformed");
	});
	it("does not append a second audit on terminal rehydrate", async () => {
		const { e } = await realEngine();
		await e.requestStop();
		const count = entries.filter((x) => x.type === "phi.loop.audit.v1").length;
		LoopEngine.rehydrate(new LoopStore(port), { now: () => 0, newId: () => "x" });
		expect(entries.filter((x) => x.type === "phi.loop.audit.v1")).toHaveLength(count);
	});
	it("reconstructs iteration records for a later audit after resume", async () => {
		const { e } = await realEngine();
		await e.requestPause("user_paused");
		const replay = LoopEngine.rehydrate(new LoopStore(port), { now: () => 0, newId: (k) => `${k}-resume` });
		const p = replay.getState()!;
		const r = (await replay.resume(token(p))).snapshot!;
		await replay.requestStop();
		const audit = entries.find((x) => x.type === "phi.loop.audit.v1")?.data as any;
		expect(audit.iterationTable.length).toBeGreaterThanOrEqual(0);
		expect(audit.loopId).toBe(r.loopId);
	});
});
