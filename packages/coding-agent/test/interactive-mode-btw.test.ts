/**
 * Integration tests for the /btw command in InteractiveMode.
 *
 * Uses Reflect to call private methods directly without a full TUI, matching
 * the pattern used in interactive-mode-compaction.test.ts.
 */
import { describe, expect, test, vi } from "vitest";
import { createSideQuestionHistory } from "../src/core/side-question.ts";
import { BtwPanel } from "../src/modes/interactive/components/btw-panel.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// ---------------------------------------------------------------------------
// Helper: build a minimal fake InteractiveMode instance for btw tests
// ---------------------------------------------------------------------------

function makeFakeInstance() {
	const btwHistory = createSideQuestionHistory(20);

	const sessionManager = {
		buildContextEntries: () => [] as unknown[],
		appendCustomEntry: vi.fn(),
		getCwd: () => process.cwd(),
		isPersisted: () => false,
		getSessionDir: () => "/tmp/phi-btw-test-sessions",
		getSessionFile: () => undefined,
	};

	// Plain object with all the properties/methods that btw private methods need.
	// We add the private btw methods from the prototype so they resolve via `this`.
	const fake: Record<string, unknown> = {
		btwPanel: undefined as BtwPanel | undefined,
		btwHistory,
		extensionWidgetsAbove: new Map<string, unknown>(),
		extensionWidgetsBelow: new Map<string, unknown>(),
		session: {
			model: {
				id: "claude-test",
				name: "Test",
				provider: "anthropic",
				api: "anthropic-messages",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8096,
			},
			systemPrompt: "system",
			modelRuntime: { getModels: () => [] },
			sessionManager,
			sendCustomMessage: vi.fn().mockResolvedValue(undefined),
		},
		// sessionManager delegates to session.sessionManager (mimics the getter)
		get sessionManager() {
			return (this as { session: { sessionManager: unknown } }).session.sessionManager;
		},
		settingsManager: {
			getBtwModel: () => undefined,
			getBtwMaxHistory: () => 20,
			getBtwPersist: () => true,
		},
		runtimeHost: {
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
		},
		editor: { getText: () => "", setText: vi.fn() },
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		renderWidgets: vi.fn(),
	};

	// Bind private btw methods from the prototype onto this fake so `this.methodName()`
	// calls within them resolve correctly.
	const proto = InteractiveMode.prototype as unknown as Record<string, unknown>;
	for (const name of [
		"handleBtwCommand",
		"mountBtwPanel",
		"closeBtwPanel",
		"clearExtensionWidgets",
		"runBtwSideCall",
		"handleBtwPromote",
		"handleBtwAdopt",
	]) {
		if (typeof proto[name] === "function") {
			fake[name] = (proto[name] as (...args: unknown[]) => unknown).bind(fake);
		}
	}

	return fake;
}

// ---------------------------------------------------------------------------
// handleBtwCommand — bare reopen
// ---------------------------------------------------------------------------

describe("handleBtwCommand", () => {
	test("bare /btw with no history is a no-op", () => {
		const fake = makeFakeInstance();
		(fake.handleBtwCommand as (q: string) => void)("");
		expect(fake.btwPanel).toBeUndefined();
		expect(fake.renderWidgets).not.toHaveBeenCalled();
	});

	test("bare /btw with existing history reopens the last panel", () => {
		const fake = makeFakeInstance();
		(fake.btwHistory as ReturnType<typeof createSideQuestionHistory>).append({
			question: "q1",
			answer: "a1",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		(fake.handleBtwCommand as (q: string) => void)("");
		expect(fake.btwPanel).toBeDefined();
		expect(fake.renderWidgets).toHaveBeenCalled();
		expect((fake.ui as { setFocus: ReturnType<typeof vi.fn> }).setFocus).toHaveBeenCalledWith(fake.btwPanel);
	});

	test("/btw with a question mounts the panel in pending state", () => {
		const fake = makeFakeInstance();
		// Stub runBtwSideCall so no real LLM call fires
		fake.runBtwSideCall = vi.fn().mockResolvedValue(undefined);
		(fake.handleBtwCommand as (q: string) => void)("what is EINTR");
		expect(fake.btwPanel).toBeDefined();
		expect(fake.renderWidgets).toHaveBeenCalled();
		expect(fake.runBtwSideCall).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// mountBtwPanel
// ---------------------------------------------------------------------------

describe("mountBtwPanel", () => {
	test("mounts a panel in extensionWidgetsAbove and focuses it", () => {
		const fake = makeFakeInstance();
		(fake.mountBtwPanel as (...args: unknown[]) => void)("test question", [], undefined, undefined, undefined);
		expect((fake.extensionWidgetsAbove as Map<string, unknown>).get("btw")).toBeInstanceOf(BtwPanel);
		expect(fake.btwPanel).toBeInstanceOf(BtwPanel);
		expect((fake.ui as { setFocus: ReturnType<typeof vi.fn> }).setFocus).toHaveBeenCalledWith(fake.btwPanel);
	});

	test("replaces existing panel when called again", () => {
		const fake = makeFakeInstance();
		(fake.mountBtwPanel as (...args: unknown[]) => void)("q1", [], undefined, undefined, undefined);
		const first = fake.btwPanel;
		(fake.mountBtwPanel as (...args: unknown[]) => void)("q2", [], undefined, undefined, undefined);
		const second = fake.btwPanel;
		expect(first).not.toBe(second);
		expect((fake.extensionWidgetsAbove as Map<string, unknown>).size).toBe(1);
	});

	test("M1: aborts the old panel's side call before replacing", () => {
		const fake = makeFakeInstance();
		(fake.mountBtwPanel as (...args: unknown[]) => void)("q1", [], undefined, undefined, undefined);
		const first = fake.btwPanel as BtwPanel;
		expect(first.signal.aborted).toBe(false);
		// Replace with a second panel
		(fake.mountBtwPanel as (...args: unknown[]) => void)("q2", [], undefined, undefined, undefined);
		// The first panel's signal must now be aborted
		expect(first.signal.aborted).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// closeBtwPanel
// ---------------------------------------------------------------------------

describe("closeBtwPanel", () => {
	test("removes panel from extensionWidgetsAbove and restores editor focus", () => {
		const fake = makeFakeInstance();
		(fake.mountBtwPanel as (...args: unknown[]) => void)("question", [], undefined, undefined, undefined);
		expect(fake.btwPanel).toBeDefined();
		(fake.closeBtwPanel as () => void)();
		expect(fake.btwPanel).toBeUndefined();
		expect((fake.extensionWidgetsAbove as Map<string, unknown>).has("btw")).toBe(false);
		expect((fake.ui as { setFocus: ReturnType<typeof vi.fn> }).setFocus).toHaveBeenLastCalledWith(fake.editor);
	});

	test("is a no-op when no panel is mounted", () => {
		const fake = makeFakeInstance();
		expect(() => (fake.closeBtwPanel as () => void)()).not.toThrow();
		expect(fake.renderWidgets).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// M3: btwPanel cleared on session invalidation (clearExtensionWidgets)
// ---------------------------------------------------------------------------

describe("M3 btwPanel cleared on clearExtensionWidgets", () => {
	test("btwPanel reference is nulled when clearExtensionWidgets is called", () => {
		const fake = makeFakeInstance();
		(fake.mountBtwPanel as (...args: unknown[]) => void)("question", [], undefined, undefined, undefined);
		expect(fake.btwPanel).toBeDefined();
		// Simulate session invalidation by calling clearExtensionWidgets
		(fake.clearExtensionWidgets as () => void)();
		expect(fake.btwPanel).toBeUndefined();
		expect((fake.extensionWidgetsAbove as Map<string, unknown>).has("btw")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// handleBtwAdopt
// ---------------------------------------------------------------------------

describe("handleBtwAdopt", () => {
	test("injects the Q&A as a nextTurn custom message and shows status", async () => {
		const fake = makeFakeInstance();
		await (fake.handleBtwAdopt as (item: { question: string; answer?: string }) => Promise<void>)({
			question: "what is X",
			answer: "X is Y",
		});
		expect((fake.session as { sendCustomMessage: ReturnType<typeof vi.fn> }).sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "btw", display: false }),
			{ deliverAs: "nextTurn" },
		);
		expect(fake.showStatus).toHaveBeenCalledWith(expect.stringContaining("next turn"));
	});

	test("is a no-op when answer is missing", async () => {
		const fake = makeFakeInstance();
		await (fake.handleBtwAdopt as (item: { question: string; answer?: string }) => Promise<void>)({
			question: "what is X",
		});
		expect(
			(fake.session as { sendCustomMessage: ReturnType<typeof vi.fn> }).sendCustomMessage,
		).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// handleBtwPromote
// ---------------------------------------------------------------------------

describe("handleBtwPromote", () => {
	test("creates a new background session file with context and Q&A without switching current session", async () => {
		const fake = makeFakeInstance();
		await (fake.handleBtwPromote as (item: { question: string; answer?: string }) => Promise<void>)({
			question: "deep dive on X",
			answer: "X is complex",
		});
		// H4: runtimeHost.newSession must NOT be called (it would abort/switch current session).
		expect((fake.runtimeHost as { newSession: ReturnType<typeof vi.fn> }).newSession).not.toHaveBeenCalled();
		// showStatus reports the outcome.
		expect(fake.showStatus).toHaveBeenCalled();
		// showError must not be called on success.
		expect(fake.showError).not.toHaveBeenCalled();
	});

	test("is a no-op when answer is missing", async () => {
		const fake = makeFakeInstance();
		await (fake.handleBtwPromote as (item: { question: string; answer?: string }) => Promise<void>)({
			question: "x",
		});
		expect((fake.runtimeHost as { newSession: ReturnType<typeof vi.fn> }).newSession).not.toHaveBeenCalled();
		expect(fake.showStatus).not.toHaveBeenCalled();
	});
});
