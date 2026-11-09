import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type AssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * A LiteLLM gateway whose upstream front door is down — the exact shape of the
 * 2026-08-06 Bedrock Mantle outage: APIConnectionError wrapping an nginx-style
 * 503 HTML page, with no gateway-side fallback for the model group.
 */
const PROVIDER_DOWN_ERROR =
	'500: {"message":"litellm.APIConnectionError: Bedrock_mantleException - <html><head><title>503 Service Temporarily Unavailable</title></head></html> No fallback model group found for original model_group=example-large-mantle"}';

const QUOTA_ERROR = "Error code: insufficient_quota - You exceeded your current quota, please check your plan.";

/** Transient-looking but not provider-down: stays with the same-model retry budget first. */
const TRANSIENT_ERROR = "500: internal server error";

const HEAD = "anthropic/claude-sonnet-4-5";
const MIDDLE = "anthropic/claude-opus-4-5";
const TAIL = "anthropic/claude-haiku-4-5";
/** Adaptive-thinking model whose `thinkingLevelMap` maps `off` to null: it cannot be asked not to think. */
const NO_OFF_LEVEL = "anthropic/claude-fable-5";

/** The 400 `invalid_grant` body a revoked Anthropic refresh token comes back with. */
function stubDeadRefreshEndpoint(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				),
		),
	);
}

describe("AgentSession error fallback (provider-outage rerouting)", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-error-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		delete process.env.PI_ERROR_FALLBACK_CHAIN;
		vi.unstubAllGlobals();
	});

	/**
	 * @param failCount how many leading calls fail with `errorMessage`
	 * @param chain errorFallback.chain, or undefined to leave the shipped default in place
	 */
	async function createSession(options: {
		failCount: number;
		errorMessage?: string;
		chain?: string[];
		sticky?: boolean;
		enabled?: boolean;
		maxRetries?: number;
		/**
		 * Seed a stale OAuth credential (expired access token) for these providers
		 * instead of a working API key, so their rungs must be probed for real.
		 */
		deadOAuthProviders?: string[];
		/** Providers that get a usable API key alongside any dead OAuth ones. */
		liveApiKeyProviders?: string[];
		/** Awaited before the Nth call answers, for driving the session mid-run. */
		beforeRespond?: (callIndex: number) => Promise<void>;
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
				const thisCall = callCount;
				queueMicrotask(async () => {
					await options.beforeRespond?.(thisCall);
					if (thisCall <= options.failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: options.errorMessage ?? PROVIDER_DOWN_ERROR,
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
		if (options.deadOAuthProviders?.length) {
			for (const providerId of options.deadOAuthProviders) {
				await authStorage.modify(providerId, async () => ({
					type: "oauth",
					access: "stale-access-token",
					refresh: "revoked-refresh-token",
					expires: Date.now() - 60_000,
				}));
			}
		} else {
			await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		}
		for (const providerId of options.liveApiKeyProviders ?? []) {
			await authStorage.modify(providerId, async () => ({ type: "api_key", key: "test-key" }));
		}
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: options.maxRetries ?? 3, baseDelayMs: 1 },
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			...(options.chain
				? {
						errorFallback: {
							enabled: options.enabled ?? true,
							chain: options.chain,
							// Left unset when the test does not care, so the shipped default applies.
							...(options.sticky === undefined ? {} : { sticky: options.sticky }),
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
			if (event.type.startsWith("error_fallback") || event.type.startsWith("auto_retry")) events.push(event);
		});

		return { session, settingsManager, sessionManager, events, modelsUsed, getCallCount: () => callCount };
	}

	it("reroutes a provider-down error to the next model immediately, without spending retries", async () => {
		const created = await createSession({ failCount: 1, chain: [HEAD, MIDDLE, TAIL], sticky: true });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.modelsUsed).toEqual([HEAD, MIDDLE]);
		// A dead endpoint must not consume the same-model retry budget.
		expect(created.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(0);
		const reroutes = created.events.filter((event) => event.type === "error_fallback");
		expect(reroutes).toHaveLength(1);
		expect(reroutes[0]).toMatchObject({ from: HEAD, to: MIDDLE, rung: 2, chainLength: 3 });
		// The session now runs on the fallback model (sticky default).
		expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe(MIDDLE);
	});

	it("reroutes quota/billing exhaustion immediately (non-retryable, but another provider can answer)", async () => {
		const created = await createSession({ failCount: 1, errorMessage: QUOTA_ERROR, chain: [HEAD, MIDDLE] });

		await created.session.prompt("Test");

		expect(created.modelsUsed).toEqual([HEAD, MIDDLE]);
		expect(created.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(0);
		expect(created.events.filter((event) => event.type === "error_fallback")).toHaveLength(1);
	});

	it("lets ordinary transient errors spend the retry budget first, then reroutes on exhaustion", async () => {
		const created = await createSession({
			failCount: 2,
			errorMessage: TRANSIENT_ERROR,
			chain: [HEAD, MIDDLE],
			maxRetries: 1,
		});

		await created.session.prompt("Test");

		// Initial call + 1 same-model retry, then the reroute answers.
		expect(created.modelsUsed).toEqual([HEAD, HEAD, MIDDLE]);
		expect(created.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(1);
		const reroutes = created.events.filter((event) => event.type === "error_fallback");
		expect(reroutes).toHaveLength(1);
		expect(reroutes[0]).toMatchObject({ from: HEAD, to: MIDDLE });
	});

	it("walks the whole chain when everything is down, and reports exhaustion once", async () => {
		const created = await createSession({ failCount: 99, chain: [HEAD, MIDDLE, TAIL], maxRetries: 1 });

		await created.session.prompt("Test");

		// Every rung is tried once; the trailing retry on the last rung is the
		// ordinary same-model budget taking over after the ladder gave up.
		expect(created.modelsUsed.slice(0, 3)).toEqual([HEAD, MIDDLE, TAIL]);
		expect(created.modelsUsed.slice(3).every((ref) => ref === TAIL)).toBe(true);
		const exhausted = created.events.filter((event) => event.type === "error_fallback_exhausted");
		expect(exhausted).toHaveLength(1);
		expect(exhausted[0]).toMatchObject({ from: TAIL });
	});

	it("restores the original model after the run when sticky is false", async () => {
		const created = await createSession({ failCount: 1, chain: [HEAD, MIDDLE], sticky: false });

		await created.session.prompt("Test");

		expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe(HEAD);
		const restored = created.events.filter((event) => event.type === "error_fallback_restored");
		expect(restored).toHaveLength(1);
		expect(restored[0]).toMatchObject({ from: MIDDLE, to: HEAD });
	});

	it("does not stay on the fallback model by default", async () => {
		// sticky used to default to true, so one blip during an outage silently moved
		// the rest of the session onto another provider's model (and billing) under the
		// label the user had selected. The reroute now covers the failed turn only.
		const created = await createSession({ failCount: 1, chain: [HEAD, MIDDLE] });

		await created.session.prompt("Test");

		expect(created.modelsUsed).toEqual([HEAD, MIDDLE]);
		expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe(HEAD);
		expect(created.events.filter((event) => event.type === "error_fallback_restored")).toHaveLength(1);
	});

	it("keeps an explicit model change made during a rerouted run", async () => {
		// sticky:false promises to undo phi's own switch, not the user's. A reroute
		// followed by an explicit setModel used to end the run by putting the
		// pre-reroute model back, silently overwriting the choice just made — and in
		// RPC mode that choice is the host's model picker.
		const created = await createSession({
			failCount: 1,
			chain: [HEAD, MIDDLE],
			beforeRespond: async (callIndex) => {
				if (callIndex !== 2) return;
				const tail = getModel("anthropic", "claude-haiku-4-5")!;
				await session.setModel(tail, { persist: false });
			},
		});

		await created.session.prompt("Test");

		expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe(TAIL);
		expect(created.events.filter((event) => event.type === "error_fallback_restored")).toHaveLength(0);
	});

	it("clamps the thinking level to what the fallback model supports", async () => {
		// Half of the P3 Code failure: the reroute replayed the failed model's level
		// verbatim onto a target with a different effort vocabulary, and the replayed
		// turn died with `400 Invalid effort level` — a hard failure on the very turn
		// meant to rescue a survivable outage.
		//
		// Clamping is only as good as the catalog it clamps against, which is the other
		// half: in the real incident the target was claude-fable-5 at medium, and the
		// catalog claimed medium was fine. See the effort-vocabulary fix in
		// generate-models.ts. This covers the replay side of it.
		const created = await createSession({ failCount: 1, chain: [HEAD, NO_OFF_LEVEL], sticky: true });
		created.session.setThinkingLevel("off", { persist: false });
		expect(created.session.thinkingLevel).toBe("off");

		await created.session.prompt("Test");

		expect(created.modelsUsed).toEqual([HEAD, NO_OFF_LEVEL]);
		const reroutes = created.events.filter((event) => event.type === "error_fallback");
		expect(reroutes).toHaveLength(1);
		// Clamped up to the nearest level the target model does support, and
		// reported on the event so an RPC host can follow the change.
		expect(reroutes[0]).toMatchObject({ from: HEAD, to: NO_OFF_LEVEL, thinkingLevel: "minimal" });
		expect(created.session.thinkingLevel).toBe("minimal");
	});

	it("does not overwrite the user's default model or thinking level when rerouting", async () => {
		const created = await createSession({ failCount: 1, chain: [HEAD, MIDDLE] });
		created.settingsManager.applyOverrides({ defaultThinkingLevel: "low" });
		created.session.setThinkingLevel("high", { persist: false });

		await created.session.prompt("Test");

		expect(created.settingsManager.getDefaultModel()).toBe("claude-sonnet-4-5");
		expect(created.settingsManager.getDefaultProvider()).toBe("anthropic");
		expect(created.settingsManager.getDefaultThinkingLevel()).toBe("low");
	});

	it("PI_ERROR_FALLBACK_CHAIN=off disables a configured chain", async () => {
		process.env.PI_ERROR_FALLBACK_CHAIN = "off";
		const created = await createSession({ failCount: 99, chain: [HEAD, MIDDLE], maxRetries: 1 });

		await created.session.prompt("Test");

		expect(created.modelsUsed.every((ref) => ref === HEAD)).toBe(true);
		expect(created.events.filter((event) => event.type === "error_fallback")).toHaveLength(0);
	});

	it("has no fallback chain by default; explicit settings opt in", async () => {
		const created = await createSession({ failCount: 99, maxRetries: 1 });
		await created.session.prompt("Test");
		expect(created.modelsUsed).toEqual([HEAD, HEAD]);
		expect(created.events.filter((event) => event.type === "error_fallback")).toHaveLength(0);
	});

	it("skips a rung whose OAuth credential is expired and cannot refresh", async () => {
		// The 2026-09-01 cascade, end to end: a Bedrock blip on the gateway rerouted
		// onto an Anthropic-direct rung whose refresh token had been revoked. The
		// dead rung used to stay in the ladder and then throw during auth resolution
		// — before any request — so the reroute never advanced and the turn died on a
		// provider outage that a later rung could have served.
		stubDeadRefreshEndpoint();
		const created = await createSession({
			failCount: 1,
			chain: [HEAD, MIDDLE, "openai/gpt-5"],
			deadOAuthProviders: ["anthropic"],
			liveApiKeyProviders: ["openai"],
		});

		await created.session.prompt("Test");

		// HEAD fails, both anthropic rungs are unreachable, so the ladder lands on
		// the one provider that can actually authenticate.
		expect(created.modelsUsed).toEqual([HEAD, "openai/gpt-5"]);
		const reroutes = created.events.filter((event) => event.type === "error_fallback");
		expect(reroutes).toHaveLength(1);
		expect(reroutes[0]).toMatchObject({ from: HEAD, to: "openai/gpt-5" });
		// The dead rung is filtered out of the resolved chain entirely, not merely
		// tried and failed: only the reachable rung is counted.
		expect(reroutes[0]).toMatchObject({ chainLength: 1 });
	});

	it("reroutes when a rung dies with invalid_grant at request time", async () => {
		// Same fault arriving as a provider error instead of at resolution time (the
		// credential looked live when the chain was resolved, then the refresh was
		// rejected). Must reroute, not spend the same-model retry budget.
		const created = await createSession({
			failCount: 1,
			errorMessage:
				'OAuth refresh failed for anthropic: Anthropic token refresh request failed. body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
			chain: [HEAD, MIDDLE],
		});

		await created.session.prompt("Test");

		expect(created.modelsUsed).toEqual([HEAD, MIDDLE]);
		expect(created.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(0);
		expect(created.events.filter((event) => event.type === "error_fallback")).toHaveLength(1);
	});

	it("leaves refusal-shaped errors to the refusal ladder", async () => {
		const created = await createSession({
			failCount: 1,
			errorMessage: "litellm.BadRequestError: response was blocked by content filter",
			chain: [HEAD, MIDDLE],
		});

		await created.session.prompt("Test");

		// No refusalFallback chain is configured, so the decline is terminal — the
		// error ladder must not treat request-content problems as provider outages.
		expect(created.getCallCount()).toBe(1);
		expect(created.events.filter((event) => event.type.startsWith("error_fallback"))).toHaveLength(0);
	});
});
