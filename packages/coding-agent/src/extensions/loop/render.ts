import { type Component, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { CheckOutcome, LoopAuditRecord, LoopIterationRecord, LoopStateSnapshot } from "./types.ts";
import { formatDurationMs, formatUsd } from "./usage.ts";

const plain = (s: string) => s.replace(/\s+/g, " ").trim();
const elapsed = (snapshot: LoopStateSnapshot, now: number) => Math.max(0, now - Date.parse(snapshot.startedAt));
const checkLabel = (check: CheckOutcome | undefined): string | undefined => {
	if (!check) return undefined;
	return `check exit ${check.exitCode === null ? (check.signal ?? "?") : check.exitCode}`;
};
const phaseLabel = (snapshot: LoopStateSnapshot, countdownMs?: number): string => {
	switch (snapshot.phase) {
		case "running":
		case "dispatching":
			return "working";
		case "verifying_check":
			return "check";
		case "evaluating_condition":
			return "evaluating";
		case "pacing":
			return `next ${formatDurationMs(countdownMs ?? 0)}`;
		case "paused":
			return snapshot.pauseCause?.replaceAll("_", " ") ?? "paused";
		case "terminal":
			return snapshot.terminalReason?.replaceAll("_", " ") ?? "stopped";
		default:
			return snapshot.phase;
	}
};

export function renderFooterText(snapshot: LoopStateSnapshot, nowMs: number): string {
	const progress = `${snapshot.iterationIndex}/${snapshot.config.maxIterations}`;
	const cost = formatUsd(snapshot.cumulative.costUsd + snapshot.cumulative.evaluatorCostUsd);
	const phase = phaseLabel(snapshot, undefined);
	const glyph =
		snapshot.phase === "paused"
			? "⏸"
			: snapshot.phase === "terminal"
				? snapshot.terminalReason === "iteration_limit" ||
					snapshot.terminalReason === "wall_time_limit" ||
					snapshot.terminalReason === "budget_limit"
					? "■"
					: "✓"
				: "↻";
	const duration = formatDurationMs(elapsed(snapshot, nowMs));
	return `${glyph} LOOP ${progress} · ${duration} · ${cost} · ${phase}`;
}

function clampLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
}
function repoStats(record: LoopIterationRecord | undefined): string {
	const n = record?.repoDelta?.numstat;
	return n ? `${n.filesChanged} files · +${n.insertions}/-${n.deletions}` : "observed: no repository delta";
}
function remaining(snapshot: LoopStateSnapshot, now: number): string {
	const left = Math.max(0, snapshot.config.maxIterations - snapshot.iterationIndex);
	const wall = Math.max(0, snapshot.config.timeoutMs - elapsed(snapshot, now));
	const budget =
		snapshot.config.budgetUsd === undefined
			? "unlimited"
			: `${formatUsd(Math.max(0, snapshot.config.budgetUsd - snapshot.cumulative.costUsd - snapshot.cumulative.evaluatorCostUsd))} left`;
	return `${left} left · ${formatDurationMs(wall)} · ${budget}`;
}

export function buildBoardLines(args: {
	snapshot: LoopStateSnapshot;
	records: LoopIterationRecord[];
	activity?: string;
	countdownMs?: number;
	nowMs: number;
	width: number;
	theme: Theme;
}): string[] {
	const { snapshot, records, activity, countdownMs, nowMs, theme } = args;
	const last = records.at(-1);
	const status = phaseLabel(snapshot, countdownMs);
	const glyph = snapshot.phase === "paused" ? "⏸" : snapshot.phase === "terminal" ? "✓" : "◉";
	const lines: string[] = [
		theme.fg(
			snapshot.phase === "terminal" ? "success" : snapshot.phase === "paused" ? "warning" : "accent",
			`${glyph} LOOP ${snapshot.iterationIndex}/${snapshot.config.maxIterations} · ${status} · ${formatDurationMs(elapsed(snapshot, nowMs))} · ${formatUsd(snapshot.cumulative.costUsd + snapshot.cumulative.evaluatorCostUsd)}`,
		),
	];
	lines.push(`${theme.fg("muted", "task")}   ${plain(snapshot.config.task)}`);
	if (activity) lines.push(`${theme.fg("muted", "now")}    ${plain(activity)}`);
	if (snapshot.phase === "paused")
		lines.push(
			`${theme.fg("warning", "paused")} ${snapshot.pauseCause?.replaceAll("_", " ") ?? "paused"} · resume or /loop stop`,
		);
	else if (snapshot.phase === "terminal")
		lines.push(
			`${theme.fg("success", "done")}    ${snapshot.terminalReason?.replaceAll("_", " ") ?? "stopped"} · ${records.length} iterations`,
		);
	else if (snapshot.config.checkCommand)
		lines.push(
			`${theme.fg("muted", "gate")}   ${snapshot.config.checkCommand}${last?.check ? ` · last exit ${last.check.exitCode ?? last.check.signal ?? "?"}` : ""}`,
		);
	else if (snapshot.config.untilCondition)
		lines.push(`${theme.fg("muted", "until")}   ${plain(snapshot.config.untilCondition)}`);
	if (last)
		lines.push(
			`${theme.fg("muted", "iter")}   ${repoStats(last)} · ${last.toolCalls} tools · ${formatUsd(last.usage.costUsd)}`,
		);
	if (snapshot.phase !== "terminal" && snapshot.phase !== "paused")
		lines.push(`${theme.fg("muted", "limit")}  ${remaining(snapshot, nowMs)}`);
	if (snapshot.phase === "pacing") lines.push(`${theme.fg("accent", "next")}   ${formatDurationMs(countdownMs ?? 0)}`);
	lines.push(theme.fg("dim", "       /loop · esc pause · /loop stop"));
	return clampLines(lines.slice(0, 7), args.width);
}

function usageLine(record: LoopIterationRecord): string {
	return `${formatDurationMs(Date.parse(record.endedAt) - Date.parse(record.startedAt))} · ${formatUsd(record.usage.costUsd)} · ${record.toolCalls} tools${record.contextPercent === undefined ? "" : ` · ctx ${record.contextPercent}%`}`;
}
function addExpandedIteration(container: Container, record: LoopIterationRecord, theme: Theme): void {
	container.addChild(new Text(theme.fg("dim", `started ${record.startedAt} · ended ${record.endedAt}`), 0, 0));
	container.addChild(
		new Text(
			theme.fg(
				"dim",
				`model: ${record.workerModel ?? "current"} · input ${record.usage.input} · output ${record.usage.output} · cache ${record.usage.cacheRead}/${record.usage.cacheWrite}`,
			),
			0,
			0,
		),
	);
	if (record.check)
		container.addChild(
			new Text(
				theme.fg(
					record.check.verdict === "satisfied" ? "success" : "error",
					`${record.check.command} · ${checkLabel(record.check)} · ${record.check.stdoutTail} ${record.check.stderrTail}`,
				),
				0,
				0,
			),
		);
	if (record.evaluator)
		container.addChild(
			new Text(
				theme.fg(
					"muted",
					`evaluator: ${record.evaluator.verdict?.satisfied ? "satisfied" : "unsatisfied"} · confidence ${record.evaluator.verdict?.confidence ?? "n/a"} · ${record.evaluator.verdict?.rationale ?? record.evaluator.error ?? ""}`,
				),
				0,
				0,
			),
		);
	for (const call of record.controlCalls)
		container.addChild(new Text(theme.fg("toolOutput", `control: ${call.action} — ${call.summary}`), 0, 0));
	if (record.protocolAnomalies.length)
		container.addChild(new Text(theme.fg("error", `anomalies: ${record.protocolAnomalies.join("; ")}`), 0, 0));
	container.addChild(new Text(theme.fg("dim", `precedence: ${record.decisionPrecedence}`), 0, 0));
}

export function renderIterationEntry(
	record: LoopIterationRecord,
	options: { expanded: boolean },
	theme: Theme,
): Component | undefined {
	const outcomeColor =
		record.phaseOutcome === "complete" ? "success" : record.phaseOutcome === "pause" ? "warning" : "accent";
	const container = new Container();
	container.addChild(
		new Text(
			theme.fg(
				outcomeColor,
				`${record.phaseOutcome === "complete" ? "✓" : record.phaseOutcome === "pause" ? "⏸" : "↻"} loop iteration ${record.index} — ${record.phaseOutcome}`,
			),
			0,
			0,
		),
	);
	container.addChild(new Text(theme.fg("muted", `  ${usageLine(record)}`), 0, 0));
	if (record.repoDelta) container.addChild(new Text(theme.fg("dim", `  observed: ${repoStats(record)}`), 0, 0));
	if (record.check)
		container.addChild(
			new Text(
				theme.fg(
					record.check.verdict === "satisfied" ? "success" : "error",
					`  ${checkLabel(record.check)}${record.check.stdoutTail ? `: ${plain(record.check.stdoutTail)}` : ""}`,
				),
				0,
				0,
			),
		);
	container.addChild(
		new Text(theme.fg("text", `  model: ${record.phaseOutcome} — ${record.summary ?? "no summary"}`), 0, 0),
	);
	if (record.nextStep) container.addChild(new Text(theme.fg("dim", `  next: ${record.nextStep}`), 0, 0));
	if (options.expanded) addExpandedIteration(container, record, theme);
	return container;
}

export function renderAuditEntry(
	record: LoopAuditRecord,
	options: { expanded: boolean },
	theme: Theme,
): Component | undefined {
	const terminalGlyph =
		record.reason === "user_stopped" ||
		record.reason === "iteration_limit" ||
		record.reason === "wall_time_limit" ||
		record.reason === "budget_limit"
			? "■"
			: record.reason === "permission_required" || record.reason.includes("error")
				? "⏸"
				: "✓";
	const container = new Container();
	container.addChild(
		new Text(
			theme.fg(
				terminalGlyph === "✓" ? "success" : terminalGlyph === "⏸" ? "warning" : "error",
				`${terminalGlyph} loop completed — ${record.reason}`,
			),
			0,
			0,
		),
	);
	container.addChild(
		new Text(
			theme.fg(
				"muted",
				`  ${record.iterations} iterations · ${formatDurationMs(Date.parse(record.endedAt) - Date.parse(record.startedAt))} · ${formatUsd(record.totals.costUsd + record.totals.evaluatorCostUsd)}`,
			),
			0,
			0,
		),
	);
	if (record.observed)
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					`  observed: ${record.observed.numstat.filesChanged} files · +${record.observed.numstat.insertions}/-${record.observed.numstat.deletions}`,
				),
				0,
				0,
			),
		);
	if (record.validationSummary)
		container.addChild(new Text(theme.fg("muted", `  validation: ${record.validationSummary}`), 0, 0));
	container.addChild(new Text(theme.fg("dim", `  started: ${record.startedAt} · ended: ${record.endedAt}`), 0, 0));
	if (options.expanded) {
		container.addChild(new Spacer(1));
		for (const row of record.iterationTable)
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						`${row.index} · ${row.phaseOutcome} · ${row.summary ?? ""} · ${row.startedAt} → ${row.endedAt}`,
					),
					0,
					0,
				),
			);
	}
	return container;
}
