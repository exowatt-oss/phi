/**
 * Pure, width-aware rendering for the overseer's live terminal widgets:
 *
 * - the threads board an overseer pins above its editor (one header, then one or two lines per
 *   unclosed thread; compact rows and a "+K more" line when there are many);
 * - the one-line banner a thread shows below its editor (who oversees it, as which thread, under
 *   which subagent model policy, and when the last `[overseer …]` message arrived).
 *
 * Everything here takes a width and returns lines that never exceed it: lower-priority fields are
 * dropped first, then long values are shortened, then the line is cut with an ellipsis. Colors come
 * from the theme only, in the subagent dashboard's idiom (accent = live, muted/dim = secondary,
 * success/warning/error = health).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import type { SessionSummary } from "../../remote/protocol.ts";
import { spinnerFrame } from "../subagents/format.ts";
import { formatAge, formatCost, type Health, oneLine, shortIds, threadHealth, toolActivityText } from "./format.ts";
import { modelLabel } from "./model.ts";
import type { ThreadRecord } from "./types.ts";

/** Up to this many threads get two lines each (stats, then current tool / error / reply). */
export const FULL_ROWS_MAX = 3;
/** Beyond FULL_ROWS_MAX, at most this many one-line rows, then "+K more". */
export const COMPACT_ROWS_MAX = 6;
/** Below this width the status and health columns merge into one. */
export const NARROW_WIDTH = 72;
const NAME_MAX = 20;
const NAME_MAX_NARROW = 14;
const STATUS_WIDTH = 7; // "working"
const HEALTH_WIDTH = 8; // "starting"
const NOTE_MIN = 12;
/** Below this much room for a longer note, line two drops `backend · id · age` for the note. */
const NOTE_SHARE_MIN = 32;

export type ThreadStatusView = "working" | "idle" | "offline";

export interface ThreadNote {
	kind: "tool" | "error" | "reply" | "info";
	text: string;
}

/** One thread as the board shows it: everything resolved from the record and its live summary. */
export interface ThreadView {
	name: string;
	/** Short session id (one length per board). */
	id: string;
	/** Backend, `*` appended for an adopted thread. */
	backend: string;
	status: ThreadStatusView;
	health: Health;
	/** `provider/id[:thinking]`. */
	model?: string;
	costUsd?: number;
	contextPercent?: number;
	createdAt: number;
	lastActivityAt?: number;
	subagentsRunning?: number;
	note?: ThreadNote;
}

function noteOf(summary: SessionSummary | undefined, record: ThreadRecord, health: Health): ThreadNote | undefined {
	if (summary?.status === "working" && summary.activity)
		return { kind: "tool", text: toolActivityText(summary.activity, 200) };
	const error = summary?.lastError ?? (record.state !== "running" ? record.lastError : undefined);
	if (error) return { kind: "error", text: oneLine(error, 200) };
	if (health === "starting") return { kind: "info", text: "waiting for the session to register with the hub" };
	if (health === "exited") return { kind: "info", text: "process gone · resume or close it" };
	if (health === "missing") return { kind: "info", text: "not listed by the hub" };
	const text = summary?.lastText ?? record.lastText;
	if (text) return { kind: "reply", text: oneLine(text, 200) };
	if (summary?.status === "working") return { kind: "info", text: "thinking" };
	return undefined;
}

/** Board views of the unclosed threads, in registry order. */
export function buildThreadViews(
	records: readonly ThreadRecord[],
	live: ReadonlyMap<string, SessionSummary>,
	now: number,
): ThreadView[] {
	const ids = shortIds(records.map((record) => record.sessionId));
	return records.map((record) => {
		const summary = live.get(record.sessionId);
		const model = summary?.model ? `${summary.model.provider}/${summary.model.id}` : record.model;
		const thinking = summary?.thinkingLevel ?? record.thinking;
		const health = threadHealth(record, summary, now);
		return {
			name: record.name,
			id: ids.get(record.sessionId) ?? record.sessionId.slice(0, 8),
			backend: record.adopted ? `${record.backend}*` : record.backend,
			status: summary ? summary.status : "offline",
			health,
			model: model ? modelLabel(model, thinking) : undefined,
			costUsd: summary?.usage?.costUsd ?? record.costUsd,
			contextPercent: summary?.usage?.contextPercent ?? record.contextPercent,
			createdAt: record.createdAt,
			lastActivityAt: summary?.lastActivityAt ?? record.lastActivityAt,
			subagentsRunning: summary?.subagents?.running ? summary.subagents.running : undefined,
			note: noteOf(summary, record, health),
		};
	});
}

// ---------------------------------------------------------------------------------------------
// Width fitting
// ---------------------------------------------------------------------------------------------

/** A styled field of a line. `keep`: higher survives longer; Infinity is never dropped. */
interface Part {
	text: string;
	color: ThemeColor;
	keep: number;
	/** Shorter form tried once every droppable part is gone and the line still overflows. */
	short?: string;
}

function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function cut(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "…");
}

/** Parts kept at least this much are shortened (model without provider) before any is dropped. */
const SHORTEN_BEFORE_KEEP = 4;

/**
 * `head` + parts joined by " · " (and `lead` between the head and the first part, when any part
 * is left), fitted to `width`: the least-kept parts go first; before a part kept at least
 * SHORTEN_BEFORE_KEEP would go, long values switch to their short forms. `fits` is false when even
 * that is wider than `width` (the caller may cut it or try a shorter head).
 */
function fitInfo(head: string, parts: Part[], width: number, theme: Theme, lead = ""): { line: string; fits: boolean } {
	const active = [...parts];
	const sep = theme.fg("dim", " · ");
	const render = (list: Part[], useShort = false) =>
		head +
		(list.length > 0 ? lead : "") +
		list.map((part) => theme.fg(part.color, useShort && part.short !== undefined ? part.short : part.text)).join(sep);
	let short = false;
	const canShorten = () => !short && active.some((part) => part.short !== undefined);
	let line = render(active);
	while (visibleWidth(line) > width) {
		let drop = -1;
		for (let index = 0; index < active.length; index++) {
			if (!Number.isFinite(active[index].keep)) continue;
			if (drop < 0 || active[index].keep < active[drop].keep) drop = index;
		}
		if (canShorten() && (drop < 0 || active[drop].keep >= SHORTEN_BEFORE_KEEP)) {
			short = true;
		} else if (drop >= 0) {
			active.splice(drop, 1);
		} else {
			break;
		}
		line = render(active, short);
	}
	return { line, fits: visibleWidth(line) <= width };
}

function fitParts(head: string, parts: Part[], width: number, theme: Theme, lead = ""): string {
	return cut(fitInfo(head, parts, width, theme, lead).line, width);
}

// ---------------------------------------------------------------------------------------------
// Overseer board
// ---------------------------------------------------------------------------------------------

const HEALTH_COLOR: Record<Health, ThemeColor> = {
	ok: "success",
	starting: "dim",
	stalled: "warning",
	error: "error",
	exited: "error",
	missing: "warning",
	closed: "dim",
};

const STATUS_COLOR: Record<ThreadStatusView, ThemeColor> = { working: "accent", idle: "muted", offline: "dim" };

/** Health first (anything not ok), then status: the glyph that leads a row. */
export function threadGlyph(view: ThreadView, now: number): { glyph: string; color: ThemeColor } {
	switch (view.health) {
		case "error":
			return { glyph: "✗", color: "error" };
		case "exited":
			return { glyph: "⊘", color: "error" };
		case "missing":
			return { glyph: "?", color: "warning" };
		case "starting":
			return { glyph: "◌", color: "dim" };
		case "stalled":
			return { glyph: "!", color: "warning" };
		case "closed":
			return { glyph: "·", color: "dim" };
		default:
			return view.status === "working"
				? { glyph: spinnerFrame(now), color: "accent" }
				: { glyph: "○", color: "muted" };
	}
}

/** Problems first, then working, starting, idle: which rows to keep when not all fit. */
function rowPriority(view: ThreadView): number {
	switch (view.health) {
		case "error":
			return 0;
		case "stalled":
			return 1;
		case "exited":
			return 2;
		case "missing":
			return 3;
		case "starting":
			return 5;
		default:
			return view.status === "working" ? 4 : 6;
	}
}

function modelShort(model: string): string {
	const slash = model.indexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}

/** The one word of the merged status/health column (narrow and compact rows). */
function stateWord(view: ThreadView): { text: string; color: ThemeColor } {
	if (view.health !== "ok") return { text: view.health, color: HEALTH_COLOR[view.health] };
	return { text: view.status, color: STATUS_COLOR[view.status] };
}

interface RowLayout {
	nameWidth: number;
	narrow: boolean;
}

function rowHead(view: ThreadView, theme: Theme, now: number, layout: RowLayout): string {
	const { glyph, color } = threadGlyph(view, now);
	const name = padVisible(theme.fg("text", theme.bold(cut(view.name, layout.nameWidth))), layout.nameWidth);
	let head = `  ${theme.fg(color, glyph)} ${name}  `;
	if (layout.narrow) {
		const word = stateWord(view);
		head += `${padVisible(theme.fg(word.color, word.text), HEALTH_WIDTH)}  `;
	} else {
		const status = view.status === "offline" ? "-" : view.status;
		head += `${padVisible(theme.fg(STATUS_COLOR[view.status], status), STATUS_WIDTH)}  `;
		head += `${padVisible(theme.fg(HEALTH_COLOR[view.health], view.health), HEALTH_WIDTH)}  `;
	}
	return head;
}

function statParts(view: ThreadView, now: number, compact: boolean): Part[] {
	const parts: Part[] = [];
	if (view.model) parts.push({ text: view.model, color: "muted", keep: 6, short: modelShort(view.model) });
	if (view.contextPercent !== undefined)
		parts.push({ text: `ctx ${Math.round(view.contextPercent)}%`, color: "muted", keep: 4 });
	if (view.costUsd !== undefined) parts.push({ text: formatCost(view.costUsd), color: "muted", keep: 3 });
	if (view.subagentsRunning && !compact)
		parts.push({
			text: `${view.subagentsRunning} subagent${view.subagentsRunning === 1 ? "" : "s"}`,
			color: "muted",
			keep: 1,
		});
	if (view.lastActivityAt !== undefined)
		parts.push({ text: `quiet ${formatAge(now - view.lastActivityAt)}`, color: "dim", keep: 5 });
	return parts;
}

function noteText(note: ThreadNote, theme: Theme, width: number): string {
	switch (note.kind) {
		case "tool":
			return theme.fg("toolOutput", cut(`⚒ ${note.text}`, width));
		case "error":
			return theme.fg("error", cut(`error: ${note.text}`, width));
		case "reply":
			return `${theme.fg("muted", "last ")}${theme.fg("dim", cut(note.text, Math.max(1, width - 5)))}`;
		default:
			return theme.fg("dim", cut(note.text, width));
	}
}

/** Two lines: stats, then the note with `backend · id · age` right-aligned. */
function fullRow(view: ThreadView, theme: Theme, width: number, now: number, layout: RowLayout): string[] {
	const first = fitParts(rowHead(view, theme, now, layout), statParts(view, now, false), width, theme).replace(
		/ +$/,
		"",
	);
	const indent = "    ";
	const meta = theme.fg("dim", `${view.backend} · ${view.id} · age ${formatAge(now - view.createdAt)}`);
	const metaWidth = visibleWidth(meta);
	let available = width - indent.length;
	// The note wins over the meta when sharing the line would cut it short.
	const noteRoom = available - metaWidth - 2;
	const withMeta = view.note
		? noteRoom >= NOTE_MIN && noteRoom >= Math.min(visibleWidth(noteText(view.note, theme, 1_000)), NOTE_SHARE_MIN)
		: available >= metaWidth;
	if (withMeta) available -= metaWidth + 2;
	const note = view.note && available >= 1 ? noteText(view.note, theme, available) : "";
	let second = indent + note;
	if (withMeta) second = padVisible(second, width - metaWidth) + meta;
	return [first, cut(second, width)];
}

/** One line: stats, then the note in whatever room is left. */
function compactRow(view: ThreadView, theme: Theme, width: number, now: number, layout: RowLayout): string {
	const stats = fitParts(
		rowHead(view, theme, now, { ...layout, narrow: true }),
		statParts(view, now, true),
		width,
		theme,
	);
	const trimmed = stats.replace(/ +$/, "");
	const room = width - visibleWidth(trimmed) - 2;
	if (!view.note || room < NOTE_MIN) return trimmed;
	return `${trimmed}  ${noteText(view.note, theme, room)}`;
}

export interface BoardLineOptions {
	hubDown?: boolean;
	/** Override FULL_ROWS_MAX / COMPACT_ROWS_MAX (tests). */
	fullRowsMax?: number;
	compactRowsMax?: number;
}

function countWord(count: number, word: string): string {
	return `${count} ${word}`;
}

function boardHeader(views: readonly ThreadView[], theme: Theme, width: number, options: BoardLineOptions): string {
	const working = views.filter((view) => view.status === "working").length;
	const idle = views.filter((view) => view.status === "idle").length;
	const by = (health: Health) => views.filter((view) => view.health === health).length;
	const errors = by("error") + by("exited");
	const warnings = by("stalled") + by("missing");
	const marker =
		errors > 0
			? theme.fg("error", "◉")
			: warnings > 0 || options.hubDown
				? theme.fg("warning", "◉")
				: working > 0
					? theme.fg("accent", "◉")
					: theme.fg("success", "◉");
	const title = theme.fg("accent", theme.bold(`overseeing ${views.length} thread${views.length === 1 ? "" : "s"}`));
	const parts: Part[] = [];
	if (working > 0) parts.push({ text: countWord(working, "working"), color: "muted", keep: Infinity });
	if (idle > 0) parts.push({ text: countWord(idle, "idle"), color: "muted", keep: Infinity });
	if (by("starting") > 0) parts.push({ text: countWord(by("starting"), "starting"), color: "muted", keep: 5 });
	if (by("error") > 0) parts.push({ text: countWord(by("error"), "error"), color: "error", keep: 8 });
	if (by("stalled") > 0) parts.push({ text: countWord(by("stalled"), "stalled"), color: "warning", keep: 8 });
	if (by("exited") > 0) parts.push({ text: countWord(by("exited"), "exited"), color: "error", keep: 8 });
	if (by("missing") > 0) parts.push({ text: countWord(by("missing"), "missing"), color: "warning", keep: 7 });
	if (options.hubDown) parts.push({ text: "hub offline · last known", color: "warning", keep: 9 });
	const cost = views.reduce((sum, view) => sum + (view.costUsd ?? 0), 0);
	if (cost > 0) parts.push({ text: formatCost(cost), color: "dim", keep: 2 });
	parts.push({ text: "/threads", color: "dim", keep: 1 });
	return fitParts(`${marker} ${title}`, parts, width, theme, theme.fg("dim", " · "));
}

/**
 * The overseer's live board: a header, then the threads. Empty when there are no threads (the
 * widget is removed then). Every line fits `width`.
 */
export function buildOverseerBoardLines(
	views: readonly ThreadView[],
	theme: Theme,
	width: number,
	now: number,
	options: BoardLineOptions = {},
): string[] {
	if (views.length === 0) return [];
	const safeWidth = Math.max(1, Math.floor(width));
	const narrow = safeWidth < NARROW_WIDTH;
	const nameCap = narrow ? NAME_MAX_NARROW : NAME_MAX;
	const fullMax = options.fullRowsMax ?? FULL_ROWS_MAX;
	const compactMax = options.compactRowsMax ?? COMPACT_ROWS_MAX;

	const lines = [boardHeader(views, theme, safeWidth, options)];
	if (views.length <= fullMax) {
		const layout = {
			nameWidth: Math.max(1, ...views.map((view) => Math.min(visibleWidth(view.name), nameCap))),
			narrow,
		};
		for (const view of views) lines.push(...fullRow(view, theme, safeWidth, now, layout));
		return lines;
	}

	// Many threads: one line each; when even that is too many, keep the ones that need attention
	// (errors, stalls, working) and show them in registry order, then "+K more".
	const shown =
		views.length <= compactMax
			? [...views]
			: views
					.map((view, index) => ({ view, index }))
					.sort((a, b) => rowPriority(a.view) - rowPriority(b.view) || a.index - b.index)
					.slice(0, Math.max(0, compactMax - 1))
					.sort((a, b) => a.index - b.index)
					.map((entry) => entry.view);
	const layout = {
		nameWidth: Math.max(1, ...shown.map((view) => Math.min(visibleWidth(view.name), NAME_MAX_NARROW))),
		narrow: true,
	};
	for (const view of shown) lines.push(compactRow(view, theme, safeWidth, now, layout));
	const hidden = views.filter((view) => !shown.includes(view));
	if (hidden.length > 0) {
		const working = hidden.filter((view) => view.status === "working").length;
		const idle = hidden.filter((view) => view.status === "idle").length;
		const detail = [working > 0 ? `${working} working` : "", idle > 0 ? `${idle} idle` : ""].filter(Boolean);
		lines.push(
			cut(
				theme.fg(
					"muted",
					`  … +${hidden.length} more${detail.length ? ` (${detail.join(" · ")})` : ""} · /threads`,
				),
				safeWidth,
			),
		);
	}
	return lines;
}

// ---------------------------------------------------------------------------------------------
// Thread banner
// ---------------------------------------------------------------------------------------------

export interface ThreadBannerInfo {
	overseerSessionId: string;
	overseerName?: string;
	thread?: string;
	subagentDefault?: string;
	subagentAllow?: string;
	/** When the last `[overseer …]` message arrived (epoch ms). */
	lastMessageAt?: number;
}

function clockTime(ts: number): string {
	const date = new Date(ts);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** `◇ overseen by <name> (<id8>) · thread <thread> · subagents <default> · last message 14:32`. */
export function buildThreadBannerLine(info: ThreadBannerInfo, theme: Theme, width: number): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const overseer = oneLine(info.overseerName ?? "overseer", 60) || "overseer";
	const head = (withId: boolean) =>
		`${theme.fg("accent", "◇")} ${theme.fg("muted", "overseen by ")}${theme.fg("accent", theme.bold(overseer))}` +
		(withId ? theme.fg("dim", ` (${info.overseerSessionId.slice(0, 8)})`) : "");
	const parts: Part[] = [];
	const thread = oneLine(info.thread, 60);
	if (thread) parts.push({ text: `thread ${thread}`, color: "text", keep: Infinity });
	if (info.subagentDefault) {
		const model = oneLine(info.subagentDefault, 60);
		parts.push({ text: `subagents ${model}`, color: "dim", keep: 4, short: `subagents ${modelShort(model)}` });
	}
	if (info.subagentAllow) parts.push({ text: `allow ${oneLine(info.subagentAllow, 120)}`, color: "dim", keep: 1 });
	if (info.lastMessageAt !== undefined && Number.isFinite(info.lastMessageAt))
		parts.push({ text: `last message ${clockTime(info.lastMessageAt)}`, color: "dim", keep: 3 });
	const lead = theme.fg("dim", " · ");
	const withId = fitInfo(head(true), parts, safeWidth, theme, lead);
	return cut(withId.fits ? withId.line : fitInfo(head(false), parts, safeWidth, theme, lead).line, safeWidth);
}
