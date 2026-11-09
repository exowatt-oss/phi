import type { LoopUsageTotals } from "./types.ts";

export function emptyUsageTotals(): LoopUsageTotals {
	return {
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
	};
}

export function addUsage(a: LoopUsageTotals, b: Partial<LoopUsageTotals>): LoopUsageTotals {
	const result = { ...a } as Record<string, number>;
	for (const key of Object.keys(a) as (keyof LoopUsageTotals)[])
		result[key] = a[key] + (Number.isFinite(b[key]) ? b[key]! : 0);
	return result as unknown as LoopUsageTotals;
}

/** Usage is {input, output, cacheRead, cacheWrite, cost: {total}} in packages/ai/src/models.ts. */
export function usageFromAssistantMessage(
	msg:
		| {
				usage?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					cost?: { total?: number };
				};
		  }
		| undefined,
): Partial<LoopUsageTotals> {
	const usage = msg?.usage;
	const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	return {
		input: number(usage?.input),
		output: number(usage?.output),
		cacheRead: number(usage?.cacheRead),
		cacheWrite: number(usage?.cacheWrite),
		costUsd: number(usage?.cost?.total),
	};
}

export function budgetExceeded(totals: LoopUsageTotals, budgetUsd?: number): boolean {
	return budgetUsd !== undefined && totals.costUsd + totals.evaluatorCostUsd >= budgetUsd;
}

export function formatUsd(n: number): string {
	return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

export function formatDurationMs(ms: number): string {
	let seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
	const hours = Math.floor(seconds / 3600);
	seconds %= 3600;
	const minutes = Math.floor(seconds / 60);
	seconds %= 60;
	if (hours) return `${hours}h ${minutes}m`;
	if (minutes) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}
