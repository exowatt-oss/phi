/**
 * phi remote session history, hub side: the session index (`sessions.past`) and stored transcripts
 * (`session.transcript`) read straight from session files.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, JsonObject, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { storedTranscript } from "../src/extensions/remote/transcript.ts";
import {
	comparePast,
	decodeCursor,
	encodeCursor,
	NotASessionError,
	pageAfter,
	readStoredTranscript,
	SessionHistoryIndex,
	UnknownItemError,
} from "../src/remote/hub/history.ts";

let tmp: string;
let sessionsDir: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phi-history-"));
	sessionsDir = join(tmp, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

let clock = Date.parse("2026-11-01T10:00:00.000Z");
const tick = (): number => {
	clock += 1000;
	return clock;
};

function user(text: string, images = 0): UserMessage {
	const content: UserMessage["content"] = [{ type: "text", text }];
	for (let i = 0; i < images; i++) content.push({ type: "image", data: "A".repeat(6000), mimeType: "image/png" });
	return { role: "user", content, timestamp: tick() };
}

function assistant(
	text: string,
	calls: { id: string; name: string; args: JsonObject }[] = [],
	model = "claude-test",
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...calls.map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: call.args })),
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: calls.length > 0 ? "toolUse" : "stop",
		timestamp: tick(),
	};
}

function result(toolCallId: string, text: string, isError = false, images = 0): ToolResultMessage {
	const content: ToolResultMessage["content"] = [{ type: "text", text }];
	for (let i = 0; i < images; i++) content.push({ type: "image", data: "B".repeat(9000), mimeType: "image/png" });
	return { role: "toolResult", toolCallId, toolName: "bash", content, isError, timestamp: tick() };
}

/** A realistic session on disk through the real session manager; returns it (file persisted). */
function realSession(cwd: string, dir = join(sessionsDir, "proj")): SessionManager {
	const sm = SessionManager.create(cwd, dir);
	sm.appendModelChange("anthropic", "claude-test");
	sm.appendMessage(user("Look at app.ts\nand tell me", 1));
	sm.appendMessage(
		assistant("Checking.", [
			{ id: "c1", name: "read", args: { path: "src/app.ts" } },
			{ id: "c2", name: "bash", args: { command: "ls -la" } },
		]),
	);
	sm.appendMessage(result("c1", "contents of app.ts"));
	sm.appendMessage(result("c2", "x".repeat(3 * 1024 * 1024), false, 2)); // a > 1 MB line with images
	const reply = sm.appendMessage(assistant("app.ts exists."));
	sm.appendCustomMessageEntry("note-type", "a displayed note", true);
	const bash = sm.appendMessage({
		role: "bashExecution",
		command: "git status",
		output: "clean\n",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: tick(),
	} as never);
	// An abandoned branch, then the branch the session continues on.
	sm.appendMessage(user("abandoned question"));
	sm.appendMessage(assistant("abandoned answer"));
	sm.branch(bash);
	sm.appendMessage(user("second question"));
	sm.appendMessage(assistant("", [{ id: "c3", name: "bash", args: { command: "false" } }]));
	sm.appendMessage(result("c3", "boom", true));
	sm.appendCompaction("summary of earlier work", reply, 1000);
	sm.appendMessage(user("third question"));
	sm.appendMessage(assistant("final answer", [], "claude-other"));
	sm.appendMessage(assistant("", [{ id: "c4", name: "bash", args: { command: "sleep 9" } }])); // no result yet
	return sm;
}

/** What the session manager would resume, rendered by the bridge's code. */
function expectedPage(path: string, options: { limit: number; before?: string }) {
	const walk = storedTranscript(SessionManager.open(path).getBranch(), options);
	return { items: walk.items, hasMore: walk.hasMore, found: walk.found };
}

function writeLines(path: string, lines: unknown[]): void {
	writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

describe("readStoredTranscript", () => {
	it("renders exactly what the session manager's branch renders, page by page", async () => {
		const sm = realSession(join(tmp, "work"));
		const path = sm.getSessionFile() as string;
		const full = expectedPage(path, { limit: 500 });
		expect(full.items.map((item) => item.kind)).toEqual([
			"user",
			"assistant",
			"tool",
			"tool",
			"assistant",
			"note",
			"note",
			"user",
			"assistant",
			"tool",
			"note",
			"user",
			"assistant",
			"assistant",
			"tool",
		]);
		expect(full.items.some((item) => item.kind === "user" && item.text.includes("abandoned"))).toBe(false);
		expect(full.items[0]).toMatchObject({ kind: "user", images: 1 });
		expect(full.items.at(-1)).toMatchObject({ kind: "tool", status: "error" }); // no result: not running
		expect(full.items.find((item) => item.kind === "tool" && item.toolCallId === "c2")).toMatchObject({
			outputTruncated: true,
			output: expect.stringContaining("[2 images]"),
		});

		expect(await readStoredTranscript(path, { limit: 500 })).toEqual({ items: full.items, hasMore: false });
		// Small pages, walked back to the start: identical to the session manager's pages.
		let before: string | undefined;
		const seen: string[] = [];
		for (let guard = 0; guard < 20; guard++) {
			const page = await readStoredTranscript(path, { limit: 2, before });
			const expected = expectedPage(path, { limit: 2, before });
			expect(page).toEqual({ items: expected.items, hasMore: expected.hasMore });
			seen.unshift(...page.items.map((item) => item.id));
			if (!page.hasMore) break;
			before = page.items[0].id;
		}
		expect(seen).toEqual(full.items.map((item) => item.id));
		await expect(readStoredTranscript(path, { limit: 5, before: "u:1" })).rejects.toBeInstanceOf(UnknownItemError);
	});

	it("reads a file without its final newline, and refuses files that are not sessions", async () => {
		const sm = realSession(join(tmp, "work"));
		const path = sm.getSessionFile() as string;
		const expected = expectedPage(path, { limit: 50 });
		const text = (await import("node:fs")).readFileSync(path, "utf8");
		const cut = join(sessionsDir, "cut.jsonl");
		writeFileSync(cut, text.replace(/\n$/, ""));
		expect(await readStoredTranscript(cut, { limit: 50 })).toEqual({ items: expected.items, hasMore: false });
		// A half-written last line is not an entry yet.
		writeFileSync(cut, `${text}{"type":"message","id":"zz","parentId":null,"timestamp":"2026`);
		expect(await readStoredTranscript(cut, { limit: 50 })).toEqual({ items: expected.items, hasMore: false });

		const notSession = join(sessionsDir, "x.jsonl");
		writeLines(notSession, [{ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:00Z" }]);
		await expect(readStoredTranscript(notSession, { limit: 10 })).rejects.toBeInstanceOf(NotASessionError);
	});

	it("migrates old (v2) files in memory, never on disk", async () => {
		const path = join(sessionsDir, "old.jsonl");
		const lines = [
			{ type: "session", version: 2, id: "old-session", timestamp: "2025-01-01T00:00:00.000Z", cwd: tmp },
			{ type: "message", id: "e1", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: user("hi") },
			{
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: "2025-01-01T00:00:02.000Z",
				message: { role: "hookMessage", customType: "x", content: "hook", display: true, timestamp: 5 },
			},
		];
		writeLines(path, lines);
		const before = (await import("node:fs")).readFileSync(path, "utf8");
		const page = await readStoredTranscript(path, { limit: 10 });
		expect(page.items.map((item) => item.kind)).toEqual(["user", "note"]);
		expect((await import("node:fs")).readFileSync(path, "utf8")).toBe(before);
	});
});

describe("SessionHistoryIndex", () => {
	function header(id: string, cwd: string, timestamp = "2026-11-01T09:00:00.000Z", extra: object = {}) {
		return { type: "session", version: 3, id, timestamp, cwd, ...extra };
	}
	function msg(id: string, parentId: string | null, message: unknown, at: string) {
		return { type: "message", id, parentId, timestamp: at, message };
	}

	it("lists sessions with their listing fields, excluding empty, subagent and non-session files", async () => {
		const dir = join(sessionsDir, "--work--");
		mkdirSync(dir);
		const cwd = join(tmp, "work");
		writeLines(join(dir, "a.jsonl"), [
			header("sess-a", cwd),
			msg(
				"1",
				null,
				user('<skill name="x" location="/s">\nbody\n</skill>\n\nFix the build'),
				"2026-11-01T09:00:01.000Z",
			),
			msg("2", "1", assistant("Fixed it.\nAll green."), "2026-11-01T09:00:02.000Z"),
			{ type: "custom", id: "3", parentId: "2", timestamp: "2026-11-01T09:30:00.000Z", customType: "c", data: {} },
		]);
		writeLines(join(dir, "b.jsonl"), [
			header("sess-b", cwd, "2026-11-01T08:00:00.000Z"),
			{ type: "session_info", id: "0", parentId: null, timestamp: "2026-11-01T08:00:00.000Z", name: "Named one" },
			msg("1", "0", user("hello"), "2026-11-01T08:00:01.000Z"),
			{
				type: "model_change",
				id: "2",
				parentId: "1",
				timestamp: "2026-11-01T08:00:02.000Z",
				provider: "p",
				modelId: "m",
			},
		]);
		writeLines(join(dir, "empty.jsonl"), [header("sess-empty", cwd)]);
		writeLines(join(dir, "tools-only.jsonl"), [
			header("sess-tools", cwd),
			msg("1", null, result("c", "x"), "2026-11-01T09:00:00Z"),
		]);
		writeLines(join(dir, "sub.jsonl"), [
			header("sess-sub", cwd, undefined, { subagent: { runId: "r1" } }),
			msg("1", null, user("child task"), "2026-11-01T09:00:00Z"),
		]);
		writeFileSync(join(dir, "junk.jsonl"), 'not json\n{"type":"message"}\n');
		writeFileSync(join(dir, "notes.txt"), "ignored");
		writeLines(join(sessionsDir, "flat.jsonl"), [
			header("sess-flat", "", "2026-10-01T00:00:00.000Z"),
			msg("1", null, user(""), "2026-10-01T00:00:00Z"),
		]);

		const index = new SessionHistoryIndex({ sessionsDir });
		expect(index.indexing).toBe(true);
		await index.refresh();
		expect(index.indexing).toBe(false);
		const list = index.list();
		expect(list.map((s) => s.sessionId)).toEqual(["sess-a", "sess-b", "sess-flat"]);
		expect(list[0]).toMatchObject({
			title: "/skill:x Fix the build",
			named: false,
			cwd,
			createdAt: Date.parse("2026-11-01T09:00:00.000Z"),
			modifiedAt: Date.parse("2026-11-01T09:30:00.000Z"), // last entry, not last message
			messageCount: 2,
			preview: "Fixed it. All green.",
			model: { provider: "anthropic", id: "claude-test" },
		});
		expect(list[1]).toMatchObject({
			title: "Named one",
			named: true,
			messageCount: 1,
			model: { provider: "p", id: "m" },
		});
		expect(list[1].preview).toBeUndefined();
		expect(list[2]).toMatchObject({ title: "sess-fla", cwd: "", messageCount: 1 });
		expect(index.stats()).toMatchObject({ files: 7, sessions: 3, indexing: false });
	});

	it("searches title, cwd and message text case-insensitively, filters by exact cwd", async () => {
		const dir = join(sessionsDir, "p");
		mkdirSync(dir);
		writeLines(join(dir, "1.jsonl"), [
			header("one", "/Users/me/Alpha"),
			msg("1", null, user("Deploy the Widget"), "2026-11-01T09:00:01Z"),
			msg("2", "1", assistant("The QUOKKA is deployed"), "2026-11-01T09:00:02Z"),
		]);
		writeLines(join(dir, "2.jsonl"), [
			header("two", "/Users/me/beta"),
			{ type: "session_info", id: "0", parentId: null, timestamp: "2026-11-01T08:00:00Z", name: "Release Train" },
			msg("1", "0", user("nothing to see"), "2026-11-01T08:00:01Z"),
		]);
		const index = new SessionHistoryIndex({ sessionsDir });
		await index.refresh();
		const ids = (query?: string, cwd?: string) => index.list({ query, cwd }).map((s) => s.sessionId);
		expect(ids("quokka")).toEqual(["one"]);
		expect(ids("widget")).toEqual(["one"]);
		expect(ids("RELEASE train")).toEqual(["two"]);
		expect(ids("alpha")).toEqual(["one"]);
		expect(ids("/users/me")).toEqual(["one", "two"]);
		expect(ids("  ")).toEqual(["one", "two"]);
		expect(ids("nope")).toEqual([]);
		expect(ids(undefined, "/Users/me/beta")).toEqual(["two"]);
		expect(ids(undefined, "/Users/me")).toEqual([]);
	});

	it("refreshes incrementally: appended lines, half-written lines, new, rewritten and deleted files", async () => {
		const dir = join(sessionsDir, "p");
		mkdirSync(dir);
		const path = join(dir, "1.jsonl");
		writeLines(path, [header("one", "/w"), msg("1", null, user("first"), "2026-11-01T09:00:01Z")]);
		const index = new SessionHistoryIndex({ sessionsDir });
		await index.refresh();
		expect(index.list()[0]).toMatchObject({ messageCount: 1, title: "first" });

		// The writer is mid-line: not counted yet, and not lost once the line completes.
		const line = JSON.stringify(msg("2", "1", assistant("second reply"), "2026-11-01T09:00:02Z"));
		appendFileSync(path, line.slice(0, 40));
		await index.refresh();
		expect(index.list()[0]).toMatchObject({ messageCount: 1 });
		appendFileSync(path, `${line.slice(40)}\n`);
		await index.refresh();
		expect(index.list()[0]).toMatchObject({ messageCount: 2, preview: "second reply" });

		// Complete JSON without its newline yet: counted once, also after the newline arrives.
		const third = JSON.stringify(msg("3", "2", user("third"), "2026-11-01T09:00:03Z"));
		appendFileSync(path, third);
		await index.refresh();
		expect(index.list()[0]).toMatchObject({ messageCount: 3 });
		appendFileSync(path, "\n");
		await index.refresh();
		expect(index.list()[0]).toMatchObject({ messageCount: 3 });
		expect(index.list({ query: "third" })).toHaveLength(1);

		writeLines(join(dir, "2.jsonl"), [header("two", "/w"), msg("1", null, user("new one"), "2026-11-01T10:00:00Z")]);
		await index.refresh();
		expect(index.list().map((s) => s.sessionId)).toEqual(["two", "one"]);

		// Shrunk (rewritten): read again from the start.
		truncateSync(path, 0);
		writeLines(path, [header("one", "/w"), msg("1", null, user("rewritten"), "2026-11-01T09:00:01Z")]);
		await index.refresh();
		expect(index.list().find((s) => s.sessionId === "one")).toMatchObject({ messageCount: 1, title: "rewritten" });

		rmSync(join(dir, "2.jsonl"));
		await index.refresh();
		expect(index.list().map((s) => s.sessionId)).toEqual(["one"]);
		expect(await index.lookup("two")).toBeUndefined();
		expect((await index.lookup("one"))?.path).toBe(path);
	});

	it("keeps the most recently active file when two claim one session id", async () => {
		const dir = join(sessionsDir, "p");
		mkdirSync(dir);
		writeLines(join(dir, "old.jsonl"), [
			header("dup", "/w"),
			msg("1", null, user("old copy"), "2026-11-01T09:00:00Z"),
		]);
		writeLines(join(dir, "new.jsonl"), [
			header("dup", "/w"),
			msg("1", null, user("new copy"), "2026-11-01T11:00:00Z"),
		]);
		const index = new SessionHistoryIndex({ sessionsDir });
		await index.refresh();
		expect(index.list()).toHaveLength(1);
		expect(index.list()[0]).toMatchObject({ title: "new copy", path: join(dir, "new.jsonl") });
	});

	it("indexes the real session manager's files with the same title rules", async () => {
		const sm = realSession(join(tmp, "work"));
		const index = new SessionHistoryIndex({ sessionsDir });
		await index.refresh();
		expect(index.list()[0]).toMatchObject({
			sessionId: sm.getSessionId(),
			path: sm.getSessionFile(),
			title: "Look at app.ts",
			messageCount: 10,
			preview: "final answer",
			model: { provider: "anthropic", id: "claude-test" },
		});
	});
});

describe("sessions.past paging", () => {
	const sessions = Array.from({ length: 7 }, (_, i) => ({
		modifiedAt: 1000 - Math.floor(i / 2) * 10,
		sessionId: `s${9 - i}`,
	}));
	sessions.sort(comparePast);

	it("pages strictly after the cursor and ends without one", () => {
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 10; guard++) {
			const { page, nextCursor } = pageAfter(sessions, 3, cursor ? decodeCursor(cursor) : undefined);
			seen.push(...page.map((s) => s.sessionId));
			if (!nextCursor) break;
			cursor = nextCursor;
		}
		expect(seen).toEqual(sessions.map((s) => s.sessionId));
		expect(pageAfter(sessions, 7).nextCursor).toBeUndefined();
		expect(pageAfter([], 5)).toEqual({ page: [] });
	});

	it("keeps its place when newer sessions appear", () => {
		const first = pageAfter(sessions, 3);
		const grown = [{ modifiedAt: 5000, sessionId: "new" }, ...sessions];
		const second = pageAfter(grown, 3, decodeCursor(first.nextCursor as string));
		expect(second.page.map((s) => s.sessionId)).toEqual(sessions.slice(3, 6).map((s) => s.sessionId));
	});

	it("rejects malformed cursors", () => {
		expect(decodeCursor(encodeCursor({ modifiedAt: 5, sessionId: "x" }))).toEqual({ modifiedAt: 5, sessionId: "x" });
		for (const bad of [
			"",
			"%%%",
			Buffer.from("[1]").toString("base64url"),
			Buffer.from('["a","b"]').toString("base64url"),
		]) {
			expect(decodeCursor(bad)).toBeUndefined();
		}
	});
});
