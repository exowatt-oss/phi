import type { LoopConfig, LoopIterationRecord, LoopStateSnapshot } from "./types.ts";

const rules =
	"Rules: do not raise any bound; never declare a failed hard gate complete. For repetitive or periodic tasks (report, poll, echo, check), DO the task each iteration and then call loop_control continue. Pause ONLY for missing credentials or permissions, destructive ambiguity, or a genuine need for a human decision; a vague-but-doable task must be done, not paused. Use complete only when the overall task is genuinely finished; open-ended periodic tasks continue until a limit.";
const protocol =
	"Call loop_control once near the end of this iteration with action continue|complete|pause, a concise summary, evidence, and nextStep. For a repeatable task, the normal action is continue.";

function budget(value: number | undefined): string {
	return value === undefined ? "unlimited" : `$${value}`;
}

export function buildInitialLoopPrompt(config: LoopConfig, _snapshot: LoopStateSnapshot): string {
	return `${config.task}\n\n[bounded /loop protocol]\nYou are in a bounded loop, iteration 1 of ${config.maxIterations}. Hard limits: ${config.maxIterations} iterations, ${config.timeoutMs}ms wall time, ${budget(config.budgetUsd)} budget. Gates: check=${config.checkCommand ?? "none"}; until=${config.untilCondition ?? "none"}. ${protocol} ${rules}`;
}

export function buildContinuationPrompt(args: {
	config: LoopConfig;
	snapshot: LoopStateSnapshot;
	lastRecord?: LoopIterationRecord;
	remaining: { iterations: number; wallTimeMs: number; budgetUsd?: number };
	checkSummary?: string;
	repoSummary?: string;
}): string {
	const record = args.lastRecord;
	return `[bounded /loop continuation]\nIteration ${args.snapshot.iterationIndex} of ${args.config.maxIterations}. Original task:\n${args.config.task}\n\nPrior summary: ${record?.summary ?? "none"}\nUnresolved next step: ${record?.nextStep ?? "none"}\nLast check: ${args.checkSummary ?? "none"}\nRepository state: ${args.repoSummary ?? "none"}\nRemaining: ${args.remaining.iterations} iterations, ${args.remaining.wallTimeMs}ms wall time, ${args.remaining.budgetUsd === undefined ? "unlimited" : `$${args.remaining.budgetUsd}`} budget. Gates: check=${args.config.checkCommand ?? "none"}; until=${args.config.untilCondition ?? "none"}. ${protocol} ${rules}`;
}
