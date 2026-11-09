import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type InferenceSpeed,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentSessionEvent, getFastTierKind } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("AgentSession fast mode (/fast)", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createModel(id = "capture-model", api: Api = "anthropic-messages"): Model<Api> {
		return {
			id,
			name: id,
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createMessage(model: Model<Api>, speed?: InferenceSpeed): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			...(speed ? { speed } : {}),
			timestamp: Date.now(),
		};
	}

	async function createHarness(options: {
		settings?: Partial<Settings>;
		serviceTier?: "default" | "flex" | "fast" | "ultrafast";
		sessionManager?: SessionManager;
		model?: Model<Api>;
		responseSpeed?: InferenceSpeed;
	}) {
		const model = options.model ?? createModel();
		const settingsManager = SettingsManager.inMemory(options.settings ?? {});
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const captured: Array<SimpleStreamOptions | undefined> = [];
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (_model, _context, providerOptions) => {
				captured.push(providerOptions);
				const stream = createAssistantMessageEventStream();
				stream.end(createMessage(model, options.responseSpeed));
				return stream;
			},
		});
		const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager,
			serviceTier: options.serviceTier,
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));
		const request = async () => {
			const stream = await session.agent.streamFunction(model, normalizeContext({ messages: [] }), {});
			await stream.result();
			return captured.at(-1)?.serviceTier;
		};
		// A full turn: persists user + assistant messages, which is what flushes a
		// file-backed session to disk.
		const prompt = async () => {
			await session.prompt("hi");
			return captured.at(-1)?.serviceTier;
		};
		const dispose = () => {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		};
		return { session, sessionManager, settingsManager, events, request, prompt, dispose };
	}

	it("is off by default and sends no tier", async () => {
		const h = await createHarness({});
		try {
			expect(h.session.fastMode).toBe(false);
			expect(h.session.serviceTier).toBe("default");
			expect(await h.request()).toBeUndefined();
		} finally {
			h.dispose();
		}
	});

	it("setFastMode(true) sends the fast tier on the next request and emits service_tier_changed", async () => {
		const h = await createHarness({});
		try {
			h.session.setFastMode(true);
			expect(h.session.fastMode).toBe(true);
			expect(h.events).toContainEqual({ type: "service_tier_changed", tier: "fast" });
			expect(await h.request()).toBe("fast");

			h.session.setFastMode(false);
			expect(h.session.fastMode).toBe(false);
			expect(h.events).toContainEqual({ type: "service_tier_changed", tier: "default" });
			expect(await h.request()).toBeUndefined();
		} finally {
			h.dispose();
		}
	});

	it("never writes the serviceTier setting: the toggle stays with the session", async () => {
		const h = await createHarness({});
		try {
			h.session.setFastMode(true);
			expect(h.settingsManager.getServiceTier()).toBe("default");
		} finally {
			h.dispose();
		}
	});

	it("off pins default over a serviceTier: fast setting, and clearing the override follows the setting again", async () => {
		const h = await createHarness({ settings: { serviceTier: "fast" } });
		try {
			expect(h.session.fastMode).toBe(true);
			expect(await h.request()).toBe("fast");

			h.session.setFastMode(false);
			expect(h.session.serviceTier).toBe("default");
			expect(await h.request()).toBeUndefined();

			h.session.setServiceTier(undefined);
			expect(h.session.serviceTier).toBe("fast");
			expect(await h.request()).toBe("fast");
		} finally {
			h.dispose();
		}
	});

	it("--service-tier seeds the override and /fast can still turn it off", async () => {
		const h = await createHarness({ serviceTier: "fast" });
		try {
			expect(h.session.fastMode).toBe(true);
			expect(await h.request()).toBe("fast");
			h.session.setFastMode(false);
			expect(await h.request()).toBeUndefined();
		} finally {
			h.dispose();
		}
	});

	it("--service-tier ultrafast is sent verbatim, counts as fast mode, and /fast off clears it", async () => {
		const h = await createHarness({ serviceTier: "ultrafast" });
		try {
			expect(h.session.fastMode).toBe(true);
			expect(await h.request()).toBe("ultrafast");
			h.session.setFastMode(false);
			expect(await h.request()).toBeUndefined();
		} finally {
			h.dispose();
		}
	});

	it("restores an explicit ultrafast tier on resume", async () => {
		const h = await createHarness({});
		try {
			h.session.setServiceTier("ultrafast");
			const resumed = await createHarness({ sessionManager: h.sessionManager });
			try {
				expect(resumed.session.serviceTier).toBe("ultrafast");
			} finally {
				resumed.dispose();
			}
		} finally {
			h.dispose();
		}
	});

	it("does not emit when the effective tier is unchanged", async () => {
		const h = await createHarness({ settings: { serviceTier: "fast" } });
		try {
			h.session.setFastMode(true);
			expect(h.events.filter((e) => e.type === "service_tier_changed")).toHaveLength(0);
		} finally {
			h.dispose();
		}
	});

	it("records the toggle in the session so resuming restores it", async () => {
		const sessionDir = join(tempDir, "sessions");
		const first = await createHarness({ sessionManager: SessionManager.create(cwd, sessionDir) });
		let sessionFile: string | undefined;
		try {
			first.session.setFastMode(true);
			expect(await first.prompt()).toBe("fast");
			sessionFile = first.sessionManager.getSessionFile();
			expect(sessionFile).toBeDefined();
			const tierEntries = first.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "service_tier");
			expect(tierEntries).toHaveLength(1);
		} finally {
			first.dispose();
		}

		const resumed = await createHarness({ sessionManager: SessionManager.open(sessionFile!) });
		try {
			expect(resumed.session.fastMode).toBe(true);
			expect(await resumed.request()).toBe("fast");
		} finally {
			resumed.dispose();
		}
	});

	it("a later off entry wins on resume, and --service-tier beats the persisted entry", async () => {
		const sessionDir = join(tempDir, "sessions");
		const first = await createHarness({ sessionManager: SessionManager.create(cwd, sessionDir) });
		let sessionFile: string | undefined;
		try {
			first.session.setFastMode(true);
			first.session.setFastMode(false);
			expect(await first.prompt()).toBeUndefined();
			sessionFile = first.sessionManager.getSessionFile();
		} finally {
			first.dispose();
		}

		const resumed = await createHarness({ sessionManager: SessionManager.open(sessionFile!) });
		try {
			expect(resumed.session.fastMode).toBe(false);
		} finally {
			resumed.dispose();
		}

		const flagged = await createHarness({ sessionManager: SessionManager.open(sessionFile!), serviceTier: "fast" });
		try {
			expect(flagged.session.fastMode).toBe(true);
		} finally {
			flagged.dispose();
		}
	});

	it("exposes the speed the last response reported", async () => {
		const h = await createHarness({ responseSpeed: "standard" });
		try {
			expect(h.session.lastResponseSpeed).toBeUndefined();
			h.session.setFastMode(true);
			await h.session.prompt("hi");
			expect(h.session.lastResponseSpeed).toBe("standard");
		} finally {
			h.dispose();
		}
	});
});

describe("getFastTierKind", () => {
	function model(api: Api, provider: string, id: string, compat?: Record<string, unknown>): Model<Api> {
		return {
			id,
			name: id,
			api,
			provider,
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
			...(compat ? { compat: compat as Model<Api>["compat"] } : {}),
		};
	}

	it("recognizes Anthropic fast-mode models", () => {
		expect(getFastTierKind(model("anthropic-messages", "anthropic", "claude-opus-5-5"))).toBe("anthropic");
		expect(getFastTierKind(model("anthropic-messages", "anthropic", "claude-opus-4-8"))).toBe("anthropic");
		expect(getFastTierKind(model("anthropic-messages", "anthropic", "claude-sonnet-5"))).toBeUndefined();
		expect(getFastTierKind(model("anthropic-messages", "anthropic", "claude-opus-4-7"))).toBeUndefined();
		expect(getFastTierKind(model("anthropic-messages", "gateway", "claude-opus-5-5"))).toBeUndefined();
		expect(
			getFastTierKind(model("anthropic-messages", "gateway", "claude-opus-5-5", { supportsFastMode: true })),
		).toBe("anthropic");
	});

	it("recognizes OpenAI-style tiered APIs and excludes GitHub Copilot and other hosts", () => {
		expect(getFastTierKind(model("openai-responses", "openai", "gpt-5.6"))).toBe("openai");
		expect(getFastTierKind(model("openai-completions", "gateway", "example-medium"))).toBe("openai");
		expect(getFastTierKind(model("openai-codex-responses", "openai-codex", "gpt-5.6"))).toBe("openai");
		expect(getFastTierKind(model("openai-completions", "github-copilot", "gpt-5"))).toBeUndefined();
		expect(
			getFastTierKind(model("bedrock-converse-stream", "amazon-bedrock", "anthropic.claude-opus-5")),
		).toBeUndefined();
		expect(getFastTierKind(model("google-generative-ai", "google", "gemini-3-pro"))).toBeUndefined();
		expect(getFastTierKind(undefined)).toBeUndefined();
	});

	it("excludes Amazon Bedrock OpenAI endpoints unless the model has a known fast tier", () => {
		const bedrock = (api: Api, id: string) => ({
			...model(api, "bedrock-mantle", id),
			baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
		});
		expect(getFastTierKind(bedrock("openai-responses", "openai.gpt-6-sol"))).toBeUndefined();
		expect(getFastTierKind(bedrock("openai-completions", "openai.gpt-6-sol"))).toBeUndefined();
		expect(getFastTierKind(bedrock("openai-responses", "openai.gpt-6-astra"))).toBe("openai");
	});
});
