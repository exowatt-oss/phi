import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

type BackgroundReady = {
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	fromExtension: boolean;
	newContext?: { handoff?: string };
	baselineCompactionId: string | null;
	snapshotTokens?: number;
};

type SessionInternals = {
	_backgroundCompactionReady?: BackgroundReady;
	_backgroundCompaction?: { promise: Promise<void> };
	_startBackgroundCompaction: (
		settings: ReturnType<SettingsManager["getCompactionSettings"]>,
		contextWindow: number,
		snapshotTokens?: number,
	) => void;
	_applyBackgroundCompaction: () => Promise<boolean>;
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
	_extensionRunner: {
		hasHandlers: (eventType: string) => boolean;
		emit: (event: unknown) => Promise<unknown>;
	};
};

async function withContextAware<T>(fn: () => Promise<T>): Promise<T> {
	const previousTuiMode = process.env.PI_TUI_MODE;
	const previousBudget = process.env.PI_CONTEXT_BUDGET;
	process.env.PI_TUI_MODE = "1";
	delete process.env.PI_CONTEXT_BUDGET;
	try {
		return await fn();
	} finally {
		if (previousTuiMode === undefined) delete process.env.PI_TUI_MODE;
		else process.env.PI_TUI_MODE = previousTuiMode;
		if (previousBudget === undefined) delete process.env.PI_CONTEXT_BUDGET;
		else process.env.PI_CONTEXT_BUDGET = previousBudget;
	}
}

describe("AgentSession mid-run compaction", () => {
	let session: AgentSession;
	let settingsManager: SettingsManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-midrun-compaction-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		// These thresholds describe a fixed 300k window, independent of catalog changes.
		const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, contextWindow: 300_000 };
		const agent = new Agent({ streamFn: streamSimple, initialState: { model, systemPrompt: "Test", tools: [] } });
		settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const registry = await createModelRegistry(authStorage, tempDir);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(registry),
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function turn(
		overThreshold: boolean,
		options: { withToolCall?: boolean; stopReason?: AssistantMessage["stopReason"]; tokens?: number } = {},
	): AssistantMessage {
		const withToolCall = options.withToolCall ?? true;
		const model = session.model!;
		const tokens = options.tokens ?? (overThreshold ? (model.contextWindow ?? 200_000) : 1);
		return {
			role: "assistant",
			content: withToolCall
				? [{ type: "toolCall", id: "call-1", name: "test", arguments: {} }]
				: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: tokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// Providers report tool-calling turns as "toolUse"; the real loop
			// context is what the hook receives, so include the message in it.
			stopReason: options.stopReason ?? "toolUse",
			timestamp: Date.now(),
		};
	}

	async function prepare(
		message: AssistantMessage,
		extraContextMessages: AgentMessage[] = [],
		compaction?: { notes: string; keep?: string[]; mode: "summarize" | "fresh" },
	) {
		const hook = session.agent.prepareNextTurnWithContext!;
		const contextMessages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "long" }], timestamp: Date.now() },
			message,
			...extraContextMessages,
		];
		return hook({
			message,
			toolResults: [],
			context: { ...session.agent.state, messages: contextMessages },
			newMessages: [],
			compaction,
		});
	}

	function spyOnAutoCompaction(implementation?: () => Promise<boolean>) {
		return vi
			.spyOn(
				session as unknown as { _runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean> },
				"_runAutoCompaction",
			)
			.mockImplementation(implementation ?? (async () => false));
	}

	it("compacts at a toolUse turn boundary and replaces messages", async () => {
		const compactedMessages = [
			{ role: "user", content: [{ type: "text", text: "summary" }], timestamp: Date.now() },
		] as typeof session.agent.state.messages;
		const spy = spyOnAutoCompaction(async () => {
			session.agent.state.messages = compactedMessages;
			return false;
		});
		const snapshot = await prepare(turn(true));
		expect(spy).toHaveBeenCalledWith("threshold", false);
		expect(snapshot?.context?.messages).toEqual(compactedMessages);
	});

	it("keeps an active deferred tool across compaction and later turns", async () => {
		const deferredTool: ToolDefinition = {
			name: "mcp_demo_ping",
			label: "Demo Ping",
			description: "Deferred MCP test tool",
			exposure: "deferred",
			autoActivateOnCall: true,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
		};
		// Every turn re-applies the tool loadout from the session's registry (upstream 1.x), so the deferred
		// tool must be registered, then activated the way a model call activates it: through the resolver.
		const model = session.model!;
		session.dispose();
		session = new AgentSession({
			agent: new Agent({ streamFn: streamSimple, initialState: { model, systemPrompt: "Test", tools: [] } }),
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(
				await createModelRegistry(AuthStorage.create(join(tempDir, "auth.json")), tempDir),
			),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: {},
			customTools: [deferredTool],
		});
		expect(session.getActiveToolNames()).toEqual([]);
		const resolved = await session.agent.resolveToolCall?.("mcp_demo_ping", { messages: [] });
		expect(resolved?.name).toBe("mcp_demo_ping");
		expect(session.getActiveToolNames()).toEqual(["mcp_demo_ping"]);
		spyOnAutoCompaction(async () => {
			session.agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "summary" }], timestamp: Date.now() },
			];
			return true;
		});

		const compacted = await prepare(turn(true));
		expect(compacted?.context?.tools?.map((tool) => tool.name)).toEqual(["mcp_demo_ping"]);
		expect(session.getActiveToolNames()).toEqual(["mcp_demo_ping"]);

		const laterTurn = await prepare(turn(false));
		expect(laterTurn?.context?.tools?.map((tool) => tool.name)).toEqual(["mcp_demo_ping"]);
	});

	it("does not alias the loop context to the agent's internal state array", async () => {
		spyOnAutoCompaction(async () => {
			session.agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "summary" }], timestamp: Date.now() },
			];
			return true;
		});
		const snapshot = await prepare(turn(true));
		const loopMessages = snapshot?.context?.messages;
		expect(loopMessages).toEqual(session.agent.state.messages);
		// A shared array would double-append every subsequent message: the loop
		// pushes streamed partials into its context while message_end pushes into
		// agent state.
		loopMessages?.push({ role: "user", content: [{ type: "text", text: "loop-only" }], timestamp: Date.now() });
		expect(session.agent.state.messages).toHaveLength(1);
	});

	it('compacts "stop" turns that carry tool calls (gateway behavior)', async () => {
		const spy = spyOnAutoCompaction();
		await prepare(turn(true, { stopReason: "stop" }));
		expect(spy).toHaveBeenCalledWith("threshold", false);
	});

	it('compacts "length" turns that carry tool calls (loop continues with failed calls)', async () => {
		const spy = spyOnAutoCompaction();
		await prepare(turn(true, { stopReason: "length" }));
		expect(spy).toHaveBeenCalledWith("threshold", false);
	});

	it("counts trailing tool results the last usage cannot include yet", async () => {
		const spy = spyOnAutoCompaction();
		const model = session.model!;
		const settings = settingsManager.getCompactionSettings();
		const threshold = (model.contextWindow ?? 200_000) - settings.reserveTokens;
		// Usage alone is safely under the threshold...
		const message = turn(false, { tokens: Math.max(1, threshold - 10_000) });
		// ...but the turn's tool results add far more than the remaining headroom.
		const bigToolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "test",
			content: [{ type: "text", text: "x".repeat(80_000) }],
			isError: false,
			timestamp: Date.now(),
		};
		await prepare(message, [bigToolResult]);
		expect(spy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not compact below threshold", async () => {
		const spy = spyOnAutoCompaction();
		await prepare(turn(false));
		expect(spy).not.toHaveBeenCalled();
	});

	it("does not compact a final turn without tool calls", async () => {
		const spy = spyOnAutoCompaction();
		await prepare(turn(true, { withToolCall: false, stopReason: "stop" }));
		expect(spy).not.toHaveBeenCalled();
	});

	it("does not compact when disabled", async () => {
		settingsManager.applyOverrides({ compaction: { enabled: false } });
		const spy = spyOnAutoCompaction();
		await prepare(turn(true));
		expect(spy).not.toHaveBeenCalled();
	});

	it("does not compact without grounding usage data", async () => {
		const spy = spyOnAutoCompaction();
		await prepare(turn(true, { tokens: 0 }));
		expect(spy).not.toHaveBeenCalled();
	});

	function installReadySummary(snapshotTokens?: number): string {
		const firstKeptEntryId = session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		const internals = session as unknown as SessionInternals;
		internals._backgroundCompactionReady = {
			summary: "background summary",
			firstKeptEntryId,
			tokensBefore: 230_000,
			fromExtension: false,
			baselineCompactionId: null,
			snapshotTokens,
		};
		return firstKeptEntryId;
	}

	it("waits for a ready summary below hard threshold during a run", async () => {
		await withContextAware(async () => {
			installReadySummary(220_000);
			await prepare(turn(true, { tokens: 230_000 }));
			expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		});
	});

	it("applies a ready summary at run end once the window opens", async () => {
		await withContextAware(async () => {
			installReadySummary(220_000);
			const message = turn(false, { tokens: 230_000, withToolCall: false });
			session.agent.state.messages = [message];
			const internals = session as unknown as SessionInternals;
			await internals._checkCompaction(message);
			const entry = session.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");
			expect(entry?.type === "compaction" ? entry.trigger : undefined).toBe("background");
		});
	});

	it("applies a ready summary mid-run above the hard threshold", async () => {
		await withContextAware(async () => {
			installReadySummary(280_000);
			await prepare(turn(true, { tokens: 285_000 }));
			const entry = session.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");
			expect(entry?.type === "compaction" ? entry.trigger : undefined).toBe("background");
		});
	});

	it("restarts a stale ready summary from the current branch", async () => {
		await withContextAware(async () => {
			installReadySummary(180_000);
			const internals = session as unknown as SessionInternals;
			const restart = vi
				.spyOn(
					session as unknown as { _startBackgroundCompaction: (...args: never[]) => void },
					"_startBackgroundCompaction",
				)
				.mockImplementation(() => undefined);
			await prepare(turn(true, { tokens: 230_000 }));
			expect(restart).toHaveBeenCalled();
			expect(internals._backgroundCompactionReady).toBeUndefined();
		});
	});

	it("starts a fresh context for a tool compaction request", async () => {
		await withContextAware(async () => {
			const snapshot = await prepare(turn(true, { tokens: 100_000 }), [], {
				mode: "fresh",
				notes: "resume from checkpoint",
			});
			expect(snapshot?.context?.messages[0]?.role).toBe("custom");
			const contextWindow = session.sessionManager.getEntries().find((entry) => entry.type === "context_window");
			expect(contextWindow?.type).toBe("context_window");
			if (contextWindow?.type === "context_window") expect(contextWindow.handoff).toBe("resume from checkpoint");
		});
	});

	it("honors a fresh-context claim from the background auto hook", async () => {
		await withContextAware(async () => {
			const internals = session as unknown as SessionInternals;
			const originalRunner = internals._extensionRunner;
			const seenEvents: string[] = [];
			internals._extensionRunner = Object.assign(Object.create(originalRunner), {
				hasHandlers: (eventType: string) => eventType === "session_before_auto_compact",
				emit: async (event: unknown) => {
					seenEvents.push((event as { type: string }).type);
					return { newContext: { handoff: "background rollover" } };
				},
			});
			internals._startBackgroundCompaction(
				session.settingsManager.getCompactionSettings(),
				session.model!.contextWindow,
				230_000,
			);
			const background = internals._backgroundCompaction;
			await background?.promise;
			expect(seenEvents).toEqual(["session_before_auto_compact"]);
			expect(internals._backgroundCompactionReady?.newContext?.handoff).toBe("background rollover");
			await internals._applyBackgroundCompaction();
			expect(session.sessionManager.getEntries().some((entry) => entry.type === "context_window")).toBe(true);
			expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		});
	});

	it("adds a checkpoint custom message below the background window", async () => {
		await withContextAware(async () => {
			const snapshot = await prepare(turn(true, { tokens: 100_000 }), [], {
				mode: "summarize",
				notes: "remember this",
				keep: ["constraint"],
			});
			expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			expect(snapshot?.context?.messages.at(-1)?.role).toBe("custom");
		});
	});

	it("merges checkpoint notes into a ready summary", async () => {
		await withContextAware(async () => {
			installReadySummary(220_000);
			const snapshot = await prepare(turn(true, { tokens: 230_000 }), [], {
				mode: "summarize",
				notes: "checkpoint note",
			});
			const entry = session.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");
			expect(entry?.type === "compaction" ? entry.trigger : undefined).toBe("checkpoint");
			expect(entry?.type === "compaction" ? entry.summary : "").toMatch(/^## Checkpoint \(model-authored\)/);
			expect(snapshot?.context?.messages[0]?.role).toBe("compactionSummary");
		});
	});
});
