import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type PromptDisposition } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

/**
 * Turn-triggering inputs (extension messages like background subagent results,
 * programmatic prompts) must never race an in-flight compaction: the
 * compaction's context rebuild replaces agent.state.messages wholesale, which
 * corrupts a concurrently started run. They queue instead, and the session
 * flushes the queue when compaction ends.
 */
describe("AgentSession compaction/turn serialization", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-compaction-queueing-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({ streamFn: streamSimple, initialState: { model, systemPrompt: "Test", tools: [] } });
		const settingsManager = SettingsManager.create(tempDir, tempDir);
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
		vi.restoreAllMocks();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function simulateActiveCompaction(): AbortController {
		const controller = new AbortController();
		(
			session as unknown as { _autoCompactionAbortController: AbortController | undefined }
		)._autoCompactionAbortController = controller;
		return controller;
	}

	function clearActiveCompaction(): void {
		(
			session as unknown as { _autoCompactionAbortController: AbortController | undefined }
		)._autoCompactionAbortController = undefined;
	}

	it("queues triggerTurn custom messages while compacting instead of starting a run", async () => {
		simulateActiveCompaction();
		const runPromptSpy = vi.spyOn(
			session as unknown as { _startRun: (trigger: unknown) => Promise<void> },
			"_startRun",
		);

		await session.sendCustomMessage(
			{
				customType: "subagent-results",
				content: [{ type: "text", text: "results" }],
				display: true,
				details: {},
			},
			{ triggerTurn: true },
		);

		expect(runPromptSpy).not.toHaveBeenCalled();
		expect(session.isStreaming).toBe(false);
		expect(session.agent.hasQueuedMessages()).toBe(true);
	});

	it("starts turns for triggerTurn custom messages when not compacting", async () => {
		const runPromptSpy = vi
			.spyOn(session as unknown as { _startRun: (trigger: unknown) => Promise<void> }, "_startRun")
			.mockResolvedValue();

		await session.sendCustomMessage(
			{ customType: "subagent-results", content: [{ type: "text", text: "results" }], display: true, details: {} },
			{ triggerTurn: true },
		);

		expect(runPromptSpy).toHaveBeenCalledTimes(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("queues prompts while compacting instead of racing the rebuild", async () => {
		simulateActiveCompaction();
		const runPromptSpy = vi.spyOn(
			session as unknown as { _startRun: (trigger: unknown) => Promise<void> },
			"_startRun",
		);

		let disposition: PromptDisposition | undefined;
		await session.prompt("hello there", {
			preflightResult: (result) => {
				disposition = result;
			},
		});

		expect(runPromptSpy).not.toHaveBeenCalled();
		expect(disposition).toBe("queued");
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(session.getFollowUpMessages()).toContain("hello there");
	});

	it("acknowledges prompts before threshold compaction completes", async () => {
		const model = session.model!;
		const contextWindow = model.contextWindow ?? 200_000;
		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: contextWindow,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: contextWindow,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as unknown as (typeof session.agent.state.messages)[number];
		session.agent.state.messages.push(assistantMessage);
		(session as unknown as { _reportedUsagePrefix: unknown })._reportedUsagePrefix = {
			provider: model.provider,
			model: model.id,
			systemPrompt: session.agent.state.systemPrompt,
			tools: session.agent.state.tools,
		};

		let releaseCompaction!: () => void;
		let compactionStarted!: () => void;
		const compactionComplete = new Promise<boolean>((resolve) => {
			releaseCompaction = () => resolve(false);
		});
		const compactionStartedPromise = new Promise<void>((resolve) => {
			compactionStarted = resolve;
		});
		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
				},
				"_runAutoCompaction",
			)
			.mockImplementation(async () => {
				compactionStarted();
				return await compactionComplete;
			});
		// The pre-prompt compaction check runs inside the run start (`_startRun` → `_prepareRun`),
		// so stub the agent run itself.
		const runPromptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();

		let disposition: PromptDisposition | undefined;
		const promptPromise = session.prompt("hello", {
			preflightResult: (result) => {
				disposition = result;
			},
		});

		await compactionStartedPromise;
		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
		expect(disposition).toBe("started");
		expect(runPromptSpy).not.toHaveBeenCalled();

		releaseCompaction();
		await promptPromise;
		expect(runPromptSpy).toHaveBeenCalledTimes(1);
	});

	it("flushes messages queued during compaction once it ends", async () => {
		simulateActiveCompaction();
		await session.sendCustomMessage(
			{ customType: "subagent-results", content: [{ type: "text", text: "results" }], display: true, details: {} },
			{ triggerTurn: true },
		);
		clearActiveCompaction();

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});
		(session as unknown as { _maybeStartQueuedRun: () => void })._maybeStartQueuedRun();
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("does not start a queued run while compaction is still in flight", () => {
		simulateActiveCompaction();
		session.agent.followUp({
			role: "custom",
			customType: "subagent-results",
			content: [{ type: "text", text: "results" }],
			display: false,
			timestamp: Date.now(),
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		(session as unknown as { _maybeStartQueuedRun: () => void })._maybeStartQueuedRun();

		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("does not start a queued run when nothing is queued", () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		(session as unknown as { _maybeStartQueuedRun: () => void })._maybeStartQueuedRun();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("refuses to stack a second compaction on top of a running one", async () => {
		simulateActiveCompaction();

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			}
		)._runAutoCompaction.bind(session);

		await expect(runAutoCompaction("threshold", false)).resolves.toBe(false);
	});

	it("skips compaction checks while a compaction is already running", async () => {
		simulateActiveCompaction();
		const model = session.model!;

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: unknown, skipAbortedCheck?: boolean) => Promise<boolean>;
			}
		)._checkCompaction.bind(session);

		const overThreshold = (model.contextWindow ?? 200_000) + 1;
		const result = await checkCompaction({
			role: "assistant",
			content: [{ type: "text", text: "big" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: overThreshold,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: overThreshold,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		expect(result).toBe(false);
	});
});
