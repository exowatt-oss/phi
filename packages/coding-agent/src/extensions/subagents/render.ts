/**
 * Themed rendering for the subagents extension: the live board rows (shared by
 * the dashboard widget, the transcript tool renderer, and /subagents), plus
 * the tool call / tool result renderers.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import {
	aggregateUsage,
	contextPercent,
	formatCost,
	formatDuration,
	formatTokens,
	formatUsageSummary,
	runElapsedMs,
	statusGlyph,
	subagentDiagnostics,
	truncateText,
} from "./format.ts";
import { isRunActive, isRunFailed, type SubagentRunSnapshot, type SubagentToolDetails } from "./types.ts";

const MAX_NAME_WIDTH = 18;
const MAX_ACTIVITY_WIDTH = 64;

function glyphColor(run: SubagentRunSnapshot): "accent" | "dim" | "success" | "error" {
	switch (run.status) {
		case "running":
			return "accent";
		case "pending":
			return "dim";
		case "done":
			return "success";
		default:
			return "error";
	}
}

function nameWidth(runs: SubagentRunSnapshot[]): number {
	let width = 0;
	for (const run of runs) width = Math.max(width, Math.min(run.name.length, MAX_NAME_WIDTH));
	return width;
}

/** One live board row: glyph, name, model, elapsed, usage, ctx%, current activity. */
export function buildRunRow(
	run: SubagentRunSnapshot,
	theme: Theme,
	now: number,
	options?: { nameWidth?: number; activityWidth?: number; stepPrefix?: boolean },
): string {
	const width = options?.nameWidth ?? Math.min(run.name.length, MAX_NAME_WIDTH);
	const glyph = theme.fg(glyphColor(run), statusGlyph(run.status, now));
	const stepPrefix = options?.stepPrefix && run.step !== undefined ? `${theme.fg("muted", `${run.step}.`)} ` : "";
	const name = theme.fg("text", theme.bold(truncateText(run.name, MAX_NAME_WIDTH).padEnd(width)));

	const stats: string[] = [];
	if (run.modelLabel || run.model) stats.push(run.modelLabel ?? (run.model as string));
	if (run.startedAt !== undefined) stats.push(formatDuration(runElapsedMs(run, now)));
	if (run.usage.turns > 0) stats.push(`${run.usage.turns}t`);
	if (run.usage.toolCalls > 0) stats.push(`⚒${run.usage.toolCalls}`);
	if (run.usage.input > 0) stats.push(`↑${formatTokens(run.usage.input)}`);
	if (run.usage.output > 0) stats.push(`↓${formatTokens(run.usage.output)}`);
	if (run.usage.cost > 0) stats.push(formatCost(run.usage.cost));
	const ctx = contextPercent(run);
	if (ctx !== undefined) stats.push(`ctx ${ctx}%`);
	const diagnostics = subagentDiagnostics(run);
	if (diagnostics) stats.push(diagnostics);
	if (run.pendingQuestion) stats.push("? asking");

	let line = `${glyph} ${stepPrefix}${name}  ${theme.fg("muted", stats.join(" · "))}`;

	const activityWidth = options?.activityWidth ?? MAX_ACTIVITY_WIDTH;
	if (isRunFailed(run) && (run.errorMessage || run.stopReason)) {
		const reason = run.errorMessage ?? `stopped: ${run.stopReason}`;
		line += `  ${theme.fg("error", truncateText(reason.replace(/\s+/g, " "), activityWidth))}`;
	} else if (isRunActive(run)) {
		const report = run.lastReport;
		const reportText =
			report && !run.pendingQuestion
				? `last report: ${report.kind} ${truncateText(report.message.replace(/\s+/g, " "), 28)}`
				: undefined;
		const activity = reportText ? [reportText, run.activity].filter(Boolean).join(" · ") : run.activity;
		if (activity) line += `  ${theme.fg("toolOutput", truncateText(activity, activityWidth))}`;
	}
	return line;
}

/** Aggregate footer row: `Σ 3 agents · 9 turns · ↑12k ↓48k · $0.42`. */
export function buildTotalsRow(runs: SubagentRunSnapshot[], theme: Theme): string {
	const totals = aggregateUsage(runs);
	const summary = formatUsageSummary(totals);
	const label = `Σ ${runs.length} agent${runs.length === 1 ? "" : "s"}`;
	return theme.fg("dim", summary ? `${label} · ${summary}` : label);
}

/** Board lines for the live widget / the /subagents entry. */
export function buildBoardLines(
	runs: SubagentRunSnapshot[],
	theme: Theme,
	now: number,
	options?: { maxRows?: number; title?: string; headerHint?: string; selectedRunId?: string },
): string[] {
	const running = runs.filter(isRunActive).length;
	const failed = runs.filter(isRunFailed).length;
	const done = runs.length - running - failed;

	const headerParts: string[] = [];
	if (running > 0) headerParts.push(`${running} running`);
	if (done > 0) headerParts.push(`${done} done`);
	if (failed > 0) headerParts.push(`${failed} failed`);
	const totals = aggregateUsage(runs);
	const usageParts: string[] = [];
	if (totals.input > 0) usageParts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output > 0) usageParts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cost > 0) usageParts.push(formatCost(totals.cost));

	const marker =
		running > 0 ? theme.fg("accent", "◉") : failed > 0 ? theme.fg("error", "◉") : theme.fg("success", "◉");
	let header = `${marker} ${theme.fg("accent", theme.bold(options?.title ?? "subagents"))}`;
	header += ` ${theme.fg("muted", headerParts.join(" · "))}`;
	if (usageParts.length > 0) header += theme.fg("dim", ` · ${usageParts.join(" ")}`);
	if (options?.headerHint) header += theme.fg("dim", ` · ${options.headerHint}`);

	const lines = [header];
	const width = nameWidth(runs);
	const maxRows = options?.maxRows ?? runs.length;
	const shown = runs.slice(0, maxRows);
	for (const run of shown) {
		const cursor = options?.selectedRunId === run.id ? theme.fg("accent", "› ") : "  ";
		lines.push(`${cursor}${buildRunRow(run, theme, now, { nameWidth: width, activityWidth: 48 })}`);
	}
	if (runs.length > shown.length) {
		const hidden = runs.slice(shown.length);
		const hiddenRunning = hidden.filter(isRunActive).length;
		lines.push(
			theme.fg("muted", `  … +${hidden.length} more${hiddenRunning > 0 ? ` (${hiddenRunning} running)` : ""}`),
		);
	}
	return lines;
}

/**
 * Fit independently-rendered TUI lines to the available width. Unlike Text,
 * widgets and custom components do not get wrapping for free; every line they
 * return must already satisfy the TUI width contract.
 */
export function fitSubagentLines(lines: string[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
}

interface SubagentCallArgs {
	action?: "run" | "status" | "kill" | "message";
	target?: string;
	message?: string;
	agent?: string;
	model?: string;
	name?: string;
	task?: string;
	tasks?: { agent?: string; model?: string; name?: string; task: string }[];
	chain?: { agent?: string; model?: string; name?: string; task: string }[];
	agentScope?: string;
}

function taskLabel(item: { agent?: string; model?: string; name?: string }, theme: Theme): string {
	const label = item.name ?? item.agent ?? item.model;
	return label ? theme.fg("accent", label) : theme.fg("muted", "(default model)");
}

/** renderCall: what was requested, before/while it runs. */
export function renderSubagentCall(args: SubagentCallArgs, theme: Theme): Text {
	const title = theme.fg("toolTitle", theme.bold("subagent "));
	const scope = args.agentScope && args.agentScope !== "user" ? theme.fg("muted", ` [${args.agentScope}]`) : "";
	if (args.action && args.action !== "run") {
		const target = args.target ? ` ${truncateText(args.target, 40)}` : "";
		const preview = args.message ? `\n  ${theme.fg("dim", truncateText(args.message.replace(/\s+/g, " "), 72))}` : "";
		return new Text(`${title}${theme.fg("accent", args.action)}${theme.fg("muted", target)}${preview}`, 0, 0);
	}

	const list = (items: { agent?: string; model?: string; name?: string; task: string }[], kind: string) => {
		let text = title + theme.fg("accent", `${kind} (${items.length} task${items.length === 1 ? "" : "s"})`) + scope;
		for (let i = 0; i < Math.min(items.length, 4); i++) {
			const item = items[i];
			const preview = truncateText(
				item.task
					.replace(/\{previous\}/g, "")
					.replace(/\s+/g, " ")
					.trim(),
				64,
			);
			text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${taskLabel(item, theme)} ${theme.fg("dim", preview)}`;
		}
		if (items.length > 4) text += `\n  ${theme.fg("muted", `… +${items.length - 4} more`)}`;
		return new Text(text, 0, 0);
	};

	if (args.chain && args.chain.length > 0) return list(args.chain, "chain");
	if (args.tasks && args.tasks.length > 0) return list(args.tasks, "parallel");

	const preview = args.task ? truncateText(args.task.replace(/\s+/g, " ").trim(), 72) : "…";
	const label = taskLabel(args, theme);
	return new Text(`${title}${label}${scope}\n  ${theme.fg("dim", preview)}`, 0, 0);
}

/** Timeline lines for one run (also used by the interactive viewer). */
export function renderTimelineLines(run: SubagentRunSnapshot, theme: Theme, limit?: number): string[] {
	const items = limit !== undefined ? run.timeline.slice(-limit) : run.timeline;
	const skipped = run.timeline.length - items.length + run.timelineDropped;
	const lines: string[] = [];
	if (skipped > 0) lines.push(theme.fg("muted", `… ${skipped} earlier step${skipped === 1 ? "" : "s"}`));
	for (const item of items) {
		if (item.kind === "tool") {
			const arrow = item.isError ? theme.fg("error", "→") : theme.fg("muted", "→");
			const detail = item.isError ? theme.fg("error", item.detail) : theme.fg("toolOutput", item.detail);
			lines.push(`${arrow} ${detail}`);
		} else {
			lines.push(theme.fg("dim", truncateText(item.text.replace(/\s+/g, " "), 100)));
		}
	}
	return lines;
}

function renderTimeline(run: SubagentRunSnapshot, theme: Theme, limit?: number): string {
	return renderTimelineLines(run, theme, limit).join("\n");
}

function renderRunSection(run: SubagentRunSnapshot, theme: Theme, now: number, container: Container): void {
	container.addChild(new Spacer(1));
	const glyph = theme.fg(glyphColor(run), statusGlyph(run.status, now));
	const stepLabel = run.step !== undefined ? `Step ${run.step}: ` : "";
	let header = `${theme.fg("muted", `─── ${stepLabel}`)}${theme.fg("accent", theme.bold(run.name))} ${glyph}`;
	const meta: string[] = [];
	if (run.model) meta.push(run.model);
	if (run.startedAt !== undefined) meta.push(formatDuration(runElapsedMs(run, now)));
	if (meta.length > 0) header += theme.fg("muted", ` ${meta.join(" · ")}`);
	container.addChild(new Text(header, 0, 0));
	const diagnostics = subagentDiagnostics(run);
	if (diagnostics) container.addChild(new Text(theme.fg("dim", `Diagnostics: ${diagnostics}`), 0, 0));
	container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", run.task), 0, 0));
	if (run.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${run.errorMessage}`), 0, 0));

	if (run.timeline.length > 0) {
		container.addChild(new Text(renderTimeline(run, theme), 0, 0));
	}
	if (run.finalText) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(run.finalText.trim(), 0, 0, getMarkdownTheme()));
	}
	const usage = formatUsageSummary(run.usage);
	if (usage) {
		const ctx = contextPercent(run);
		container.addChild(new Text(theme.fg("dim", ctx !== undefined ? `${usage} · ctx ${ctx}%` : usage), 0, 0));
	}
}

/**
 * Settled board rendering shared by the tool result and the background
 * results message: board + failure tails + totals collapsed, full per-run
 * sections expanded.
 */
export function renderSettledRuns(
	runs: SubagentRunSnapshot[],
	theme: Theme,
	options: { expanded: boolean; expandHint?: boolean; title?: string },
): Container | Text {
	const now = Date.now();
	if (options.expanded) {
		const container = new Container();
		container.addChild(new Text(buildBoardLines(runs, theme, now, { title: options.title }).join("\n"), 0, 0));
		for (const run of runs) renderRunSection(run, theme, now, container);
		container.addChild(new Spacer(1));
		container.addChild(new Text(buildTotalsRow(runs, theme), 0, 0));
		return container;
	}

	const lines = buildBoardLines(runs, theme, now, { title: options.title });
	for (const run of runs) {
		if (isRunFailed(run) && (run.errorMessage || run.stderrTail)) {
			const reason = truncateText((run.errorMessage ?? run.stderrTail ?? "").replace(/\s+/g, " "), 120);
			lines.push(theme.fg("error", `  ${run.name}: ${reason}`));
		}
	}
	lines.push(buildTotalsRow(runs, theme));
	if (options.expandHint !== false) lines.push(theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`));
	return new Text(lines.join("\n"), 0, 0);
}

/**
 * renderResult: while runs are live the transcript stays out of the way (the
 * footer widget owns the live board — showing it twice was redundant); once
 * settled it renders board + totals collapsed, full sections expanded.
 */
export function renderSubagentResult(
	result: AgentToolResult<SubagentToolDetails>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Container | Text {
	const details = result.details;
	if (!details || details.runs.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no subagents)", 0, 0);
	}

	const runs = details.runs;
	const anyActive = runs.some(isRunActive);

	// Background launch receipt: the real results arrive as a message later.
	if (details.background) {
		const names = runs
			.map((run) => (run.modelLabel && run.modelLabel !== run.name ? `${run.name} (${run.modelLabel})` : run.name))
			.join(", ");
		const lines = [
			`${theme.fg("accent", "◉")} ${theme.fg("accent", theme.bold("subagents"))} ${theme.fg(
				"muted",
				`launched ${runs.length} in background (${details.mode})`,
			)}`,
			theme.fg("dim", `  ${truncateText(names, 110)}`),
			theme.fg("muted", "  results arrive as a message when they finish · /subagents to watch"),
		];
		return new Text(lines.join("\n"), 0, 0);
	}

	if (anyActive) {
		// Blocking mode, still running: one status line only — the live board is
		// in the footer widget, not duplicated here.
		const running = runs.filter(isRunActive).length;
		const done = runs.length - running;
		const totals = aggregateUsage(runs);
		const parts = [`${running} running`];
		if (done > 0) parts.push(`${done} done`);
		let line = `${theme.fg("accent", "◉")} ${theme.fg("accent", theme.bold("subagents"))} ${theme.fg(
			"muted",
			parts.join(" · "),
		)}`;
		if (totals.cost > 0) line += theme.fg("dim", ` · ${formatCost(totals.cost)}`);
		line += theme.fg("dim", " — live board below · /subagents to inspect");
		return new Text(line, 0, 0);
	}

	return renderSettledRuns(runs, theme, { expanded: options.expanded });
}
