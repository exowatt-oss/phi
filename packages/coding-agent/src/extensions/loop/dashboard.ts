import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { buildBoardLines, renderFooterText } from "./render.ts";
import type { LoopIterationRecord, LoopStateSnapshot } from "./types.ts";

const TICK_MS = 250;
const LINGER_MS = 6000;

export class LoopDashboard {
	private snapshot: LoopStateSnapshot | undefined;
	private records: LoopIterationRecord[] = [];
	private activity: string | undefined;
	private countdownMs: number | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private linger: ReturnType<typeof setTimeout> | undefined;
	private ui: ExtensionUIContext;

	constructor(ui: ExtensionUIContext) {
		this.ui = ui;
	}

	update(
		snapshot: LoopStateSnapshot | undefined,
		opts: { records: LoopIterationRecord[]; activity?: string; countdownMs?: number },
	): void {
		this.snapshot = snapshot;
		this.records = opts.records;
		this.activity = opts.activity;
		this.countdownMs = opts.countdownMs;
		if (!snapshot) {
			this.clear();
			return;
		}
		if (snapshot.phase === "terminal") {
			this.stopTicker();
			this.render();
			if (!this.linger) this.linger = setTimeout(() => this.clear(), LINGER_MS);
			return;
		}
		if (snapshot.phase === "paused") this.stopTicker();
		else this.startTicker();
		this.render();
	}

	dispose(): void {
		this.stopTicker();
		if (this.linger) clearTimeout(this.linger);
		this.linger = undefined;
		this.clear();
	}

	private startTicker(): void {
		if (!this.ticker) this.ticker = setInterval(() => this.render(), TICK_MS);
	}
	private stopTicker(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}
	private clear(): void {
		this.ui.setStatus("loop", undefined);
		this.ui.setWidget("loop", undefined);
	}
	private render(): void {
		if (!this.snapshot) return;
		const snapshot = this.snapshot;
		const now = Date.now();
		this.ui.setStatus("loop", renderFooterText(snapshot, now));
		this.ui.setWidget(
			"loop",
			(_tui, theme) => ({
				render: (width: number) =>
					buildBoardLines({
						snapshot,
						records: this.records,
						activity: this.activity,
						countdownMs: this.countdownMs,
						nowMs: Date.now(),
						width,
						theme,
					}),
				invalidate() {},
			}),
			{ placement: "aboveEditor" },
		);
	}
}
