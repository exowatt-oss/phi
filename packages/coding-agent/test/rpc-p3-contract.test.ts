import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { LoadExtensionsResult } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

/**
 * Contract between phi's RPC mode and P3 Code (the `phi` provider driver in p3code).
 *
 * P3 drives `phi --mode rpc` over JSON lines. The commands, fields and event shapes below are
 * the ones P3 actually reads (see the inventory in the 2026-10-29 upstream sync PR). Breaking any
 * of them silently breaks every P3 thread, so they are pinned here rather than in P3.
 */

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type Record_ = Record<string, any>;

function createAssistantMessage(text: string, model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 120,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 128,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function records(): Record_[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record_);
}

function responses(id?: string): Record_[] {
	return records().filter(
		(record) => record.type === "response" && (id === undefined ? record.id === undefined : record.id === id),
	);
}

function events(type: string): Record_[] {
	return records().filter((record) => record.type === type);
}

interface Host {
	send: (command: Record_) => void;
	request: (command: Record_) => Promise<Record_>;
	session: AgentSession;
	settingsManager: SettingsManager;
	sessionDir: string;
	cleanup: () => Promise<void>;
}

let nextId = 0;

async function startHost(
	options: {
		responseDelayMs?: number;
		reply?: string;
		extensionsResult?: LoadExtensionsResult;
		streamFn?: ConstructorParameters<typeof Agent>[0]["streamFn"];
	} = {},
): Promise<Host> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const tempDir = join(tmpdir(), `phi-rpc-p3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const sessionDir = join(tempDir, "sessions");

	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Test model not found");

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn:
			options.streamFn ??
			((streamModel: Model<any>) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("", streamModel) });
					setTimeout(() => {
						const message = createAssistantMessage(options.reply ?? "done", streamModel);
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: message.content[0]!.type === "text" ? message.content[0].text : "",
							partial: message,
						});
						stream.push({ type: "done", reason: "stop", message });
					}, options.responseDelayMs ?? 0);
				});
				return stream;
			}),
	});

	const sessionManager = SessionManager.create(tempDir, sessionDir);
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader({ extensionsResult: options.extensionsResult }),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: false })),
		switchSession: vi.fn(async () => ({ cancelled: false })),
		fork: vi.fn(async () => ({ cancelled: false, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	const lineHandler = rpcIo.lineHandler!;

	return {
		session,
		settingsManager,
		sessionDir,
		send: (command) => lineHandler(JSON.stringify(command)),
		request: async (command) => {
			const id = `t3-${++nextId}`;
			lineHandler(JSON.stringify({ id, ...command }));
			let response: Record_ | undefined;
			await vi.waitFor(
				() => {
					response = responses(id)[0];
					expect(response).toBeDefined();
				},
				{ timeout: 10_000 },
			);
			return response!;
		},
		cleanup: async () => {
			try {
				await session.abort();
			} catch {
				// ignore
			}
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		},
	};
}

async function settled(count = 1): Promise<void> {
	await vi.waitFor(() => expect(events("agent_settled").length).toBeGreaterThanOrEqual(count), { timeout: 10_000 });
}

describe("RPC contract with P3 Code", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("get_state carries the fields P3 registers and probes with", async () => {
		const host = await startHost();
		try {
			const response = await host.request({ type: "get_state" });
			expect(response).toMatchObject({ command: "get_state", success: true });
			const state = response.data;
			// Thread registration: the native thread id and the switch_session key.
			expect(typeof state.sessionFile).toBe("string");
			expect(state.sessionFile.startsWith(host.sessionDir)).toBe(true);
			expect(state.model).toMatchObject({ provider: "anthropic", id: "claude-sonnet-4-5" });
			expect(typeof state.model.contextWindow).toBe("number");
			expect(typeof state.thinkingLevel).toBe("string");
			// Settle probe: idle means all three hold.
			expect(state.isStreaming).toBe(false);
			expect(state.isCompacting).toBe(false);
			expect(state.pendingMessageCount).toBe(0);
		} finally {
			await host.cleanup();
		}
	});

	it("get_available_models lists provider, id, contextWindow, reasoning and phi's level/tier decorations", async () => {
		const host = await startHost();
		try {
			const response = await host.request({ type: "get_available_models" });
			expect(response).toMatchObject({ command: "get_available_models", success: true });
			const models: Record_[] = response.data.models;
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(typeof model.provider).toBe("string");
				expect(model.id.length).toBeGreaterThan(0);
				expect(typeof model.name).toBe("string");
				expect(typeof model.contextWindow).toBe("number");
				expect(typeof model.reasoning).toBe("boolean");
				// phi decorations P3 may adopt; thinkingLevelMap stays where upstream puts it.
				expect(Array.isArray(model.thinkingLevels)).toBe(true);
				expect(Array.isArray(model.serviceTiers)).toBe(true);
			}
			expect(models.some((model) => model.thinkingLevelMap !== undefined)).toBe(true);

			const all = await host.request({ type: "get_available_models", scope: "all" });
			expect(all.success).toBe(true);
			const bad = await host.request({ type: "get_available_models", scope: "nope" });
			expect(bad).toMatchObject({ success: false, error: expect.stringContaining("scope") });
		} finally {
			await host.cleanup();
		}
	});

	it("set_model honours persist:false (session-scoped) and persists by default", async () => {
		const host = await startHost();
		try {
			const scoped = await host.request({
				type: "set_model",
				provider: "anthropic",
				modelId: "claude-opus-5-5",
				persist: false,
			});
			expect(scoped).toMatchObject({ command: "set_model", success: true });
			expect(scoped.data).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
			expect(typeof scoped.data.contextWindow).toBe("number");
			expect(host.settingsManager.getDefaultModel()).toBeUndefined();
			expect(host.settingsManager.getDefaultProvider()).toBeUndefined();

			const persisted = await host.request({
				type: "set_model",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			expect(persisted.success).toBe(true);
			expect(host.settingsManager.getDefaultModel()).toBe("claude-sonnet-4-5");
			expect(host.settingsManager.getDefaultProvider()).toBe("anthropic");

			const invalid = await host.request({ type: "set_model", provider: "anthropic", modelId: "x", persist: "yes" });
			expect(invalid).toMatchObject({ success: false, error: expect.stringContaining("persist") });
			const missing = await host.request({ type: "set_model", provider: "anthropic", modelId: "no-such-model" });
			expect(missing).toMatchObject({ success: false, error: expect.stringContaining("Model not found") });

			const level = await host.request({ type: "set_thinking_level", level: "high" });
			expect(level).toMatchObject({ command: "set_thinking_level", success: true });
			expect((await host.request({ type: "get_state" })).data.thinkingLevel).toBe("high");
		} finally {
			await host.cleanup();
		}
	});

	it("a prompt without id gets exactly one id-less ack, then the turn's event sequence, and the state settles", async () => {
		const host = await startHost();
		try {
			host.send({ type: "prompt", message: "hello", streamingBehavior: "steer" });
			await settled();
			// Give trailing writes a tick.
			await new Promise((resolve) => setTimeout(resolve, 50));

			const acks = responses().filter((record) => record.command === "prompt");
			expect(acks).toHaveLength(1);
			expect(acks[0]).toMatchObject({ success: true, data: { disposition: "started" } });
			expect(acks[0].id).toBeUndefined();

			const types = records().map((record) => record.type);
			const order = ["agent_start", "message_start", "message_update", "message_end", "agent_settled"];
			let cursor = -1;
			for (const type of order) {
				const index = types.indexOf(type, cursor + 1);
				expect(index, `${type} after index ${cursor}`).toBeGreaterThan(cursor);
				cursor = index;
			}

			const update = events("message_update")[0];
			// Upstream ≥0.84: usage at the top level plus the assistant delta; no cumulative message.
			expect(update.usage).toBeDefined();
			expect(update.message).toBeUndefined();
			expect(update.assistantMessageEvent).toMatchObject({ type: "text_delta", contentIndex: 0, delta: "done" });

			const end = events("message_end").find((record) => record.message?.role === "assistant");
			expect(end?.message.usage).toMatchObject({
				input: 120,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 128,
			});
			expect(end?.message.stopReason).toBe("stop");

			expect(events("agent_settled")[0]).toMatchObject({ aborted: false });

			const state = (await host.request({ type: "get_state" })).data;
			expect(state).toMatchObject({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
			// P3 snapshots threads from get_messages: exactly one user and one assistant message per turn.
			const roles = ((await host.request({ type: "get_messages" })).data.messages as Record_[]).map((m) => m.role);
			expect(roles.filter((role) => role === "user")).toHaveLength(1);
			expect(roles.filter((role) => role === "assistant")).toHaveLength(1);
		} finally {
			await host.cleanup();
		}
	});

	it("a slash command handled by an extension acks as handled and emits no agent_settled", async () => {
		const host = await startHost({
			extensionsResult: await createTestExtensionsResult([
				(pi) => {
					pi.registerCommand("noop", { handler: async () => {} });
				},
			]),
		});
		try {
			host.send({ type: "prompt", message: "/noop" });
			await vi.waitFor(() => expect(responses().filter((record) => record.command === "prompt")).toHaveLength(1));
			expect(responses()[0]).toMatchObject({ success: true, data: { disposition: "handled" } });
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(events("agent_settled")).toHaveLength(0);
			expect((await host.request({ type: "get_state" })).data).toMatchObject({
				isStreaming: false,
				isCompacting: false,
				pendingMessageCount: 0,
			});
		} finally {
			await host.cleanup();
		}
	});

	it("abort during a turn settles with aborted:true", async () => {
		const host = await startHost({ responseDelayMs: 5_000 });
		try {
			host.send({ type: "prompt", message: "slow" });
			await vi.waitFor(() => expect(events("agent_start")).toHaveLength(1));
			const abort = await host.request({ type: "abort" });
			expect(abort).toMatchObject({ command: "abort", success: true });
			await settled();
			expect(events("agent_settled")[0]).toMatchObject({ aborted: true });
		} finally {
			await host.cleanup();
		}
	});

	it("extension_ui_request / extension_ui_response round-trips a confirm", async () => {
		let answer: boolean | undefined;
		const host = await startHost({
			extensionsResult: await createTestExtensionsResult([
				(pi) => {
					pi.registerCommand("ask", {
						handler: async (_args, ctx) => {
							answer = await ctx.ui.confirm("Allow edit?", "touch a file");
						},
					});
				},
			]),
		});
		try {
			host.send({ type: "prompt", message: "/ask" });
			await vi.waitFor(() => expect(events("extension_ui_request")).toHaveLength(1));
			const request = events("extension_ui_request")[0];
			expect(request).toMatchObject({ method: "confirm", title: "Allow edit?", message: "touch a file" });
			expect(typeof request.id).toBe("string");
			host.send({ type: "extension_ui_response", id: request.id, confirmed: true });
			await vi.waitFor(() => expect(answer).toBe(true));
		} finally {
			await host.cleanup();
		}
	});

	it("session inspection commands return the shapes P3 reads", async () => {
		const host = await startHost();
		try {
			host.send({ type: "prompt", message: "hello" });
			await settled();

			const entries = await host.request({ type: "get_entries" });
			expect(entries).toMatchObject({ command: "get_entries", success: true });
			expect(typeof entries.data.leafId).toBe("string");
			expect(entries.data.entries.length).toBeGreaterThanOrEqual(2);
			for (const entry of entries.data.entries as Record_[]) {
				expect(typeof entry.id).toBe("string");
				expect(entry.parentId === null || typeof entry.parentId === "string").toBe(true);
				expect(typeof entry.type).toBe("string");
				expect(typeof entry.timestamp).toBe("string");
			}
			const userEntry = (entries.data.entries as Record_[]).find((entry) => entry.message?.role === "user")!;
			const since = await host.request({ type: "get_entries", since: userEntry.id });
			expect(since.success).toBe(true);
			expect((since.data.entries as Record_[]).some((entry) => entry.id === userEntry.id)).toBe(false);
			expect(await host.request({ type: "get_entries", since: "nope" })).toMatchObject({ success: false });

			const stats = await host.request({ type: "get_session_stats" });
			expect(stats).toMatchObject({ command: "get_session_stats", success: true });
			expect(stats.data.tokens).toMatchObject({ input: 120, output: 8, cacheRead: 0 });
			expect(typeof stats.data.cost).toBe("number");
			expect(typeof stats.data.contextUsage.tokens).toBe("number");
			expect(typeof stats.data.contextUsage.contextWindow).toBe("number");

			const messages = await host.request({ type: "get_messages" });
			expect(messages.success).toBe(true);
			const roles = (messages.data.messages as Record_[]).map((message) => message.role);
			expect(roles).toEqual(expect.arrayContaining(["user", "assistant"]));
			for (const message of messages.data.messages as Record_[]) {
				expect(typeof message.timestamp).toBe("number");
			}

			expect(await host.request({ type: "get_last_assistant_text" })).toMatchObject({
				success: true,
				data: { text: "done" },
			});

			expect(await host.request({ type: "set_session_name", name: "P3 thread" })).toMatchObject({ success: true });
			expect((await host.request({ type: "get_state" })).data.sessionName).toBe("P3 thread");
			expect(await host.request({ type: "set_session_name", name: "  " })).toMatchObject({ success: false });

			const commands = await host.request({ type: "get_commands" });
			expect(commands.success).toBe(true);
			expect(Array.isArray(commands.data.commands)).toBe(true);
			for (const command of commands.data.commands as Record_[]) {
				expect(typeof command.name).toBe("string");
				expect(typeof command.source).toBe("string");
			}

			expect(await host.request({ type: "new_session" })).toMatchObject({
				success: true,
				data: { cancelled: false },
			});
			expect(await host.request({ type: "switch_session", sessionPath: "/tmp/x.jsonl" })).toMatchObject({
				success: true,
				data: { cancelled: false },
			});
			expect(await host.request({ type: "fork", entryId: userEntry.id })).toMatchObject({
				success: true,
				data: { cancelled: false },
			});
		} finally {
			await host.cleanup();
		}
	});

	it("manual compact acks once without id and brackets the work with compaction events", async () => {
		const host = await startHost();
		try {
			host.send({ type: "prompt", message: "hello" });
			await settled();
			host.send({ type: "compact" });
			await vi.waitFor(() => expect(responses().filter((record) => record.command === "compact")).toHaveLength(1), {
				timeout: 10_000,
			});
			const ack = responses().filter((record) => record.command === "compact")[0];
			expect(ack.id).toBeUndefined();
			if (ack.success) {
				expect(events("compaction_start")).toHaveLength(1);
				expect(events("compaction_start")[0].reason).toBe("manual");
				await vi.waitFor(() => expect(events("compaction_end")).toHaveLength(1));
				const end = events("compaction_end")[0];
				expect(end).toMatchObject({ reason: "manual", aborted: false });
				expect(typeof end.result.summary).toBe("string");
				expect(typeof end.result.tokensBefore).toBe("number");
				expect(typeof end.result.estimatedTokensAfter).toBe("number");
			} else {
				// Nothing to compact in a two-message session is a legitimate outcome; P3 shows the error.
				expect(typeof ack.error).toBe("string");
				expect(events("compaction_end").every((end) => end.result === undefined)).toBe(true);
			}
			expect((await host.request({ type: "get_state" })).data).toMatchObject({ isCompacting: false });
		} finally {
			await host.cleanup();
		}
	});

	it("rejects P3-unknown command shapes with an error response rather than silence", async () => {
		const host = await startHost();
		try {
			const unknown = await host.request({ type: "definitely_not_a_command" });
			expect(unknown).toMatchObject({ success: false });
			expect(typeof unknown.error).toBe("string");
		} finally {
			await host.cleanup();
		}
	});
});

// Compile-time pins for the phi-only event shapes P3's flavor layer reads (PhiAdapterV2).
type EventOf<T extends AgentSessionEvent["type"]> = Extract<AgentSessionEvent, { type: T }>;
const _errorFallback: EventOf<"error_fallback"> = {
	type: "error_fallback",
	reason: "provider down",
	from: "anthropic/a",
	to: "openai/b",
	thinkingLevel: "medium",
	rung: 2,
	chainLength: 3,
};
const _errorFallbackExhausted: EventOf<"error_fallback_exhausted"> = {
	type: "error_fallback_exhausted",
	reason: "provider down",
	from: "anthropic/a",
	tried: ["openai/b"],
};
const _errorFallbackRestored: EventOf<"error_fallback_restored"> = {
	type: "error_fallback_restored",
	from: "openai/b",
	to: "anthropic/a",
	thinkingLevel: "medium",
};
const _refusalFallback: EventOf<"refusal_fallback"> = {
	type: "refusal_fallback",
	category: null,
	explanation: undefined,
	from: "anthropic/a",
	to: "openai/b",
	rung: 2,
	chainLength: 3,
};
const _refusalFallbackExhausted: EventOf<"refusal_fallback_exhausted"> = {
	type: "refusal_fallback_exhausted",
	category: null,
	explanation: undefined,
	from: "anthropic/a",
	tried: ["openai/b"],
};
const _refusalFallbackRestored: EventOf<"refusal_fallback_restored"> = {
	type: "refusal_fallback_restored",
	to: "anthropic/a",
};
const _settled: EventOf<"agent_settled"> = { type: "agent_settled", aborted: false };
const _compactionEnd: EventOf<"compaction_end"> = {
	type: "compaction_end",
	reason: "manual",
	result: undefined,
	aborted: false,
	willRetry: false,
	prune: true,
};
void [
	_errorFallback,
	_errorFallbackExhausted,
	_errorFallbackRestored,
	_refusalFallback,
	_refusalFallbackExhausted,
	_refusalFallbackRestored,
	_settled,
	_compactionEnd,
];
