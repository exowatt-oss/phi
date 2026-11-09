/**
 * Plain-text formatting for the overseer: the thread board (`list`, `/threads`, heartbeat), the
 * transcript tail (`read`), and the batched `overseer_event` message. Model-facing, so aligned
 * plain text without colors; the TUI renderers color it separately.
 */

import { basename } from "node:path";
import type { SessionSummary, TranscriptItem } from "../../remote/protocol.ts";
import { modelLabel } from "./model.ts";
import type { OverseerEvent, ThreadRecord } from "./types.ts";

export const IDLE_REPLY_LIMIT = 1500;
const READ_TOTAL_LIMIT = 16_000;

/** One line, control characters removed, at most `max` chars. */
export function oneLine(text: string | undefined, max = 120): string {
	if (!text) return "";
	const line = text
		.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line;
}

/** Text truncated to `max` chars with a note of the full length. */
export function clip(text: string, max: number, hint = ""): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [${text.length} chars${hint ? `; ${hint}` : ""}]`;
}

/** Compact age: 12s, 4m, 3h05m, 2d. */
export function formatAge(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "-";
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d`;
}

export function formatCost(cost: number | undefined): string {
	if (cost === undefined || !Number.isFinite(cost)) return "-";
	return cost >= 10 ? `$${cost.toFixed(1)}` : `$${cost.toFixed(2)}`;
}

/**
 * One prefix length for every id of a board: the shortest length (at least 8) at which all the
 * prefixes differ. UUIDv7 ids created within a minute share their first 8 characters, so a fixed
 * 8-char id would be ambiguous; per-id minimal prefixes of different lengths read like misprints.
 */
export function shortIds(ids: readonly string[]): Map<string, string> {
	const unique = [...new Set(ids)];
	const longest = Math.max(0, ...unique.map((id) => id.length));
	let length = Math.min(8, longest);
	while (length < longest && new Set(unique.map((id) => id.slice(0, length))).size < unique.length) length++;
	return new Map(unique.map((id) => [id, id.slice(0, length)]));
}

/** Aligned plain-text table; the last column is not padded. */
export function table(header: string[], rows: string[][]): string[] {
	const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)));
	const render = (row: string[]) =>
		row
			.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column])))
			.join("  ")
			.trimEnd();
	return [render(header), ...rows.map(render)];
}

export type Health = "ok" | "starting" | "stalled" | "error" | "exited" | "closed" | "missing";

/** Health of a thread given its live summary (undefined when the hub does not list it). */
export function threadHealth(record: ThreadRecord, live: SessionSummary | undefined, now: number): Health {
	if (record.state === "closed") return "closed";
	if (record.state === "exited") return "exited";
	if (!live) return record.registered ? "missing" : "starting";
	if (live.lastError) return "error";
	if (
		live.status === "working" &&
		record.watch.stallMinutes > 0 &&
		now - live.lastActivityAt >= record.watch.stallMinutes * 60_000
	)
		return "stalled";
	return "ok";
}

/**
 * The running tool as one line. The session's activity summary already starts with the tool's name
 * (`bash  npm test`), so the name is added only when it does not.
 */
export function toolActivityText(activity: { tool: string; summary?: string }, max: number): string {
	const summary = activity.summary?.trim();
	if (!summary) return oneLine(activity.tool, max);
	return oneLine(summary.startsWith(activity.tool) ? summary : `${activity.tool}  ${summary}`, max);
}

function activityLine(summary: SessionSummary | undefined, record: ThreadRecord): string {
	if (summary?.status === "working" && summary.activity) {
		return `⚒ ${toolActivityText(summary.activity, 100)}`;
	}
	const error = summary?.lastError ?? (record.state !== "running" ? record.lastError : undefined);
	if (error) return `error: ${oneLine(error, 140)}`;
	const text = summary?.lastText ?? record.lastText;
	return text ? `last: ${oneLine(text, 140)}` : "";
}

/** The board of this overseer's threads (`list`, `/threads`, heartbeat). */
export function formatBoard(
	records: readonly ThreadRecord[],
	live: ReadonlyMap<string, SessionSummary>,
	now: number,
	options: { title?: string; hubDown?: boolean } = {},
): string {
	if (records.length === 0) return 'No threads. Start one with overseer {action:"spawn", name, prompt, model}.';
	const ids = shortIds(records.map((record) => record.sessionId));
	const rows: string[][] = [];
	const notes: string[] = [];
	for (const record of records) {
		const summary = live.get(record.sessionId);
		const model = summary?.model ? `${summary.model.provider}/${summary.model.id}` : record.model;
		const thinking = summary?.thinkingLevel ?? record.thinking;
		const lastActivity = summary?.lastActivityAt ?? record.lastActivityAt;
		rows.push([
			oneLine(record.name, 24),
			ids.get(record.sessionId) ?? record.sessionId.slice(0, 8),
			record.adopted ? `${record.backend}*` : record.backend,
			summary ? summary.status : record.state === "running" ? "-" : record.state,
			threadHealth(record, summary, now),
			modelLabel(model, thinking),
			formatCost(summary?.usage?.costUsd ?? record.costUsd),
			summary?.usage?.contextPercent !== undefined ? `${Math.round(summary.usage.contextPercent)}%` : "-",
			formatAge(now - record.createdAt),
			formatAge(lastActivity !== undefined ? now - lastActivity : undefined),
		]);
		notes.push(activityLine(summary, record));
	}
	const lines = table(["NAME", "ID", "BACKEND", "STATUS", "HEALTH", "MODEL", "COST", "CTX", "AGE", "QUIET"], rows);
	const out: string[] = [];
	if (options.title) out.push(options.title);
	if (options.hubDown) out.push("(phi remote hub unreachable: live status unknown)");
	out.push(lines[0]);
	for (let index = 0; index < rows.length; index++) {
		out.push(lines[index + 1]);
		if (notes[index]) out.push(`  ${notes[index]}`);
	}
	if (records.some((record) => record.adopted)) out.push("* adopted (watched, not started by this overseer)");
	return out.join("\n");
}

/** Every session the hub lists (`list` with `all`). */
export function formatAllSessions(
	sessions: readonly SessionSummary[],
	ownSessionId: string,
	tracked: ReadonlyMap<string, string>,
	now: number,
): string {
	if (sessions.length === 0) return "The hub lists no sessions.";
	const ids = shortIds(sessions.map((session) => session.sessionId));
	const rows = sessions.map((session) => {
		const owner =
			session.sessionId === ownSessionId
				? "(this overseer)"
				: tracked.has(session.sessionId)
					? `thread ${tracked.get(session.sessionId)}`
					: session.overseer
						? `thread of ${oneLine(session.overseer.name ?? session.overseer.sessionId.slice(0, 8), 24)}`
						: "-";
		return [
			oneLine(session.name, 28),
			ids.get(session.sessionId) ?? session.sessionId,
			session.kind,
			session.status,
			session.model ? modelLabel(`${session.model.provider}/${session.model.id}`, session.thinkingLevel) : "-",
			formatAge(now - session.lastActivityAt),
			oneLine(basename(session.cwd) || session.cwd, 24),
			owner,
		];
	});
	return table(["NAME", "ID", "KIND", "STATUS", "MODEL", "QUIET", "CWD", "OWNER"], rows).join("\n");
}

function clock(ts: number): string {
	const date = new Date(ts);
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** One transcript item as compact text. */
export function formatItem(item: TranscriptItem): string {
	const at = Number.isFinite(item.ts) ? `[${clock(item.ts)}] ` : "";
	switch (item.kind) {
		case "user":
			return `${at}user: ${clip(item.text, 800)}${item.images ? ` (+${item.images} image${item.images === 1 ? "" : "s"})` : ""}`;
		case "assistant": {
			const error = item.error ? ` [error: ${oneLine(item.error, 200)}]` : "";
			const streaming = item.streaming ? " (streaming)" : "";
			return `${at}assistant${streaming}: ${clip(item.text, IDLE_REPLY_LIMIT) || "(no text)"}${error}`;
		}
		case "tool": {
			const output = item.output ? ` · ${oneLine(item.output, 240)}` : "";
			return `${at}tool ${oneLine(item.summary || item.name, 160)} → ${item.status}${output}`;
		}
		case "note":
			return `${at}note${item.label ? ` (${item.label})` : ""}: ${clip(item.text, 300)}`;
		default:
			return `${at}${JSON.stringify(item).slice(0, 200)}`;
	}
}

/** Transcript tail for `read`, newest last, capped at ~16k chars (oldest items dropped first). */
export function formatTranscript(header: string, items: readonly TranscriptItem[], hasMore: boolean): string {
	const lines = items.map(formatItem);
	let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
	let dropped = 0;
	while (lines.length > 1 && total > READ_TOTAL_LIMIT) {
		total -= (lines.shift() as string).length + 1;
		dropped++;
	}
	const more =
		hasMore || dropped > 0
			? `\n(${dropped > 0 ? `${dropped} older items dropped for size; ` : ""}older items exist)`
			: "";
	return `${header}${more}\n${lines.length ? lines.join("\n") : "(no transcript items)"}`;
}

/** Last finished assistant text in a transcript tail. */
export function lastAssistantText(items: readonly TranscriptItem[]): string | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "assistant" && !item.streaming && item.text.trim()) return item.text.trim();
	}
	return undefined;
}

/** Model id stored on the last finished assistant message of a transcript tail. */
export function lastAssistantModel(items: readonly TranscriptItem[]): string | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "assistant" && !item.streaming) return item.model || undefined;
	}
	return undefined;
}

const KIND_ORDER: Record<OverseerEvent["kind"], number> = { error: 0, stalled: 1, exited: 2, idle: 3, heartbeat: 4 };

/** Content of one batched `overseer_event` message. */
export function formatEvents(events: readonly OverseerEvent[]): string {
	const updates = events.filter((event) => event.kind !== "heartbeat");
	const heartbeat = events.filter((event) => event.kind === "heartbeat").at(-1);
	const sorted = [...updates].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.at - b.at);
	const lines: string[] = [];
	if (sorted.length > 0) lines.push(`[overseer] ${sorted.length} thread update${sorted.length === 1 ? "" : "s"}`);
	else lines.push(`[overseer] heartbeat${heartbeat?.summary ? ` · ${heartbeat.summary}` : ""}`);
	for (const event of sorted) {
		lines.push(`── ${event.thread} · ${event.kind}${event.summary ? ` · ${event.summary}` : ""}`);
		if (event.text) lines.push(event.text);
	}
	if (heartbeat) {
		if (sorted.length > 0) lines.push(`── heartbeat${heartbeat.summary ? ` · ${heartbeat.summary}` : ""}`);
		if (heartbeat.text) lines.push(heartbeat.text);
	}
	lines.push(
		'Reply with overseer {action:"send", target:"<thread>", message}; inspect with overseer {action:"read", target:"<thread>"}. These are thread reports, not user messages.',
	);
	return lines.join("\n");
}
