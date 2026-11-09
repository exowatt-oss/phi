import {
	type Component,
	Key,
	Loader,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface StartupProgressStage {
	current: number;
	total: number;
	message: string;
}

const TITLE = "Starting phi";

function normalizePositiveInteger(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function normalizeStage(stage: StartupProgressStage): StartupProgressStage {
	const total = normalizePositiveInteger(stage.total, 1);
	const current = Number.isFinite(stage.current) ? Math.floor(stage.current) : 0;

	return {
		current: Math.max(0, Math.min(total, current)),
		total,
		message: typeof stage.message === "string" ? stage.message : "",
	};
}

function fitLine(line: string, width: number): string {
	return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "");
}

function wrapAndFit(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, width).map((line) => fitLine(line, width));
}

/**
 * Compact, cancellable progress display used while phi is starting.
 *
 * The Loader owns the spinner timer. This component owns the surrounding
 * progress display and deliberately ignores every input except its cancel
 * binding while it is active.
 */
export class StartupProgressComponent implements Component {
	private readonly loader: Loader;
	private stage: StartupProgressStage;
	private readonly onCancel?: () => void;
	private disposed = false;

	constructor(tui: TUI, stage: StartupProgressStage, onCancel?: () => void) {
		this.stage = normalizeStage(stage);
		this.onCancel = onCancel;
		this.loader = new Loader(
			tui,
			(frame) => theme.fg("accent", frame),
			(message) => theme.fg("muted", message),
			this.stage.message,
		);
	}

	setStage(stage: StartupProgressStage): void {
		this.stage = normalizeStage(stage);
		this.loader.setMessage(this.stage.message);
		this.invalidate();
	}

	handleInput(data: string): void {
		if (!this.disposed && matchesKey(data, Key.ctrl("c"))) {
			this.onCancel?.();
		}
	}

	invalidate(): void {
		this.loader.invalidate();
	}

	render(width: number): string[] {
		if (!Number.isFinite(width) || width < 1) return [];
		const safeWidth = Math.floor(width);
		const titleLines = wrapAndFit(theme.bold(theme.fg("accent", TITLE)), safeWidth);
		const loaderLines = this.loader
			.render(safeWidth)
			.slice(1)
			.map((line) => fitLine(line, safeWidth));
		return [...titleLines, ...loaderLines, ...this.renderProgress(safeWidth)];
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.loader.stop();
	}

	private renderProgress(width: number): string[] {
		const count = `${this.stage.current}/${this.stage.total}`;
		const countText = theme.fg("muted", count);
		const countWidth = visibleWidth(count);
		const gapWidth = countWidth < width ? 1 : 0;
		const barWidth = width - countWidth - gapWidth;

		if (barWidth <= 0) return wrapAndFit(countText, width);

		const bar = this.renderBar(barWidth);
		return [fitLine(`${bar}${" ".repeat(gapWidth)}${countText}`, width)];
	}

	private renderBar(width: number): string {
		const filledGlyph = "━";
		const emptyGlyph = "─";

		const completed = Math.max(0, this.stage.current - 1);

		if (width < 3) {
			const filled = Math.floor((completed / this.stage.total) * width);
			return `${theme.fg("accent", filledGlyph.repeat(filled))}${theme.fg("dim", emptyGlyph.repeat(width - filled))}`;
		}

		const innerWidth = width - 2;
		const filledWidth = Math.floor((completed / this.stage.total) * innerWidth);
		const emptyWidth = innerWidth - filledWidth;
		return (
			theme.fg("dim", "[") +
			theme.fg("accent", filledGlyph.repeat(filledWidth)) +
			theme.fg("dim", emptyGlyph.repeat(emptyWidth)) +
			theme.fg("dim", "]")
		);
	}
}
