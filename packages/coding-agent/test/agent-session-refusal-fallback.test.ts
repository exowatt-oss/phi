import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type AssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

/** A structural Anthropic-style decline (stop_reason: "refusal" -> refusal details). */
function refusalMessage(): AssistantMessage {
	return createAssistantMessage("", {
		stopReason: "error",
		errorMessage: "The model's safety classifier declined this request (category: cyber): nope.",
		refusal: { category: "cyber", explanation: "nope" },
	});
}

const HEAD = "anthropic/claude-sonnet-4-5";
const MIDDLE = "anthropic/claude-opus-4-5";
const TAIL = "anthropic/claude-haiku-4-5";

describe("AgentSession refusal fallback", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-refusal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		delete process.env.PI_REFUSAL_FALLBACK_CHAIN;
		delete process.env.PI_DEBUG_FORCE_REFUSAL;
	});

	/**
	 * @param declineCount how many leading turns are declined by their model
	 * @param chain refusalFallback.chain, or undefined to leave it unset
	 */
	async function createSession(options: {
		declineCount: number;
		chain?: string[];
		sticky?: boolean;
		enabled?: boolean;
		authProviders?: string[];
	}) {
		const modelsUsed: string[] = [];
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (streamModel) => {
				callCount++;
				modelsUsed.push(`${streamModel.provider}/${streamModel.id}`);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (callCount <= options.declineCount) {
						const msg = refusalMessage();
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Answered");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		for (const provider of options.authProviders ?? ["anthropic"]) {
			await authStorage.modify(provider, async () => ({ type: "api_key", key: "test-key" }));
		}
		settingsManager.applyOverrides({
			// Keep the same-model retry budget out of the way: refusals must not consume it.
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			...(options.chain
				? {
						refusalFallback: {
							enabled: options.enabled ?? true,
							chain: options.chain,
							sticky: options.sticky ?? true,
						},
					}
				: {}),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			if (event.type.startsWith("refusal_fallback") || event.type.startsWith("auto_retry")) events.push(event);
		});

		return { session, settingsManager, sessionManager, events, modelsUsed, getCallCount: () => callCount };
	}

	it("escalates to the next model in the chain and replays the declined turn", async () => {
		const created = await createSession({ declineCount: 1, chain: [HEAD, MIDDLE, TAIL] });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.modelsUsed).toEqual([HEAD, MIDDLE]);
		const escalations = created.events.filter((event) => event.type === "refusal_fallback");
		expect(escalations).toHaveLength(1);
		expect(escalations[0]).toMatchObject({ category: "cyber", from: HEAD, to: MIDDLE, rung: 2, chainLength: 3 });
		// The session now runs on the fallback model (sticky default).
		expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe(MIDDLE);
	});

	it("walks the whole chain when every rung declines, then leaves the error terminal", async () => {
		const created = await createSession({ declineCount: 99, chain: [HEAD, MIDDLE, TAIL] });

		await created.session.prompt("Test");

		expect(created.modelsUsed).toEqual([HEAD, MIDDLE, TAIL]);
		const exhausted = created.events.filter((event) => event.type === "refusal_fallback_exhausted");
		expect(exhausted).toHaveLength(1);
		expect(exhausted[0]).toMatchObject({ from: TAIL });
		// A refusal must never spend the same-model retry budget.
		expect(created.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(0);
	});

	it("does not overwrite the user's default model when escalating", async () => {
		const created = await createSession({ declineCount: 1, chain: [HEAD, MIDDLE, TAIL] });

		await created.session.prompt("Test");

		expect(created.settingsManager.getDefaultModel()).toBe("claude-sonnet-4-5");
		expect(created.settingsManager.getDefaultProvider()).toBe("anthropic");
	});

	it("records the escalation in the session as a model change", async () => {
		const created = await createSession({ declineCount: 1, chain: [HEAD, MIDDLE, TAIL] });

		await created.session.prompt("Test");

		const modelChanges = created.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "model_change")
			.map((entry) => `${(entry as { provider: string }).provider}/${(entry as { modelId: string }).modelId}`);
		expect(modelChanges).toContain(MIDDLE);
	});

	it("restores the head of the chain after the run when sticky is false", async () => {
		const created = await createSession({ declineCount: 1, chain: [HEAD, MIDDLE, TAIL], sticky: false });

		await created.session.prompt("Test");

		expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe(HEAD);
		expect(created.events.filter((event) => event.type === "refusal_fallback_restored")).toHaveLength(1);
	});

	it("skips rungs whose provider has no auth configured", async () => {
		const created = await createSession({
			declineCount: 1,
			// openai sits between the anthropic rungs but has no credentials in this test.
			chain: [HEAD, "openai/gpt-5", MIDDLE],
			authProviders: ["anthropic"],
		});

		await created.session.prompt("Test");

		expect(created.modelsUsed).toEqual([HEAD, MIDDLE]);
	});

	it("ignores unresolvable refs instead of stalling the ladder", async () => {
		const created = await createSession({
			declineCount: 1,
			chain: [HEAD, "anthropic/no-such-model", "not-a-ref", MIDDLE],
		});

		await created.session.prompt("Test");

		expect(created.modelsUsed).toEqual([HEAD, MIDDLE]);
	});

	it("escalates into the chain at the head when the current model is not a rung", async () => {
		// A model picked ad hoc (--model, /model) is not necessarily in the chain; the
		// ladder should still take over rather than having nowhere to go.
		const created = await createSession({ declineCount: 1, chain: [MIDDLE, TAIL] });

		await created.session.prompt("Test");

		expect(created.modelsUsed).toEqual([HEAD, MIDDLE]);
		expect(created.events.filter((event) => event.type === "refusal_fallback")[0]).toMatchObject({
			from: HEAD,
			to: MIDDLE,
			rung: 1,
		});
	});

	it("does nothing when no chain is configured", async () => {
		const created = await createSession({ declineCount: 1 });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(1);
		expect(created.events).toHaveLength(0);
	});

	it("does nothing when disabled, even with a chain", async () => {
		const created = await createSession({ declineCount: 1, chain: [HEAD, MIDDLE], enabled: false });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(1);
	});

	it("PI_REFUSAL_FALLBACK_CHAIN=off disables a configured chain", async () => {
		process.env.PI_REFUSAL_FALLBACK_CHAIN = "off";
		const created = await createSession({ declineCount: 1, chain: [HEAD, MIDDLE] });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(1);
	});

	it("PI_REFUSAL_FALLBACK_CHAIN overrides the configured chain", async () => {
		process.env.PI_REFUSAL_FALLBACK_CHAIN = `${HEAD}, ${TAIL}`;
		const created = await createSession({ declineCount: 1, chain: [HEAD, MIDDLE] });

		await created.session.prompt("Test");

		expect(created.modelsUsed).toEqual([HEAD, TAIL]);
	});

	it("PI_DEBUG_FORCE_REFUSAL forces the ladder on turns the model answered fine", async () => {
		process.env.PI_DEBUG_FORCE_REFUSAL = "2";
		// declineCount 0: the model answers every call, and the hook declines the
		// first two anyway — how an escalation is demonstrated without a nasty prompt.
		const created = await createSession({ declineCount: 0, chain: [HEAD, MIDDLE, TAIL] });

		await created.session.prompt("Test");

		expect(created.modelsUsed).toEqual([HEAD, MIDDLE, TAIL]);
		expect(created.events.filter((event) => event.type === "refusal_fallback")).toHaveLength(2);
	});

	it("escalates a proxied decline that only carries error text", async () => {
		const created = await createSession({ declineCount: 0, chain: [HEAD, MIDDLE] });
		created.session.dispose();

		// A gateway (OpenAI-completions shaped) flattens the decline into a string:
		// no stop_details, so detection has to fall back to the text signature.
		const modelsUsed: string[] = [];
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (streamModel) => {
				callCount++;
				modelsUsed.push(`${streamModel.provider}/${streamModel.id}`);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "litellm.BadRequestError: response was blocked by content filter",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Answered");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			refusalFallback: { chain: [HEAD, MIDDLE] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		await session.prompt("Test");

		expect(modelsUsed).toEqual([HEAD, MIDDLE]);
	});
});
