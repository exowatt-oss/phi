import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { Extension, ExtensionContext } from "../src/core/extensions/types.ts";
import contextBudgetExtension from "../src/extensions/context-budget/index.ts";
import { toolContext } from "./tool-context.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

type SentMessage = {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
};

function context(tokens: number | null): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: {} as ExtensionContext["ui"],
		cwd: process.cwd(),
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({
			tokens,
			contextWindow: 200_000,
			percent: tokens === null ? null : tokens / 200_000,
		}),
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 0, softCeilingTokens: 0 }),
		newContext: vi.fn(),
		compact: vi.fn(),
		getSystemPrompt: () => "",
		getContextBreakdown: () => undefined,
	};
}

async function loadBudget(): Promise<{ extension: Extension; sent: SentMessage[] }> {
	const runtime = createExtensionRuntime();
	const sent: SentMessage[] = [];
	runtime.sendMessage = ((message: Record<string, unknown>, options: Record<string, unknown> | undefined) => {
		sent.push({ message, options });
	}) as never;
	const extension = await loadExtensionFromFactory(
		contextBudgetExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"<inline:context-budget>",
	);
	return { extension, sent };
}

async function invoke(extension: Extension, name: string, ctx: ExtensionContext): Promise<void> {
	for (const handler of (extension.handlers.get(name) ?? []) as Handler[]) {
		await handler({ type: name }, ctx);
	}
}

let previousTuiMode: string | undefined;
let previousContextBudget: string | undefined;

beforeEach(() => {
	previousTuiMode = process.env.PI_TUI_MODE;
	previousContextBudget = process.env.PI_CONTEXT_BUDGET;
	process.env.PI_TUI_MODE = "1";
	delete process.env.PI_CONTEXT_BUDGET;
});

afterEach(() => {
	if (previousTuiMode === undefined) delete process.env.PI_TUI_MODE;
	else process.env.PI_TUI_MODE = previousTuiMode;
	if (previousContextBudget === undefined) delete process.env.PI_CONTEXT_BUDGET;
	else process.env.PI_CONTEXT_BUDGET = previousContextBudget;
});

describe("context-budget extension", () => {
	it("does not send a budget line below 60%", async () => {
		const { extension, sent } = await loadBudget();
		await invoke(extension, "turn_end", context(119_999));
		expect(sent).toHaveLength(0);
	});

	it("sends one line at 60% and uses the hidden ephemeral next-turn delivery", async () => {
		const { extension, sent } = await loadBudget();
		await invoke(extension, "turn_end", context(120_000));
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			message: { customType: "context-budget", display: false, ephemeral: true },
			options: { deliverAs: "nextTurn" },
		});
		expect(sent[0]?.message.content).toContain("Used 120k of 200k effective context (200k raw)");
	});

	it("emits at the window-open boundary", async () => {
		const { extension, sent } = await loadBudget();
		await invoke(extension, "turn_end", context(160_000));
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.content).toContain("The compaction window is open (160k–200k)");
	});

	it("re-emits below the window after checkpoint() records notes", async () => {
		const { extension, sent } = await loadBudget();
		const checkpoint = extension.tools.get("checkpoint")?.definition;
		expect(checkpoint).toBeDefined();
		await checkpoint?.execute(
			"call-1",
			{ notes: "Keep this handoff." },
			undefined,
			undefined,
			toolContext(context(80_000)),
		);
		await invoke(extension, "turn_end", context(80_000));
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.content).toContain("The compaction window opens at 160k");
	});

	it("uses five-percent hysteresis after the first line", async () => {
		const { extension, sent } = await loadBudget();
		await invoke(extension, "turn_end", context(120_000));
		await invoke(extension, "turn_end", context(122_000));
		await invoke(extension, "turn_end", context(124_000));
		expect(sent).toHaveLength(1);

		await invoke(extension, "turn_end", context(130_000));
		expect(sent).toHaveLength(2);
	});

	it("registers nothing when TUI mode is unset", async () => {
		delete process.env.PI_TUI_MODE;
		const { extension } = await loadBudget();
		expect(extension.handlers.size).toBe(0);
		expect(extension.tools.size).toBe(0);
	});
});
