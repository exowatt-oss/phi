import { describe, expect, it } from "vitest";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CompactionSummaryMessageComponent", () => {
	it("keeps the existing header for entries without compaction metadata", () => {
		initTheme("dark");
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "Earlier work was summarized.",
			tokensBefore: 227_000,
			timestamp: 0,
		});

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered).toContain("Compacted from 227,000 tokens");
		expect(rendered).not.toContain("background summary applied");
		expect(rendered).not.toContain("tool results");
	});

	it("adds the trigger and available statistics to the header", () => {
		initTheme("dark");
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "Earlier work was summarized.",
			tokensBefore: 227_000,
			timestamp: 0,
			trigger: "background",
			stats: { toolResultsElided: 41, turnsSummarized: 96 },
		});

		component.setExpanded(true);
		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered).toContain(
			"Compacted from 227,000 tokens · background summary applied · 41 tool results, 96 turns summarized",
		);
	});
});
