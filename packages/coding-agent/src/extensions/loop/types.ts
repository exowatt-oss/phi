export const LOOP_SCHEMA_VERSION = 1 as const;

export const LOOP_STATE_ENTRY = "phi.loop.state.v1" as const;
export const LOOP_ITERATION_ENTRY = "phi.loop.iteration.v1" as const;
export const LOOP_AUDIT_ENTRY = "phi.loop.audit.v1" as const;
export const LOOP_SNAPSHOT_ENTRY = "phi.loop.snapshot.v1" as const;

export type LoopPhase =
	| "idle"
	| "dispatching"
	| "running"
	| "verifying_check"
	| "evaluating_condition"
	| "pacing"
	| "pausing"
	| "paused"
	| "stopping"
	| "terminal";

export type LoopTerminalReason =
	| "completed_by_model"
	| "check_passed"
	| "condition_satisfied"
	| "check_and_condition_satisfied"
	| "user_stopped"
	| "iteration_limit"
	| "wall_time_limit"
	| "budget_limit"
	| "permission_required"
	| "check_error"
	| "evaluator_error"
	| "protocol_error"
	| "session_interrupted"
	| "agent_error";

export type LoopPauseCause =
	| "user_paused"
	| "permission_required"
	| "session_interrupted"
	| "check_error"
	| "evaluator_error"
	| "protocol_error"
	| "worker_requested";

export interface LoopConfig {
	readonly task: string;
	readonly maxIterations: number;
	readonly untilCondition?: string;
	readonly checkCommand?: string;
	readonly checkTimeoutMs: number;
	readonly everyMs: number;
	readonly timeoutMs: number;
	readonly budgetUsd?: number;
	readonly workerModel?: string;
	readonly evaluatorModel?: string;
	readonly evaluatorConfidence: number;
	readonly cwd: string;
	readonly startedAt: string;
}

export const LOOP_MAX_ITERATIONS_CEILING = 100;
export const LOOP_MAX_WALL_TIME_MS_CEILING = 24 * 60 * 60 * 1000;
export const LOOP_DEFAULT_MAX_ITERATIONS = 12;
export const LOOP_DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const LOOP_DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const LOOP_DEFAULT_EVALUATOR_CONFIDENCE = 0.85;

export interface LoopUsageTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costUsd: number;
	readonly evaluatorCostUsd: number;
	readonly wallTimeMs: number;
	readonly toolCalls: number;
	readonly toolErrors: number;
	readonly retries: number;
	readonly compactions: number;
}

export interface LoopStateSnapshot {
	readonly schemaVersion: typeof LOOP_SCHEMA_VERSION;
	readonly loopId: string;
	readonly iterationId?: string;
	readonly iterationIndex: number;
	readonly revision: number;
	readonly phase: LoopPhase;
	readonly config: LoopConfig;
	readonly pauseCause?: LoopPauseCause;
	readonly terminalReason?: LoopTerminalReason;
	readonly cumulative: LoopUsageTotals;
	readonly startedAt: string;
	readonly updatedAt: string;
	readonly sessionId?: string;
	readonly headBefore?: string;
}

export interface CheckOutcome {
	readonly command: string;
	readonly cwd: string;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly durationMs: number;
	readonly stdoutTail: string;
	readonly stderrTail: string;
	readonly truncated: boolean;
	readonly verdict: "satisfied" | "unsatisfied" | "error";
	readonly mutatedWorktree?: boolean;
}

export interface EvaluatorVerdict {
	readonly satisfied: boolean;
	readonly confidence: number;
	readonly rationale: string;
	readonly missing: string[];
}

export interface EvaluatorOutcome {
	readonly model: string;
	readonly usage: LoopUsageTotals;
	readonly costUsd: number;
	readonly error?: string;
	readonly verdict?: EvaluatorVerdict;
}

export type LoopControlAction = "continue" | "complete" | "pause";

export interface LoopControlCall {
	readonly action: LoopControlAction;
	readonly summary: string;
	readonly evidence?: string[];
	readonly nextStep?: string;
	readonly at: string;
	readonly iterationId: string;
	readonly stale?: boolean;
	readonly invalid?: string;
}

export interface RepoSnapshot {
	readonly roots: string[];
	readonly head: string;
	readonly branch: string;
	readonly stagedCount: number;
	readonly unstagedCount: number;
	readonly untrackedCount: number;
	readonly numstat: {
		readonly filesChanged: number;
		readonly insertions: number;
		readonly deletions: number;
	};
}

export interface RepoDelta {
	readonly roots: string[];
	readonly head: string;
	readonly branch: string;
	readonly stagedCount: number;
	readonly unstagedCount: number;
	readonly untrackedCount: number;
	readonly numstat: {
		readonly filesChanged: number;
		readonly insertions: number;
		readonly deletions: number;
	};
	readonly commitsAdded: string[];
	readonly mixedChanges: boolean;
}

export interface LoopIterationRecord {
	readonly schemaVersion: typeof LOOP_SCHEMA_VERSION;
	readonly loopId: string;
	readonly iterationId: string;
	readonly index: number;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly phaseOutcome: "continue" | "complete" | "pause";
	readonly decisionPrecedence: string;
	readonly workerModel?: string;
	readonly usage: LoopUsageTotals;
	readonly contextPercent?: number;
	readonly toolCalls: number;
	readonly toolErrors: number;
	readonly retries: number;
	readonly compactions: number;
	readonly repoDelta?: RepoDelta;
	readonly check?: CheckOutcome;
	readonly evaluator?: EvaluatorOutcome;
	readonly controlCalls: LoopControlCall[];
	readonly protocolAnomalies: string[];
	readonly summary?: string;
	readonly nextStep?: string;
	readonly interrupted?: boolean;
}

type LoopAuditIteration = Pick<
	LoopIterationRecord,
	| "iterationId"
	| "index"
	| "startedAt"
	| "endedAt"
	| "phaseOutcome"
	| "decisionPrecedence"
	| "summary"
	| "nextStep"
	| "interrupted"
>;

export interface LoopAuditRecord {
	readonly schemaVersion: typeof LOOP_SCHEMA_VERSION;
	readonly loopId: string;
	readonly reason: LoopTerminalReason;
	readonly iterations: number;
	readonly totals: LoopUsageTotals;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly config: LoopConfig;
	readonly iterationTable: LoopAuditIteration[];
	readonly observed?: RepoDelta;
	readonly validationSummary?: string;
}

export const LEGAL_TRANSITIONS: Readonly<Record<LoopPhase, readonly LoopPhase[]>> = {
	idle: ["dispatching"],
	dispatching: ["running", "pausing", "stopping"],
	running: ["verifying_check", "evaluating_condition", "pacing", "dispatching", "pausing", "stopping", "terminal"],
	verifying_check: ["evaluating_condition", "pacing", "dispatching", "pausing", "stopping", "terminal"],
	evaluating_condition: ["pacing", "dispatching", "pausing", "stopping", "terminal"],
	pacing: ["dispatching", "pausing", "stopping"],
	pausing: ["paused"],
	paused: ["dispatching", "stopping"],
	stopping: ["terminal"],
	terminal: [],
};

export function isLegalTransition(from: LoopPhase, to: LoopPhase): boolean {
	return LEGAL_TRANSITIONS[from].includes(to);
}
