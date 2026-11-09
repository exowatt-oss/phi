import { type Component, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { renderIterationEntry } from "./render.ts";
import type { LoopIterationRecord, LoopStateSnapshot } from "./types.ts";
import { formatDurationMs, formatUsd } from "./usage.ts";

const TICK_MS = 250;

class LoopViewer implements Component {
	private view: "list" | "detail" = "list";
	private selected = 0;
	private scroll = 0;
	private confirming = false;
	private readonly ticker: ReturnType<typeof setInterval>;
	private readonly theme: any;
	private readonly opts: Parameters<typeof openLoopViewer>[0];
	private readonly done: () => void;
	constructor(tui: TUI, theme: any, opts: Parameters<typeof openLoopViewer>[0], done: () => void) {
		this.theme = theme;
		this.opts = opts;
		this.done = done;
		this.ticker = setInterval(() => tui.requestRender(), TICK_MS);
	}
	dispose(): void {
		clearInterval(this.ticker);
	}
	invalidate(): void {}
	private snapshot(): LoopStateSnapshot | undefined {
		return this.opts.getSnapshot();
	}
	private records(): LoopIterationRecord[] {
		return [...this.opts.getRecords()].sort((a, b) => b.index - a.index);
	}
	render(width: number): string[] {
		const snapshot = this.snapshot();
		const records = this.records();
		if (this.view === "detail" && records[this.selected]) {
			const component = renderIterationEntry(records[this.selected], { expanded: true }, this.theme);
			return [
				this.theme.fg("accent", "LOOP detail"),
				...(component?.render(width) ?? []),
				this.theme.fg("dim", "↑↓/pgup/pgdn scroll · esc back"),
			].map((line) => line.slice(this.scroll));
		}
		const lines = [
			this.theme.fg(
				"accent",
				`LOOP · ${snapshot?.phase ?? "idle"} · ${snapshot?.iterationIndex ?? 0}/${snapshot?.config.maxIterations ?? 0} · ${snapshot ? formatDurationMs(Date.now() - Date.parse(snapshot.startedAt)) : "0s"} · ${formatUsd((snapshot?.cumulative.costUsd ?? 0) + (snapshot?.cumulative.evaluatorCostUsd ?? 0))}`,
			),
		];
		for (let i = 0; i < records.length; i++) {
			const r = records[i];
			const delta = r.repoDelta?.numstat;
			const check = r.check ? `check:${r.check.exitCode ?? r.check.signal ?? "?"}` : "";
			lines.push(
				`${i === this.selected ? this.theme.fg("accent", "› ") : "  "}${r.index}  ${r.phaseOutcome}  ${formatDurationMs(Date.parse(r.endedAt) - Date.parse(r.startedAt))}  ${formatUsd(r.usage.costUsd)}  ${delta ? `+${delta.insertions}/-${delta.deletions}` : ""}  ${check}`,
			);
		}
		lines.push(
			this.theme.fg("dim", `Σ ${records.length} iterations · ${formatUsd(snapshot?.cumulative.costUsd ?? 0)}`),
		);
		lines.push(
			this.theme.fg(
				"dim",
				this.confirming
					? "stop loop? x confirm · esc cancel"
					: "↑↓ select · enter detail · p pause/resume · x stop · r verify · s pin · q close",
			),
		);
		return lines;
	}
	handleInput(data: string): void {
		const records = this.records();
		if (this.view === "detail") {
			if (matchesKey(data, "escape")) {
				this.view = "list";
				return;
			}
			if (matchesKey(data, "up")) {
				this.scroll = Math.max(0, this.scroll - 1);
				return;
			}
			if (matchesKey(data, "down")) {
				this.scroll++;
				return;
			}
			if (matchesKey(data, "pageUp")) {
				this.scroll = Math.max(0, this.scroll - 10);
				return;
			}
			if (matchesKey(data, "pageDown")) {
				this.scroll += 10;
				return;
			}
			if (data === "q") this.done();
			return;
		}
		if (matchesKey(data, "escape") || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(Math.max(0, records.length - 1), this.selected + 1);
		else if (matchesKey(data, "return") && records.length) {
			this.view = "detail";
			this.scroll = 0;
		} else if (data === "p") {
			if (this.snapshot()?.phase === "paused") this.opts.onResume();
			else this.opts.onPause();
		} else if (data === "x") {
			if (this.confirming) {
				this.opts.onStop();
				this.confirming = false;
			} else this.confirming = true;
		} else if (data === "r") this.opts.onVerify();
		else if (data === "s") this.opts.onPin();
	}
}

export function openLoopViewer(opts: {
	ui: ExtensionUIContext;
	getSnapshot(): LoopStateSnapshot | undefined;
	getRecords(): LoopIterationRecord[];
	onPause(): void;
	onResume(): void;
	onStop(): void;
	onVerify(): void;
	onPin(): void;
}): Promise<void> {
	return opts.ui.custom<void>((tui, theme, _keybindings, done) => {
		const viewer = new LoopViewer(tui, theme, opts, () => done());
		return viewer;
	});
}
