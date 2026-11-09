import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_SOFT_CEILING_TOKENS,
	effectiveContextWindow,
	MIN_PRUNE_SAVINGS_TOKENS,
	prepareCompaction,
	preparePruning,
	resolveKeepRecentTokens,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import {
	buildContextEntries,
	elideToolResultContent,
	isPruneCompaction,
	SessionManager,
} from "../src/core/session-manager.ts";

const SETTINGS = { ...DEFAULT_COMPACTION_SETTINGS };

describe("compaction soft ceiling", () => {
	it("caps huge advertised windows at the default 300k ceiling", () => {
		expect(effectiveContextWindow(1_000_000, SETTINGS)).toBe(DEFAULT_SOFT_CEILING_TOKENS);
	});

	it("leaves windows below the ceiling untouched", () => {
		expect(effectiveContextWindow(200_000, SETTINGS)).toBe(200_000);
	});

	it("is disabled by softCeilingTokens: 0", () => {
		expect(effectiveContextWindow(1_000_000, { ...SETTINGS, softCeilingTokens: 0 })).toBe(1_000_000);
	});

	it("honors an explicit ceiling", () => {
		expect(effectiveContextWindow(1_000_000, { ...SETTINGS, softCeilingTokens: 150_000 })).toBe(150_000);
	});

	it("triggers compaction at 350k on a 1M-window model (a long-context stall scenario)", () => {
		// Before the ceiling existed the threshold was ~983k and sessions
		// degraded for hundreds of thousands of tokens without ever compacting.
		const effective = effectiveContextWindow(1_000_000, SETTINGS);
		expect(shouldCompact(350_000, effective, SETTINGS)).toBe(true);
		expect(shouldCompact(250_000, effective, SETTINGS)).toBe(false);
	});
});

describe("adaptive keep-recent budget", () => {
	it("uses 10% of the effective window when unset", () => {
		const settings = { ...SETTINGS, keepRecentTokens: undefined };
		expect(resolveKeepRecentTokens(settings, 1_000_000)).toBe(30_000); // 10% of the 300k ceiling
	});

	it("never drops below the 20k floor", () => {
		const settings = { ...SETTINGS, keepRecentTokens: undefined };
		expect(resolveKeepRecentTokens(settings, 150_000)).toBe(20_000);
	});

	it("respects an explicit override", () => {
		expect(resolveKeepRecentTokens({ ...SETTINGS, keepRecentTokens: 42_000 }, 1_000_000)).toBe(42_000);
	});

	it("uses a model's per-model soft ceiling when one is passed", () => {
		const settings = { ...SETTINGS, keepRecentTokens: undefined };
		const model = { compaction: { softCeilingTokens: 500_000 } } as never;
		expect(resolveKeepRecentTokens(settings, 1_000_000, model)).toBe(50_000); // 10% of 500k, not 300k
	});
});

describe("tool-result elision", () => {
	function toolResult(text: string, isError = false) {
		return {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text" as const, text }],
			isError,
			timestamp: 0,
		};
	}

	it("keeps short results unchanged (identity, for cache stability)", () => {
		const message = toolResult("short output");
		expect(elideToolResultContent(message)).toBe(message);
	});

	it("elides long results to a head plus note", () => {
		const message = toolResult("x".repeat(50_000));
		const elided = elideToolResultContent(message);
		expect(elided).not.toBe(message);
		const text = (elided.content[0] as { text: string }).text;
		expect(text.length).toBeLessThan(1500);
		expect(text).toContain("[elided by context pruning");
		expect(text).toContain("full output preserved in the session file");
	});

	it("keeps a larger head for error results", () => {
		const message = toolResult("e".repeat(50_000), true);
		const text = (elideToolResultContent(message).content[0] as { text: string }).text;
		expect(text.length).toBeGreaterThan(4000);
	});

	it("drops images and notes them", () => {
		const message = {
			...toolResult("screenshot follows"),
			content: [
				{ type: "text" as const, text: "screenshot follows" },
				{ type: "image" as const, data: "abc", mimeType: "image/png" },
			],
		};
		const elided = elideToolResultContent(message);
		const text = (elided.content[0] as { text: string }).text;
		expect(elided.content).toHaveLength(1);
		expect(text).toContain("1 image");
	});

	it("is deterministic", () => {
		const message = toolResult("y".repeat(30_000));
		const first = JSON.stringify(elideToolResultContent(message));
		const second = JSON.stringify(elideToolResultContent(message));
		expect(first).toBe(second);
	});
});

describe("prune preparation and context masking", () => {
	function buildBigSession(): SessionManager {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "do the big task" }],
			timestamp: 1,
		});
		// 30 turns of assistant toolCall + fat toolResult (~10k tokens each).
		for (let i = 0; i < 30; i++) {
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${i}`, name: "bash", arguments: { command: `step ${i}` } }],
				timestamp: 2 + i * 2,
				stopReason: "toolUse",
			} as never);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: `call-${i}`,
				toolName: "bash",
				content: [{ type: "text", text: `output ${i}\n${"z".repeat(40_000)}` }],
				isError: false,
				timestamp: 3 + i * 2,
			});
		}
		return manager;
	}

	it("measures the prune trigger against a model's per-model soft ceiling", () => {
		const entries = buildBigSession().getBranch();
		// ~300k tokens: past half of the global 300k ceiling, but under half of a 1M per-model ceiling.
		expect(preparePruning(entries, SETTINGS, 1_000_000)).toBeDefined();
		const model = { compaction: { softCeilingTokens: 1_000_000 } } as never;
		expect(preparePruning(entries, SETTINGS, 1_000_000, undefined, model)).toBeUndefined();
	});

	it("proposes a watermark on an oversized session and masks only old tool results", () => {
		const manager = buildBigSession();
		const entries = manager.getBranch();
		const prune = preparePruning(entries, SETTINGS, 1_000_000);
		expect(prune).toBeDefined();
		expect(prune!.estimatedSavingsTokens).toBeGreaterThan(MIN_PRUNE_SAVINGS_TOKENS);

		manager.appendCompaction(
			prune!.note,
			prune!.firstKeptEntryId,
			prune!.tokensBefore,
			undefined,
			false,
			undefined,
			"prune",
		);
		const context = buildContextEntries(manager.getBranch());

		const watermarkIdx = context.findIndex((entry) => entry.id === prune!.firstKeptEntryId);
		expect(watermarkIdx).toBeGreaterThan(0);
		const isElided = (entry: (typeof context)[number]) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			JSON.stringify(entry.message.content).includes("[elided by context pruning");
		const before = context
			.slice(0, watermarkIdx)
			.filter((e) => e.type === "message" && e.message.role === "toolResult");
		const after = context.slice(watermarkIdx).filter((e) => e.type === "message" && e.message.role === "toolResult");
		expect(before.length).toBeGreaterThan(0);
		expect(before.every(isElided)).toBe(true);
		expect(after.length).toBeGreaterThan(0);
		expect(after.some(isElided)).toBe(false);

		// The user message and assistant tool calls survive verbatim.
		const user = context.find((e) => e.type === "message" && e.message.role === "user");
		expect(JSON.stringify(user)).toContain("do the big task");
	});

	it("does not re-propose immediately after pruning", () => {
		const manager = buildBigSession();
		const prune = preparePruning(manager.getBranch(), SETTINGS, 1_000_000);
		manager.appendCompaction(
			prune!.note,
			prune!.firstKeptEntryId,
			prune!.tokensBefore,
			undefined,
			false,
			undefined,
			"prune",
		);
		expect(preparePruning(manager.getBranch(), SETTINGS, 1_000_000)).toBeUndefined();
	});

	it("stays quiet on small sessions", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		expect(preparePruning(manager.getBranch(), SETTINGS, 1_000_000)).toBeUndefined();
	});

	it("a trailing prune entry neither blocks summary compaction nor leaks into its boundary", () => {
		const manager = buildBigSession();
		const prune = preparePruning(manager.getBranch(), SETTINGS, 1_000_000);
		manager.appendCompaction(
			prune!.note,
			prune!.firstKeptEntryId,
			prune!.tokensBefore,
			undefined,
			false,
			undefined,
			"prune",
		);
		const entries = manager.getBranch();
		expect(isPruneCompaction(entries[entries.length - 1])).toBe(true);
		const preparation = prepareCompaction(entries, SETTINGS, 1_000_000);
		expect(preparation).toBeDefined();
		// A prune's note must never masquerade as the previous summary.
		expect(preparation!.previousSummary).toBeUndefined();
	});
});
