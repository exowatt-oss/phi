import type { LoopStore } from "./store.ts";
import {
	type CheckOutcome,
	type EvaluatorOutcome,
	isLegalTransition,
	LOOP_SCHEMA_VERSION,
	type LoopAuditRecord,
	type LoopConfig,
	type LoopControlCall,
	type LoopIterationRecord,
	type LoopPauseCause,
	type LoopStateSnapshot,
	type LoopTerminalReason,
	type LoopUsageTotals,
} from "./types.ts";

export type LoopToken = { loopId: string; iterationId?: string; revision: number };
export interface LoopEnginePorts {
	store: LoopStore;
	now(): number;
	newId(kind: "loop" | "iteration"): string;
	onTransition?(snapshot: LoopStateSnapshot): void;
}

type Result<T = object> = { applied: boolean; reason?: string; snapshot?: LoopStateSnapshot } & T;
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
const add = (a: LoopUsageTotals, b: LoopUsageTotals): LoopUsageTotals =>
	Object.fromEntries(Object.keys(a).map((k) => [k, (a as any)[k] + ((b as any)[k] ?? 0)])) as LoopUsageTotals;

export class LoopEngine {
	private queue: Promise<unknown> = Promise.resolve();
	private current?: LoopStateSnapshot;
	private pending?: { usage: LoopUsageTotals; calls: LoopControlCall[]; interrupted?: boolean; agentError?: string };
	private check?: CheckOutcome;
	private evaluator?: EvaluatorOutcome;
	private pauseRequested?: LoopPauseCause;
	private readonly records: LoopIterationRecord[] = [];
	// Rehydrated active iterations were already persisted; updatedAt is the best
	// available stand-in because restored loops are paused before resuming.
	private iterationStartedAt?: string;
	private readonly ports: LoopEnginePorts;
	private constructor(ports: LoopEnginePorts) {
		this.ports = ports;
	}
	private run<T>(fn: () => T | Promise<T>): Promise<T> {
		const result = this.queue.then(fn);
		this.queue = result.catch(() => undefined);
		return result;
	}
	private fail(reason: string): Result {
		return { applied: false, reason };
	}
	private transition(
		phase: LoopStateSnapshot["phase"],
		extra: Partial<LoopStateSnapshot> = {},
	): LoopStateSnapshot | undefined {
		const old = this.current;
		if (
			!old ||
			(old.phase !== phase && !isLegalTransition(old.phase, phase)) ||
			(old.phase === phase && phase !== "dispatching")
		)
			return undefined;
		const next = {
			...old,
			...extra,
			phase,
			revision: old.revision + 1,
			updatedAt: new Date(this.ports.now()).toISOString(),
		};
		this.current = next;
		this.ports.store.persistState(next);
		this.ports.onTransition?.(next);
		return next;
	}
	private token(token: LoopToken, phases?: LoopStateSnapshot["phase"][]): string | undefined {
		const s = this.current;
		if (!s) return "no active loop";
		if (
			s.loopId !== token.loopId ||
			s.revision !== token.revision ||
			(token.iterationId !== undefined && s.iterationId !== token.iterationId)
		)
			return "stale loop token";
		if (phases && !phases.includes(s.phase)) return `illegal phase ${s.phase}`;
		return undefined;
	}

	start(config: LoopConfig, opts: { sessionId?: string } = {}): Promise<Result<{ snapshot?: LoopStateSnapshot }>> {
		return this.run(() => {
			if (this.current && this.current.phase !== "terminal")
				return { applied: false, reason: "loop already active" };
			const now = new Date(this.ports.now()).toISOString();
			const idle: LoopStateSnapshot = {
				schemaVersion: LOOP_SCHEMA_VERSION,
				loopId: this.ports.newId("loop"),
				iterationIndex: 0,
				revision: 0,
				phase: "idle",
				config,
				cumulative: zero(),
				startedAt: config.startedAt || now,
				updatedAt: now,
				sessionId: opts.sessionId,
			};
			this.current = idle;
			this.ports.store.persistState(idle);
			this.ports.onTransition?.(idle);
			this.iterationStartedAt = new Date(this.ports.now()).toISOString();
			const next = this.transition("dispatching", { iterationId: this.ports.newId("iteration"), iterationIndex: 1 });
			return { applied: true, snapshot: next! };
		});
	}
	markRunning(token: LoopToken) {
		return this.run(() => {
			const e = this.token(token, ["dispatching"]);
			if (e) return this.fail(e);
			return { applied: true, snapshot: this.transition("running")! };
		});
	}
	recordSettlement(
		token: LoopToken,
		data: { usage: LoopUsageTotals; controlCalls: LoopControlCall[]; interrupted?: boolean; agentError?: string },
	) {
		return this.run(() => {
			const e = this.token(token, ["running"]);
			if (e) return this.fail(e);
			this.pending = {
				usage: data.usage,
				calls: data.controlCalls,
				interrupted: data.interrupted,
				agentError: data.agentError,
			};
			this.current = { ...this.current!, cumulative: add(this.current!.cumulative, data.usage) };
			const phase = this.current.config.checkCommand
				? "verifying_check"
				: this.current.config.untilCondition
					? "evaluating_condition"
					: "dispatching";
			return { applied: true, snapshot: this.transition(phase)! };
		});
	}
	applyCheck(token: LoopToken, outcome: CheckOutcome) {
		return this.run(() => {
			const e = this.token(token, ["verifying_check"]);
			if (e) return this.fail(e);
			this.check = outcome;
			const phase = this.current!.config.untilCondition ? "evaluating_condition" : "dispatching";
			return { applied: true, snapshot: this.transition(phase)! };
		});
	}
	applyEvaluator(token: LoopToken, outcome: EvaluatorOutcome) {
		return this.run(() => {
			const e = this.token(token, ["evaluating_condition"]);
			if (e) return this.fail(e);
			this.evaluator = outcome;
			this.current = {
				...this.current!,
				cumulative: {
					...this.current!.cumulative,
					evaluatorCostUsd: this.current!.cumulative.evaluatorCostUsd + outcome.costUsd,
				},
			};
			return { applied: true, snapshot: this.transition("dispatching")! };
		});
	}

	decide(token: LoopToken): Promise<
		Result<{
			decision?: {
				kind: "continue" | "complete" | "pause";
				reason: string;
				terminalReason?: LoopTerminalReason;
				pauseCause?: LoopPauseCause;
			};
		}>
	> {
		return this.run(() => {
			const e = this.token(token, ["dispatching", "verifying_check", "evaluating_condition"]);
			if (e) return this.fail(e);
			const s = this.current!,
				c = s.config,
				p = this.pending;
			let kind: "continue" | "complete" | "pause" = "continue";
			let reason = "worker requested continue",
				terminalReason: LoopTerminalReason | undefined,
				pauseCause: LoopPauseCause | undefined,
				precedence = "worker_loop_control";
			const valid = (p?.calls ?? []).filter((x) => !x.invalid && !x.stale && x.iterationId === s.iterationId);
			const call = valid.at(-1);
			if (this.pauseRequested) {
				kind = "pause";
				pauseCause = this.pauseRequested;
				reason = "pause requested";
				precedence = "user_pause";
			} else if (s.iterationIndex >= c.maxIterations && !(call?.action === "complete")) {
				kind = "complete";
				terminalReason = "iteration_limit";
				reason = "iteration limit";
				precedence = "iteration_limit";
			} else if (this.ports.now() - Date.parse(s.startedAt) >= c.timeoutMs) {
				kind = "complete";
				terminalReason = "wall_time_limit";
				reason = "wall time limit";
				precedence = "wall_time_limit";
			} else if (
				(() => {
					const budget = c.budgetUsd;
					return (
						typeof budget === "number" &&
						Number.isFinite(budget) &&
						s.cumulative.costUsd + s.cumulative.evaluatorCostUsd >= budget
					);
				})()
			) {
				kind = "complete";
				terminalReason = "budget_limit";
				reason = "budget limit";
				precedence = "budget_limit";
			} else if (this.check?.verdict === "error") {
				kind = "pause";
				pauseCause = "check_error";
				reason = "check error";
				precedence = "check";
			} else if (c.checkCommand && this.check?.verdict === "satisfied" && !c.untilCondition) {
				kind = "complete";
				terminalReason = "check_passed";
				reason = "check passed";
				precedence = "check";
			} else if (this.evaluator?.error) {
				kind = "pause";
				pauseCause = "evaluator_error";
				reason = "evaluator error";
				precedence = "evaluator";
			} else if (
				c.untilCondition &&
				this.evaluator?.verdict?.satisfied &&
				this.evaluator.verdict.confidence >= c.evaluatorConfidence
			) {
				kind = "complete";
				terminalReason = c.checkCommand ? "check_and_condition_satisfied" : "condition_satisfied";
				reason = "condition satisfied";
				precedence = "evaluator";
			} else if (call?.action === "complete" && !c.checkCommand && !c.untilCondition) {
				kind = "complete";
				terminalReason = "completed_by_model";
				reason = call.summary;
				precedence = "worker_loop_control";
			} else if (call?.action === "pause") {
				kind = "pause";
				pauseCause = "worker_requested";
				reason = call.summary;
				precedence = "worker_loop_control";
			} else if (!call) precedence = "protocol_anomaly";
			const ended = new Date(this.ports.now()).toISOString();
			const usage = p?.usage ?? zero();
			const rec: LoopIterationRecord = {
				schemaVersion: LOOP_SCHEMA_VERSION,
				loopId: s.loopId,
				iterationId: s.iterationId!,
				index: s.iterationIndex,
				startedAt: this.iterationStartedAt ?? s.updatedAt,
				endedAt: ended,
				phaseOutcome: kind,
				decisionPrecedence: precedence,
				workerModel: c.workerModel,
				usage,
				toolCalls: usage.toolCalls,
				toolErrors: usage.toolErrors,
				retries: usage.retries,
				compactions: usage.compactions,
				check: this.check,
				evaluator: this.evaluator,
				controlCalls: p?.calls ?? [],
				protocolAnomalies: call ? [] : ["no valid loop_control call"],
				interrupted: p?.interrupted,
				summary: call?.summary,
				nextStep: call?.nextStep,
			};
			this.records.push(rec);
			this.ports.store.persistIteration(rec);
			const decision = {
				kind,
				reason,
				...(terminalReason ? { terminalReason } : {}),
				...(pauseCause ? { pauseCause } : {}),
			} as const;
			this.pauseRequested = undefined;
			this.pending = undefined;
			this.check = undefined;
			this.evaluator = undefined;
			if (kind === "pause") {
				this.transition("pausing", { pauseCause });
				const paused = this.transition("paused", { pauseCause });
				return { applied: true, decision, snapshot: paused };
			}
			if (kind === "complete") {
				const terminal = this.terminalize(terminalReason!);
				this.audit(terminal!);
				return { applied: true, decision, snapshot: terminal };
			}
			if (s.iterationIndex >= c.maxIterations) {
				const terminal = this.terminalize("iteration_limit");
				this.audit(terminal!);
				return {
					applied: true,
					decision: { kind: "complete", reason: "iteration limit", terminalReason: "iteration_limit" },
					snapshot: terminal,
				};
			}
			const phase = c.everyMs > 0 ? "pacing" : "dispatching";
			this.iterationStartedAt = new Date(this.ports.now()).toISOString();
			return {
				applied: true,
				decision,
				snapshot: this.transition(phase, {
					iterationId: this.ports.newId("iteration"),
					iterationIndex: s.iterationIndex + 1,
				}),
			};
		});
	}
	private terminalize(reason: LoopTerminalReason): LoopStateSnapshot | undefined {
		const old = this.current;
		if (!old || old.phase === "terminal") return old;
		const next: LoopStateSnapshot = {
			...old,
			phase: "terminal",
			terminalReason: reason,
			revision: old.revision + 1,
			updatedAt: new Date(this.ports.now()).toISOString(),
		};
		this.current = next;
		this.ports.store.persistState(next);
		this.ports.onTransition?.(next);
		return next;
	}
	private audit(s: LoopStateSnapshot): void {
		const entries = [...this.records, ...this.ports.store.reconstruct().iterations].filter(
			(r, i, a) => a.findIndex((x) => x.iterationId === r.iterationId) === i,
		);
		const audit: LoopAuditRecord = {
			schemaVersion: LOOP_SCHEMA_VERSION,
			loopId: s.loopId,
			reason: s.terminalReason!,
			iterations: entries.length,
			totals: s.cumulative,
			startedAt: s.startedAt,
			endedAt: s.updatedAt,
			config: s.config,
			iterationTable: entries.map(
				({
					iterationId,
					index,
					startedAt,
					endedAt,
					phaseOutcome,
					decisionPrecedence,
					summary,
					nextStep,
					interrupted,
				}) => ({
					iterationId,
					index,
					startedAt,
					endedAt,
					phaseOutcome,
					decisionPrecedence,
					summary,
					nextStep,
					interrupted,
				}),
			),
		};
		this.ports.store.persistAudit(audit);
	}
	paceElapsed(token: LoopToken) {
		return this.run(() => {
			const e = this.token(token, ["pacing"]);
			if (e) return this.fail(e);
			this.iterationStartedAt = new Date(this.ports.now()).toISOString();
			return {
				applied: true,
				snapshot: this.transition("dispatching", {
					iterationId: this.ports.newId("iteration"),
					iterationIndex: this.current!.iterationIndex + 1,
				})!,
			};
		});
	}
	requestPause(cause: LoopPauseCause) {
		return this.run(() => {
			if (!this.current || this.current.phase === "terminal") return this.fail("no active loop");
			this.pauseRequested = cause;
			if (this.current.phase === "running") return { applied: true, snapshot: this.current };
			const p = this.transition("pausing", { pauseCause: cause });
			if (!p) return this.fail(`illegal phase ${this.current.phase}`);
			return { applied: true, snapshot: this.transition("paused", { pauseCause: cause }) ?? p };
		});
	}
	requestStop() {
		return this.run(() => {
			if (!this.current || this.current.phase === "terminal") return this.fail("no active loop");
			const stopping = this.transition("stopping");
			const terminal = this.terminalize("user_stopped");
			this.audit(terminal!);
			return { applied: true, snapshot: terminal ?? stopping };
		});
	}
	resume(token: LoopToken) {
		return this.run(() => {
			const e = this.token(token, ["paused"]);
			if (e) return this.fail(e);
			const increment = this.current!.iterationId ? 1 : 0;
			this.iterationStartedAt = new Date(this.ports.now()).toISOString();
			return {
				applied: true,
				snapshot: this.transition("dispatching", {
					pauseCause: undefined,
					iterationId: this.ports.newId("iteration"),
					iterationIndex: this.current!.iterationIndex + increment,
				})!,
			};
		});
	}
	markInterrupted() {
		return this.run(() => {
			if (!this.current || this.current.phase === "terminal" || this.current.phase === "paused")
				return { applied: false, reason: "not active" };
			this.transition("pausing", { pauseCause: "session_interrupted" });
			return { applied: true, snapshot: this.transition("paused", { pauseCause: "session_interrupted" })! };
		});
	}
	getState(): LoopStateSnapshot | undefined {
		return this.current;
	}
	static rehydrate(store: LoopStore, ports: Omit<LoopEnginePorts, "store">): LoopEngine {
		const e = new LoopEngine({ ...ports, store });
		const r = store.reconstruct();
		e.current = r.latest;
		if (e.current?.iterationId) e.iterationStartedAt = e.current.updatedAt;
		if (
			e.current &&
			[
				"dispatching",
				"running",
				"verifying_check",
				"evaluating_condition",
				"pacing",
				"pausing",
				"stopping",
			].includes(e.current.phase)
		) {
			e.transition("pausing", { pauseCause: r.corruption ? "protocol_error" : "session_interrupted" });
			e.transition("paused", { pauseCause: r.corruption ? "protocol_error" : "session_interrupted" });
		} else if (e.current && r.corruption && e.current.phase !== "terminal") {
			e.current = { ...e.current, phase: "paused", pauseCause: "protocol_error", revision: e.current.revision + 1 };
			store.persistState(e.current);
			ports.onTransition?.(e.current);
		}
		return e;
	}
}
