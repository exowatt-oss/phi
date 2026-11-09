import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Terminal } from "../src/terminal.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class ProfilingTuiAltScreen extends TuiAltScreen {
	/** Run one synchronous render cycle without waiting for the scheduler. */
	renderNow(): void {
		this.doRender();
	}
}

class CountingLines implements Component {
	private lines: string[];
	renderCalls = 0;

	constructor(lines: string[]) {
		this.lines = lines;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		this.renderCalls += 1;
		return this.lines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
	}
}

const markdownTheme = defaultMarkdownTheme;

function addLongTranscript(document: Container): { entries: number; estimatedLines: number } {
	const entries = Number.parseInt(process.env.PI_SCROLL_PROFILE_ENTRIES ?? "500", 10);
	const linesPerEntry = Number.parseInt(process.env.PI_SCROLL_PROFILE_LINES ?? "42", 10);
	for (let entry = 0; entry < entries; entry++) {
		const paragraphs = Array.from(
			{ length: Math.max(1, Math.floor(linesPerEntry / 3)) },
			(_, paragraph) =>
				`### Message ${entry}.${paragraph}\n\n` +
				`This is a long transcript line with **markdown**, \`tool output\`, ANSI styling, and enough words to wrap in the viewport. ` +
				`entry=${entry} paragraph=${paragraph} ` +
				"0123456789 ".repeat(3),
		).join("\n\n");
		const markdown = new Markdown(paragraphs, 1, 0, markdownTheme);
		document.addChild(markdown);
	}
	return { entries, estimatedLines: entries * linesPerEntry };
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function profileScrollFrames(): Promise<{ entries: number; lines: number; medianMs: number; frames: number }> {
	const terminal = new VirtualTerminal(100, 40);
	const tui = new ProfilingTuiAltScreen(terminal as Terminal, undefined, undefined, {
		jumpToBottom: { enabled: false },
	});
	const document = new Container();
	const transcript = addLongTranscript(document);
	const scrollView = new ScrollView(document, { follow: "end", primary: true });
	tui.setLayoutRoot(new VStack([{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 }]));
	tui.start();
	await terminal.waitForRender();
	const totalLines = document.render(terminal.columns).length;
	assert.ok(totalLines > 20_000, `expected a long transcript, got ${totalLines} lines`);

	// Warm Markdown and terminal/image state before timing steady-state scrolling.
	tui.scrollToTop();
	tui.renderNow();
	tui.scrollBy(3);
	tui.renderNow();

	const frames = Number.parseInt(process.env.PI_SCROLL_PROFILE_FRAMES ?? "40", 10);
	const samples: number[] = [];
	for (let frame = 0; frame < frames; frame++) {
		const direction = frame % 2 === 0 ? 1 : -1;
		const start = performance.now();
		tui.scrollBy(direction * 3);
		tui.renderNow();
		samples.push(performance.now() - start);
	}

	const result = {
		entries: transcript.entries,
		lines: totalLines,
		medianMs: median(samples),
		frames,
	};
	console.log(
		`scroll profile: entries=${result.entries} lines=${result.lines} frames=${result.frames} medianMsPerFrame=${result.medianMs.toFixed(3)}`,
	);
	tui.stop();
	assert.ok(samples.every((sample) => Number.isFinite(sample)));
	return result;
}

test("profiles steady-state scrolling on a long transcript", async () => {
	await profileScrollFrames();
});

test("reuses scroll content but invalidates it for content changes", async () => {
	const terminal = new VirtualTerminal(20, 4);
	const tui = new ProfilingTuiAltScreen(terminal as Terminal, undefined, undefined, {
		jumpToBottom: { enabled: false },
	});
	const document = new Container();
	const component = new CountingLines(Array.from({ length: 40 }, (_, index) => `line ${index}`));
	document.addChild(component);
	tui.setLayoutRoot(new ScrollView(document, { follow: "end", primary: true }));
	tui.start();
	await terminal.waitForRender();

	const warmRenderCalls = component.renderCalls;
	tui.scrollBy(-1);
	tui.renderNow();
	assert.equal(component.renderCalls, warmRenderCalls, "scroll-only frames should reuse cached content");

	component.setLines(["streamed update"]);
	tui.requestRender();
	tui.renderNow();
	assert.equal(component.renderCalls, warmRenderCalls + 1, "content changes should invalidate cached content");
	tui.stop();
});
