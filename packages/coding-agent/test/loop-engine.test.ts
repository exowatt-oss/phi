import { describe, expect, it } from "vitest";
import { LoopEngine } from "../src/extensions/loop/engine.ts";
import { LoopStore, type LoopStorePort } from "../src/extensions/loop/store.ts";
import type {
	CheckOutcome,
	EvaluatorOutcome,
	LoopConfig,
	LoopControlCall,
	LoopStateSnapshot,
	LoopUsageTotals,
} from "../src/extensions/loop/types.ts";

const zero = (): LoopUsageTotals => ({
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
});
const cfg = (o: Partial<LoopConfig> = {}): LoopConfig => ({
	task: "task",
	maxIterations: 3,
	checkTimeoutMs: 1000,
	everyMs: 0,
	timeoutMs: 10_000,
	budgetUsd: 10,
	evaluatorConfidence: 0.8,
	cwd: "/tmp",
	startedAt: new Date(0).toISOString(),
	...o,
});
const check = (verdict: CheckOutcome["verdict"]): CheckOutcome => ({
	command: "test",
	cwd: "/tmp",
	exitCode: verdict === "error" ? 1 : 0,
	signal: null,
	timedOut: false,
	durationMs: 1,
	stdoutTail: "",
	stderrTail: "",
	truncated: false,
	verdict,
});
const evaluator = (satisfied: boolean, confidence = 1, error?: string): EvaluatorOutcome => ({
	model: "judge",
	usage: zero(),
	costUsd: 0,
	...(error ? { error } : { verdict: { satisfied, confidence, rationale: "r", missing: [] } }),
});
type Entry = { type: string; data?: unknown };
function setup(now: () => number = () => 0) {
	const entries: Entry[] = [];
	const port: LoopStorePort = { append: (type, data) => entries.push({ type, data }), entries: () => entries };
	let n = 0;
	const engine = LoopEngine.rehydrate(new LoopStore(port), { now, newId: (kind) => `${kind}-${++n}` });
	return { engine, entries };
}
const token = (s: LoopStateSnapshot) => ({ loopId: s.loopId, iterationId: s.iterationId, revision: s.revision });
async function begin(engine: LoopEngine, c = cfg()) {
	return (await engine.start(c)).snapshot!;
}
async function settle(engine: LoopEngine, s: LoopStateSnapshot, usage = zero(), calls: LoopControlCall[] = []) {
	const r = (await engine.markRunning(token(s))).snapshot!;
	return (await engine.recordSettlement(token(r), { usage, controlCalls: calls })).snapshot!;
}
async function _drive(
	engine: LoopEngine,
	c = cfg(),
	calls: LoopControlCall[] = [],
	opts: { check?: CheckOutcome["verdict"]; evaluator?: EvaluatorOutcome } = {},
) {
	let s = await begin(engine, c);
	s = await settle(engine, s, opts.evaluator?.usage ?? zero(), calls);
	if (opts.check) s = (await engine.applyCheck(token(s), check(opts.check))).snapshot!;
	if (opts.evaluator) s = (await engine.applyEvaluator(token(s), opts.evaluator)).snapshot!;
	return { result: await engine.decide(token(s)), snapshot: s };
}
const call = (s: LoopStateSnapshot, action: LoopControlCall["action"]): LoopControlCall => ({
	action,
	summary: action,
	at: "worker",
	iterationId: s.iterationId!,
});
const states = (es: Entry[]) =>
	es.filter((e) => e.type === "phi.loop.state.v1").map((e) => e.data as LoopStateSnapshot);
const iterations = (es: Entry[]) => es.filter((e) => e.type === "phi.loop.iteration.v1").map((e) => e.data as any);
const audits = (es: Entry[]) => es.filter((e) => e.type === "phi.loop.audit.v1");

describe("LoopEngine — bounded controller matrix", () => {
	it("completes with loop_control when no gates are configured", async () => {
		const { engine } = setup();
		const s = await begin(engine);
		const r = await settle(engine, s, zero(), [call(s, "complete")]);
		const d = await engine.decide(token(r));
		expect(d.decision?.terminalReason).toBe("completed_by_model");
	});
	it("check-only completes on a satisfied check", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ checkCommand: "test" }));
		const r = await settle(engine, s, zero(), [call(s, "continue")]);
		const x = (await engine.applyCheck(token(r), check("satisfied"))).snapshot!;
		expect((await engine.decide(token(x))).decision?.terminalReason).toBe("check_passed");
	});
	it("until-only completes at or above the confidence threshold", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ untilCondition: "done" }));
		const r = await settle(engine, s, zero(), [call(s, "continue")]);
		const x = (await engine.applyEvaluator(token(r), evaluator(true, 0.8))).snapshot!;
		expect((await engine.decide(token(x))).decision?.terminalReason).toBe("condition_satisfied");
	});
	it("both gates complete with the combined reason", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ checkCommand: "test", untilCondition: "done" }));
		const r = await settle(engine, s, zero(), [call(s, "continue")]);
		const x = (await engine.applyCheck(token(r), check("satisfied"))).snapshot!;
		const y = (await engine.applyEvaluator(token(x), evaluator(true))).snapshot!;
		expect((await engine.decide(token(y))).decision?.terminalReason).toBe("check_and_condition_satisfied");
	});
	it("continue advances index and creates a new iteration with monotonic revisions", async () => {
		const { engine, entries } = setup();
		const s = await begin(engine);
		const r = await settle(engine, s, zero(), [call(s, "continue")]);
		const d = await engine.decide(token(r));
		expect(d.snapshot!.iterationIndex).toBe(2);
		expect(d.snapshot!.iterationId).not.toBe(s.iterationId);
		const ss = states(entries);
		expect(ss.map((x) => x.revision)).toEqual([...ss].sort((a, b) => a.revision - b.revision).map((x) => x.revision));
		expect(ss.at(-1)!.revision).toBe(ss.at(-2)!.revision + 1);
	});
	it("unsatisfied check makes model complete continue", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ checkCommand: "test" }));
		const r = await settle(engine, s, zero(), [call(s, "complete")]);
		const x = (await engine.applyCheck(token(r), check("unsatisfied"))).snapshot!;
		expect((await engine.decide(token(x))).decision?.kind).toBe("continue");
	});
	it("check error pauses", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ checkCommand: "test" }));
		const r = await settle(engine, s);
		const x = (await engine.applyCheck(token(r), check("error"))).snapshot!;
		expect((await engine.decide(token(x))).decision?.pauseCause).toBe("check_error");
	});
	it("satisfied check outranks worker uncertainty", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ checkCommand: "test" }));
		const r = await settle(engine, s, zero(), [call(s, "continue")]);
		const x = (await engine.applyCheck(token(r), check("satisfied"))).snapshot!;
		expect((await engine.decide(token(x))).decision?.terminalReason).toBe("check_passed");
	});
	it("evaluator below threshold continues", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ untilCondition: "done" }));
		const r = await settle(engine, s);
		const x = (await engine.applyEvaluator(token(r), evaluator(true, 0.79))).snapshot!;
		expect((await engine.decide(token(x))).decision?.kind).toBe("continue");
	});
	it("evaluator error pauses", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ untilCondition: "done" }));
		const r = await settle(engine, s);
		const x = (await engine.applyEvaluator(token(r), evaluator(false, 0, "broken"))).snapshot!;
		expect((await engine.decide(token(x))).decision?.pauseCause).toBe("evaluator_error");
	});
	it("pause requested during running wins at decide", async () => {
		const { engine } = setup();
		const s = await begin(engine);
		const r = (await engine.markRunning(token(s))).snapshot!;
		await engine.requestPause("user_paused");
		const x = (await engine.recordSettlement(token(r), { usage: zero(), controlCalls: [call(r, "complete")] }))
			.snapshot!;
		expect((await engine.decide(token(x))).decision?.kind).toBe("pause");
	});
	it("worker pause produces worker_requested", async () => {
		const { engine } = setup();
		const s = await begin(engine);
		const r = await settle(engine, s, zero(), [call(s, "pause")]);
		expect((await engine.decide(token(r))).decision?.pauseCause).toBe("worker_requested");
	});
	it("missing loop control persists an anomaly", async () => {
		const { engine, entries } = setup();
		const s = await begin(engine);
		const r = await settle(engine, s);
		await engine.decide(token(r));
		expect(iterations(entries)[0].protocolAnomalies).toContain("no valid loop_control call");
	});
	it("uses the final valid call and records every call", async () => {
		const { engine, entries } = setup();
		const s = await begin(engine);
		const r = await settle(engine, s, zero(), [call(s, "continue"), call(s, "complete")]);
		await engine.decide(token(r));
		expect(iterations(entries)[0].controlCalls).toHaveLength(2);
		expect(iterations(entries)[0].phaseOutcome).toBe("complete");
	});
	it("filters a call for the wrong iteration", async () => {
		const { engine, entries } = setup();
		const s = await begin(engine);
		const r = await settle(engine, s, zero(), [{ ...call(s, "complete"), iterationId: "wrong" }]);
		const d = await engine.decide(token(r));
		expect(d.decision?.kind).toBe("continue");
		expect(iterations(entries)[0].protocolAnomalies).toContain("no valid loop_control call");
	});
	it("allows iteration two to complete before the exact limit", async () => {
		const { engine } = setup();
		let s = await begin(engine, cfg({ maxIterations: 2 }));
		let r = await settle(engine, s, zero(), [call(s, "continue")]);
		s = (await engine.decide(token(r))).snapshot!;
		r = await settle(engine, s, zero(), [call(s, "complete")]);
		expect((await engine.decide(token(r))).decision?.terminalReason).toBe("completed_by_model");
	});
	it("enforces iteration limit", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ maxIterations: 1 }));
		const r = await settle(engine, s, zero(), [call(s, "continue")]);
		expect((await engine.decide(token(r))).decision?.terminalReason).toBe("iteration_limit");
	});
	it("enforces wall time", async () => {
		let now = 0;
		const { engine } = setup(() => now);
		const s = await begin(engine, cfg({ timeoutMs: 10 }));
		const r = await settle(engine, s);
		now = 11;
		expect((await engine.decide(token(r))).decision?.terminalReason).toBe("wall_time_limit");
	});
	it("leaves an unset budget unlimited", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ budgetUsd: undefined }));
		const r = await settle(engine, s, { ...zero(), costUsd: 1000 });
		expect((await engine.decide(token(r))).decision?.terminalReason).not.toBe("budget_limit");
	});
	it("enforces worker cost budget", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ budgetUsd: 1 }));
		const r = await settle(engine, s, { ...zero(), costUsd: 1 });
		expect((await engine.decide(token(r))).decision?.terminalReason).toBe("budget_limit");
	});
	it("records overshoot rather than clamping totals", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ budgetUsd: 1 }));
		const r = await settle(engine, s, { ...zero(), costUsd: 99 });
		const d = await engine.decide(token(r));
		expect(d.snapshot?.cumulative.costUsd).toBe(99);
		expect(d.decision?.terminalReason).toBe("budget_limit");
	});
	it("counts evaluator cost toward the budget", async () => {
		const { engine } = setup();
		const s = await begin(engine, cfg({ untilCondition: "x", budgetUsd: 1 }));
		const r = await settle(engine, s);
		const x = (await engine.applyEvaluator(token(r), { ...evaluator(false), costUsd: 2 })).snapshot!;
		expect((await engine.decide(token(x))).decision?.terminalReason).toBe("budget_limit");
	});
	it("rejects stale revision on every token mutator without persistence", async () => {
		const methods = [
			"markRunning",
			"recordSettlement",
			"applyCheck",
			"applyEvaluator",
			"decide",
			"paceElapsed",
			"resume",
		] as const;
		for (const method of methods) {
			const { engine, entries } = setup();
			const s = await begin(
				engine,
				method === "resume"
					? cfg()
					: method === "paceElapsed"
						? cfg({ everyMs: 1 })
						: method === "applyCheck"
							? cfg({ checkCommand: "x" })
							: method === "applyEvaluator"
								? cfg({ untilCondition: "x" })
								: cfg(),
			);
			const before = entries.length;
			const bad = { ...token(s), revision: s.revision - 1 };
			const args: any =
				method === "recordSettlement"
					? [bad, { usage: zero(), controlCalls: [] }]
					: method === "applyCheck"
						? [bad, check("satisfied")]
						: method === "applyEvaluator"
							? [bad, evaluator(true)]
							: [bad];
			const result = await (engine as any)[method](...args);
			expect(result.applied, method).toBe(false);
			expect(entries.length, method).toBe(before);
		}
	});
	it("pace elapsed after stop cannot resurrect", async () => {
		const now = 0;
		const { engine, entries } = setup(() => now);
		let s = await begin(engine, cfg({ everyMs: 1 }));
		const r = await settle(engine, s, zero(), [call(s, "continue")]);
		await engine.decide(token(r));
		s = engine.getState()!;
		const p = await engine.requestStop();
		const before = entries.length;
		const x = await engine.paceElapsed(token(s));
		expect(x.applied).toBe(false);
		expect(entries.length).toBe(before);
		expect(p.snapshot?.phase).toBe("terminal");
	});
	it("rejects a second decide with the same token", async () => {
		const { engine } = setup();
		const s = await begin(engine);
		const r = await settle(engine, s);
		const first = await engine.decide(token(r));
		const second = await engine.decide(token(r));
		expect(first.applied).toBe(true);
		expect(second.applied).toBe(false);
	});
	it("rejects a prior iteration settlement after the next starts", async () => {
		const { engine } = setup();
		const s = await begin(engine);
		const running = (await engine.markRunning(token(s))).snapshot!;
		const r = (await engine.recordSettlement(token(running), { usage: zero(), controlCalls: [] })).snapshot!;
		const next = (await engine.decide(token(r))).snapshot!;
		const stale = await engine.recordSettlement(token(running), { usage: zero(), controlCalls: [] });
		expect(stale.applied).toBe(false);
		expect(next.iterationId).not.toBe(running.iterationId);
	});
	it("rejects resume with a pre-pause token", async () => {
		const { engine } = setup();
		const s = await begin(engine);
		await engine.requestPause("user_paused");
		expect((await engine.resume(token(s))).applied).toBe(false);
	});
	it("rejects start atomically while active", async () => {
		const { engine, entries } = setup();
		await begin(engine);
		const before = entries.length;
		const x = await engine.start(cfg());
		expect(x.applied).toBe(false);
		expect(entries.length).toBe(before);
	});
	it("starts a new loop after terminal with revision zero", async () => {
		const { engine } = setup();
		const s = await begin(engine);
		const r = await settle(engine, s, zero(), [call(s, "complete")]);
		await engine.decide(token(r));
		const n = await engine.start(cfg());
		expect(n.applied).toBe(true);
		expect(n.snapshot!.loopId).not.toBe(s.loopId);
		expect(n.snapshot!.revision).toBe(1);
	});
	it("writes one audit when completed then stopped", async () => {
		const { engine, entries } = setup();
		const s = await begin(engine);
		const r = await settle(engine, s, zero(), [call(s, "complete")]);
		await engine.decide(token(r));
		await engine.requestStop();
		expect(audits(entries)).toHaveLength(1);
	});
	it("writes one audit for repeated stop", async () => {
		const { engine, entries } = setup();
		await begin(engine);
		await engine.requestStop();
		await engine.requestStop();
		expect(audits(entries)).toHaveLength(1);
	});
	it("does not audit a paused loop", async () => {
		const { engine, entries } = setup();
		await begin(engine);
		await engine.requestPause("user_paused");
		expect(audits(entries)).toHaveLength(0);
	});
	it("stops a check-error pause with user_stopped audit", async () => {
		const { engine, entries } = setup();
		const s = await begin(engine, cfg({ checkCommand: "x" }));
		const r = await settle(engine, s);
		const x = (await engine.applyCheck(token(r), check("error"))).snapshot!;
		await engine.decide(token(x));
		await engine.requestStop();
		expect((audits(entries)[0].data as any).reason).toBe("user_stopped");
	});
	it("audit iteration table has one row per run", async () => {
		const { engine, entries } = setup();
		let s = await begin(engine);
		let r = await settle(engine, s, zero(), [call(s, "continue")]);
		s = (await engine.decide(token(r))).snapshot!;
		r = await settle(engine, s, zero(), [call(s, "complete")]);
		await engine.decide(token(r));
		expect((audits(entries)[0].data as any).iterationTable).toHaveLength(2);
	});
	it("preserves interrupted settlement in its iteration record", async () => {
		const { engine, entries } = setup();
		const s = await begin(engine);
		const r = (await engine.markRunning(token(s))).snapshot!;
		const x = (await engine.recordSettlement(token(r), { usage: zero(), controlCalls: [], interrupted: true }))
			.snapshot!;
		await engine.decide(token(x));
		expect(iterations(entries)[0].interrupted).toBe(true);
	});
});
