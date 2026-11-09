import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	calculateContextTokens,
	compact,
	compactionLines,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	findCutPoint,
	getLastAssistantUsage,
	prepareCompaction,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type ContextWindowEntry,
	type CustomMessageEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
	sessionEntryToContextMessages,
	type ThinkingLevelChangeEntry,
} from "../src/core/session-manager.ts";

// ============================================================================
// Test fixtures
// ============================================================================

function loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "fixtures/large-session.jsonl");
	const content = readFileSync(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
const initialTuiMode = process.env.PI_TUI_MODE;
beforeEach(() => {
	resetEntryCounter();
	delete process.env.PI_TUI_MODE;
});
afterEach(() => {
	if (initialTuiMode === undefined) delete process.env.PI_TUI_MODE;
	else process.env.PI_TUI_MODE = initialTuiMode;
});

function withTuiMode<T>(value: string | undefined, callback: () => T): T {
	const previous = process.env.PI_TUI_MODE;
	if (value === undefined) delete process.env.PI_TUI_MODE;
	else process.env.PI_TUI_MODE = value;
	try {
		return callback();
	} finally {
		if (previous === undefined) delete process.env.PI_TUI_MODE;
		else process.env.PI_TUI_MODE = previous;
	}
}

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function createCompactionEntry(summary: string, firstKeptEntryId: string, pinned?: string[]): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
		...(pinned ? { pinned } : {}),
	};
	lastId = id;
	return entry;
}

function createContextWindowEntry(handoff?: string): ContextWindowEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ContextWindowEntry = {
		type: "context_window",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		handoff,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function createModelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
	lastId = id;
	return entry;
}

function createThinkingLevelEntry(thinkingLevel: string): ThinkingLevelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	lastId = id;
	return entry;
}

function createCustomMessageEntry(content: string, customType = "test", details?: unknown): CustomMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CustomMessageEntry = {
		type: "custom_message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		customType,
		content,
		details,
		display: true,
	};
	lastId = id;
	return entry;
}

function extractText(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			switch (message.role) {
				case "user":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "assistant":
					return message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
				case "branchSummary":
				case "compactionSummary":
					return message.summary;
				case "custom":
				case "toolResult":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "bashExecution":
					return `${message.command}\n${message.output}`;
				default:
					return "";
			}
		})
		.join("\n");
}

// ============================================================================
// Unit tests
// ============================================================================

describe("Token calculation", () => {
	it("should calculate total context tokens from usage", () => {
		const usage = createMockUsage(1000, 500, 200, 100);
		expect(calculateContextTokens(usage)).toBe(1800);
	});

	it("should handle zero values", () => {
		const usage = createMockUsage(0, 0, 0, 0);
		expect(calculateContextTokens(usage)).toBe(0);
	});
});

describe("getLastAssistantUsage", () => {
	it("should find the last non-aborted assistant message usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(createAssistantMessage("Good", createMockUsage(200, 100))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(200);
	});

	it("should skip aborted messages", () => {
		const abortedMsg: AssistantMessage = {
			...createAssistantMessage("Aborted", createMockUsage(300, 150)),
			stopReason: "aborted",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(abortedMsg),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should skip all-zero assistant usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("continue")),
			createMessageEntry(createAssistantMessage("Partial", createMockUsage(0, 0))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should return undefined if no assistant messages", () => {
		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Hello"))];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("estimateContextTokens", () => {
	it("uses the last non-zero assistant usage as the context anchor", () => {
		const messages: AgentMessage[] = [
			createUserMessage("Hello"),
			createAssistantMessage("Hi", createMockUsage(100, 50)),
			createUserMessage("continue"),
			createAssistantMessage("Partial thinking", createMockUsage(0, 0)),
		];

		const estimate = estimateContextTokens(messages);

		expect(estimate.usageTokens).toBe(150);
		expect(estimate.lastUsageIndex).toBe(1);
		expect(estimate.trailingTokens).toBeGreaterThan(0);
		expect(estimate.tokens).toBe(150 + estimate.trailingTokens);
	});
});

describe("compactionLines", () => {
	it.each([
		{
			contextWindow: 1_000_000,
			softCeilingTokens: 300_000,
			reserveTokens: 16_384,
			expected: { effectiveWindow: 300_000, hardAt: 283_616, windowOpenAt: 226_892, pruneAt: 150_000 },
		},
		{
			contextWindow: 200_000,
			softCeilingTokens: 300_000,
			reserveTokens: 16_384,
			expected: { effectiveWindow: 200_000, hardAt: 183_616, windowOpenAt: 146_892, pruneAt: 100_000 },
		},
		{
			contextWindow: 128_000,
			softCeilingTokens: 0,
			reserveTokens: 16_384,
			expected: { effectiveWindow: 128_000, hardAt: 111_616, windowOpenAt: 89_292, pruneAt: 64_000 },
		},
	])(
		"derives thresholds for contextWindow=$contextWindow and softCeilingTokens=$softCeilingTokens",
		({ contextWindow, softCeilingTokens, reserveTokens, expected }) => {
			expect(compactionLines(contextWindow, { enabled: true, reserveTokens, softCeilingTokens })).toEqual(expected);
		},
	);

	it("uses a model soft ceiling instead of the global setting", () => {
		const model = { compaction: { softCeilingTokens: 200_000 } } as Parameters<typeof compactionLines>[2];
		expect(
			compactionLines(1_000_000, { enabled: true, reserveTokens: 16_384, softCeilingTokens: 300_000 }, model),
		).toEqual({ effectiveWindow: 200_000, hardAt: 183_616, windowOpenAt: 146_892, pruneAt: 100_000 });
	});

	it("uses the global soft ceiling when the model has no override", () => {
		const model = {} as Parameters<typeof compactionLines>[2];
		expect(
			compactionLines(1_000_000, { enabled: true, reserveTokens: 16_384, softCeilingTokens: 300_000 }, model),
		).toEqual({ effectiveWindow: 300_000, hardAt: 283_616, windowOpenAt: 226_892, pruneAt: 150_000 });
	});
});

describe("shouldCompact", () => {
	it("should return true when context exceeds threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(89000, 100000, settings)).toBe(false);
	});

	it("should return false when disabled", () => {
		const settings: CompactionSettings = {
			enabled: false,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(false);
	});
});

describe("findCutPoint", () => {
	it("should find cut point based on actual token differences", () => {
		// Create entries with cumulative token counts
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(createMessageEntry(createUserMessage(`User ${i}`)));
			entries.push(
				createMessageEntry(createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0))),
			);
		}

		// 20 entries, last assistant has 10000 tokens
		// keepRecentTokens = 2500: keep entries where diff < 2500
		const result = findCutPoint(entries, 0, entries.length, 2500);

		// Should cut at a valid cut point (user or assistant message)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should return startIndex if no valid cut points in range", () => {
		const entries: SessionEntry[] = [createMessageEntry(createAssistantMessage("a"))];
		const result = findCutPoint(entries, 0, entries.length, 1000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should keep everything if all messages fit within budget", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b", createMockUsage(0, 50, 1000, 0))),
		];

		const result = findCutPoint(entries, 0, entries.length, 50000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should indicate split turn when cutting at assistant message", () => {
		// Create a scenario where we cut at an assistant message mid-turn
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("A1", createMockUsage(0, 100, 1000, 0))),
			createMessageEntry(createUserMessage("Turn 2")), // index 2
			createMessageEntry(createAssistantMessage("A2-1", createMockUsage(0, 100, 5000, 0))), // index 3
			createMessageEntry(createAssistantMessage("A2-2", createMockUsage(0, 100, 8000, 0))), // index 4
			createMessageEntry(createAssistantMessage("A2-3", createMockUsage(0, 100, 10000, 0))), // index 5
		];

		// With keepRecentTokens = 3000, should cut somewhere in Turn 2
		const result = findCutPoint(entries, 0, entries.length, 3000);

		// If cut at assistant message (not user), should indicate split turn
		const cutEntry = entries[result.firstKeptEntryIndex] as SessionMessageEntry;
		if (cutEntry.message.role === "assistant") {
			expect(result.isSplitTurn).toBe(true);
			expect(result.turnStartIndex).toBe(2); // Turn 2 starts at index 2
		}
	});

	it("should budget context-visible custom message entries", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("hi")),
			createMessageEntry(createAssistantMessage("hello")),
			createCustomMessageEntry("x".repeat(4000)),
			createMessageEntry(createAssistantMessage("ok")),
		];

		const tinyBudget = findCutPoint(entries, 0, entries.length, 1);
		expect(tinyBudget.firstKeptEntryIndex).toBe(3);
		expect(tinyBudget.isSplitTurn).toBe(true);
		expect(tinyBudget.turnStartIndex).toBe(2);

		const customFitsBudget = findCutPoint(entries, 0, entries.length, 2);
		expect(customFitsBudget.firstKeptEntryIndex).toBe(2);
		expect(customFitsBudget.isSplitTurn).toBe(false);
		expect(customFitsBudget.turnStartIndex).toBe(-1);
	});

	// Regression test for #9740.
	it("should fall back to the latest valid cut point before oversized trailing tool results", () => {
		const oldUser = createMessageEntry(createUserMessage("old history"));
		const oldAssistant = createMessageEntry(createAssistantMessage("old answer"));
		const currentUser = createMessageEntry(createUserMessage("read the large file"));
		const toolCall = createMessageEntry({
			...createAssistantMessage(""),
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "big.txt" } }],
			stopReason: "toolUse",
		});
		const toolResult = createMessageEntry({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(8000) }],
			isError: false,
			timestamp: Date.now(),
		});
		const entries = [oldUser, oldAssistant, currentUser, toolCall, toolResult];

		const result = findCutPoint(entries, 0, entries.length, 1000);
		expect(result).toEqual({
			firstKeptEntryIndex: 3,
			turnStartIndex: 2,
			isSplitTurn: true,
		});

		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1000,
		});
		expect(preparation?.firstKeptEntryId).toBe(toolCall.id);
		expect(preparation?.messagesToSummarize).toEqual([oldUser.message, oldAssistant.message]);
		expect(preparation?.turnPrefixMessages).toEqual([currentUser.message]);
	});
});

describe("buildSessionContext", () => {
	it("should load all messages when no compaction", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a")),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b")),
		];

		const loaded = buildSessionContext(entries);
		expect(loaded.messages.length).toBe(4);
		expect(loaded.thinkingLevel).toBe("off");
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});

	it("should handle single compaction", () => {
		// IDs: u1=test-id-0, a1=test-id-1, u2=test-id-2, a2=test-id-3, compaction=test-id-4, u3=test-id-5, a3=test-id-6
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const u2 = createMessageEntry(createUserMessage("2"));
		const a2 = createMessageEntry(createAssistantMessage("b"));
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id); // keep from u2 onwards
		const u3 = createMessageEntry(createUserMessage("3"));
		const a3 = createMessageEntry(createAssistantMessage("c"));

		const entries: SessionEntry[] = [u1, a1, u2, a2, compaction, u3, a3];

		const loaded = buildSessionContext(entries);
		// summary + kept (u2, a2) + after (u3, a3) = 5
		expect(loaded.messages.length).toBe(5);
		expect(loaded.messages[0].role).toBe("compactionSummary");
		expect((loaded.messages[0] as any).summary).toContain("Summary of 1,a,2,b");
	});

	it("should handle multiple compactions (only latest matters)", () => {
		// First batch
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id);
		// Second batch
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));
		const u3 = createMessageEntry(createUserMessage("3"));
		const c = createMessageEntry(createAssistantMessage("c"));
		const compact2 = createCompactionEntry("Second summary", u3.id); // keep from u3 onwards
		// After second compaction
		const u4 = createMessageEntry(createUserMessage("4"));
		const d = createMessageEntry(createAssistantMessage("d"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b, u3, c, compact2, u4, d];

		const loaded = buildSessionContext(entries);
		// summary + kept from u3 (u3, c) + after (u4, d) = 5
		expect(loaded.messages.length).toBe(5);
		expect((loaded.messages[0] as any).summary).toContain("Second summary");
	});

	it("should keep all messages when firstKeptEntryId is first entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id); // keep from first entry
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b];

		const loaded = buildSessionContext(entries);
		// summary + all messages (u1, a1, u2, b) = 5
		expect(loaded.messages.length).toBe(5);
	});

	it("should track model and thinking level changes", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createModelChangeEntry("openai", "gpt-4"),
			createMessageEntry(createAssistantMessage("a")),
			createThinkingLevelEntry("high"),
		];

		const loaded = buildSessionContext(entries);
		// model_change is later overwritten by assistant message's model info
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});
});

describe("prepareCompaction with context windows", () => {
	it("never summarizes entries from an earlier window", () => {
		const oldUser = createMessageEntry(createUserMessage("old secret ".repeat(100)));
		const oldAssistant = createMessageEntry(createAssistantMessage("old response ".repeat(100)));
		const boundary = createContextWindowEntry("current task");
		const currentUser = createMessageEntry(createUserMessage("current first ".repeat(100)));
		const currentAssistant = createMessageEntry(createAssistantMessage("current response ".repeat(100)));
		const recentUser = createMessageEntry(createUserMessage("recent request ".repeat(100)));
		const recentAssistant = createMessageEntry(createAssistantMessage("recent response ".repeat(100)));
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 };

		const preparation = prepareCompaction(
			[oldUser, oldAssistant, boundary, currentUser, currentAssistant, recentUser, recentAssistant],
			settings,
		);

		expect(preparation).toBeDefined();
		const summarizedText = extractText(preparation!.messagesToSummarize);
		expect(summarizedText).toContain("current first");
		expect(summarizedText).not.toContain("old secret");
	});
});

describe("prepareCompaction", () => {
	it("does not treat system messages as conversation history", () => {
		const system = createMessageEntry({
			role: "system",
			content: "",
			sections: { preamble: "current prompt" },
			timestamp: Date.now(),
		});
		const user = createMessageEntry(createUserMessage("one long turn"));
		const assistant = createMessageEntry(createAssistantMessage("assistant suffix"));
		const preparation = prepareCompaction([system, user, assistant], {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});

		expect(preparation).toBeDefined();
		expect(preparation?.firstKeptEntryId).toBe(assistant.id);
		expect(preparation?.isSplitTurn).toBe(true);
		expect(preparation?.messagesToSummarize).toEqual([]);
		expect(preparation?.turnPrefixMessages).toEqual([user.message]);
	});

	it("splits a turn at the assistant tool call before oversized trailing tool results", () => {
		// Two turns on a projection that starts with the replayed system prompt: the first turn's
		// tool results exceed the recent budget by themselves, so the cut lands inside that turn,
		// on an assistant tool call, and the turn prefix before it is summarized.
		const system = createMessageEntry({
			role: "system",
			content: "",
			sections: { preamble: "p".repeat(2000) },
			timestamp: Date.now(),
		});
		const user1 = createMessageEntry(createUserMessage("read the three files"));
		const toolTurn = (index: number) => {
			const call = createMessageEntry({
				...createAssistantMessage(""),
				content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `f${index}` } }],
				stopReason: "toolUse",
			});
			const result = createMessageEntry({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(3000) }],
				isError: false,
				timestamp: Date.now(),
			});
			return [call, result];
		};
		const [call1, result1] = toolTurn(1);
		const [call2, result2] = toolTurn(2);
		const [call3, result3] = toolTurn(3);
		const assistant1 = createMessageEntry(createAssistantMessage("read them all"));
		const user2 = createMessageEntry(createUserMessage("reply ready"));
		const assistant2 = createMessageEntry(createAssistantMessage("ready"));
		const entries = [system, user1, call1, result1, call2, result2, call3, result3, assistant1, user2, assistant2];

		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1500 });

		// The budget overflows on the second result; the cut lands on the tool call after it.
		expect(preparation).toBeDefined();
		expect(preparation?.isSplitTurn).toBe(true);
		expect(preparation?.firstKeptEntryId).toBe(call3.id);
		expect(preparation?.messagesToSummarize).toEqual([]);
		expect(preparation?.turnPrefixMessages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
		]);
	});
});

describe("prepareCompaction with previous compaction", () => {
	it("should skip repeated compactions when kept messages still fit", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1"));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2"));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1"));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1)"));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4", createMockUsage(8000, 2000)));

		const pathEntries = [u1, a1, u2, a2, u3, a3, compaction1, u4, a4];
		const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeUndefined();
	});

	it("should re-summarize previously kept messages when the recent window moves past them", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)".repeat(4)));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1".repeat(4)));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1 ".repeat(12)));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2 ".repeat(12)));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1 ".repeat(12)));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3 ".repeat(12), createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1) ".repeat(12)));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4 ".repeat(12), createMockUsage(8000, 2000)));

		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 100,
		};
		const preparation = prepareCompaction([u1, a1, u2, a2, u3, a3, compaction1, u4, a4], settings);

		expect(preparation).toBeDefined();
		const summarizedText = extractText(preparation!.messagesToSummarize);
		expect(summarizedText).toContain("user msg 2 - kept by compaction1");
		expect(summarizedText).toContain("user msg 3 - kept by compaction1");
		expect(summarizedText).not.toContain("First summary");
		expect(preparation!.previousSummary).toBe("First summary");
	});
});

describe("context-aware pinned compaction", () => {
	const settings: CompactionSettings = {
		...DEFAULT_COMPACTION_SETTINGS,
		keepRecentTokens: 1,
	};

	it("collects the first user request and checkpoint keep items, excluding the request from summary input", () => {
		withTuiMode("1", () => {
			const firstUser = createMessageEntry(createUserMessage("preserve this request exactly"));
			const firstAssistant = createMessageEntry(createAssistantMessage("first response"));
			const checkpoint = createCustomMessageEntry("checkpoint notes", "checkpoint", { keep: ["src/file.ts"] });
			const laterUser = createMessageEntry(createUserMessage("a later request"));
			const laterAssistant = createMessageEntry(createAssistantMessage("a later response"));

			const preparation = prepareCompaction(
				[firstUser, firstAssistant, checkpoint, laterUser, laterAssistant],
				settings,
			);

			expect(preparation).toBeDefined();
			expect(preparation?.pinned).toEqual(["preserve this request exactly", "src/file.ts"]);
			expect(extractText(preparation?.messagesToSummarize ?? [])).not.toContain("preserve this request exactly");
		});
	});

	it("carries previous pinned values forward in order without duplicates", () => {
		withTuiMode("1", () => {
			const firstUser = createMessageEntry(createUserMessage("original request"));
			const firstAssistant = createMessageEntry(createAssistantMessage("first response"));
			const keptUser = createMessageEntry(createUserMessage("kept request"));
			const previous = createCompactionEntry("summary", keptUser.id, ["existing", "original request"]);
			const laterUser = createMessageEntry(createUserMessage("later request"));
			const laterAssistant = createMessageEntry(createAssistantMessage("later response"));

			const preparation = prepareCompaction(
				[firstUser, firstAssistant, keptUser, previous, laterUser, laterAssistant],
				settings,
			);

			expect(preparation?.pinned).toEqual(["existing", "original request"]);
		});
	});

	it("uses checkpoint notes as the previous summary seed", () => {
		withTuiMode("1", () => {
			const firstUser = createMessageEntry(createUserMessage("original request"));
			const firstAssistant = createMessageEntry(createAssistantMessage("first response"));
			const checkpoint = createCustomMessageEntry("fresh checkpoint notes", "checkpoint");
			const laterUser = createMessageEntry(createUserMessage("later request"));
			const laterAssistant = createMessageEntry(createAssistantMessage("later response"));

			const preparation = prepareCompaction(
				[firstUser, firstAssistant, checkpoint, laterUser, laterAssistant],
				settings,
			);

			expect(preparation?.previousSummary).toBe("fresh checkpoint notes");
		});
	});

	it("does not let a checkpoint kept by the previous compaction override its newer summary", () => {
		const firstUser = createMessageEntry(createUserMessage("original request"));
		const firstAssistant = createMessageEntry(createAssistantMessage("first response"));
		const keptUser = createMessageEntry(createUserMessage("kept request"));
		const checkpoint = createCustomMessageEntry("stale checkpoint notes", "checkpoint");
		const keptAssistant = createMessageEntry(createAssistantMessage("kept response"));
		const previous = createCompactionEntry("newer summary", keptUser.id);
		const laterUser = createMessageEntry(createUserMessage("later request"));
		const laterAssistant = createMessageEntry(createAssistantMessage("later response"));

		const preparation = prepareCompaction(
			[firstUser, firstAssistant, keptUser, checkpoint, keptAssistant, previous, laterUser, laterAssistant],
			settings,
		);

		expect(preparation?.previousSummary).toBe("newer summary");
	});

	it("does not collect pinned context when the feature flag is off", () => {
		withTuiMode(undefined, () => {
			const firstUser = createMessageEntry(createUserMessage("legacy request"));
			const firstAssistant = createMessageEntry(createAssistantMessage("first response"));
			const laterUser = createMessageEntry(createUserMessage("later request"));
			const laterAssistant = createMessageEntry(createAssistantMessage("later response"));

			const preparation = prepareCompaction([firstUser, firstAssistant, laterUser, laterAssistant], settings);

			expect(preparation?.pinned).toBeUndefined();
			expect(extractText(preparation?.messagesToSummarize ?? [])).toContain("legacy request");
		});
	});

	it("renders pinned context immediately after a compaction summary", () => {
		const entry: CompactionEntry = {
			type: "compaction",
			id: "compaction-id",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "summary",
			firstKeptEntryId: "kept-id",
			tokensBefore: 100,
			pinned: ["first constraint", "src/file.ts"],
		};

		const messages = sessionEntryToContextMessages(entry);
		expect(messages).toHaveLength(2);
		expect(messages[0]?.role).toBe("compactionSummary");
		expect(messages[1]).toMatchObject({
			role: "custom",
			customType: "pinned-context",
			display: false,
			content: "<pinned-context>\nfirst constraint\n---\nsrc/file.ts\n</pinned-context>",
		});
	});
});

// ============================================================================
// Integration tests with real session data
// ============================================================================

describe("Large session fixture", () => {
	it("should parse the large session", () => {
		const entries = loadLargeSessionEntries();
		expect(entries.length).toBeGreaterThan(100);

		const messageCount = entries.filter((e) => e.type === "message").length;
		expect(messageCount).toBeGreaterThan(100);
	});

	it("should find cut point in large session", () => {
		const entries = loadLargeSessionEntries();
		const result = findCutPoint(entries, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens ?? 20_000);

		// Cut point should be at a message entry (user or assistant)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should load session correctly", () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);

		expect(loaded.messages.length).toBeGreaterThan(100);
		expect(loaded.model).not.toBeNull();
	});
});

// ============================================================================
// LLM integration tests (skipped without API key)
// ============================================================================

describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)("LLM summarization", () => {
	it("should generate a compaction result for the large session", async () => {
		const entries = loadLargeSessionEntries();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_OAUTH_TOKEN!);

		expect(compactionResult.summary.length).toBeGreaterThan(100);
		expect(compactionResult.firstKeptEntryId).toBeTruthy();
		expect(compactionResult.tokensBefore).toBeGreaterThan(0);

		console.log("Summary length:", compactionResult.summary.length);
		console.log("First kept entry ID:", compactionResult.firstKeptEntryId);
		console.log("Tokens before:", compactionResult.tokensBefore);
		console.log("\n--- SUMMARY ---\n");
		console.log(compactionResult.summary);
	}, 60000);

	it("should produce valid session after compaction", async () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_OAUTH_TOKEN!);

		// Simulate appending compaction to entries by creating a proper entry
		const lastEntry = entries[entries.length - 1];
		const parentId = lastEntry.id;
		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: "compaction-test-id",
			parentId,
			timestamp: new Date().toISOString(),
			...compactionResult,
		};
		const newEntries = [...entries, compactionEntry];
		const reloaded = buildSessionContext(newEntries);

		// Should have summary + kept messages
		expect(reloaded.messages.length).toBeLessThan(loaded.messages.length);
		expect(reloaded.messages[0].role).toBe("compactionSummary");
		expect((reloaded.messages[0] as any).summary).toContain(compactionResult.summary);

		console.log("Original messages:", loaded.messages.length);
		console.log("After compaction:", reloaded.messages.length);
	}, 60000);
});
