import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";
import {
	buildSideQuestionMessages,
	createSideQuestionHistory,
	DEFAULT_MAX_SIDE_HISTORY,
	dropTrailingUnmatchedToolCalls,
	runSideQuestion,
	SIDE_QUESTION_SYSTEM_REMINDER,
	type SideQuestionPair,
} from "../src/core/side-question.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_MODEL: Model<Api> = {
	id: "claude-test",
	name: "Claude Test",
	provider: "anthropic",
	api: "anthropic-messages" as Api,
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8096,
};

function mockUsage(input = 100, output = 50): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistantEntry(
	id: string,
	parentId: string | null,
	text: string,
	stopReason: "stop" | "pending" = "stop",
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: mockUsage(),
			stopReason,
			timestamp: 1,
		},
	};
}

function compactionEntry(
	id: string,
	parentId: string | null,
	summary: string,
	firstKeptEntryId: string,
): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1000,
	};
}

function mockAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: mockUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// buildSideQuestionMessages
// ---------------------------------------------------------------------------

describe("buildSideQuestionMessages", () => {
	describe("context normalization", () => {
		it("converts session entries to messages", () => {
			const entries: SessionEntry[] = [userEntry("1", null, "hello"), assistantEntry("2", "1", "hi")];
			const msgs = buildSideQuestionMessages(entries, MOCK_MODEL, "what?", []);
			// 2 context + 1 question
			expect(msgs).toHaveLength(3);
			expect(msgs[0].role).toBe("user");
			expect(msgs[1].role).toBe("assistant");
			expect(msgs[2].role).toBe("user");
		});

		it("includes compaction summary when present", () => {
			const entries: SessionEntry[] = [
				userEntry("1", null, "a"),
				assistantEntry("2", "1", "b"),
				compactionEntry("3", "2", "Old summary", "1"),
				userEntry("4", "3", "c"),
			];
			const msgs = buildSideQuestionMessages(entries, MOCK_MODEL, "q?", []);
			// compaction summary becomes a user message, then kept entries (1,2,4) + question
			const roles = msgs.map((m) => m.role);
			expect(roles[0]).toBe("user"); // compaction summary
			expect(roles[roles.length - 1]).toBe("user"); // question
		});
	});

	describe("trailing partial assistant drop", () => {
		it("drops a trailing assistant message with stopReason pending", () => {
			const entries: SessionEntry[] = [
				userEntry("1", null, "hello"),
				assistantEntry("2", "1", "partial response", "pending"),
			];
			const msgs = buildSideQuestionMessages(entries, MOCK_MODEL, "q?", []);
			// Only user context + question (partial assistant dropped)
			expect(msgs).toHaveLength(2);
			expect(msgs[0].role).toBe("user");
			expect(msgs[0]).toHaveProperty("content", "hello");
			expect(msgs[1].role).toBe("user"); // question
		});

		it("keeps a trailing complete assistant message", () => {
			const entries: SessionEntry[] = [userEntry("1", null, "hello"), assistantEntry("2", "1", "complete", "stop")];
			const msgs = buildSideQuestionMessages(entries, MOCK_MODEL, "q?", []);
			// user + assistant context + question
			expect(msgs).toHaveLength(3);
			expect(msgs[1].role).toBe("assistant");
		});

		it("drops multiple trailing pending assistant messages", () => {
			const entries: SessionEntry[] = [
				userEntry("1", null, "a"),
				assistantEntry("2", "1", "stop", "stop"),
				userEntry("3", "2", "b"),
				assistantEntry("4", "3", "pending1", "pending"),
				assistantEntry("5", "4", "pending2", "pending"),
			];
			const msgs = buildSideQuestionMessages(entries, MOCK_MODEL, "q?", []);
			// a, assistant(stop), b, question — pending ones dropped
			const contextMsgs = msgs.slice(0, -1);
			expect(contextMsgs.every((m) => m.role !== "assistant" || (m as any).stopReason !== "pending")).toBe(true);
		});
	});

	describe("history ordering and replay", () => {
		it("places history between context and question", () => {
			const entries: SessionEntry[] = [userEntry("1", null, "ctx")];
			const history: SideQuestionPair[] = [{ question: "prior q", answer: "prior a", usage: mockUsage() }];
			const msgs = buildSideQuestionMessages(entries, MOCK_MODEL, "new q", history);
			// context(1) + history(2) + question(1) = 4
			expect(msgs).toHaveLength(4);
			expect(msgs[0]).toHaveProperty("content", "ctx");
			expect(msgs[1]).toHaveProperty("role", "user");
			expect(msgs[1]).toHaveProperty("content", "prior q");
			expect(msgs[2]).toHaveProperty("role", "assistant");
			expect(msgs[3].role).toBe("user");
			expect(msgs[3].content).toContain("new q");
		});

		it("replays multiple history pairs in order", () => {
			const history: SideQuestionPair[] = [
				{ question: "q1", answer: "a1", usage: mockUsage() },
				{ question: "q2", answer: "a2", usage: mockUsage() },
			];
			const msgs = buildSideQuestionMessages([], MOCK_MODEL, "q3", history);
			// q1/a1, q2/a2, question
			expect(msgs).toHaveLength(5);
			expect(msgs[0]).toHaveProperty("content", "q1");
			expect(msgs[1]).toHaveProperty("role", "assistant");
			expect(msgs[2]).toHaveProperty("content", "q2");
			expect(msgs[3]).toHaveProperty("role", "assistant");
		});
	});

	describe("history cap", () => {
		it("caps history at maxHistory pairs", () => {
			const history: SideQuestionPair[] = Array.from({ length: 25 }, (_, i) => ({
				question: `q${i}`,
				answer: `a${i}`,
				usage: mockUsage(),
			}));
			const msgs = buildSideQuestionMessages([], MOCK_MODEL, "new", history, 20);
			// 20 pairs = 40 messages + 1 question = 41
			expect(msgs).toHaveLength(41);
			// Should have kept the last 20, so q5..q24
			expect(msgs[0]).toHaveProperty("content", "q5");
		});

		it("uses DEFAULT_MAX_SIDE_HISTORY = 20 when not specified", () => {
			expect(DEFAULT_MAX_SIDE_HISTORY).toBe(20);
			const history: SideQuestionPair[] = Array.from({ length: 25 }, (_, i) => ({
				question: `q${i}`,
				answer: `a${i}`,
				usage: mockUsage(),
			}));
			const msgs = buildSideQuestionMessages([], MOCK_MODEL, "new", history);
			// 20 pairs + 1 question
			expect(msgs).toHaveLength(41);
		});
	});

	describe("system reminder", () => {
		it("injects the system reminder into the question message", () => {
			const msgs = buildSideQuestionMessages([], MOCK_MODEL, "my question", []);
			expect(msgs).toHaveLength(1);
			const qMsg = msgs[0];
			expect(qMsg.role).toBe("user");
			expect(qMsg.content).toContain(SIDE_QUESTION_SYSTEM_REMINDER);
			expect(qMsg.content).toContain("my question");
		});
	});
});

// ---------------------------------------------------------------------------
// runSideQuestion — no-tools shape and abort
// ---------------------------------------------------------------------------

describe("runSideQuestion", () => {
	let capturedContext: Context | undefined;
	let capturedOptions: { signal?: AbortSignal; idleTimeoutMs?: number } | undefined;
	let mockRuntime: ModelRuntime;

	beforeEach(() => {
		capturedContext = undefined;
		capturedOptions = undefined;

		mockRuntime = {
			completeSimple: vi.fn(async (_model: Model<Api>, ctx: Context, opts: unknown) => {
				capturedContext = ctx;
				capturedOptions = opts as { signal?: AbortSignal; idleTimeoutMs?: number };
				return mockAssistantMessage("answer text");
			}),
		} as unknown as ModelRuntime;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("no-tools shape", () => {
		it("passes an empty tools array", async () => {
			const msgs = buildSideQuestionMessages([], MOCK_MODEL, "q?", []);
			await runSideQuestion(MOCK_MODEL, mockRuntime, msgs, "sys");
			expect(capturedContext?.tools).toEqual([]);
		});

		it("passes the system prompt", async () => {
			const msgs = buildSideQuestionMessages([], MOCK_MODEL, "q?", []);
			await runSideQuestion(MOCK_MODEL, mockRuntime, msgs, "my system prompt");
			expect(capturedContext?.systemPrompt).toBe("my system prompt");
		});

		it("passes the messages to the model", async () => {
			const msgs = buildSideQuestionMessages([], MOCK_MODEL, "q?", []);
			await runSideQuestion(MOCK_MODEL, mockRuntime, msgs, undefined);
			expect(capturedContext?.messages).toEqual(msgs);
		});

		it("returns answer text from text content blocks", async () => {
			const result = await runSideQuestion(MOCK_MODEL, mockRuntime, [], "sys");
			expect(result.answer).toBe("answer text");
		});

		it("returns usage from the response", async () => {
			const result = await runSideQuestion(MOCK_MODEL, mockRuntime, [], "sys");
			expect(result.usage.input).toBe(100);
			expect(result.usage.output).toBe(50);
		});

		it("forwards the owning session's resolved idle timeout", async () => {
			await runSideQuestion(MOCK_MODEL, mockRuntime, [], "sys", undefined, undefined, 4321);
			expect(capturedOptions?.idleTimeoutMs).toBe(4321);
		});

		it("concatenates multiple text blocks", async () => {
			(mockRuntime.completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				...mockAssistantMessage("block1"),
				content: [
					{ type: "text", text: "block1" },
					{ type: "text", text: " block2" },
				],
			});
			const result = await runSideQuestion(MOCK_MODEL, mockRuntime, [], "sys");
			expect(result.answer).toBe("block1 block2");
		});

		it("turns an attempted tool call into a synthetic no-tools answer", async () => {
			(mockRuntime.completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				...mockAssistantMessage(""),
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
				stopReason: "toolUse",
			});
			const result = await runSideQuestion(MOCK_MODEL, mockRuntime, [], "sys");
			expect(result.answer).toContain("tried to call read");
			expect(result.answer).toContain("cannot use tools");
		});
	});

	describe("own AbortSignal", () => {
		it("passes its own signal (not the external one) to completeSimple", async () => {
			const externalController = new AbortController();
			const msgs = buildSideQuestionMessages([], MOCK_MODEL, "q?", []);
			await runSideQuestion(MOCK_MODEL, mockRuntime, msgs, "sys", externalController.signal);
			// The signal passed must be its own — it is NOT the external signal directly
			expect(capturedOptions?.signal).toBeDefined();
			expect(capturedOptions?.signal).not.toBe(externalController.signal);
		});

		it("aborts the internal controller when the external signal fires", async () => {
			const externalController = new AbortController();
			let resolveCall!: () => void;
			(mockRuntime.completeSimple as ReturnType<typeof vi.fn>).mockImplementationOnce(
				async (_m: Model<Api>, _ctx: Context, opts: unknown) => {
					capturedOptions = opts as { signal?: AbortSignal; idleTimeoutMs?: number };
					// Wait until aborted
					await new Promise<void>((resolve) => {
						resolveCall = resolve;
						capturedOptions?.signal?.addEventListener("abort", () => resolve());
					});
					return mockAssistantMessage("ok");
				},
			);

			const runPromise = runSideQuestion(MOCK_MODEL, mockRuntime, [], "sys", externalController.signal);
			// Give the mock time to start and register the listener
			await Promise.resolve();
			externalController.abort();
			resolveCall?.(); // unblock the mock
			await runPromise;
			expect(capturedOptions?.signal?.aborted).toBe(true);
		});
	});
});

// ---------------------------------------------------------------------------
// createSideQuestionHistory
// ---------------------------------------------------------------------------

describe("createSideQuestionHistory", () => {
	it("starts empty", () => {
		const h = createSideQuestionHistory();
		expect(h.getAll()).toHaveLength(0);
	});

	it("appends pairs", () => {
		const h = createSideQuestionHistory();
		h.append({ question: "q1", answer: "a1", usage: mockUsage() });
		h.append({ question: "q2", answer: "a2", usage: mockUsage() });
		expect(h.getAll()).toHaveLength(2);
	});

	it("caps at maxHistory", () => {
		const h = createSideQuestionHistory(3);
		for (let i = 0; i < 5; i++) {
			h.append({ question: `q${i}`, answer: `a${i}`, usage: mockUsage() });
		}
		const all = h.getAll();
		expect(all).toHaveLength(3);
		expect(all[0].question).toBe("q2");
		expect(all[2].question).toBe("q4");
	});

	it("applies a changed maxHistory setting to existing history", () => {
		const h = createSideQuestionHistory(5);
		for (let i = 0; i < 5; i++) h.append({ question: `q${i}`, answer: `a${i}`, usage: mockUsage() });
		h.setMaxHistory(2);
		expect(h.getAll().map((pair) => pair.question)).toEqual(["q3", "q4"]);
	});

	it("clears all pairs", () => {
		const h = createSideQuestionHistory();
		h.append({ question: "q", answer: "a", usage: mockUsage() });
		h.clear();
		expect(h.getAll()).toHaveLength(0);
	});

	it("getAll returns readonly snapshot", () => {
		const h = createSideQuestionHistory();
		h.append({ question: "q", answer: "a", usage: mockUsage() });
		const snapshot = h.getAll();
		h.append({ question: "q2", answer: "a2", usage: mockUsage() });
		// The snapshot reference reflects the internal array (readonly view)
		expect(snapshot).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// H3: dropTrailingUnmatchedToolCalls
// ---------------------------------------------------------------------------

describe("dropTrailingUnmatchedToolCalls", () => {
	function toolUseAssistantEntry(id: string, parentId: string | null): SessionMessageEntry {
		return {
			type: "message",
			id,
			parentId,
			timestamp: "2025-01-01T00:00:00Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `tc-${id}`, name: "bash", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-test",
				usage: mockUsage(),
				stopReason: "toolUse",
				timestamp: 1,
			},
		};
	}

	function toolResultEntry(id: string, parentId: string | null, toolCallId: string): SessionMessageEntry {
		return {
			type: "message",
			id,
			parentId,
			timestamp: "2025-01-01T00:00:00Z",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 1,
			},
		};
	}

	it("is a no-op for a normal conversation (stop reason)", () => {
		const msgs = [
			{ role: "user" as const, content: "hello", timestamp: 1 },
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "hi" }],
				api: "anthropic-messages" as const,
				provider: "anthropic",
				model: "m",
				usage: mockUsage(),
				stopReason: "stop" as const,
				timestamp: 1,
			},
		];
		const result = dropTrailingUnmatchedToolCalls(msgs as any);
		expect(result).toHaveLength(2);
	});

	it("drops a trailing assistant with stopReason toolUse that has no following toolResult", () => {
		const entries: SessionMessageEntry[] = [userEntry("1", null, "run bash"), toolUseAssistantEntry("2", "1")];
		const msgs = entries.flatMap((e) => (e.type === "message" ? [e.message] : [])) as any[];
		const result = dropTrailingUnmatchedToolCalls(msgs);
		// The unmatched toolUse assistant should be dropped
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});

	it("keeps a matched toolUse + toolResult pair", () => {
		const entries: SessionMessageEntry[] = [
			userEntry("1", null, "run bash"),
			toolUseAssistantEntry("2", "1"),
			toolResultEntry("3", "2", "tc-2"),
		];
		const msgs = entries.flatMap((e) => (e.type === "message" ? [e.message] : [])) as any[];
		const result = dropTrailingUnmatchedToolCalls(msgs);
		expect(result).toHaveLength(3);
	});

	it("applies after buildSideQuestionMessages — unmatched toolUse assistant is excluded from side call", () => {
		const entries: SessionEntry[] = [
			userEntry("1", null, "do thing"),
			toolUseAssistantEntry("2", "1") as unknown as SessionEntry,
		];
		const msgs = buildSideQuestionMessages(entries as SessionEntry[], MOCK_MODEL, "what?", []);
		// The unmatched toolUse assistant should have been stripped; only user+question remain
		const contextMsgs = msgs.slice(0, -1); // excluding the question
		expect(contextMsgs.every((m) => m.role !== "assistant")).toBe(true);
	});

	it("strips multiple consecutive unmatched toolUse assistants from tail", () => {
		const msgs = [
			{ role: "user" as const, content: "a", timestamp: 1 },
			{
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: "tc1", name: "bash", arguments: {} }],
				api: "anthropic-messages" as const,
				provider: "anthropic",
				model: "m",
				usage: mockUsage(),
				stopReason: "toolUse" as const,
				timestamp: 1,
			},
			{
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: "tc2", name: "bash", arguments: {} }],
				api: "anthropic-messages" as const,
				provider: "anthropic",
				model: "m",
				usage: mockUsage(),
				stopReason: "toolUse" as const,
				timestamp: 1,
			},
		];
		const result = dropTrailingUnmatchedToolCalls(msgs as any);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});
});
