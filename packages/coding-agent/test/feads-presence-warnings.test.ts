import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import feadsAgentExtension, { __testing } from "../src/extensions/feads-agent/index.ts";
import {
	FEADS_PRESENCE_ALERT_AFTER_FAILURES,
	FeadsPresencePublisher,
	formatFeadsPresenceStatus,
	getFeadsPresenceStatus,
	__testing as presenceTesting,
	setFeadsPresenceAlertListener,
} from "../src/extensions/feads-agent/presence-publisher.ts";
import { feadsSessionState } from "../src/extensions/feads-agent/session-state.ts";
import { isolateFeadsAgentDir } from "./feads-test-env.ts";

let agentDir: string;

const mainEvent = { v: 1, event: "subagent_update", agent: { kind: "main", status: "working" } };

function writeMcpConfig(servers: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
}

function makeContext(hasUI = true) {
	const notify = vi.fn();
	const ctx = {
		cwd: agentDir,
		hasUI,
		ui: { notify },
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => `session-${Math.random()}` },
	};
	return { ctx, notify };
}

async function loadExtension() {
	return loadExtensionFromFactory(
		feadsAgentExtension,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<inline:feads-agent>",
	);
}

async function invoke(
	extension: Awaited<ReturnType<typeof loadExtension>>,
	name: string,
	event: unknown,
	ctx: unknown,
): Promise<void> {
	const handlers = (extension.handlers as Map<string, Array<(event: unknown, ctx: unknown) => unknown>>).get(name);
	for (const handler of handlers ?? []) await handler(event, ctx);
}

/** The missing-token check is fire-and-forget; give its file reads time to settle. */
async function settleWarning(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
	agentDir = isolateFeadsAgentDir();
	vi.stubEnv("FEADS_AGENT_TOKEN", undefined);
	vi.stubEnv("FEADS_TOKEN", undefined);
	vi.stubEnv("PI_SUBAGENT_ID", undefined);
	vi.stubEnv("PI_NO_FEADS", undefined);
	vi.stubEnv("FEADS_URL", "http://feads.test");
	__testing.resetMissingTokenWarning();
	presenceTesting.resetAlerts();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	presenceTesting.resetAlerts();
	presenceTesting.resetPresenceStatus(undefined, "http://127.0.0.1:8787");
	// session_start consumes PI_NO_FEADS; leave the shared guard enabled for the next test.
	feadsSessionState.startSession(`reset-${Math.random()}`);
});

describe("missing-token warning at session_start", () => {
	it("warns once per process when a feads MCP server is configured and no token resolves", async () => {
		writeMcpConfig({ feads: { type: "http", url: "http://127.0.0.1:8787" } });
		const extension = await loadExtension();
		const { ctx, notify } = makeContext();
		await invoke(extension, "session_start", {}, ctx);
		await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
		expect(notify).toHaveBeenCalledWith(__testing.MISSING_TOKEN_WARNING, "warning");
		expect(__testing.MISSING_TOKEN_WARNING).not.toContain("\n");

		await invoke(extension, "session_start", {}, ctx);
		await settleWarning();
		expect(notify).toHaveBeenCalledOnce();
	});

	it("matches a server by URL host, and ignores non-feads or disabled servers", async () => {
		const entry = (name: string, url: string, disabled = false) => ({
			name,
			enabled: !disabled,
			entry: { config: { type: "http", url } },
		});
		expect(__testing.isFeadsServer(entry("tasks", "https://feads.internal.example/mcp") as never)).toBe(true);
		expect(__testing.isFeadsServer(entry("FEADS", "https://x.example/mcp") as never)).toBe(true);
		expect(__testing.isFeadsServer(entry("feads", "https://x.example/mcp", true) as never)).toBe(false);
		expect(__testing.isFeadsServer(entry("other", "https://feads-like.example/mcp") as never)).toBe(false);

		writeMcpConfig({ slack: { type: "http", url: "http://127.0.0.1:8787" } });
		const extension = await loadExtension();
		const { ctx, notify } = makeContext();
		await invoke(extension, "session_start", {}, ctx);
		await settleWarning();
		expect(notify).not.toHaveBeenCalled();
	});

	it("stays silent when a token resolves from the environment or phi.env", async () => {
		writeMcpConfig({ feads: { type: "http", url: "http://127.0.0.1:8787" } });
		vi.stubEnv("FEADS_AGENT_TOKEN", "env-token");
		const extension = await loadExtension();
		const { ctx, notify } = makeContext();
		await invoke(extension, "session_start", {}, ctx);
		await settleWarning();

		vi.stubEnv("FEADS_AGENT_TOKEN", undefined);
		writeFileSync(join(agentDir, "phi.env"), "export FEADS_AGENT_TOKEN=fdsa_example\n");
		await invoke(extension, "session_start", {}, ctx);
		await settleWarning();
		expect(notify).not.toHaveBeenCalled();
	});

	it("stays silent when Feads is disabled or in a nested subagent", async () => {
		writeMcpConfig({ feads: { type: "http", url: "http://127.0.0.1:8787" } });
		const extension = await loadExtension();
		const { ctx, notify } = makeContext();

		vi.stubEnv("PI_NO_FEADS", "1");
		await invoke(extension, "session_start", {}, ctx);
		await settleWarning();

		vi.stubEnv("PI_SUBAGENT_ID", "run-1");
		await invoke(extension, "session_start", {}, ctx);
		await settleWarning();
		expect(notify).not.toHaveBeenCalled();
	});

	it("writes the warning to stderr when there is no UI (print mode)", async () => {
		writeMcpConfig({ feads: { type: "http", url: "http://127.0.0.1:8787" } });
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const extension = await loadExtension();
		const { ctx, notify } = makeContext(false);
		await invoke(extension, "session_start", {}, ctx);
		await vi.waitFor(() => expect(error).toHaveBeenCalledWith(__testing.MISSING_TOKEN_WARNING));
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("heartbeat failure alerts", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv("FEADS_AGENT_TOKEN", "test-token");
		feadsSessionState.startSession(`alerts-${Math.random()}`);
	});

	function startPublisher(): FeadsPresencePublisher {
		const publisher = new FeadsPresencePublisher({ debounceMs: 1 });
		publisher.publish(mainEvent);
		return publisher;
	}

	it("alerts immediately on a 401 and only once for that category", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
		const listener = vi.fn();
		setFeadsPresenceAlertListener(listener);
		const publisher = startPublisher();
		await vi.advanceTimersByTimeAsync(1);
		expect(listener).toHaveBeenCalledOnce();
		expect(listener.mock.calls[0]?.[0]).toMatchObject({ category: "401", statusCode: 401, consecutiveFailures: 1 });
		expect(listener.mock.calls[0]?.[0].message).toContain("(401)");
		expect(listener.mock.calls[0]?.[0].message).toContain("/feads-status");

		await vi.advanceTimersByTimeAsync(120_000);
		expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(2);
		expect(listener).toHaveBeenCalledOnce();
		const rendered = formatFeadsPresenceStatus(getFeadsPresenceStatus());
		expect(rendered).toContain("last failure status code: 401");
		expect(rendered).toMatch(/consecutive failures: [2-9]/);
		publisher.dispose();
	});

	it("alerts on a 400 immediately", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 400 })));
		const listener = vi.fn();
		setFeadsPresenceAlertListener(listener);
		const publisher = startPublisher();
		await vi.advanceTimersByTimeAsync(1);
		expect(listener).toHaveBeenCalledWith(expect.objectContaining({ category: "400" }));
		publisher.dispose();
	});

	it("alerts on transient failures only after three in a row, once", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("slow", "TimeoutError")));
		const listener = vi.fn();
		setFeadsPresenceAlertListener(listener);
		const publisher = startPublisher();
		const fetchMock = vi.mocked(fetch);
		while (fetchMock.mock.calls.length < FEADS_PRESENCE_ALERT_AFTER_FAILURES - 1) {
			await vi.advanceTimersByTimeAsync(250);
		}
		expect(listener).not.toHaveBeenCalled();
		while (fetchMock.mock.calls.length < FEADS_PRESENCE_ALERT_AFTER_FAILURES) {
			await vi.advanceTimersByTimeAsync(250);
		}
		await vi.advanceTimersByTimeAsync(0);
		expect(listener).toHaveBeenCalledOnce();
		expect(listener.mock.calls[0]?.[0]).toMatchObject({
			category: "timeout",
			statusCode: undefined,
			consecutiveFailures: 3,
		});
		await vi.advanceTimersByTimeAsync(120_000);
		expect(listener).toHaveBeenCalledOnce();
		publisher.dispose();
	});

	it("a success resets the transient streak and never alerts", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("down"))
			.mockRejectedValueOnce(new TypeError("down"))
			.mockResolvedValue(new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const listener = vi.fn();
		setFeadsPresenceAlertListener(listener);
		const publisher = startPublisher();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(getFeadsPresenceStatus().consecutiveFailures).toBe(0);
		fetchMock.mockReset().mockRejectedValue(new TypeError("down"));
		publisher.publish({ ...mainEvent, agent: { ...mainEvent.agent, status: "idle" } });
		await vi.advanceTimersByTimeAsync(1);
		expect(getFeadsPresenceStatus().consecutiveFailures).toBe(1);
		expect(listener).not.toHaveBeenCalled();
		publisher.dispose();
	});

	it("routes alerts to the session UI via the feads-agent extension, not in subagents or when disabled", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 403 })));
		const extension = await loadExtension();
		const { ctx, notify } = makeContext();
		await invoke(extension, "session_start", {}, ctx);
		const publisher = startPublisher();
		await vi.advanceTimersByTimeAsync(1);
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0]?.[0]).toContain("(403)");
		expect(notify.mock.calls[0]?.[1]).toBe("warning");
		publisher.dispose();

		// After shutdown the listener is gone; the category is not spent without a listener.
		await invoke(extension, "session_shutdown", {}, ctx);
		presenceTesting.resetAlerts();
		vi.stubEnv("PI_SUBAGENT_ID", "run-1");
		const nested = makeContext();
		await invoke(extension, "session_start", {}, nested.ctx);
		const nestedPublisher = startPublisher();
		await vi.advanceTimersByTimeAsync(1);
		expect(nested.notify).not.toHaveBeenCalled();
		nestedPublisher.dispose();
		await vi.advanceTimersByTimeAsync(1);
		expect(nested.notify).not.toHaveBeenCalled();

		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		const disabled = makeContext();
		await invoke(extension, "session_start", {}, disabled.ctx);
		await extension.commands.get("no-feads")?.handler("", { ui: { notify: vi.fn() } } as never);
		const disabledPublisher = startPublisher();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(disabled.notify).not.toHaveBeenCalled();
		disabledPublisher.dispose();
	});
});
