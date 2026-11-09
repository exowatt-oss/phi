/**
 * Live subagent dashboard: one widget above the editor plus a footer status
 * chip, always in sync with every in-flight subagent tool call in the session.
 *
 * The dashboard is the "am I running subagents right now?" answer: when any
 * subagent is running the board is pinned above the editor with per-agent
 * model, elapsed time, turns, tokens, cost, context % and the current tool
 * call; when the last one settles it shows the final board briefly and then
 * gets out of the way. State survives for /subagents to re-inspect.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { aggregateUsage, formatCost, formatDuration } from "./format.ts";
import { buildBoardLines, fitSubagentLines } from "./render.ts";
import { isRunActive, isRunFailed, type SubagentMode, type SubagentRunSnapshot } from "./types.ts";

const WIDGET_KEY = "subagents";
const STATUS_KEY = "subagents";
const TICK_MS = 250;
const SETTLED_LINGER_MS = 6000;
/** interactive-mode caps widgets at 10 lines total; keep the board inside that. */
const MAX_WIDGET_ROWS = 7;

interface RunGroup {
	toolCallId: string;
	mode: SubagentMode;
	runs: SubagentRunSnapshot[];
	startedAt: number;
	endedAt?: number;
}

export class SubagentDashboard {
	private groups: Map<string, RunGroup> = new Map();
	private lastSettledGroup: RunGroup | undefined;
	private ui: ExtensionUIContext | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private lingerTimer: ReturnType<typeof setTimeout> | undefined;
	private terminalInputUnsubscribe: (() => void) | undefined;
	private selectedRunId: string | undefined;
	private inspect: ((run: SubagentRunSnapshot) => Promise<void> | void) | undefined;
	private viewerOpen = false;

	/** Bind the UI context (idempotent; safe in every mode — non-TUI UIs no-op). */
	attach(ui: ExtensionUIContext, inspect?: (run: SubagentRunSnapshot) => Promise<void> | void): void {
		if (this.ui !== ui) {
			this.terminalInputUnsubscribe?.();
			this.terminalInputUnsubscribe = ui.onTerminalInput((data) => this.handleTerminalInput(data));
		}
		this.ui = ui;
		this.inspect = inspect;
	}

	/** Register a new tool call's runs and start live updates. */
	register(toolCallId: string, mode: SubagentMode, runs: SubagentRunSnapshot[]): void {
		this.groups.set(toolCallId, { toolCallId, mode, runs, startedAt: Date.now() });
		this.clearLinger();
		this.startTicker();
		this.render();
	}

	/** Called on any run state change. */
	update(): void {
		this.render();
		this.onChange?.(this.activeRuns());
	}

	private onChange: ((runs: SubagentRunSnapshot[]) => void) | undefined;

	setOnChange(handler: ((runs: SubagentRunSnapshot[]) => void) | undefined): void {
		this.onChange = handler;
	}

	/** Mark a tool call finished. The board lingers briefly, then clears. */
	complete(toolCallId: string): void {
		const group = this.groups.get(toolCallId);
		if (group) {
			group.endedAt = Date.now();
			this.onChange?.(group.runs);
			this.groups.delete(toolCallId);
			this.lastSettledGroup = group;
		}
		if (this.groups.size === 0) {
			this.stopTicker();
			this.render();
			this.clearLinger();
			this.lingerTimer = setTimeout(() => {
				this.lingerTimer = undefined;
				this.clear();
			}, SETTLED_LINGER_MS);
		} else {
			this.render();
		}
	}

	/** All runs currently in flight (for /subagents). */
	activeRuns(): SubagentRunSnapshot[] {
		const runs: SubagentRunSnapshot[] = [];
		for (const group of this.groups.values()) runs.push(...group.runs);
		return runs;
	}

	private handleTerminalInput(data: string): { consume?: boolean } | undefined {
		const runs = this.activeRuns();
		if (this.viewerOpen || runs.length === 0 || !this.ui || this.ui.getEditorText().length > 0) return undefined;

		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const current = runs.findIndex((run) => run.id === this.selectedRunId);
			if (current < 0) {
				this.selectedRunId = runs[0]?.id;
			} else {
				const delta = matchesKey(data, "up") ? -1 : 1;
				this.selectedRunId = runs[(current + delta + runs.length) % runs.length]?.id;
			}
			this.render();
			return { consume: true };
		}
		if (matchesKey(data, "return") && this.selectedRunId) {
			const selected = runs.find((run) => run.id === this.selectedRunId);
			if (selected && this.inspect) {
				this.viewerOpen = true;
				Promise.resolve(this.inspect(selected)).finally(() => {
					this.viewerOpen = false;
				});
			}
			return { consume: true };
		}
		if (matchesKey(data, "escape") && this.selectedRunId) {
			this.selectedRunId = undefined;
			this.render();
			return { consume: true };
		}
		return undefined;
	}

	/** The most recently settled group's runs (for /subagents when idle). */
	lastRuns(): SubagentRunSnapshot[] {
		return this.lastSettledGroup?.runs ?? [];
	}

	/** Tear down timers and UI artifacts (session shutdown). */
	dispose(): void {
		this.stopTicker();
		this.clearLinger();
		this.terminalInputUnsubscribe?.();
		this.terminalInputUnsubscribe = undefined;
		this.selectedRunId = undefined;
		this.inspect = undefined;
		this.viewerOpen = false;
		this.groups.clear();
		this.clear();
	}

	private startTicker(): void {
		if (this.ticker) return;
		this.ticker = setInterval(() => this.render(), TICK_MS);
	}

	private stopTicker(): void {
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	private clearLinger(): void {
		if (this.lingerTimer) {
			clearTimeout(this.lingerTimer);
			this.lingerTimer = undefined;
		}
	}

	private clear(): void {
		if (!this.ui) return;
		this.ui.setWidget(WIDGET_KEY, undefined);
		this.ui.setStatus(STATUS_KEY, undefined);
	}

	private render(): void {
		if (!this.ui) return;

		const activeRuns = this.activeRuns();
		const runs = activeRuns.length > 0 ? activeRuns : (this.lastSettledGroup?.runs ?? []);
		if (runs.length === 0) {
			this.clear();
			return;
		}

		const theme = this.ui.theme;
		const now = Date.now();
		const selectedRunId = activeRuns.some((run) => run.id === this.selectedRunId) ? this.selectedRunId : undefined;
		if (!selectedRunId) this.selectedRunId = undefined;
		this.ui.setWidget(WIDGET_KEY, () => ({
			render: (width) =>
				fitSubagentLines(
					buildBoardLines(runs, theme, now, {
						maxRows: MAX_WIDGET_ROWS,
						headerHint: selectedRunId
							? "↑↓ select · enter inspect · esc cancel"
							: "↓ select · /subagents inspect",
						selectedRunId,
					}),
					width,
				),
			invalidate() {},
		}));

		const running = runs.filter(isRunActive).length;
		const failed = runs.filter(isRunFailed).length;
		const totals = aggregateUsage(runs);
		const costPart = totals.cost > 0 ? ` · ${formatCost(totals.cost)}` : "";
		const asking = runs.filter((run) => run.pendingQuestion && isRunActive(run)).length;
		const askingPart = asking > 0 ? ` · ? ${asking} asking` : "";
		if (running > 0) {
			const oldest = Math.min(...Array.from(this.groups.values(), (group) => group.startedAt));
			this.ui.setStatus(
				STATUS_KEY,
				`⚒ ${running} subagent${running === 1 ? "" : "s"} ${formatDuration(now - oldest)}${askingPart}${costPart}`,
			);
		} else {
			const summary = failed > 0 ? `${failed} failed` : "done";
			this.ui.setStatus(STATUS_KEY, `⚒ subagents ${summary}${costPart}`);
		}
	}
}
