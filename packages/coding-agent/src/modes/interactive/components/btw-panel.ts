import { type Component, Markdown, type MarkdownTheme, matchesKey, parseKey } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

export type BtwPanelState = "pending" | "answer" | "error";

export interface BtwUsage {
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}

export interface BtwHistoryItem {
	question: string;
	answer?: string;
	state?: Exclude<BtwPanelState, "pending">;
	usage?: BtwUsage;
}

export interface BtwPanelCallbacks {
	onClose?: () => void;
	onCopy?: (item: BtwHistoryItem) => void;
	onClear?: () => void;
	onPromote?: (item: BtwHistoryItem) => void;
	onAdopt?: (item: BtwHistoryItem) => void;
	onAbort?: () => void;
	/**
	 * Called when the user presses Escape. Defaults to closing the panel.
	 * Callers can override to forward the Escape to the main abort while keeping
	 * the panel open (e.g. when the main agent is streaming).
	 */
	onEscape?: () => void;
}

export interface BtwPanelOptions extends BtwPanelCallbacks {
	question: string;
	answer?: string;
	error?: string;
	usage?: BtwUsage;
	history?: readonly BtwHistoryItem[];
	markdownTheme?: MarkdownTheme;
	/** Maximum answer/history body lines shown at once. */ viewportLines?: number;
	/** The controller for the request represented by this panel. */ abortController?: AbortController;
}

/**
 * The ephemeral side-question panel. It owns focus while mounted: recognized
 * input is consumed here and is never forwarded to the prompt editor.
 */
export class BtwPanel implements Component {
	private question: string;
	private answer = "";
	private error = "";
	private state: BtwPanelState;
	private usage?: BtwUsage;
	private history: BtwHistoryItem[];
	private selected = 0;
	private scrollTop = 0;
	private markdownTheme: MarkdownTheme;
	private readonly callbacks: BtwPanelCallbacks;
	private readonly abortController: AbortController;
	private readonly viewportLines: number;
	private closed = false;

	constructor(options: BtwPanelOptions) {
		this.question = options.question;
		this.markdownTheme = options.markdownTheme ?? getMarkdownTheme();
		this.callbacks = options;
		this.viewportLines = Math.max(3, options.viewportLines ?? 12);
		this.history = [...(options.history ?? [])];
		this.answer = options.answer ?? "";
		this.error = options.error ?? "";
		this.usage = options.usage;
		this.state = this.error ? "error" : options.answer !== undefined ? "answer" : "pending";
		this.abortController = options.abortController ?? new AbortController();
		if (this.history.length === 0 || this.history[this.history.length - 1]?.question !== this.question) {
			this.history.push({
				question: this.question,
				answer: this.answer,
				state: this.state === "pending" ? undefined : this.state,
				usage: this.usage,
			});
		}
		this.selected = Math.max(0, this.history.length - 1);
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/** Abort the in-flight side call (same as panel close, but without firing onClose/onAbort). */
	abort(): void {
		if (!this.abortController.signal.aborted) {
			this.abortController.abort();
		}
	}

	get currentItem(): BtwHistoryItem {
		return {
			question: this.question,
			answer: this.answer,
			state: this.state === "pending" ? undefined : this.state,
			usage: this.usage,
		};
	}

	setPending(question = this.question): void {
		this.question = question;
		this.answer = "";
		this.error = "";
		this.usage = undefined;
		this.state = "pending";
		this.scrollTop = 0;
	}

	setAnswer(answer: string, usage?: BtwUsage): void {
		this.answer = answer;
		this.error = "";
		this.usage = usage;
		this.state = "answer";
		this.scrollTop = 0;
	}

	setError(error: string, usage?: BtwUsage): void {
		this.error = error;
		this.usage = usage;
		this.state = "error";
		this.scrollTop = 0;
	}

	setHistory(history: readonly BtwHistoryItem[]): void {
		this.history = [...history];
		this.selected = Math.max(0, this.history.length - 1);
		this.showSelected();
	}

	addHistory(item: BtwHistoryItem): void {
		this.history.push(item);
		this.selected = this.history.length - 1;
		this.showSelected();
	}

	clearHistory(): void {
		this.history = [];
		this.selected = 0;
		this.callbacks.onClear?.();
	}

	private showSelected(): void {
		const item = this.history[this.selected];
		if (!item) return;
		this.question = item.question;
		this.answer = item.answer ?? "";
		this.error = item.state === "error" ? (item.answer ?? "") : "";
		this.usage = item.usage;
		this.state = item.state ?? (item.answer === undefined ? "pending" : "answer");
		this.scrollTop = 0;
	}

	private moveHistory(delta: number): void {
		if (this.history.length === 0) return;
		const next = Math.max(0, Math.min(this.history.length - 1, this.selected + delta));
		if (next !== this.selected) {
			this.selected = next;
			this.showSelected();
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.state === "pending") {
			this.abortController.abort();
			this.callbacks.onAbort?.();
		}
		this.callbacks.onClose?.();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const key = parseKey(data);
		if (matchesKey(data, "left")) {
			this.moveHistory(-1);
			return;
		}
		if (matchesKey(data, "right")) {
			this.moveHistory(1);
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollTop = Math.max(0, this.scrollTop - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			// Upper bound is clamped during render; increment eagerly and let render clamp.
			this.scrollTop += 1;
			return;
		}
		if (key === "c") return void this.callbacks.onCopy?.(this.currentItem);
		if (key === "x") {
			this.clearHistory();
			return;
		}
		if (key === "f" && this.state === "answer") return void this.callbacks.onPromote?.(this.currentItem);
		if (key === "a" && this.state === "answer") return void this.callbacks.onAdopt?.(this.currentItem);
		if (matchesKey(data, "escape")) {
			if (this.callbacks.onEscape) {
				this.callbacks.onEscape();
			} else {
				this.close();
			}
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "space")) this.close();
	}

	invalidate(): void {
		// State changes are reflected on the next render; the parent TUI owns invalidation.
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		lines.push(theme.fg("accent", ` btw: ${this.question}`));
		const earlier = Math.max(0, this.history.length - 5);
		const labels = this.history.slice(-5).map((item, index) => {
			const absolute = this.history.length - Math.min(5, this.history.length) + index;
			const marker = absolute === this.selected ? "▸" : " ";
			return `${marker} ${item.question}`;
		});
		if (labels.length > 0) lines.push(theme.fg("muted", ` history: ${labels.join("  ")}`));
		if (earlier > 0) lines.push(theme.fg("muted", ` (+${earlier} earlier /btw)`));
		if (this.state === "pending") lines.push(theme.fg("accent", " ◐ Answering…"));
		else if (this.state === "error") lines.push(theme.fg("error", ` Error: ${this.error}`));
		else {
			const rendered = new Markdown(this.answer || "(empty answer)", 1, 0, this.markdownTheme).render(innerWidth);
			lines.push(...rendered);
		}
		if (this.usage) {
			const cost = this.usage.cost === undefined ? "" : `$${this.usage.cost.toFixed(4)} · `;
			const input = this.usage.inputTokens === undefined ? "" : `${this.usage.inputTokens} in`;
			const output = this.usage.outputTokens === undefined ? "" : `${this.usage.outputTokens} out`;
			lines.push(theme.fg("muted", ` usage: ${cost}${input}${input && output ? " / " : ""}${output}`));
		}
		lines.push(theme.fg("dim", " [←/→ history] [↑/↓ scroll] [c copy] [x clear] [f promote] [a adopt] [Esc close]"));
		// Pin the header and keep the panel bounded so it cannot push the editor off screen.
		const header = lines[0]!;
		const scrollable = lines.slice(1);
		const maxScroll = Math.max(0, scrollable.length - this.viewportLines);
		this.scrollTop = Math.min(this.scrollTop, maxScroll);
		return [header, ...scrollable.slice(this.scrollTop, this.scrollTop + this.viewportLines)];
	}
}
