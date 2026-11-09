import { describe, expect, test, vi } from "vitest";
import { BtwPanel } from "../src/modes/interactive/components/btw-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("BtwPanel", () => {
	test("renders pending state and aborts only its request when closed", () => {
		initTheme("dark");
		const abort = vi.fn();
		const close = vi.fn();
		const panel = new BtwPanel({ question: "What is this?", onAbort: abort, onClose: close });

		const rendered = stripAnsi(panel.render(100).join("\n"));
		expect(rendered).toContain("What is this?");
		expect(rendered).toContain("Answering");
		panel.handleInput("\x1b");
		expect(panel.signal.aborted).toBe(true);
		expect(abort).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	test("renders markdown answer, usage, and history count", () => {
		initTheme("dark");
		const panel = new BtwPanel({
			question: "current",
			answer: "**answer**",
			usage: { inputTokens: 12, outputTokens: 3, cost: 0.0021 },
			history: [
				{ question: "one", answer: "old" },
				{ question: "two", answer: "old" },
				{ question: "three", answer: "old" },
				{ question: "four", answer: "old" },
				{ question: "five", answer: "old" },
				{ question: "six", answer: "old" },
			],
		});
		const rendered = stripAnsi(panel.render(100).join("\n"));
		expect(rendered).toContain("answer");
		expect(rendered).toContain("$0.0021");
		expect(rendered).toContain("12 in / 3 out");
		expect(rendered).toContain("(+2 earlier /btw)");
	});

	test("handles navigation, copy, clear, promote, and adopt without leaking prompt input", () => {
		initTheme("dark");
		const copy = vi.fn();
		const clear = vi.fn();
		const promote = vi.fn();
		const adopt = vi.fn();
		const panel = new BtwPanel({
			question: "second",
			answer: "answer",
			history: [{ question: "first", answer: "first answer" }],
			onCopy: copy,
			onClear: clear,
			onPromote: promote,
			onAdopt: adopt,
		});

		panel.handleInput("\x1b[D");
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("first");
		panel.handleInput("c");
		panel.handleInput("f");
		panel.handleInput("a");
		panel.handleInput("x");
		expect(copy).toHaveBeenCalledOnce();
		expect(promote).toHaveBeenCalledOnce();
		expect(adopt).toHaveBeenCalledOnce();
		expect(clear).toHaveBeenCalledOnce();
	});

	test("renders errors and closes without aborting completed requests", () => {
		initTheme("dark");
		const abort = vi.fn();
		const panel = new BtwPanel({ question: "q", answer: "partial", onAbort: abort });
		panel.setError("network failed");
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("network failed");
		panel.handleInput("\r");
		expect(abort).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// H1: onEscape callback
// ---------------------------------------------------------------------------
describe("H1 Esc routing", () => {
	test("calls onEscape instead of closing when onEscape is provided", () => {
		initTheme("dark");
		const escHandler = vi.fn();
		const close = vi.fn();
		const panel = new BtwPanel({ question: "q", onClose: close, onEscape: escHandler });
		panel.handleInput("\x1b");
		// onEscape fires; panel stays open (onClose was NOT called through normal close path)
		expect(escHandler).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
	});

	test("closes the panel on Esc when no onEscape is provided", () => {
		initTheme("dark");
		const close = vi.fn();
		const panel = new BtwPanel({ question: "q", onClose: close });
		panel.handleInput("\x1b");
		expect(close).toHaveBeenCalledOnce();
	});

	test("Enter still closes the panel regardless of onEscape", () => {
		initTheme("dark");
		const escHandler = vi.fn();
		const close = vi.fn();
		const panel = new BtwPanel({ question: "q", onClose: close, onEscape: escHandler });
		panel.handleInput("\r"); // Enter
		expect(close).toHaveBeenCalledOnce();
		expect(escHandler).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// M4: viewport / scroll clamping
// ---------------------------------------------------------------------------
describe("M4 scroll clamping", () => {
	test("bounds the viewport and clamps scrolling at the last page", () => {
		initTheme("dark");
		const answer = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");
		const panel = new BtwPanel({ question: "q", answer, viewportLines: 4 });
		for (let i = 0; i < 50; i++) panel.handleInput("\x1b[B");
		const rendered = panel.render(80);
		expect(rendered).toHaveLength(5); // pinned header + four body lines
		expect(stripAnsi(rendered.join("\n"))).toContain("line-29");
	});

	test("scrollTop cannot go negative", () => {
		initTheme("dark");
		const panel = new BtwPanel({ question: "q", answer: "answer" });
		for (let i = 0; i < 10; i++) {
			panel.handleInput("\x1b[A"); // up arrow
		}
		const rendered = panel.render(80);
		expect(stripAnsi(rendered.join("\n"))).toContain("btw: q");
	});

	test("render always returns at least the header line", () => {
		initTheme("dark");
		const panel = new BtwPanel({ question: "short q", answer: "a" });
		const rendered = panel.render(80);
		expect(rendered.length).toBeGreaterThanOrEqual(1);
		expect(stripAnsi(rendered[0]!)).toContain("short q");
	});
});
