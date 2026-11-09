import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import type { CompactionTrigger } from "../../../core/session-manager.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

type CompactionSummaryDisplayMessage = CompactionSummaryMessage & {
	trigger?: CompactionTrigger;
	stats?: { toolResultsElided: number; turnsSummarized: number };
};

const COMPACTION_TRIGGER_LABELS: Record<CompactionTrigger, string> = {
	background: "background summary applied",
	threshold: "threshold compaction",
	overflow: "context overflow",
	manual: "manual /compact",
	checkpoint: "model checkpoint",
	stall: "stall recovery",
};

function compactionHeader(message: CompactionSummaryDisplayMessage): string {
	const segments: string[] = [`Compacted from ${message.tokensBefore.toLocaleString()} tokens`];
	if (message.trigger) {
		segments.push(COMPACTION_TRIGGER_LABELS[message.trigger]);
	}

	const stats = message.stats;
	if (stats) {
		const statSegments: string[] = [];
		if (typeof stats.toolResultsElided === "number" && Number.isFinite(stats.toolResultsElided)) {
			statSegments.push(`${stats.toolResultsElided.toLocaleString()} tool results`);
		}
		if (typeof stats.turnsSummarized === "number" && Number.isFinite(stats.turnsSummarized)) {
			statSegments.push(`${stats.turnsSummarized.toLocaleString()} turns summarized`);
		}
		if (statSegments.length > 0) segments.push(statSegments.join(", "));
	}

	return segments.join(" · ");
}

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryDisplayMessage;
	private markdownTheme: MarkdownTheme;

	constructor(
		message: CompactionSummaryDisplayMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
	) {
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();

		const header = compactionHeader(this.message);
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		content.addChild(new Text(label, 0, 0));
		content.addChild(new Spacer(1));

		if (this.expanded) {
			const markdownHeader = `**${header}**\n\n`;
			content.addChild(
				new Markdown(markdownHeader + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			content.addChild(
				new Text(
					theme.fg("customMessageText", `${header} (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
