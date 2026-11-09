import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	getModel,
	streamSimple,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { contextAwareCompactionEnabled } from "../src/core/context-aware-compaction.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

const SYSTEM_PROMPT = "You are a helpful assistant with a deliberately long-ish system prompt for token accounting.";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(text: string, totalTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

function createUserMessage(text: string, timestamp: number) {
	return { role: "user" as const, content: text, timestamp };
}

function createToolResultMessage(text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `tool-call-${timestamp}`,
		toolName: "test_tool",
		content: [{ type: "text", text }],
		usage: createUsage(0),
		isError: false,
		timestamp,
	};
}

async function createSession() {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: SYSTEM_PROMPT,
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
		resourceLoader: createTestResourceLoader(),
	});
	return { session, sessionManager };
}

function syncAgentMessages(session: AgentSession, sessionManager: SessionManager): void {
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
}

describe("AgentSession.getContextBreakdown", () => {
	it("reports the authoritative total plus a per-category estimate", async () => {
		const { session, sessionManager } = await createSession();
		try {
			sessionManager.appendMessage(createUserMessage("hello there", 1));
			sessionManager.appendMessage(createAssistantMessage("general kenobi", 500, 2));
			syncAgentMessages(session, sessionManager);

			const breakdown = session.getContextBreakdown();
			expect(breakdown).toBeDefined();
			if (!breakdown) return;

			// Headline numbers agree with getContextUsage (provider usage is authoritative).
			const usage = session.getContextUsage();
			expect(breakdown.total).toBe(usage?.tokens);
			expect(breakdown.percent).toBe(usage?.percent);
			expect(breakdown.contextWindow).toBe(model.contextWindow);

			// System prompt is attributed and non-zero.
			expect(breakdown.systemPrompt.tokens).toBeGreaterThan(0);

			// Tool definitions are counted, and cost tokens whenever any tool is active.
			expect(breakdown.tools.count).toBe(session.getActiveToolNames().length);
			expect(breakdown.tools.tokens).toBeGreaterThan(0);

			// Messages are bucketed by role with counts.
			expect(breakdown.messages.byRole.user?.count).toBe(1);
			expect(breakdown.messages.byRole.assistant?.count).toBe(1);
			expect(breakdown.messages.total).toBeGreaterThan(0);

			// estimatedTotal is the sum of the categories.
			expect(breakdown.estimatedTotal).toBe(
				breakdown.systemPrompt.tokens + breakdown.tools.tokens + breakdown.messages.total,
			);
		} finally {
			session.dispose();
		}
	});

	it("buckets tool results separately so context bloat is attributable", async () => {
		const { session, sessionManager } = await createSession();
		try {
			sessionManager.appendMessage(createUserMessage("read a file", 1));
			sessionManager.appendMessage(createToolResultMessage("x".repeat(8000), 2));
			sessionManager.appendMessage(createAssistantMessage("done", 3000, 3));
			syncAgentMessages(session, sessionManager);

			const breakdown = session.getContextBreakdown();
			expect(breakdown).toBeDefined();
			if (!breakdown) return;

			const toolResults = breakdown.messages.byRole.toolResult;
			expect(toolResults?.count).toBe(1);
			// The large tool result should dominate the message tokens.
			expect(toolResults?.tokens ?? 0).toBeGreaterThan(breakdown.messages.byRole.user?.tokens ?? 0);
			expect(toolResults?.tokens ?? 0).toBeGreaterThan(1000);
		} finally {
			session.dispose();
		}
	});

	it("surfaces the auto-compaction threshold derived from settings", async () => {
		const { session, sessionManager } = await createSession();
		try {
			sessionManager.appendMessage(createUserMessage("hi", 1));
			sessionManager.appendMessage(createAssistantMessage("hello", 100, 2));
			syncAgentMessages(session, sessionManager);

			const breakdown = session.getContextBreakdown();
			expect(breakdown).toBeDefined();
			if (!breakdown) return;

			const settings = session.settingsManager.getCompactionSettings();
			expect(breakdown.compaction.enabled).toBe(settings.enabled);
			expect(breakdown.compaction.reserveTokens).toBe(settings.reserveTokens);
			const expectedEffectiveWindow = Math.min(model.contextWindow, settings.softCeilingTokens);
			const thresholdWindow = contextAwareCompactionEnabled() ? expectedEffectiveWindow : model.contextWindow;
			expect(breakdown.compaction.threshold).toBe(
				settings.enabled ? thresholdWindow - settings.reserveTokens : null,
			);
			expect(breakdown.compaction.effectiveWindow).toBe(expectedEffectiveWindow);
			expect(breakdown.compaction.windowOpenAt).toBe(
				Math.floor(0.8 * (expectedEffectiveWindow - settings.reserveTokens)),
			);
		} finally {
			session.dispose();
		}
	});

	it("reports an unknown total immediately after compaction, but still breaks down categories", async () => {
		const { session, sessionManager } = await createSession();
		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("hello", 100, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendCompaction("summary of earlier work", keptUserId, 100);
			syncAgentMessages(session, sessionManager);

			const breakdown = session.getContextBreakdown();
			expect(breakdown).toBeDefined();
			if (!breakdown) return;

			// Total is unknown until the next assistant response after compaction...
			expect(breakdown.total).toBeNull();
			expect(breakdown.percent).toBeNull();
			// ...but the fixed overhead is still knowable.
			expect(breakdown.systemPrompt.tokens).toBeGreaterThan(0);
			expect(breakdown.contextWindow).toBe(model.contextWindow);
		} finally {
			session.dispose();
		}
	});
});
