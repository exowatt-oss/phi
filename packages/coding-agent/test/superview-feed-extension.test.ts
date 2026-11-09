import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { agentSessionRegistry } from "../src/core/agent-session-registry.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import superviewFeedExtension from "../src/extensions/superview-feed.ts";
import { SuperviewTransport } from "../src/extensions/superview-transport.ts";
import { workspaceStateStore } from "../src/extensions/workspace-state/state.ts";
import { isolateFeadsAgentDir } from "./feads-test-env.ts";

beforeEach(() => {
	isolateFeadsAgentDir();
});

type TestHostIdentity = {
	hostname?: string;
	tmuxSession?: string;
	tmuxPane?: string;
	devboxProfileId?: string;
	sshConnection?: true;
};

let mockedHostIdentity: TestHostIdentity | undefined;
vi.mock("../src/extensions/superview-host-identity.ts", () => ({
	getHostIdentity: () => mockedHostIdentity,
}));

let sessionName: string | undefined;

const context = {
	cwd: "/tmp/project",
	sessionManager: { getSessionId: () => "session-main", getSessionName: () => sessionName },
	model: { id: "model-1" },
	getContextUsage: () => ({ tokens: 10, contextWindow: 100 }),
} as never;

describe("superview feed extension", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		mockedHostIdentity = undefined;
		sessionName = undefined;
		workspaceStateStore.clear();
	});

	it("registers main and lifecycle/activity handlers", async () => {
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		vi.stubEnv("PI_SUBAGENT_NAME", undefined);
		vi.stubEnv("PI_SUBAGENT_HANDLE", undefined);
		const extension = await loadExtensionFromFactory(
			superviewFeedExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:superview-feed>",
		);
		expect([...extension.handlers.keys()]).toEqual(
			expect.arrayContaining([
				"session_start",
				"tool_execution_start",
				"tool_execution_end",
				"session_shutdown",
				"message_end",
			]),
		);
	});

	it("does not publish child sessions because the parent owns their rows", async () => {
		vi.stubEnv("PI_SUBAGENT_ID", "child-run");
		const publish = vi.spyOn(SuperviewTransport.prototype, "publish");
		const extension = await loadExtensionFromFactory(
			superviewFeedExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:superview-feed>",
		);

		expect(extension.handlers.size).toBe(0);
		for (const handler of (
			extension.handlers as Map<string, Array<(event: unknown, ctx: unknown) => unknown>>
		).values()) {
			for (const callback of handler) callback({}, context);
		}
		expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ event: "agent_register" }));
	});

	it("publishes register, tool activity, and end through the transport seam for the main session", async () => {
		mockedHostIdentity = {
			hostname: "forca-workstation",
			tmuxSession: "devbox-roam-3-dbfix",
			tmuxPane: "%7",
			devboxProfileId: "roam",
			sshConnection: true,
		};
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		vi.stubEnv("PI_SUBAGENT_NAME", undefined);
		vi.stubEnv("PI_SUBAGENT_HANDLE", undefined);
		const publish = vi.spyOn(SuperviewTransport.prototype, "publish").mockImplementation(() => undefined);
		const extension = await loadExtensionFromFactory(
			superviewFeedExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:superview-feed>",
		);
		// The observer is intentionally best effort; replace the transport's publish path
		// by exercising handlers with the default transport and asserting no handler throws.
		const handlers = extension.handlers as Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
		const invoke = (name: string, event: unknown): void => {
			for (const handler of handlers.get(name) ?? []) handler(event, context);
		};
		expect(() => invoke("session_start", {})).not.toThrow();
		expect(publish).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "agent_register",
				agent: expect.objectContaining({ host: mockedHostIdentity }),
			}),
		);
		expect(() => invoke("tool_execution_start", { toolName: "bash", args: { command: "pwd" } })).not.toThrow();
		expect(publish).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "subagent_update",
				agent: expect.objectContaining({
					host: mockedHostIdentity,
					safeActivity: { kind: "tool", name: "bash" },
					activity: { tool: "bash", argsPreview: JSON.stringify({ command: "pwd" }) },
				}),
			}),
		);
		expect(() => invoke("tool_execution_end", {})).not.toThrow();
		expect(() => invoke("session_shutdown", {})).not.toThrow();
		expect(publish).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "agent_register",
				agent: expect.objectContaining({ host: mockedHostIdentity }),
			}),
		);
		expect(publish).toHaveBeenCalledWith(expect.objectContaining({ event: "agent_register" }));
	});

	it("omits host when the identity provider has no information", async () => {
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		const publish = vi.spyOn(SuperviewTransport.prototype, "publish").mockImplementation(() => undefined);
		const extension = await loadExtensionFromFactory(
			superviewFeedExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:superview-feed>",
		);
		const handlers = extension.handlers as Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
		for (const handler of handlers.get("session_start") ?? []) handler({}, context);

		const register = publish.mock.calls.find(([event]) => {
			return typeof event === "object" && event !== null && "event" in event && event.event === "agent_register";
		})?.[0];
		expect(register).toBeDefined();
		const agent = (register as { agent?: Record<string, unknown> }).agent;
		expect(agent).not.toHaveProperty("host");
		const serializedAgent = JSON.parse(JSON.stringify(agent)) as Record<string, unknown>;
		expect(serializedAgent).not.toHaveProperty("host");
	});

	it("cleans up the previous transport and heartbeat on a repeated session start", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		vi.stubEnv("PI_SUBAGENT_NAME", undefined);
		vi.stubEnv("PI_SUBAGENT_HANDLE", undefined);
		vi.stubEnv("FEADS_AGENT_TOKEN", undefined);
		const publish = vi.spyOn(SuperviewTransport.prototype, "publish").mockImplementation(() => undefined);
		const dispose = vi.spyOn(SuperviewTransport.prototype, "dispose");
		const clearInterval = vi.spyOn(globalThis, "clearInterval");
		const extension = await loadExtensionFromFactory(
			superviewFeedExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:superview-feed>",
		);
		const handlers = extension.handlers as Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
		const invoke = (name: string, event: unknown): void => {
			for (const handler of handlers.get(name) ?? []) handler(event, context);
		};

		invoke("session_start", {});
		invoke("session_start", {});
		expect(dispose).toHaveBeenCalledOnce();
		expect(clearInterval).toHaveBeenCalledOnce();

		publish.mockClear();
		vi.advanceTimersByTime(30_000);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(publish).toHaveBeenCalledWith(expect.objectContaining({ event: "heartbeat", agents: ["session-main"] }));

		invoke("session_shutdown", {});
		invoke("session_shutdown", {});
		expect(dispose).toHaveBeenCalledTimes(2);
		expect(clearInterval).toHaveBeenCalledTimes(2);
	});

	it("names the main row after the friendly session name and falls back to main without one", async () => {
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		vi.stubEnv("PI_SUBAGENT_NAME", undefined);
		vi.stubEnv("PI_SUBAGENT_HANDLE", undefined);
		const publish = vi.spyOn(SuperviewTransport.prototype, "publish").mockImplementation(() => undefined);
		const extension = await loadExtensionFromFactory(
			superviewFeedExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:superview-feed>",
		);
		const handlers = extension.handlers as Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
		const invoke = (name: string, event: unknown): void => {
			for (const handler of handlers.get(name) ?? []) handler(event, context);
		};

		sessionName = "night shift";
		invoke("session_start", {});
		expect(publish).toHaveBeenLastCalledWith(
			expect.objectContaining({
				event: "agent_register",
				agent: expect.objectContaining({ displayName: "night shift" }),
			}),
		);

		sessionName = undefined;
		invoke("message_end", { message: { role: "assistant", usage: { input: 1, output: 2, cost: { total: 0 } } } });
		expect(publish).toHaveBeenLastCalledWith(
			expect.objectContaining({
				agent: expect.objectContaining({ displayName: "main" }),
			}),
		);
		invoke("session_shutdown", {});
	});

	it("publishes the workspace-state end state and question, and drops them once superseded", async () => {
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		vi.stubEnv("PI_SUBAGENT_NAME", undefined);
		vi.stubEnv("PI_SUBAGENT_HANDLE", undefined);
		const publish = vi.spyOn(SuperviewTransport.prototype, "publish").mockImplementation(() => undefined);
		const extension = await loadExtensionFromFactory(
			superviewFeedExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:superview-feed>",
		);
		const handlers = extension.handlers as Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
		const invoke = (name: string, event: unknown): void => {
			for (const handler of handlers.get(name) ?? []) handler(event, context);
		};

		invoke("session_start", {});
		// No record yet: the fields must be absent, not null, so a consumer can read presence.
		let agent = (publish.mock.calls.at(-1)?.[0] as { agent: Record<string, unknown> }).agent;
		expect(agent).not.toHaveProperty("endState");
		expect(agent).not.toHaveProperty("question");

		workspaceStateStore.publish({
			v: 1,
			session_id: "session-main",
			session_file: "/tmp/project/.pi/sessions/session-main.jsonl",
			cwd: "/tmp/project",
			host: "workstation",
			end_state: "awaiting-human",
			question: "Promote or hold?",
			source: "tool",
			ts: 1_700_000_000_000,
		});
		invoke("agent_settled", {});
		expect(publish).toHaveBeenLastCalledWith(
			expect.objectContaining({
				agent: expect.objectContaining({
					endState: "awaiting-human",
					question: "Promote or hold?",
					status: "idle",
				}),
			}),
		);

		// The emitter clears the store at agent_start; the feed must stop advertising the question.
		workspaceStateStore.clear();
		invoke("agent_start", {});
		agent = (publish.mock.calls.at(-1)?.[0] as { agent: Record<string, unknown> }).agent;
		expect(agent.status).toBe("working");
		expect(agent).not.toHaveProperty("endState");
		expect(agent).not.toHaveProperty("question");

		// A complete record carries an end state and no question.
		workspaceStateStore.publish({
			v: 1,
			session_id: "session-main",
			session_file: "",
			cwd: "/tmp/project",
			host: "workstation",
			end_state: "complete",
			source: "classifier",
			ts: 1_700_000_000_001,
		});
		invoke("agent_settled", {});
		agent = (publish.mock.calls.at(-1)?.[0] as { agent: Record<string, unknown> }).agent;
		expect(agent.endState).toBe("complete");
		expect(agent).not.toHaveProperty("question");
		invoke("session_shutdown", {});
	});

	it("republishes the row when the session is renamed", async () => {
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		vi.stubEnv("PI_SUBAGENT_NAME", undefined);
		vi.stubEnv("PI_SUBAGENT_HANDLE", undefined);
		const publish = vi.spyOn(SuperviewTransport.prototype, "publish").mockImplementation(() => undefined);
		const extension = await loadExtensionFromFactory(
			superviewFeedExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:superview-feed>",
		);
		const handlers = extension.handlers as Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
		expect([...handlers.keys()]).toContain("session_info_changed");
		const invoke = (name: string, event: unknown): void => {
			for (const handler of handlers.get(name) ?? []) handler(event, context);
		};

		invoke("session_start", {});
		invoke("agent_start", {});
		sessionName = "renamed";
		invoke("session_info_changed", { type: "session_info_changed", name: sessionName });
		// A mid-turn rename (Forca's auto-namer fires during the first turn) must not flip the row to idle.
		expect(publish).toHaveBeenLastCalledWith(
			expect.objectContaining({
				event: "subagent_update",
				agent: expect.objectContaining({ displayName: "renamed", status: "working" }),
			}),
		);
		invoke("session_shutdown", {});
	});

	it("publishes in-process child sessions as subagents and ends them on dispose", async () => {
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		const publish = vi.spyOn(SuperviewTransport.prototype, "publish").mockImplementation(() => undefined);
		const extension = await loadExtensionFromFactory(
			superviewFeedExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:superview-feed>",
		);
		const handlers = extension.handlers as Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
		for (const handler of handlers.get("session_start") ?? []) handler({}, context);

		let listener: ((event: unknown) => void) | undefined;
		const child = {
			sessionId: "session-child",
			sessionManager: { getSessionName: () => undefined },
			model: { id: "model-2" },
			messages: [{ role: "user", content: "Review the auth module\nthen report" }],
			getContextUsage: () => undefined,
			subscribe: (fn: (event: unknown) => void) => {
				listener = fn;
				return () => undefined;
			},
		} as unknown as AgentSession;
		agentSessionRegistry.created(child);
		listener?.({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
		expect(publish).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "subagent_update",
				agent: expect.objectContaining({
					kind: "subagent",
					runId: "session-child",
					parentSessionId: "session-main",
					displayName: "Review the auth module",
					model: "model-2",
					status: "working",
					safeActivity: { kind: "tool", name: "read" },
				}),
			}),
		);
		agentSessionRegistry.disposed(child);
		expect(publish).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "subagent_end",
				agent: expect.objectContaining({ runId: "session-child", status: "done" }),
			}),
		);
		// A replacement main session must not be mistaken for a child.
		publish.mockClear();
		const nextMain = { ...child, sessionId: "session-next" } as unknown as AgentSession;
		agentSessionRegistry.created(nextMain);
		for (const handler of handlers.get("session_start") ?? []) {
			handler(
				{},
				{
					...(context as object),
					sessionManager: { getSessionId: () => "session-next", getSessionName: () => undefined },
				},
			);
		}
		expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ event: "subagent_end" }));
		for (const handler of handlers.get("session_shutdown") ?? []) handler({}, context);
	});
});
