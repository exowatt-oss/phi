/**
 * The overseer's live terminal widgets, mounted only in phi's own terminal UI:
 *
 * - overseer side: the threads board above the editor (`OverseerBoardWidget`), fed by the monitor's
 *   15 s `sessions.list` poll (no extra hub traffic). While a thread works it re-renders every
 *   250 ms locally so the spinner and the quiet/age clocks move; otherwise once a second.
 * - thread side: a one-line banner below the editor (`ThreadBannerWidget`) built from the thread's
 *   environment alone, plus the time of the last `[overseer …]` message seen in this session.
 *
 * Gate: `PI_TUI_MODE=1` (or another truthy spelling) AND an interactive terminal context
 * (`ctx.mode === "tui"`, `ctx.hasUI`). RPC (FORCA's embedded chat, the phone, headless threads),
 * print and JSON modes, and terminals without `PI_TUI_MODE`, never get either widget; they keep the
 * footer status and `/threads` exactly as before.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, ExtensionUIContext } from "../../core/extensions/types.ts";
import { isTuiMode } from "../../core/tui-mode.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { SessionSummary } from "../../remote/protocol.ts";
import type { ThreadInfo } from "./thread.ts";
import { buildOverseerBoardLines, buildThreadBannerLine, buildThreadViews } from "./tui-board.ts";
import type { ThreadRecord } from "./types.ts";

export const BOARD_WIDGET_KEY = "overseer";
export const THREAD_WIDGET_KEY = "overseer-thread";
const TICK_WORKING_MS = 250;
const TICK_IDLE_MS = 1000;

/** Whether the overseer's TUI widgets may appear in this context. */
export function overseerTuiEnabled(env: NodeJS.ProcessEnv, ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean {
	return isTuiMode(env) && ctx.hasUI === true && ctx.mode === "tui";
}

type WidgetComponent = Component & { dispose?(): void };

/** What the board reads on every render. */
export interface BoardSource {
	records(): readonly ThreadRecord[];
	live(): ReadonlyMap<string, SessionSummary>;
	hubDown(): boolean;
	now(): number;
}

export class OverseerBoardWidget {
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	/** Identity of the mounted component (a stale component's dispose must not unmount a newer one). */
	private mount: object | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private tickMs = 0;
	private readonly source: BoardSource;
	private readonly env: NodeJS.ProcessEnv;

	constructor(source: BoardSource, env: NodeJS.ProcessEnv) {
		this.source = source;
		this.env = env;
	}

	get mounted(): boolean {
		return this.mount !== undefined;
	}

	/** Bind to a context: the board shows only in phi's own TUI (see the module comment). */
	attach(ctx: ExtensionContext): void {
		let enabled = false;
		try {
			enabled = overseerTuiEnabled(this.env, ctx);
		} catch {
			enabled = false;
		}
		if (!enabled) {
			this.dispose();
			return;
		}
		if (this.ui !== ctx.ui) {
			this.hide();
			this.ui = ctx.ui;
		}
		this.refresh();
	}

	/** Re-read the source: mount, re-render or hide. Called after every monitor poll and registry change. */
	refresh(): void {
		const ui = this.ui;
		if (!ui) return;
		const records = this.source.records();
		if (records.length === 0) {
			this.hide();
			return;
		}
		if (!this.mount) {
			const token = {};
			this.mount = token;
			try {
				ui.setWidget(BOARD_WIDGET_KEY, (tui: TUI, theme: Theme): WidgetComponent => {
					this.tui = tui;
					return {
						render: (width: number) => this.lines(theme, width),
						invalidate() {},
						dispose: () => {
							if (this.mount !== token) return;
							this.mount = undefined;
							this.tui = undefined;
							this.stopTicker();
						},
					};
				});
			} catch {
				this.mount = undefined;
				return;
			}
		} else {
			this.tui?.requestRender();
		}
		this.syncTicker(records);
	}

	/** The board's lines at `width` (the component's render). */
	lines(theme: Theme, width: number): string[] {
		const now = this.source.now();
		const views = buildThreadViews(this.source.records(), this.source.live(), now);
		return buildOverseerBoardLines(views, theme, width, now, { hubDown: this.source.hubDown() });
	}

	private syncTicker(records: readonly ThreadRecord[]): void {
		if (!this.mount) {
			this.stopTicker();
			return;
		}
		const live = this.source.live();
		const working = records.some((record) => live.get(record.sessionId)?.status === "working");
		const tickMs = working ? TICK_WORKING_MS : TICK_IDLE_MS;
		if (this.ticker && this.tickMs === tickMs) return;
		this.stopTicker();
		this.tickMs = tickMs;
		this.ticker = setInterval(() => this.tui?.requestRender(), tickMs);
		this.ticker.unref?.();
	}

	private stopTicker(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
		this.tickMs = 0;
	}

	private hide(): void {
		this.stopTicker();
		if (!this.mount) return;
		this.mount = undefined;
		this.tui = undefined;
		try {
			this.ui?.setWidget(BOARD_WIDGET_KEY, undefined);
		} catch {
			// stale UI context
		}
	}

	dispose(): void {
		this.hide();
		this.ui = undefined;
	}
}

/** Plain text of a user message (string or text blocks). */
function userText(message: AgentMessage): string | undefined {
	if (!message || (message as { role?: string }).role !== "user") return undefined;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const first = content.find(
		(block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
	);
	return first?.text;
}

/** A message the overseer sent with `send` (its first line is `[overseer <name> (<id>)]`). */
export function isOverseerMessage(message: AgentMessage): boolean {
	const text = userText(message);
	return text !== undefined && /^\s*\[overseer[\s\]]/.test(text);
}

function messageTime(message: AgentMessage, fallback: number): number {
	const ts = (message as { timestamp?: unknown }).timestamp;
	return typeof ts === "number" && Number.isFinite(ts) ? ts : fallback;
}

const HISTORY_SCAN_LIMIT = 400;

/** The thread's banner below the editor. Works from the environment alone (no hub, no overseer). */
export class ThreadBannerWidget {
	lastMessageAt: number | undefined;
	private tui: TUI | undefined;
	private mounted = false;
	private readonly info: ThreadInfo;
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => number;
	private readonly fallbackThread: () => string | undefined;

	constructor(info: ThreadInfo, env: NodeJS.ProcessEnv, now: () => number, fallbackThread: () => string | undefined) {
		this.info = info;
		this.env = env;
		this.now = now;
		this.fallbackThread = fallbackThread;
	}

	attach(ctx: ExtensionContext): void {
		let enabled = false;
		try {
			enabled = overseerTuiEnabled(this.env, ctx);
		} catch {
			enabled = false;
		}
		if (!enabled) return;
		this.lastMessageAt = this.scanHistory(ctx);
		try {
			ctx.ui.setWidget(
				THREAD_WIDGET_KEY,
				(tui: TUI, theme: Theme): WidgetComponent => {
					this.tui = tui;
					this.mounted = true;
					return {
						render: (width: number) => [this.line(theme, width)],
						invalidate() {},
						dispose: () => {
							if (this.tui === tui) this.tui = undefined;
							this.mounted = false;
						},
					};
				},
				{ placement: "belowEditor" },
			);
		} catch {
			// stale UI context
		}
	}

	/** message_start: note an `[overseer …]` message and re-render. */
	observe(message: AgentMessage): void {
		if (!isOverseerMessage(message)) return;
		this.lastMessageAt = messageTime(message, this.now());
		if (this.mounted) this.tui?.requestRender();
	}

	line(theme: Theme, width: number): string {
		return buildThreadBannerLine(
			{ ...this.info, thread: this.info.thread ?? this.fallbackThread(), lastMessageAt: this.lastMessageAt },
			theme,
			width,
		);
	}

	/** The newest `[overseer …]` message on the current branch (bounded scan from the leaf). */
	private scanHistory(ctx: ExtensionContext): number | undefined {
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let index = branch.length - 1, seen = 0; index >= 0 && seen < HISTORY_SCAN_LIMIT; index--, seen++) {
				const entry = branch[index];
				if (entry.type === "message" && isOverseerMessage(entry.message)) {
					const parsed = Date.parse(entry.timestamp);
					return messageTime(entry.message, Number.isFinite(parsed) ? parsed : this.now());
				}
			}
		} catch {
			// no history available
		}
		return undefined;
	}
}
