import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import feadsAgentExtension, { __testing } from "../src/extensions/feads-agent/index.ts";
import { __testing as presenceTesting } from "../src/extensions/feads-agent/presence-publisher.ts";
import { isolateFeadsAgentDir } from "./feads-test-env.ts";

beforeEach(() => {
	isolateFeadsAgentDir();
});

const context = { cwd: "/tmp", sessionManager: { getSessionId: () => "s" } } as never;
const invokeHandlers = async (
	extension: Awaited<ReturnType<typeof loadExtensionFromFactory>>,
	name: string,
	event: unknown,
) => {
	const results = [];
	for (const handler of (extension.handlers as Map<string, Array<(event: unknown, ctx: unknown) => unknown>>).get(
		name,
	) ?? []) {
		results.push(await handler(event, context));
	}
	return results;
};

const load = async () =>
	loadExtensionFromFactory(
		feadsAgentExtension,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<inline:feads-agent>",
	);

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	delete process.env.FEADS_AGENT_TOKEN;
	delete process.env.FEADS_TOKEN;
	delete process.env.FEADS_URL;
	delete process.env.PI_SUBAGENT_ID;
	presenceTesting.resetPresenceStatus(undefined, "http://127.0.0.1:8787");
	delete process.env[__testing.NO_FEADS_ENV];
});

describe("feads-agent extension", () => {
	it("delegates opportunistically without delaying spawn", async () => {
		process.env.FEADS_AGENT_TOKEN = "parent";
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const extension = await load();
		const shared = createExtensionRuntime();
		await loadExtensionFromFactory(feadsAgentExtension, process.cwd(), createEventBus(), shared, "<inline>");
		let settled = false;
		fetchMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					setTimeout(() => {
						settled = true;
						resolve(new Response("{}", { status: 200 }));
					}, 100);
				}),
		);
		const env = await shared.subagentSpawnHooks[0](
			{ type: "subagent_spawn", runId: "run-1", handle: "ws-a-x7k2", name: "ws-a", toolCallId: "t", env: {} },
			context,
		);
		expect(env).toEqual({});
		expect(settled).toBe(false);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/agent/delegate"),
			expect.objectContaining({ method: "POST" }),
		);
		expect(extension).toBeDefined();
	});

	it("is inert without a token", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const shared = createExtensionRuntime();
		await loadExtensionFromFactory(feadsAgentExtension, process.cwd(), createEventBus(), shared, "<inline>");
		expect(shared.subagentSpawnHooks).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps legacy enrollment scoped to runtime presence, not delegation", async () => {
		process.env.FEADS_TOKEN = "legacy-token";
		const shared = createExtensionRuntime();
		await loadExtensionFromFactory(feadsAgentExtension, process.cwd(), createEventBus(), shared, "<inline>");
		expect(shared.subagentSpawnHooks).toHaveLength(0);
	});

	it("delegation failure stays fail-open", async () => {
		process.env.FEADS_AGENT_TOKEN = "parent";
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const shared = createExtensionRuntime();
		await loadExtensionFromFactory(feadsAgentExtension, process.cwd(), createEventBus(), shared, "<inline>");
		expect(
			await shared.subagentSpawnHooks[0](
				{ type: "subagent_spawn", runId: "r", handle: "h", name: "n", toolCallId: "t", env: {} },
				context,
			),
		).toEqual({});
		await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
		expect(warn).toHaveBeenCalledWith("[feads-agent] delegation failed");
		expect(warn.mock.calls.flat().join(" ")).not.toContain("offline");
	});

	it("reports only safe Agentwatch status categories", async () => {
		const token = "fdsa_example";
		process.env.FEADS_AGENT_TOKEN = token;
		process.env.FEADS_URL = "https://user:password@agentwatch.example:8443/private?token=query-secret";
		const extension = await load();
		const notify = vi.fn();
		await extension.commands.get("feads-status")?.handler("", { ui: { notify } } as never);

		expect(notify).toHaveBeenCalledOnce();
		const [message, level] = notify.mock.calls[0] as [string, string];
		expect(level).toBe("info");
		expect(message).toContain("configured token: yes");
		expect(message).toContain("credential source: canonical");
		expect(message).toContain("effective host: agentwatch.example:8443");
		expect(message).toContain("enabled: no");
		expect(message).toContain("disabled reason: publisher not started");
		expect(message).toContain("publisher started: no");
		expect(message).toContain("last successful accepted count: none");
		expect(message).toContain("last successful time: never");
		expect(message).toContain("last failure: none");
		for (const secret of [token, "password", "private", "query-secret"]) expect(message).not.toContain(secret);
		expect(presenceTesting.effectiveHost(`https://${token}.example`, token)).toBe("redacted");
	});

	it("reports legacy enrollment and migration guidance without exposing the token", async () => {
		const legacyToken = "fdsa_example";
		process.env.FEADS_TOKEN = legacyToken;
		const extension = await load();
		const notify = vi.fn();
		await extension.commands.get("feads-status")?.handler("", { ui: { notify } } as never);

		const [message] = notify.mock.calls[0] as [string, string];
		expect(message).toContain("configured token: yes");
		expect(message).toContain("credential source: legacy");
		expect(message).toContain("migration: rename FEADS_TOKEN to FEADS_AGENT_TOKEN and restart phi");
		expect(message).not.toContain(legacyToken);
	});

	it("does not start an idle heartbeat", async () => {
		process.env.FEADS_AGENT_TOKEN = "child";
		process.env.PI_SUBAGENT_ID = "run";
		vi.useFakeTimers();
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const extension = await load();
		await invokeHandlers(extension, "session_start", {});
		await vi.advanceTimersByTimeAsync(90_000);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("raises, then heartbeats and drops child flares after issue touch", async () => {
		process.env.FEADS_AGENT_TOKEN = "child";
		process.env.PI_SUBAGENT_ID = "run";
		vi.useFakeTimers();
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const extension = await load();
		await invokeHandlers(extension, "session_start", {});
		await invokeHandlers(extension, "tool_execution_start", {
			toolName: "mcp_feads_artifact_add",
			args: { issue_id: "forca-4qs" },
		});
		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining("/api/flares"),
				expect.objectContaining({ method: "PUT" }),
			),
		);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await invokeHandlers(extension, "session_shutdown", {});
		expect(fetchMock).toHaveBeenLastCalledWith(
			expect.stringContaining("/api/flares"),
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("/no-feads plus spawn and issue touch makes zero requests", async () => {
		process.env.FEADS_AGENT_TOKEN = "parent";
		process.env.PI_SUBAGENT_ID = "run";
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const shared = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			feadsAgentExtension,
			process.cwd(),
			createEventBus(),
			shared,
			"<inline>",
		);
		const command = extension.commands.get("no-feads");
		expect(command).toBeDefined();
		await command?.handler("", { ui: { notify: vi.fn() } } as never);
		const notify = vi.fn();
		await extension.commands.get("feads-status")?.handler("", { ui: { notify } } as never);
		expect(notify.mock.calls[0]?.[0]).toContain("disabled reason: /no-feads");
		expect(
			await shared.subagentSpawnHooks[0](
				{ type: "subagent_spawn", runId: "r", handle: "h", name: "n", toolCallId: "t", env: {} },
				context,
			),
		).toEqual({});
		await invokeHandlers(extension, "tool_execution_start", {
			toolName: "mcp_feads_artifact_add",
			args: { issue_id: "forca-4qs" },
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("declares acceptsArgs false so trailing input is forwarded, not swallowed", async () => {
		const extension = await load();
		expect(extension.commands.get("no-feads")?.acceptsArgs).toBe(false);
		expect(extension.commands.get("feads-status")?.acceptsArgs).toBe(false);
	});

	it("activates the same guard through the disable-model-invocation skill command", async () => {
		process.env.FEADS_AGENT_TOKEN = "parent";
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const shared = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			feadsAgentExtension,
			process.cwd(),
			createEventBus(),
			shared,
			"<inline>",
		);
		expect(await invokeHandlers(extension, "input", { text: "/skill:no-feads", source: "interactive" })).toEqual([
			{ action: "continue" },
		]);
		expect(
			await shared.subagentSpawnHooks[0](
				{ type: "subagent_spawn", runId: "r", handle: "h", name: "n", toolCallId: "t", env: {} },
				context,
			),
		).toEqual({});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("blocks explicit Feads tools after the guard is active", async () => {
		process.env.FEADS_AGENT_TOKEN = "parent";
		const extension = await load();
		await extension.commands.get("no-feads")?.handler("", { ui: { notify: vi.fn() } } as never);
		expect(
			await invokeHandlers(extension, "tool_call", {
				type: "tool_call",
				toolName: "mcp_feads_notifications",
				toolCallId: "t",
				input: {},
			}),
		).toEqual([{ block: true, reason: "Feads is disabled for this session by /no-feads." }]);
	});

	it("resets the guard when the extension observes a new session generation", async () => {
		process.env.FEADS_AGENT_TOKEN = "parent";
		let sessionId = "one";
		const dynamicContext = { cwd: "/tmp", sessionManager: { getSessionId: () => sessionId } } as never;
		const shared = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			feadsAgentExtension,
			process.cwd(),
			createEventBus(),
			shared,
			"<inline>",
		);
		for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, dynamicContext);
		await extension.commands.get("no-feads")?.handler("", { ui: { notify: vi.fn() } } as never);
		sessionId = "two";
		for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, dynamicContext);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		expect(
			await shared.subagentSpawnHooks[0](
				{ type: "subagent_spawn", runId: "r", handle: "h", name: "n", toolCallId: "t", env: {} },
				dynamicContext,
			),
		).toEqual({});
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
