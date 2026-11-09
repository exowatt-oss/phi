import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	type Component,
	Container,
	ScrollView,
	Spacer,
	StdinBuffer,
	type Terminal,
	Text,
	VStack,
} from "@earendil-works/pi-tui";
import { afterAll, describe, expect, it } from "vitest";
import { getScrollViewBox } from "../../tui/src/layout.ts";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	buildContextEntries,
	type SessionEntry,
	SessionManager,
	sessionEntryToContextMessages,
} from "../src/core/session-manager.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const WIDTH = 220;
const HEIGHT = 60;
const WHEEL_LINES = 3;
const FRAME_COUNT = Number.parseInt(process.env.PHI_SCROLL_FRAMES ?? "40", 10);
const WHEEL_FRAME_COUNT = Number.parseInt(process.env.PHI_SCROLL_WHEEL_FRAMES ?? "12", 10);
const CACHE_CLEAR_FRAME_COUNT = Number.parseInt(process.env.PHI_SCROLL_CLEAR_FRAMES ?? "1", 10);
// Performance tests must be reproducible in a clean CI checkout. Never point
// fixtures at an engineer's untracked local session directory.
const SESSION_PATHS = [fileURLToPath(new URL("./fixtures/large-session.jsonl", import.meta.url))];

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class InstrumentedAltScreen extends TuiAltScreen {
	readonly ordinaryRenderStacks: string[] = [];
	captureOrdinaryRequests = false;

	override requestRender(force = false): void {
		if (this.captureOrdinaryRequests) {
			this.ordinaryRenderStacks.push(new Error("requestRender").stack ?? "");
		}
		super.requestRender(force);
	}
}

type MessageLike = {
	role: string;
	content?: unknown;
	toolCallId?: string;
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	excludeFromContext?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
	stopReason?: string;
	errorMessage?: string;
	display?: boolean;
};

function textFromUserMessage(message: MessageLike): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => {
			return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
		})
		.map((block) => block.text)
		.join("");
}

function suppressScheduledRender(tui: InstrumentedAltScreen): void {
	const internals = tui as unknown as {
		renderTimer?: NodeJS.Timeout;
		renderRequested?: boolean;
	};
	if (internals.renderTimer) {
		clearTimeout(internals.renderTimer);
		internals.renderTimer = undefined;
	}
	internals.renderRequested = false;
}

function renderRoot(chat: Container): { root: Component; scrollView: ScrollView } {
	const documentContainer = new Container();
	documentContainer.addChild(new Container()); // headerContainer
	documentContainer.addChild(new Container()); // loadedResourcesContainer
	documentContainer.addChild(chat);

	// These are the same layout regions InteractiveMode mounts below the transcript.
	const pendingMessages = new Container();
	const status = new Container();
	const widgetsAbove = new Container();
	const editor = new Container();
	editor.addChild(new Spacer(3));
	const widgetsBelow = new Container();
	const footer = new Container();
	footer.addChild(new Text("footer", 1, 0));

	const scrollView = new ScrollView(documentContainer, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: "hidden",
	});
	const dock = new VStack([
		{ component: pendingMessages, shrink: 1, minSize: 0 },
		{ component: status, shrink: 1, minSize: 0 },
		{ component: widgetsAbove, shrink: 1, minSize: 0 },
		{ component: editor, shrink: 1, minSize: 3 },
		{ component: widgetsBelow, shrink: 1, minSize: 0 },
		{ component: footer, shrink: 1, minSize: 1 },
	]);
	const root = new VStack([
		{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	return { root, scrollView };
}

function addMessage(
	chat: Container,
	message: MessageLike,
	tui: InstrumentedAltScreen,
	cwd: string,
	pendingTools: Map<string, ToolExecutionComponent>,
	renderedTools: Map<string, ToolExecutionComponent>,
	toolDefinitions: ReturnType<typeof createAllToolDefinitions>,
): void {
	switch (message.role) {
		case "user": {
			const text = textFromUserMessage(message);
			if (text) {
				if (chat.children.length > 0) chat.addChild(new Spacer(1));
				chat.addChild(new UserMessageComponent(text, getMarkdownTheme(), 1, []));
			}
			return;
		}
		case "assistant": {
			chat.addChild(
				new AssistantMessageComponent(message as never, false, getMarkdownTheme(), "Thinking...", 1, []),
			);
			if (Array.isArray(message.content)) {
				for (const content of message.content) {
					if (!content || typeof content !== "object" || (content as { type?: string }).type !== "toolCall")
						continue;
					const call = content as { type: "toolCall"; name: string; id: string; arguments: unknown };
					const component = new ToolExecutionComponent(
						call.name,
						call.id,
						call.arguments,
						{ showImages: false, collapsedLines: 5, display: "minimal" },
						toolDefinitions[call.name as keyof typeof toolDefinitions],
						tui,
						cwd,
					);
					chat.addChild(component);
					component.setExpanded(false);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						component.updateResult({
							content: [
								{
									type: "text",
									text:
										message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error",
								},
							],
							isError: true,
						});
					} else {
						renderedTools.set(call.id, component);
					}
				}
			}
			return;
		}
		case "toolResult": {
			const component = renderedTools.get(message.toolCallId ?? "");
			if (component) {
				component.updateResult(message as never);
				renderedTools.delete(message.toolCallId ?? "");
				pendingTools.delete(message.toolCallId ?? "");
			}
			return;
		}
		case "bashExecution": {
			const component = new BashExecutionComponent(message.command ?? "", tui, message.excludeFromContext ?? false);
			if (message.output) component.appendOutput(message.output);
			component.setComplete(message.exitCode, message.cancelled ?? false, undefined, message.fullOutputPath);
			chat.addChild(component);
			return;
		}
		case "custom": {
			if (message.display !== false)
				chat.addChild(new CustomMessageComponent(message as never, undefined, getMarkdownTheme(), 1));
			return;
		}
		case "compactionSummary":
			chat.addChild(new Spacer(1));
			chat.addChild(new CompactionSummaryMessageComponent(message as never, getMarkdownTheme()));
			return;
		case "branchSummary":
			chat.addChild(new Spacer(1));
			chat.addChild(new BranchSummaryMessageComponent(message as never, getMarkdownTheme()));
			return;
		default:
			return;
	}
}

function buildChat(
	entries: SessionEntry[],
	tui: InstrumentedAltScreen,
	cwd: string,
): { chat: Container; messageCount: number; toolCallCount: number } {
	const chat = new Container();
	const toolDefinitions = createAllToolDefinitions(cwd);
	const renderedTools = new Map<string, ToolExecutionComponent>();
	const pendingTools = new Map<string, ToolExecutionComponent>();
	let messageCount = 0;
	let toolCallCount = 0;
	for (const entry of entries) {
		if (entry.type === "custom") {
			addMessage(chat, entry as never, tui, cwd, pendingTools, renderedTools, toolDefinitions);
			continue;
		}
		for (const message of sessionEntryToContextMessages(entry)) {
			messageCount++;
			if (message.role === "assistant" && Array.isArray(message.content)) {
				toolCallCount += message.content.filter((c) => c.type === "toolCall").length;
			}
			addMessage(chat, message as never, tui, cwd, pendingTools, renderedTools, toolDefinitions);
		}
	}
	for (const [id, component] of renderedTools) pendingTools.set(id, component);
	return { chat, messageCount, toolCallCount };
}

function loadSession(path: string): { entries: SessionEntry[]; cwd: string; bytes: number } {
	const tempDir = mkdtempSync(join(tmpdir(), "phi-scroll-session-"));
	const copy = join(tempDir, "session.jsonl");
	cpSync(path, copy);
	try {
		const manager = SessionManager.open(copy);
		return {
			entries: buildContextEntries(manager.getEntries()),
			cwd: manager.getCwd(),
			bytes: readFileSync(path).byteLength,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function changedRows(writes: string[]): number {
	return writes.reduce((count, write) => count + (write.match(/\x1b\[\d+;1H\x1b\[2K/g)?.length ?? 0), 0);
}

function scrollRegionShifts(writes: string[]): number {
	return writes.reduce((count, write) => count + (write.match(/\x1b\[\d+;\d+r\x1b\[\d+[ST]/g)?.length ?? 0), 0);
}

function stackCallers(stacks: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const stack of stacks) {
		for (const line of stack.split("\n").slice(2)) {
			const match = line.match(/at (?:new )?([^ (]+).*\/(?:packages|node_modules)\//);
			if (match) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
		}
	}
	return counts;
}

async function runCase(
	path: string,
	options?: { disableJumpToBottomPill?: boolean },
): Promise<Record<string, unknown>> {
	const loaded = loadSession(path);
	const terminal = new RecordingTerminal(WIDTH, HEIGHT);
	const tui = new InstrumentedAltScreen(
		terminal,
		false,
		"/tmp/phi-scroll-harness",
		options?.disableJumpToBottomPill ? { jumpToBottom: { enabled: false } } : {},
	);
	const built = buildChat(loaded.entries, tui, loaded.cwd);
	const { root, scrollView } = renderRoot(built.chat);
	tui.setLayoutRoot(root);
	tui.start();
	await terminal.waitForRender();
	suppressScheduledRender(tui);

	const frame = (tui as unknown as { currentLayout?: unknown }).currentLayout;
	const box = frame ? getScrollViewBox(frame as never, scrollView) : undefined;
	const renderedLines = box?.scrollContentLines?.length ?? 0;
	const initialBytes = terminal.writes.reduce((sum, write) => sum + Buffer.byteLength(write), 0);

	const scrollSamples: number[] = [];
	const scrollBytes: number[] = [];
	const scrollRows: number[] = [];
	let scrollShiftFrames = 0;
	for (let i = 0; i < FRAME_COUNT; i++) {
		terminal.writes.length = 0;
		const started = performance.now();
		tui.scrollBy(-WHEEL_LINES);
		(tui as unknown as { doRender(): void }).doRender();
		const elapsed = performance.now() - started;
		scrollSamples.push(elapsed);
		scrollBytes.push(terminal.writes.reduce((sum, write) => sum + Buffer.byteLength(write), 0));
		scrollRows.push(changedRows(terminal.writes));
		scrollShiftFrames += scrollRegionShifts(terminal.writes) > 0 ? 1 : 0;
		suppressScheduledRender(tui);
	}

	const cacheClearSamples: number[] = [];
	const cacheClearBytesSamples: number[] = [];
	for (let i = 0; i < CACHE_CLEAR_FRAME_COUNT; i++) {
		terminal.writes.length = 0;
		const clearStarted = performance.now();
		tui.requestRender();
		(tui as unknown as { doRender(): void }).doRender();
		cacheClearSamples.push(performance.now() - clearStarted);
		cacheClearBytesSamples.push(terminal.writes.reduce((sum, write) => sum + Buffer.byteLength(write), 0));
		suppressScheduledRender(tui);
	}
	const cacheClearMs = median(cacheClearSamples);
	const cacheClearBytes = median(cacheClearBytesSamples);

	const wheelSamples: number[] = [];
	const wheelBytes: number[] = [];
	const wheelRows: number[] = [];
	const wheelData = "\x1b[<64;100;30M";
	tui.captureOrdinaryRequests = true;
	tui.ordinaryRenderStacks.length = 0;
	for (let i = 0; i < WHEEL_FRAME_COUNT; i++) {
		terminal.writes.length = 0;
		const started = performance.now();
		terminal.sendInput(wheelData);
		(tui as unknown as { doRender(): void }).doRender();
		wheelSamples.push(performance.now() - started);
		wheelBytes.push(terminal.writes.reduce((sum, write) => sum + Buffer.byteLength(write), 0));
		wheelRows.push(changedRows(terminal.writes));
		suppressScheduledRender(tui);
	}
	tui.captureOrdinaryRequests = false;

	const result = {
		path,
		jumpToBottomPill: options?.disableJumpToBottomPill ? "disabled" : "enabled",
		bytes: loaded.bytes,
		messageCount: built.messageCount,
		toolCallCount: built.toolCallCount,
		entryCount: loaded.entries.length,
		renderedLines,
		terminal: { width: WIDTH, height: HEIGHT },
		initialBytes,
		scrollOnlyMs: median(scrollSamples.slice(5)),
		scrollOnlyP95Ms: percentile(scrollSamples.slice(5), 0.95),
		scrollOnlyBytes: median(scrollBytes.slice(5)),
		scrollOnlyRows: median(scrollRows.slice(5)),
		scrollShiftFrames,
		scrollShiftFramesOf: FRAME_COUNT,
		cacheClearMs,
		cacheClearP95Ms: percentile(cacheClearSamples, 0.95),
		cacheClearBytes,
		wheelMs: median(wheelSamples.slice(2)),
		wheelP95Ms: percentile(wheelSamples.slice(2), 0.95),
		wheelBytes: median(wheelBytes.slice(2)),
		wheelRows: median(wheelRows.slice(2)),
		wheelBytesPerSecondAt60Hz: median(wheelBytes.slice(2)) * 60,
		wheelRequestRenderCount: tui.ordinaryRenderStacks.length,
		wheelRequestRenderCallers: stackCallers(tui.ordinaryRenderStacks),
		wheelRequestRenderStacks: tui.ordinaryRenderStacks.slice(0, 3),
	};
	tui.stop();
	return result;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length % 2 === 0
		? ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2
		: (sorted[Math.floor(sorted.length / 2)] ?? 0);
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

if (process.env.PHI_SCROLL_DIRECT === "1") {
	initTheme("light");
	const directResults: Record<string, unknown>[] = [];
	const disablePill = process.env.PHI_SCROLL_NO_PILL === "1";
	for (const path of SESSION_PATHS) directResults.push(await runCase(path, { disableJumpToBottomPill: disablePill }));
	console.log(JSON.stringify({ cases: directResults }, null, 2));
} else {
	let results: Record<string, unknown>[] = [];

	describe("real-session fullscreen scroll performance", () => {
		it("renders the tracked transcript fixture through the real chat components", async () => {
			initTheme("light");
			results = [];
			for (const path of SESSION_PATHS) results.push(await runCase(path));
			console.log(JSON.stringify({ cases: results }, null, 2));
			expect(results).toHaveLength(1);
			for (const result of results) {
				expect(result.renderedLines).toBeGreaterThan(0);
				expect(result.messageCount).toBeGreaterThan(0);
			}
		}, 120_000);
	});

	afterAll(() => {
		// Keep the test process from being held open by any component timer.
		results = [];
	});

	describe("stdin burst framing", () => {
		it("splits concatenated SGR wheel events before TuiBase.handleTerminalInput", () => {
			const event = "\x1b[<64;100;30M";
			const emitted: string[] = [];
			const buffer = new StdinBuffer({ timeout: 10 });
			buffer.on("data", (data) => emitted.push(data));
			buffer.process(event + event);
			console.log(JSON.stringify({ wheelBurstBytes: (event + event).length, stdinBufferEvents: emitted }));
			expect(emitted).toEqual([event, event]);
		});
	});
}

export { SESSION_PATHS, runCase };
