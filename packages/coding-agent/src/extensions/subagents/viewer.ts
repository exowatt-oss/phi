/**
 * Interactive subagent viewer (/subagents in TUI): a live board where each
 * agent thread is selectable. Enter drills into one agent and follows what it
 * is doing — full step timeline, current activity, output so far — updating
 * live while the agent runs. Runs can be killed and the board can be pinned
 * into the transcript as a durable snapshot.
 */

import { type Component, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { contextPercent, formatDuration, formatUsageSummary, runElapsedMs, statusGlyph } from "./format.ts";
import { buildRunRow, buildTotalsRow, fitSubagentLines, renderTimelineLines } from "./render.ts";
import { isRunActive, type SubagentRunSnapshot } from "./types.ts";

const TICK_MS = 250;
const LIST_MAX_VISIBLE = 12;
const DETAIL_VIEWPORT_LINES = 22;

export interface SubagentViewerCallbacks {
	/** Latest run list: live runs when any are in flight, else the last settled swarm. */
	runs(): SubagentRunSnapshot[];
	/** Kill a running subagent. Returns false when it was not killable. */
	kill(run: SubagentRunSnapshot): boolean;
	/** Pin a board snapshot into the transcript. */
	pin(): void;
}

/** Wrap one styled/unstyled line to a width by hard-chunking (plain text only). */
function chunkPlain(text: string, width: number, maxLines: number): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		let line = raw;
		while (line.length > width && out.length < maxLines) {
			out.push(line.slice(0, width));
			line = line.slice(width);
		}
		if (out.length >= maxLines) break;
		out.push(line);
	}
	return out.slice(0, maxLines);
}

export class SubagentViewer implements Component {
	private view: "list" | "detail" = "list";
	private selected = 0;
	private detailRun: SubagentRunSnapshot | undefined;
	private scrollTop = 0;
	private followEnd = true;
	private lastDetailLineCount = 0;
	private ticker: ReturnType<typeof setInterval>;

	private theme: Theme;
	private callbacks: SubagentViewerCallbacks;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, callbacks: SubagentViewerCallbacks, done: () => void, initialRunId?: string) {
		this.theme = theme;
		this.callbacks = callbacks;
		this.done = done;
		if (initialRunId) {
			const runs = callbacks.runs();
			const index = runs.findIndex((run) => run.id === initialRunId);
			if (index >= 0) {
				this.selected = index;
				this.detailRun = runs[index];
				this.view = "detail";
			}
		}
		this.ticker = setInterval(() => tui.requestRender(), TICK_MS);
	}

	dispose(): void {
		clearInterval(this.ticker);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const runs = this.callbacks.runs();
		if (runs.length === 0) {
			return [this.theme.fg("muted", "No subagents have run in this session."), this.hintLine("esc close")];
		}
		this.selected = Math.min(this.selected, runs.length - 1);
		const lines =
			this.view === "detail" && this.detailRun ? this.renderDetail(this.detailRun, width) : this.renderList(runs);
		return fitSubagentLines(lines, width);
	}

	private hintLine(hints: string): string {
		return this.theme.fg("dim", `  ${hints}`);
	}

	private renderList(runs: SubagentRunSnapshot[]): string[] {
		const theme = this.theme;
		const now = Date.now();
		const running = runs.filter(isRunActive).length;
		const lines: string[] = [];
		const counts = running > 0 ? `${running} running · ${runs.length - running} settled` : `${runs.length} settled`;
		lines.push(`${theme.fg("accent", theme.bold("subagents"))} ${theme.fg("muted", counts)}`);

		const start = Math.max(
			0,
			Math.min(this.selected - Math.floor(LIST_MAX_VISIBLE / 2), runs.length - LIST_MAX_VISIBLE),
		);
		const end = Math.min(start + LIST_MAX_VISIBLE, runs.length);
		for (let i = start; i < end; i++) {
			const cursor = i === this.selected ? theme.fg("accent", "› ") : "  ";
			lines.push(cursor + buildRunRow(runs[i], theme, now, { stepPrefix: true, activityWidth: 42 }));
		}
		if (start > 0 || end < runs.length) {
			lines.push(theme.fg("muted", `  (${this.selected + 1}/${runs.length})`));
		}
		lines.push(buildTotalsRow(runs, theme));
		lines.push(this.hintLine("↑↓ select · enter inspect · x kill · p pin to chat · esc close"));
		return lines;
	}

	private renderDetail(run: SubagentRunSnapshot, width: number): string[] {
		const theme = this.theme;
		const now = Date.now();
		const body: string[] = [];

		body.push(theme.fg("muted", "task: ") + theme.fg("dim", run.task.replace(/\s+/g, " ")));
		if (run.cwd) body.push(theme.fg("muted", "cwd: ") + theme.fg("dim", run.cwd));
		if (run.errorMessage) body.push(theme.fg("error", `error: ${run.errorMessage}`));
		if (run.timeline.length > 0) {
			body.push("");
			body.push(...renderTimelineLines(run, theme));
		}
		if (run.finalText.trim()) {
			body.push("");
			body.push(theme.fg("muted", "── output ──"));
			body.push(...chunkPlain(run.finalText.trim(), Math.max(20, width - 4), 400));
		}
		if (isRunActive(run) && run.activity) {
			body.push("");
			body.push(theme.fg("toolOutput", `⚒ ${run.activity}`));
		}

		// Viewport with follow-end while the agent is running.
		this.lastDetailLineCount = body.length;
		const viewport = DETAIL_VIEWPORT_LINES;
		const maxTop = Math.max(0, body.length - viewport);
		if (this.followEnd) this.scrollTop = maxTop;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxTop));
		const visible = body.slice(this.scrollTop, this.scrollTop + viewport);

		const lines: string[] = [];
		lines.push(buildRunRow(run, theme, now, { stepPrefix: true }));
		const meta: string[] = [];
		const usage = formatUsageSummary(run.usage);
		if (usage) meta.push(usage);
		const ctx = contextPercent(run);
		if (ctx !== undefined) meta.push(`ctx ${ctx}%`);
		if (run.startedAt !== undefined) meta.push(formatDuration(runElapsedMs(run, now)));
		meta.push(statusGlyph(run.status, now));
		lines.push(theme.fg("dim", `  ${meta.join(" · ")}`));
		if (this.scrollTop > 0)
			lines.push(theme.fg("muted", `  ↑ ${this.scrollTop} more line${this.scrollTop === 1 ? "" : "s"}`));
		lines.push(...visible);
		const below = maxTop - this.scrollTop;
		if (below > 0) lines.push(theme.fg("muted", `  ↓ ${below} more line${below === 1 ? "" : "s"}`));
		lines.push(this.hintLine("↑↓ scroll · x kill · esc back · q close"));
		return lines;
	}

	handleInput(data: string): void {
		const runs = this.callbacks.runs();

		if (this.view === "detail") {
			if (matchesKey(data, "escape")) {
				this.view = "list";
				this.detailRun = undefined;
				this.followEnd = true;
				return;
			}
			if (matchesKey(data, "up")) {
				this.followEnd = false;
				this.scrollTop = Math.max(0, this.scrollTop - 1);
				return;
			}
			if (matchesKey(data, "down")) {
				this.scrollTop += 1;
				if (this.scrollTop >= this.lastDetailLineCount - DETAIL_VIEWPORT_LINES) this.followEnd = true;
				return;
			}
			if (matchesKey(data, "pageUp")) {
				this.followEnd = false;
				this.scrollTop = Math.max(0, this.scrollTop - DETAIL_VIEWPORT_LINES);
				return;
			}
			if (matchesKey(data, "pageDown")) {
				this.scrollTop += DETAIL_VIEWPORT_LINES;
				return;
			}
			if (data === "x" && this.detailRun) {
				this.callbacks.kill(this.detailRun);
				return;
			}
			if (data === "q" || matchesKey(data, "ctrl+c")) this.done();
			return;
		}

		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = this.selected === 0 ? Math.max(0, runs.length - 1) : this.selected - 1;
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = this.selected >= runs.length - 1 ? 0 : this.selected + 1;
			return;
		}
		if (matchesKey(data, "return") && runs.length > 0) {
			this.detailRun = runs[this.selected];
			this.view = "detail";
			this.followEnd = true;
			return;
		}
		if (data === "x" && runs.length > 0) {
			this.callbacks.kill(runs[this.selected]);
			return;
		}
		if (data === "p") {
			this.callbacks.pin();
			return;
		}
	}
}
