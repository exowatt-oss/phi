import { contextAwareCompactionEnabled } from "../../core/context-aware-compaction.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { registerCheckpointTool } from "./checkpoint-tool.ts";
import { consumeCheckpoint, resetCheckpointState } from "./state.ts";

export const CONTEXT_BUDGET_MESSAGE_TYPE = "context-budget";
const FIRST_BUCKET = 12; // 60% of the effective window, in five-point buckets.
const BUCKET_SIZE = 0.05;

type ResolvedCompactionSettings = {
	reserveTokens: number;
	softCeilingTokens?: number;
	effectiveWindow?: number;
	windowOpenAt?: number;
	hardAt?: number;
};

type BudgetMetrics = {
	tokens: number;
	contextWindow: number;
	effectiveWindow: number;
	windowOpenAt: number;
	hardAt: number;
	bucket: number;
};

function formatTokens(tokens: number): string {
	const rounded = Math.max(0, Math.round(tokens));
	if (rounded < 1000) return String(rounded);
	if (rounded < 1_000_000) return `${Math.round(rounded / 1000)}k`;
	const millions = rounded / 1_000_000;
	const precision = millions >= 100 ? 0 : millions >= 10 ? 1 : 2;
	return `${Number(millions.toFixed(precision))}m`;
}

function finitePositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveMetrics(ctx: ExtensionContext): BudgetMetrics | undefined {
	const usage = ctx.getContextUsage();
	if (!usage || !finitePositive(usage.contextWindow) || !finitePositive(usage.tokens)) return undefined;

	const settings = ctx.getCompactionSettings() as ResolvedCompactionSettings;
	const effectiveWindow = finitePositive(settings.effectiveWindow)
		? settings.effectiveWindow
		: finitePositive(settings.softCeilingTokens)
			? Math.min(usage.contextWindow, settings.softCeilingTokens)
			: usage.contextWindow;
	if (!finitePositive(effectiveWindow)) return undefined;

	const reserveTokens = finitePositive(settings.reserveTokens) ? settings.reserveTokens : 0;
	const hardAt = finitePositive(settings.hardAt) ? settings.hardAt : Math.max(0, effectiveWindow - reserveTokens);
	const windowOpenAt = finitePositive(settings.windowOpenAt) ? settings.windowOpenAt : Math.floor(0.8 * hardAt);
	const bucket = Math.floor(usage.tokens / effectiveWindow / BUCKET_SIZE + 1e-9);

	return {
		tokens: usage.tokens,
		contextWindow: usage.contextWindow,
		effectiveWindow,
		windowOpenAt,
		hardAt,
		bucket,
	};
}

function budgetContent(metrics: BudgetMetrics): string {
	const state =
		metrics.tokens >= metrics.windowOpenAt
			? `The compaction window is open (${formatTokens(metrics.windowOpenAt)}–${formatTokens(metrics.hardAt)})`
			: `The compaction window opens at ${formatTokens(metrics.windowOpenAt)}`;
	return (
		`<context-budget>Used ${formatTokens(metrics.tokens)} of ${formatTokens(metrics.effectiveWindow)} effective context ` +
		`(${formatTokens(metrics.contextWindow)} raw). ${state}. At your next natural boundary call checkpoint(); ` +
		`phi compacts for you at ${formatTokens(metrics.hardAt)} or when this run ends. Never artificially stop any ` +
		"task early regardless of the context remaining.</context-budget>"
	);
}

/**
 * The TUI-only context budget line. It deliberately has no visible renderer: the hidden,
 * ephemeral message is useful to the next model request without adding transcript noise.
 */
export default function contextBudgetExtension(pi: ExtensionAPI): void {
	if (!contextAwareCompactionEnabled()) return;

	let lastEmittedBucket: number | undefined;
	let windowOpenEmitted = false;
	resetCheckpointState();
	registerCheckpointTool(pi);

	const reset = (): void => {
		lastEmittedBucket = undefined;
		windowOpenEmitted = false;
		resetCheckpointState();
	};

	const maybeSendBudget = (ctx: ExtensionContext): void => {
		const metrics = resolveMetrics(ctx);
		if (!metrics) return;
		const checkpointRecorded = consumeCheckpoint();

		const crossedFirstThreshold =
			metrics.tokens >= 0.6 * metrics.effectiveWindow &&
			(lastEmittedBucket === undefined || lastEmittedBucket < FIRST_BUCKET);
		const crossedWindowOpen = metrics.tokens >= metrics.windowOpenAt && !windowOpenEmitted;
		const crossedBucket =
			metrics.bucket >= FIRST_BUCKET && (lastEmittedBucket === undefined || metrics.bucket > lastEmittedBucket);
		if (!checkpointRecorded && !crossedFirstThreshold && !crossedWindowOpen && !crossedBucket) return;

		pi.sendMessage(
			{
				customType: CONTEXT_BUDGET_MESSAGE_TYPE,
				display: false,
				ephemeral: true,
				content: budgetContent(metrics),
			},
			{ deliverAs: "nextTurn" },
		);
		lastEmittedBucket = Math.max(lastEmittedBucket ?? Number.NEGATIVE_INFINITY, metrics.bucket);
		if (metrics.tokens >= metrics.windowOpenAt) windowOpenEmitted = true;
	};

	pi.on("turn_end", (_event, ctx) => maybeSendBudget(ctx));
	pi.on("agent_end", (_event, ctx) => maybeSendBudget(ctx));
	pi.on("session_start", reset);
	pi.on("session_before_switch", reset);
	pi.on("session_compact", reset);
}

export const __testing = {
	formatTokens,
	resolveMetrics,
	budgetContent,
};
