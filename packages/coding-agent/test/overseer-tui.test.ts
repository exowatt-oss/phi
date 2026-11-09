import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { ThreadRegistry } from "../src/extensions/overseer/registry.ts";
import {
	BOARD_WIDGET_KEY,
	isOverseerMessage,
	OverseerBoardWidget,
	overseerTuiEnabled,
	THREAD_WIDGET_KEY,
	ThreadBannerWidget,
} from "../src/extensions/overseer/tui.ts";
import {
	buildOverseerBoardLines,
	buildThreadBannerLine,
	buildThreadViews,
	COMPACT_ROWS_MAX,
	threadGlyph,
} from "../src/extensions/overseer/tui-board.ts";
import { DEFAULT_WATCH, type ThreadRecord } from "../src/extensions/overseer/types.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import type { SessionSummary } from "../src/remote/protocol.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { FakeHub, mountOverseer, summary, testDeps } from "./overseer-helpers.ts";

const OVERSEER = "0190aaaa-0000-7000-8000-00000000beef";
const NOW = 10_000_000;
const MIN = 60_000;
const WIDTHS = [200, 120, 100, 80, 72, 60, 40, 24, 12];

let theme: Theme;

beforeAll(async () => {
	initTheme("dark");
	theme = (await import("../src/modes/interactive/theme/theme.ts")).theme;
});

function record(name: string, sessionId: string, extra: Partial<ThreadRecord> = {}): ThreadRecord {
	return {
		name,
		sessionId,
		backend: "forca",
		cwd: "/tmp",
		createdAt: NOW - 12 * MIN,
		watch: { ...DEFAULT_WATCH },
		state: "running",
		registered: true,
		...extra,
	};
}

const ids = {
	api: "0190bbbb-1111-7000-8000-000000000001",
	docs: "0190bbbb-2222-7000-8000-000000000002",
	lint: "0190bbbb-3333-7000-8000-000000000003",
};

/** api working on a tool, docs idle with a reply, lint idle with an error. */
function sampleBoard(): { records: ThreadRecord[]; live: Map<string, SessionSummary> } {
	const records = [
		record("api-filters", ids.api),
		record("docs", ids.docs, { backend: "tmux" }),
		record("lint", ids.lint, { backend: "headless", adopted: true }),
	];
	const live = new Map<string, SessionSummary>([
		[
			ids.api,
			summary({
				sessionId: ids.api,
				status: "working",
				lastActivityAt: NOW - 4_000,
				model: { provider: "anthropic", id: "claude-opus-5-5" },
				thinkingLevel: "high",
				activity: { tool: "bash", summary: "bash  npm test -- items" },
				usage: { costUsd: 1.24, contextPercent: 38 },
				subagents: { running: 2, total: 3 },
			}),
		],
		[
			ids.docs,
			summary({
				sessionId: ids.docs,
				status: "idle",
				lastActivityAt: NOW - 3 * MIN,
				model: { provider: "gateway", id: "example-medium" },
				thinkingLevel: "max",
				lastText: "Docs updated: added the filters section and regenerated the API table.",
				usage: { costUsd: 0.42, contextPercent: 21 },
			}),
		],
		[
			ids.lint,
			summary({
				sessionId: ids.lint,
				status: "idle",
				lastActivityAt: NOW - 9 * MIN,
				model: { provider: "anthropic", id: "claude-sonnet-5" },
				thinkingLevel: "medium",
				lastError: "429 rate limited by provider",
				usage: { costUsd: 0.08, contextPercent: 7 },
			}),
		],
	]);
	return { records, live };
}

function plain(lines: string[]): string[] {
	return lines.map(stripAnsi);
}

describe("overseer TUI board: views", () => {
	it("resolves status, health, model, backend and note per thread", () => {
		const { records, live } = sampleBoard();
		records.push(
			record("fresh", "0190cccc-0000-7000-8000-000000000004", { registered: false }),
			record("gone", "0190cccc-0000-7000-8000-000000000005", { state: "exited", lastError: "killed" }),
			record("lost", "0190cccc-0000-7000-8000-000000000006"),
			record("slow", "0190cccc-0000-7000-8000-000000000007", { watch: { ...DEFAULT_WATCH, stallMinutes: 5 } }),
		);
		live.set(
			"0190cccc-0000-7000-8000-000000000007",
			summary({
				sessionId: "0190cccc-0000-7000-8000-000000000007",
				status: "working",
				lastActivityAt: NOW - 6 * MIN,
			}),
		);
		const views = buildThreadViews(records, live, NOW);
		const by = (name: string) => views.find((view) => view.name === name)!;

		expect(by("api-filters")).toMatchObject({
			status: "working",
			health: "ok",
			model: "anthropic/claude-opus-5-5:high",
			backend: "forca",
			costUsd: 1.24,
			contextPercent: 38,
			subagentsRunning: 2,
			note: { kind: "tool", text: "bash npm test -- items" },
		});
		expect(by("docs")).toMatchObject({ status: "idle", health: "ok", note: { kind: "reply" } });
		expect(by("lint")).toMatchObject({
			health: "error",
			backend: "headless*",
			note: { kind: "error", text: "429 rate limited by provider" },
		});
		expect(by("fresh")).toMatchObject({ status: "offline", health: "starting", note: { kind: "info" } });
		expect(by("gone")).toMatchObject({ health: "exited", note: { kind: "error", text: "killed" } });
		expect(by("lost")).toMatchObject({ status: "offline", health: "missing" });
		expect(by("slow")).toMatchObject({ status: "working", health: "stalled" });
		// One id length per board, at least 8 characters.
		expect(new Set(views.map((view) => view.id.length)).size).toBe(1);
		expect(views[0].id.length).toBeGreaterThanOrEqual(8);
	});

	it("leads each row with a glyph for its health, animating only a healthy working thread", () => {
		const { records, live } = sampleBoard();
		const views = buildThreadViews(records, live, NOW);
		const working = views[0];
		expect(threadGlyph(working, 0).glyph).not.toBe(threadGlyph(working, 120).glyph);
		expect(threadGlyph(working, 0).color).toBe("accent");
		expect(threadGlyph(views[1], 0)).toEqual({ glyph: "○", color: "muted" });
		expect(threadGlyph(views[2], 0)).toEqual({ glyph: "✗", color: "error" });
		expect(threadGlyph({ ...working, health: "stalled" }, 0)).toEqual({ glyph: "!", color: "warning" });
		expect(threadGlyph({ ...working, health: "starting" }, 0).glyph).toBe("◌");
		expect(threadGlyph({ ...working, health: "exited" }, 0).color).toBe("error");
		expect(threadGlyph({ ...working, health: "missing" }, 0).color).toBe("warning");
	});
});

describe("overseer TUI board: lines", () => {
	it("never exceeds the width, at any width", () => {
		const { records, live } = sampleBoard();
		const many = [
			...records,
			...Array.from({ length: 9 }, (_, index) =>
				record(`worker-with-a-rather-long-name-${index}`, `0190dddd-${index}000-7000-8000-00000000000${index}`),
			),
		];
		for (const set of [records, many]) {
			const views = buildThreadViews(set, live, NOW);
			for (const width of WIDTHS) {
				for (const hubDown of [false, true]) {
					const lines = buildOverseerBoardLines(views, theme, width, NOW, { hubDown });
					expect(lines.length).toBeGreaterThan(0);
					for (const line of lines)
						expect(visibleWidth(line), `${width}: ${stripAnsi(line)}`).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("shows a clear overseer header and two lines per thread for a few threads", () => {
		const { records, live } = sampleBoard();
		const lines = plain(buildOverseerBoardLines(buildThreadViews(records, live, NOW), theme, 110, NOW));
		expect(lines).toHaveLength(1 + 3 * 2);
		expect(lines[0]).toContain("overseeing 3 threads");
		expect(lines[0]).toContain("1 working");
		expect(lines[0]).toContain("2 idle");
		expect(lines[0]).toContain("1 error");
		expect(lines[0]).toContain("$1.74");
		expect(lines[0]).toContain("/threads");

		const [api, apiNote, docs, docsNote, lint, lintNote] = lines.slice(1);
		for (const part of [
			"api-filters",
			"working",
			"ok",
			"anthropic/claude-opus-5-5:high",
			"ctx 38%",
			"$1.24",
			"quiet 4s",
		])
			expect(api).toContain(part);
		expect(apiNote).toContain("⚒ bash npm test -- items");
		expect(apiNote).toMatch(/forca · 0190bbbb-1 · age 12m$/);
		expect(docs).toContain("idle");
		expect(docs).toContain("gateway/example-medium:max");
		expect(docsNote).toContain("last Docs updated");
		expect(docsNote).toContain("tmux");
		expect(lint).toContain("error");
		expect(lintNote).toContain("error: 429 rate limited by provider");
		expect(lintNote).toContain("headless*");
	});

	it("degrades gracefully on a narrow terminal", () => {
		const { records, live } = sampleBoard();
		const lines = plain(buildOverseerBoardLines(buildThreadViews(records, live, NOW), theme, 60, NOW));
		expect(lines[0]).toContain("overseeing 3 threads");
		// Status and health merge into one column; the model shortens before it disappears.
		expect(lines[1]).toContain("api-filters");
		expect(lines[1]).toContain("working");
		expect(lines[1]).toContain("claude-opus-5-5:high");
		expect(lines[5]).toContain("error");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("collapses many threads into compact rows, keeping the ones that need attention", () => {
		const records: ThreadRecord[] = [];
		const live = new Map<string, SessionSummary>();
		for (let index = 0; index < 12; index++) {
			const sessionId = `0190eeee-${String(index).padStart(4, "0")}-7000-8000-000000000000`;
			records.push(record(`t${index}`, sessionId));
			live.set(
				sessionId,
				summary({
					sessionId,
					status: index === 10 ? "working" : "idle",
					lastActivityAt: NOW - MIN,
					...(index === 11 ? { lastError: "boom" } : {}),
				}),
			);
		}
		const lines = plain(buildOverseerBoardLines(buildThreadViews(records, live, NOW), theme, 100, NOW));
		expect(lines).toHaveLength(1 + COMPACT_ROWS_MAX);
		expect(lines[0]).toContain("overseeing 12 threads");
		expect(lines.at(-1)).toContain("+7 more (7 idle) · /threads");
		const rows = lines.slice(1, -1).join("\n");
		expect(rows).toContain("t10");
		expect(rows).toContain("t11");
		// Shown rows stay in registry order.
		expect(rows.indexOf("t0 ")).toBeLessThan(rows.indexOf("t10"));
		expect(rows.indexOf("t10")).toBeLessThan(rows.indexOf("t11"));

		// Four to six threads: one compact line each, no "more" line.
		const five = plain(buildOverseerBoardLines(buildThreadViews(records.slice(0, 5), live, NOW), theme, 100, NOW));
		expect(five).toHaveLength(6);
		expect(five.join("\n")).not.toContain("more");
	});

	it("is empty without threads, and flags an unreachable hub", () => {
		expect(buildOverseerBoardLines([], theme, 100, NOW)).toEqual([]);
		const { records, live } = sampleBoard();
		const header = plain(
			buildOverseerBoardLines(buildThreadViews(records, live, NOW), theme, 120, NOW, { hubDown: true }),
		)[0];
		expect(header).toContain("hub offline");
	});
});

describe("overseer TUI: thread banner", () => {
	const info = {
		overseerSessionId: OVERSEER,
		overseerName: "boss",
		thread: "api-filters",
		subagentDefault: "gateway/example-medium:max",
	};

	it("names the overseer, its id, the thread and the subagent policy", () => {
		const line = stripAnsi(buildThreadBannerLine(info, theme, 120));
		expect(line).toBe("◇ overseen by boss (0190aaaa) · thread api-filters · subagents gateway/example-medium:max");
		const at = new Date(2026, 10, 6, 14, 32).getTime();
		expect(stripAnsi(buildThreadBannerLine({ ...info, lastMessageAt: at }, theme, 140))).toContain(
			"last message 14:32",
		);
		expect(stripAnsi(buildThreadBannerLine({ overseerSessionId: OVERSEER }, theme, 80))).toBe(
			"◇ overseen by overseer (0190aaaa)",
		);
	});

	it("fits narrow terminals, dropping detail before the thread name", () => {
		const full = {
			...info,
			subagentAllow: "gateway/example-medium:max,anthropic/claude-sonnet-5:medium",
			lastMessageAt: NOW,
		};
		for (const width of WIDTHS) {
			const line = buildThreadBannerLine(full, theme, width);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const narrow = stripAnsi(buildThreadBannerLine(full, theme, 48));
		expect(narrow).toContain("thread api-filters");
		expect(narrow).not.toContain("allow");
	});

	it("recognizes messages the overseer sent", () => {
		expect(
			isOverseerMessage({ role: "user", content: "[overseer boss (0190aaaa)]\ndo it", timestamp: 1 } as never),
		).toBe(true);
		expect(
			isOverseerMessage({
				role: "user",
				content: [{ type: "text", text: "[overseer x]\nhi" }],
				timestamp: 1,
			} as never),
		).toBe(true);
		expect(isOverseerMessage({ role: "user", content: "[overseers] no", timestamp: 1 } as never)).toBe(false);
		expect(isOverseerMessage({ role: "assistant", content: [], timestamp: 1 } as never)).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------
// Gating and widget lifecycle
// ---------------------------------------------------------------------------------------------

interface FakeUi {
	calls: Array<{ key: string; content: unknown; options?: unknown }>;
	ui: ExtensionContext["ui"];
}

function fakeUi(): FakeUi {
	const calls: FakeUi["calls"] = [];
	const ui = {
		setWidget: (key: string, content: unknown, options?: unknown) => calls.push({ key, content, options }),
		setStatus: () => {},
		notify: () => {},
	} as unknown as ExtensionContext["ui"];
	return { calls, ui };
}

function fakeCtx(ui: ExtensionContext["ui"], mode = "tui", hasUI = true): ExtensionContext {
	return { mode, hasUI, ui, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
}

type Factory = (tui: unknown, theme: Theme) => { render(width: number): string[]; dispose?(): void };

describe("overseer TUI: gating", () => {
	it("needs PI_TUI_MODE and an interactive terminal context", () => {
		expect(overseerTuiEnabled({}, { mode: "tui", hasUI: true })).toBe(false);
		expect(overseerTuiEnabled({ PI_TUI_MODE: "0" }, { mode: "tui", hasUI: true })).toBe(false);
		expect(overseerTuiEnabled({ PI_TUI_MODE: "1" }, { mode: "tui", hasUI: true })).toBe(true);
		expect(overseerTuiEnabled({ PI_TUI_MODE: "true" }, { mode: "tui", hasUI: true })).toBe(true);
		for (const mode of ["rpc", "json", "print"] as const)
			expect(overseerTuiEnabled({ PI_TUI_MODE: "1" }, { mode, hasUI: true })).toBe(false);
		expect(overseerTuiEnabled({ PI_TUI_MODE: "1" }, { mode: "tui", hasUI: false })).toBe(false);
	});

	it("mounts, re-renders and hides the board widget with the threads", () => {
		vi.useFakeTimers();
		try {
			const { records, live } = sampleBoard();
			let current: ThreadRecord[] = [];
			const widget = new OverseerBoardWidget(
				{ records: () => current, live: () => live, hubDown: () => false, now: () => NOW },
				{ PI_TUI_MODE: "1" },
			);
			const { calls, ui } = fakeUi();
			widget.attach(fakeCtx(ui));
			expect(calls).toEqual([]); // no threads, no widget

			current = records;
			widget.refresh();
			expect(calls).toHaveLength(1);
			expect(calls[0].key).toBe(BOARD_WIDGET_KEY);
			const requestRender = vi.fn();
			const component = (calls[0].content as Factory)({ requestRender }, theme);
			expect(stripAnsi(component.render(100)[0])).toContain("overseeing 3 threads");

			widget.refresh(); // already mounted: re-render, not re-mount
			expect(calls).toHaveLength(1);
			expect(requestRender).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1000); // a thread works: the spinner ticks every 250 ms
			expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(4);

			current = [];
			widget.refresh();
			expect(calls).toHaveLength(2);
			expect(calls[1]).toMatchObject({ key: BOARD_WIDGET_KEY, content: undefined });
			const before = requestRender.mock.calls.length;
			vi.advanceTimersByTime(5000);
			expect(requestRender.mock.calls.length).toBe(before); // ticker stopped
			widget.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("never touches the UI outside phi's own TUI", () => {
		const { records, live } = sampleBoard();
		for (const [env, mode, hasUI] of [
			[{}, "tui", true],
			[{ PI_TUI_MODE: "1" }, "rpc", true],
			[{ PI_TUI_MODE: "1" }, "print", false],
			[{ PI_TUI_MODE: "1" }, "tui", false],
		] as const) {
			const widget = new OverseerBoardWidget(
				{ records: () => records, live: () => live, hubDown: () => false, now: () => NOW },
				env,
			);
			const { calls, ui } = fakeUi();
			widget.attach(fakeCtx(ui, mode, hasUI));
			widget.refresh();
			expect(calls).toEqual([]);

			const banner = new ThreadBannerWidget(
				{ overseerSessionId: OVERSEER },
				env,
				() => NOW,
				() => undefined,
			);
			banner.attach(fakeCtx(ui, mode, hasUI));
			expect(calls).toEqual([]);
		}
	});

	it("shows the thread banner below the editor and notes overseer messages", () => {
		const { calls, ui } = fakeUi();
		const banner = new ThreadBannerWidget(
			{ overseerSessionId: OVERSEER, overseerName: "boss" },
			{ PI_TUI_MODE: "1" },
			() => NOW,
			() => "my-thread",
		);
		banner.attach(fakeCtx(ui));
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ key: THREAD_WIDGET_KEY, options: { placement: "belowEditor" } });
		const requestRender = vi.fn();
		const component = (calls[0].content as Factory)({ requestRender }, theme);
		expect(stripAnsi(component.render(100)[0])).toBe("◇ overseen by boss (0190aaaa) · thread my-thread");
		const at = new Date(2026, 10, 6, 9, 5).getTime();
		banner.observe({ role: "user", content: "[overseer boss (0190aaaa)]\nnext step", timestamp: at } as never);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(stripAnsi(component.render(100)[0])).toContain("last message 09:05");
		banner.observe({ role: "user", content: "plain user text", timestamp: at + MIN } as never);
		expect(banner.lastMessageAt).toBe(at);
	});
});

describe("overseer TUI: extension wiring", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "phi-overseer-tui-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	function seedRegistry(): void {
		const registry = new ThreadRegistry(agentDir, OVERSEER);
		registry.add(record("api-filters", ids.api));
		registry.save();
	}

	async function mount(env: Record<string, string>, mode = "tui", hasUI = true) {
		const hub = new FakeHub();
		hub.sessions = [summary({ sessionId: ids.api, status: "working", overseer: { sessionId: OVERSEER } })];
		const m = await mountOverseer({ deps: testDeps(hub, agentDir, { env: { PATH: "", ...env } }), mode, hasUI });
		await m.fire("session_start", { reason: "startup" });
		return m;
	}

	it("sets the board widget at session start only with PI_TUI_MODE=1 in an interactive TUI", async () => {
		seedRegistry();
		const on = await mount({ PI_TUI_MODE: "1" });
		expect(on.widgets.map((call) => call.key)).toContain(BOARD_WIDGET_KEY);
		await on.fire("session_shutdown");
		expect(on.widgets.at(-1)).toMatchObject({ key: BOARD_WIDGET_KEY, content: undefined });

		for (const [env, mode, hasUI] of [
			[{}, "tui", true],
			[{ PI_TUI_MODE: "1" }, "rpc", true],
			[{ PI_TUI_MODE: "1" }, "print", false],
		] as const) {
			const off = await mount(env, mode, hasUI);
			expect(off.widgets).toEqual([]);
			// The footer status is unchanged in every mode that has a UI.
			if (hasUI) expect(off.statuses.at(-1)).toMatch(/^threads /);
			await off.fire("session_shutdown");
		}
	});

	it("sets no board widget when this overseer has no threads", async () => {
		const m = await mount({ PI_TUI_MODE: "1" });
		expect(m.widgets).toEqual([]);
		await m.fire("session_shutdown");
	});

	it("sets the thread banner in a thread's TUI, from the environment alone", async () => {
		const thread = { PHI_OVERSEER_SESSION_ID: OVERSEER, PHI_OVERSEER_NAME: "boss", PHI_OVERSEER_THREAD: "api" };
		const on = await mount({ ...thread, PI_TUI_MODE: "1" });
		const call = on.widgets.find((entry) => entry.key === THREAD_WIDGET_KEY);
		expect(call?.options).toEqual({ placement: "belowEditor" });
		const component = (call?.content as Factory)({ requestRender: () => {} }, theme);
		expect(stripAnsi(component.render(80)[0])).toBe("◇ overseen by boss (0190aaaa) · thread api");
		await on.fire("session_shutdown");

		const off = await mount(thread);
		expect(off.widgets).toEqual([]);
		await off.fire("session_shutdown");
		const rpc = await mount({ ...thread, PI_TUI_MODE: "1" }, "rpc");
		expect(rpc.widgets).toEqual([]);
		await rpc.fire("session_shutdown");
	});
});
