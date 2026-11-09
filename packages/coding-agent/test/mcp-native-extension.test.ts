import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import {
	CatalogCache,
	catalogCachePath,
	DEFAULT_CATALOG_CACHE_TTL_MS,
	loadCatalogCache,
} from "../src/extensions/mcp/cache.ts";
import type { McpClient } from "../src/extensions/mcp/client.ts";
import * as mcpClient from "../src/extensions/mcp/client.ts";
import { loadBridgeConfig, serverConfigFingerprint } from "../src/extensions/mcp/config.ts";
import { FINDER_TOOL_NAME } from "../src/extensions/mcp/finder.ts";
import mcpExtension, { McpManager } from "../src/extensions/mcp/index.ts";
import type { McpToolInfo } from "../src/extensions/mcp/protocol.ts";
import { toolContext } from "./tool-context.ts";

type Loaded = Awaited<ReturnType<typeof loadExtensionFromFactory>>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

type FakeServerOptions = {
	gate?: Promise<void>;
	tools?: McpToolInfo[];
	instructions?: string;
	callError?: { code: number; message: string };
	onCall?: (toolName: string) => void;
};

let agentDir: string;
let configPath: string;
let loaded: Loaded[];
let fetchMock: ReturnType<typeof vi.spyOn>;
let previousAgentDir: string | undefined;
let previousBrandedAgentDir: string | undefined;
let previousConfigPath: string | undefined;
let previousAuthDir: string | undefined;
let previousInstructionsWait: string | undefined;
const persistedEntries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
let branchEntries: Array<{ type: "custom"; customType: string; data: unknown }> = persistedEntries;
let extensionActiveTools: string[] = [];

const notify = vi.fn();
const setStatus = vi.fn();
const context = {
	cwd: "/tmp/mcp-native-test",
	isProjectTrusted: () => true,
	mode: "print",
	hasUI: true,
	ui: { notify, setStatus, custom: vi.fn() },
	sessionManager: {
		getSessionId: () => "mcp-test-session",
		getBranch: () => branchEntries,
	},
} as unknown as ExtensionCommandContext;

beforeEach(() => {
	vi.clearAllMocks();
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousBrandedAgentDir = process.env.PHI_CODING_AGENT_DIR;
	previousConfigPath = process.env.PHI_MCP_CONFIG;
	previousAuthDir = process.env.PHI_MCP_AUTH_DIR;
	previousInstructionsWait = process.env.PHI_MCP_INSTRUCTIONS_WAIT_MS;
	delete process.env.PHI_MCP_INSTRUCTIONS_WAIT_MS;
	agentDir = mkdtempSync(join(tmpdir(), "phi-mcp-native-"));
	configPath = join(agentDir, "mcp.json");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PHI_CODING_AGENT_DIR;
	process.env.PHI_MCP_CONFIG = configPath;
	// HTTP servers default to OAuth, so keep the credential store inside the
	// fixture instead of reading the developer's real ~/.mcp-auth.
	process.env.PHI_MCP_AUTH_DIR = join(agentDir, "mcp-auth");
	loaded = [];
	persistedEntries.length = 0;
	branchEntries = persistedEntries;
	extensionActiveTools = [];
});

afterEach(async () => {
	for (const extension of loaded) await invoke(extension, "session_shutdown", { type: "session_shutdown" });
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousBrandedAgentDir === undefined) delete process.env.PHI_CODING_AGENT_DIR;
	else process.env.PHI_CODING_AGENT_DIR = previousBrandedAgentDir;
	if (previousConfigPath === undefined) delete process.env.PHI_MCP_CONFIG;
	else process.env.PHI_MCP_CONFIG = previousConfigPath;
	if (previousAuthDir === undefined) delete process.env.PHI_MCP_AUTH_DIR;
	else process.env.PHI_MCP_AUTH_DIR = previousAuthDir;
	if (previousInstructionsWait === undefined) delete process.env.PHI_MCP_INSTRUCTIONS_WAIT_MS;
	else process.env.PHI_MCP_INSTRUCTIONS_WAIT_MS = previousInstructionsWait;
	try {
		chmodSync(agentDir, 0o755);
	} catch {
		// The temporary directory may already have been removed by a failed test.
	}
	rmSync(agentDir, { recursive: true, force: true });
});

function writeConfig(entry: Record<string, unknown> = { type: "http", url: "http://mcp.test/mcp" }): void {
	writeFileSync(configPath, JSON.stringify({ mcpServers: { demo: entry } }), "utf8");
}

async function load(runtime = createExtensionRuntime()): Promise<Loaded> {
	const extension = await loadExtensionFromFactory(
		mcpExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"<inline:mcp-test>",
	);
	runtime.getActiveTools = () => extensionActiveTools;
	runtime.setActiveTools = (names) => {
		extensionActiveTools = [...names];
	};
	// The tests do not add an unrelated extension, so this is enough to exercise
	// the registration and active-set logic without constructing a full session.
	runtime.getAllTools = () => [];
	loaded.push(extension);
	return extension;
}

async function invoke(extension: Loaded, eventName: string, event: unknown): Promise<unknown[]> {
	const handlers = (extension.handlers as Map<string, Handler[]>).get(eventName) ?? [];
	const results: unknown[] = [];
	for (const handler of handlers) results.push(await handler(event, context));
	return results;
}

function definition(extension: Loaded, name: string): ToolDefinition {
	const tool = extension.tools.get(name)?.definition;
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool as ToolDefinition;
}

function jsonRpc(result: unknown, id: number): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function jsonRpcError(error: { code: number; message: string }, id: number): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, error }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function waitForGate(gate: Promise<void>, signal: AbortSignal | null | undefined): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(new DOMException("aborted", "AbortError"));
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		gate.then(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			(error: unknown) => {
				signal?.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function installFakeServer(options: FakeServerOptions = {}): { release: () => void } {
	let releaseGate: (() => void) | undefined;
	const gate =
		options.gate ??
		new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
	const tools = options.tools ?? [
		{
			name: "ping",
			description: "ping the test server",
			inputSchema: { type: "object", properties: {}, required: [] },
		},
	];
	let nextId = 0;
	fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		if (init?.method === "DELETE") return new Response("", { status: 204 });
		const body = JSON.parse(String(init?.body)) as { id?: number; method?: string; params?: { name?: string } };
		if (options.gate && body.method === "initialize") await waitForGate(gate, init?.signal);
		if (body.method === "initialize") {
			return jsonRpc(
				{
					protocolVersion: "2025-06-18",
					serverInfo: { name: "fake-mcp", version: "1" },
					instructions: options.instructions,
				},
				body.id ?? ++nextId,
			);
		}
		if (body.method === "notifications/initialized") return new Response("", { status: 202 });
		if (body.method === "tools/list") return jsonRpc({ tools }, body.id ?? ++nextId);
		if (body.method === "tools/call") {
			options.onCall?.(body.params?.name ?? "");
			if (options.callError) return jsonRpcError(options.callError, body.id ?? ++nextId);
			return jsonRpc({ content: [{ type: "text", text: "pong" }] }, body.id ?? ++nextId);
		}
		if (body.method === undefined) return new Response("", { status: 202 });
		return new Response("not found", { status: 404 });
	});
	return { release: () => releaseGate?.() };
}

describe("native MCP extension", () => {
	it("publishes safe controller snapshots for live, disabled, and invalid servers", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: {
					demo: { type: "http", url: "http://mcp.test/mcp" },
					disabled: { type: "http", url: "http://disabled.test/mcp", disabled: true },
					invalid: { type: "stdio", command: "$MCP_MISSING" },
				},
			}),
			"utf8",
		);
		installFakeServer();
		const tools = new Map<string, ToolDefinition>();
		let active: string[] = [];
		const pi = {
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerTools: (defs: readonly ToolDefinition[]) => {
				for (const tool of defs) tools.set(tool.name, tool);
			},
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = [...names];
			},
			getAllTools: () => [],
		} as unknown as ExtensionAPI;
		const manager = new McpManager(pi, agentDir);
		const changes = vi.fn();
		const controller = manager.getController();
		const unsubscribe = controller.subscribe(changes);
		await manager.beginSession(await loadBridgeConfig(agentDir), context);

		expect(controller.getServers()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "disabled", status: "disabled", enabled: false }),
				expect.objectContaining({ name: "invalid", status: "invalid", enabled: true }),
			]),
		);
		await vi.waitFor(() =>
			expect(controller.getServers().find((server) => server.name === "demo")?.status).toBe("ready"),
		);
		expect(controller.getServers().find((server) => server.name === "demo")).toMatchObject({
			status: "ready",
			toolCount: 1,
			loadedToolCount: 0,
		});
		expect(changes).toHaveBeenCalled();
		unsubscribe();
		await manager.stop();
	});

	it("keeps a finder-loaded lazy tool through reconciliation, reconnect, and manager recreation", async () => {
		writeConfig();
		installFakeServer();
		const tools = new Map<string, ToolDefinition>();
		let active: string[] = [];
		const pi = {
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerTools: (defs: readonly ToolDefinition[]) => {
				for (const tool of defs) tools.set(tool.name, tool);
			},
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = [...names];
			},
			getAllTools: () => [],
			appendEntry: (customType: string, data: unknown) => {
				persistedEntries.push({ type: "custom", customType, data });
			},
		} as unknown as ExtensionAPI;
		const sessionContext = {
			...context,
			sessionManager: {
				getSessionId: () => "mcp-test-session",
				getBranch: () => persistedEntries,
			},
		} as unknown as ExtensionCommandContext;
		const manager = new McpManager(pi, agentDir);
		await manager.beginSession(await loadBridgeConfig(agentDir), sessionContext);
		await vi.waitFor(() => expect(tools.has("mcp_demo_ping")).toBe(true));
		const finder = tools.get(FINDER_TOOL_NAME)!;
		const firstLoad = await finder.execute(
			"find",
			{ query: "ping" } as never,
			undefined,
			undefined,
			toolContext(sessionContext),
		);
		expect(firstLoad.details).toMatchObject({ added: ["mcp_demo_ping"] });
		expect(firstLoad.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Loaded 1 tool(s):") }),
		]);
		expect(active).toContain("mcp_demo_ping");
		expect(persistedEntries).toEqual([
			expect.objectContaining({ customType: "mcp_tool_loaded", data: { serverName: "demo", toolName: "ping" } }),
		]);

		await manager.reconnect("demo");
		expect(active).toContain("mcp_demo_ping");
		await manager.stop();

		const recreated = new McpManager(pi, agentDir);
		await recreated.beginSession(await loadBridgeConfig(agentDir), sessionContext);
		await vi.waitFor(() => expect(active).toContain("mcp_demo_ping"));
		await recreated.stop();
	});

	it("limits lazy auto-activation to finder-selected tools and follows branch navigation", async () => {
		writeConfig();
		installFakeServer();
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });
		await vi.waitFor(() => expect(extension.tools.has("mcp_demo_ping")).toBe(true));

		const lazyTool = definition(extension, "mcp_demo_ping");
		if (typeof lazyTool.autoActivateOnCall !== "function") throw new Error("lazy tool lacks eligibility predicate");
		const inactiveContext = { systemPrompt: "", messages: [], tools: [] };
		expect(lazyTool.autoActivateOnCall(inactiveContext)).toBe(false);

		const finder = definition(extension, FINDER_TOOL_NAME);
		await finder.execute("find", { query: "ping" } as never, undefined, undefined, toolContext(context));
		expect(lazyTool.autoActivateOnCall(inactiveContext)).toBe(true);
		expect(extensionActiveTools).toContain("mcp_demo_ping");
		persistedEntries.push({
			type: "custom",
			customType: "mcp_tool_loaded",
			data: { serverName: "demo", toolName: "ping" },
		});

		branchEntries = [];
		await invoke(extension, "session_tree", { type: "session_tree", newLeafId: "branch-b", oldLeafId: "branch-a" });
		expect(lazyTool.autoActivateOnCall(inactiveContext)).toBe(false);
		expect(extensionActiveTools).not.toContain("mcp_demo_ping");

		branchEntries = persistedEntries;
		await invoke(extension, "session_tree", { type: "session_tree", newLeafId: "branch-a", oldLeafId: "branch-b" });
		expect(lazyTool.autoActivateOnCall(inactiveContext)).toBe(true);
		expect(extensionActiveTools).toContain("mcp_demo_ping");
	});

	it("returns from session_start while a handshake is delayed", async () => {
		writeConfig();
		const { release } = installFakeServer({ gate: new Promise<void>(() => undefined) });
		const extension = await load();

		await expect(invoke(extension, "session_start", { type: "session_start" })).resolves.toBeDefined();
		// session_start has already returned; the first POST follows a turn later,
		// because an OAuth-capable server looks for a cached credential first.
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(extension.tools.has(FINDER_TOOL_NAME)).toBe(true);
		expect(extension.tools.has("mcp_demo_ping")).toBe(false);
		release();
	});

	it("registers a multi-server catalogue with one registry refresh per reconcile, not one per tool", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: Object.fromEntries(
					["alpha", "beta", "gamma"].map((name) => [name, { type: "http", url: `http://${name}.test/mcp` }]),
				),
			}),
			"utf8",
		);
		installFakeServer({
			gate: Promise.resolve(),
			tools: Array.from({ length: 50 }, (_, index) => ({
				name: `tool_${index}`,
				description: "bulk catalogue tool",
				inputSchema: { type: "object", properties: {}, required: [] },
			})),
		});
		const runtime = createExtensionRuntime();
		let refreshes = 0;
		runtime.refreshTools = () => {
			refreshes++;
		};
		const reconcile = vi.spyOn(McpManager.prototype as unknown as { reconcile: () => void }, "reconcile");
		const extension = await load(runtime);
		await invoke(extension, "session_start", { type: "session_start" });
		await vi.waitFor(() => expect(extension.tools.size).toBe(151));
		// Each refresh rebuilds every tool wrapper and the system prompt. Per-tool
		// registration made this one refresh per tool per reconcile (quadratic in tools),
		// which blocked the event loop for seconds on large catalogues. Now each reconcile
		// refreshes at most once (catalogue and finder in one batch), plus the finder's own
		// registration when the session starts.
		expect(reconcile.mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(refreshes).toBeLessThanOrEqual(reconcile.mock.calls.length + 1);
	});

	it("bounds first-prompt instruction wait and includes a late server on the next turn", async () => {
		writeConfig({ type: "http", url: "http://mcp.test/mcp", toolMode: "eager" });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		installFakeServer({ gate, instructions: "Read the live MCP contract." });
		process.env.PHI_MCP_INSTRUCTIONS_WAIT_MS = "120";
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

		vi.useFakeTimers();
		const firstTurn = invoke(extension, "before_agent_start", {
			type: "before_agent_start",
			prompt: "first",
			systemPrompt: "BASE",
			systemPromptOptions: {},
		});
		let settled = false;
		void firstTurn.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(119);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await firstTurn).toEqual([undefined]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.useRealTimers();

		release();
		await vi.waitFor(() => expect(extension.tools.has("mcp_demo_ping")).toBe(true));
		const nextTurn = await invoke(extension, "before_agent_start", {
			type: "before_agent_start",
			prompt: "next",
			systemPrompt: "BASE",
			systemPromptOptions: {},
		});
		expect((nextTurn[0] as { systemPrompt: string }).systemPrompt).toContain("Read the live MCP contract.");
	});

	it("delivers a lazy server's instructions with its first loaded tool, not the system prompt", async () => {
		writeConfig();
		installFakeServer({ instructions: "Read the lazy MCP contract." });
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });
		await vi.waitFor(() => expect(extension.tools.has("mcp_demo_ping")).toBe(true));

		const firstTurn = await invoke(extension, "before_agent_start", {
			type: "before_agent_start",
			prompt: "first",
			systemPrompt: "BASE",
			systemPromptOptions: {},
		});
		expect(firstTurn).toEqual([undefined]);

		const finder = definition(extension, FINDER_TOOL_NAME);
		const first = await finder.execute(
			"find",
			{ query: "ping" } as never,
			undefined,
			undefined,
			toolContext(context),
		);
		expect(first.content[0]).toMatchObject({ text: expect.stringContaining("Read the lazy MCP contract.") });
		const again = await finder.execute(
			"find",
			{ query: "ping" } as never,
			undefined,
			undefined,
			toolContext(context),
		);
		expect(again.content[0]).toMatchObject({ text: expect.not.stringContaining("Read the lazy MCP contract.") });
		const nextTurn = await invoke(extension, "before_agent_start", {
			type: "before_agent_start",
			prompt: "next",
			systemPrompt: "BASE",
			systemPromptOptions: {},
		});
		expect((nextTurn[0] as { systemPrompt: string }).systemPrompt).toContain("Read the lazy MCP contract.");
	});

	it("skips the instruction wait entirely when configured to zero", async () => {
		writeConfig({ type: "http", url: "http://mcp.test/mcp", toolMode: "eager" });
		installFakeServer({ gate: new Promise<void>(() => undefined), instructions: "Pending MCP instructions." });
		process.env.PHI_MCP_INSTRUCTIONS_WAIT_MS = "0";
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });
		const firstTurn = await invoke(extension, "before_agent_start", {
			type: "before_agent_start",
			prompt: "first",
			systemPrompt: "BASE",
			systemPromptOptions: {},
		});
		expect(firstTurn).toEqual([undefined]);
	});

	it("switches sessions before an in-flight connect settles and closes its late client", async () => {
		writeConfig();
		let release!: (client: McpClient) => void;
		const pending = new Promise<McpClient>((resolve) => {
			release = resolve;
		});
		const staleClose = vi.fn(async () => undefined);
		const staleClient: McpClient = {
			serverName: "demo",
			endpoint: "fake",
			identity: {
				protocolVersion: "2025-06-18",
				serverName: "stale",
				instructions: "STALE INSTRUCTIONS",
			},
			tools: [{ name: "stale", inputSchema: { type: "object" } }],
			callTool: vi.fn(),
			close: staleClose,
		};
		const liveClient: McpClient = {
			...staleClient,
			identity: { protocolVersion: "2025-06-18", serverName: "current" },
			tools: [{ name: "current", inputSchema: { type: "object" } }],
			close: vi.fn(async () => undefined),
		};
		vi.spyOn(mcpClient, "connectServer")
			.mockImplementationOnce(() => pending)
			.mockImplementationOnce(async () => liveClient);
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });
		const switched = invoke(extension, "session_start", { type: "session_start" });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const outcome = Promise.race([
				switched.then(() => "switched"),
				new Promise<string>((resolve) => {
					timer = setTimeout(() => resolve("blocked"), 1_000);
				}),
			]);
			expect(await outcome).toBe("switched");
		} finally {
			if (timer) clearTimeout(timer);
		}

		await vi.waitFor(() => expect(extension.tools.has("mcp_demo_current")).toBe(true));
		release(staleClient);
		await vi.waitFor(() => expect(staleClose).toHaveBeenCalledOnce());
		expect(extension.tools.has("mcp_demo_stale")).toBe(false);
		const instructions = await invoke(extension, "before_agent_start", {
			type: "before_agent_start",
			prompt: "next",
			systemPrompt: "BASE",
			systemPromptOptions: {},
		});
		expect(instructions).toEqual([undefined]);
	});

	it("updates progress and announces when every server is connected", async () => {
		writeConfig();
		installFakeServer();
		const extension = await load();

		await invoke(extension, "session_start", { type: "session_start" });
		expect(setStatus).toHaveBeenCalledWith("mcp", "MCP 0/1 connected · connecting…");
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("✓ MCP connected — 1 server, 1 tool ready", "info"));
		expect(setStatus).toHaveBeenLastCalledWith("mcp", "✓ MCP 1/1 connected");
	});

	it("summarizes connection failures and leaves a warning status", async () => {
		writeConfig();
		fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		const extension = await load();

		await invoke(extension, "session_start", { type: "session_start" });
		await vi.waitFor(() =>
			expect(notify).toHaveBeenCalledWith("MCP unavailable — all 1 server failed; run /mcp for details", "warning"),
		);
		expect(setStatus).toHaveBeenLastCalledWith("mcp", "⚠ MCP 0/1 connected · 1 unavailable");
	});

	it("makes a server-scoped finder wait for that server's in-flight connection", async () => {
		writeConfig();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		installFakeServer({ gate });
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });

		const finder = definition(extension, FINDER_TOOL_NAME);
		let settled = false;
		const search = finder
			.execute("find", { query: "ping", server: "demo" } as never, undefined, undefined, toolContext(context))
			.then(() => {
				settled = true;
			});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);
		release();
		await search;
		expect(settled).toBe(true);
	});

	it("fails a server that needs a sign-in at once when headless, and the finder never retries it", async () => {
		writeConfig();
		const previousBrowserAuth = process.env.PHI_MCP_BROWSER_AUTH;
		delete process.env.PHI_MCP_BROWSER_AUTH;
		try {
			fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));
			const extension = await load();
			const started = Date.now();
			await invoke(extension, "session_start", { type: "session_start" });
			const finder = definition(extension, FINDER_TOOL_NAME);
			const search = async (params: Record<string, unknown>) => {
				const result = await finder.execute("find", params as never, undefined, undefined, toolContext(context));
				return (result.content[0] as { text: string }).text;
			};

			const first = await search({ query: "ping" });
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(first).toContain('demo: The MCP OAuth server returned HTTP 401 (MCP server "demo" needs a sign-in');
			expect(first).toContain("run `phi mcp login demo` in a terminal");
			const calls = fetchMock.mock.calls.length;

			// Negative-cached for the session: neither a broad nor a server-scoped search reconnects.
			expect(await search({ query: "ping" })).toContain("needs a sign-in");
			expect(await search({ query: "ping", server: "demo" })).toContain("needs a sign-in");
			expect(fetchMock.mock.calls.length).toBe(calls);
			// No discovery and no login lock: nothing a terminal `phi mcp login` could block on.
			expect(fetchMock.mock.calls.some((call: unknown[]) => String(call[0]).includes(".well-known"))).toBe(false);
			const authDir = join(agentDir, "mcp-auth");
			const files = existsSync(authDir) ? readdirSync(authDir, { recursive: true }).map(String) : [];
			expect(files.filter((file) => file.endsWith("_lock.json"))).toEqual([]);
		} finally {
			if (previousBrowserAuth === undefined) delete process.env.PHI_MCP_BROWSER_AUTH;
			else process.env.PHI_MCP_BROWSER_AUTH = previousBrowserAuth;
		}
	});

	it("uses a valid cached catalogue and cached instructions before refresh completes", async () => {
		const entry = { type: "http", url: "http://mcp.test/mcp", toolMode: "eager" };
		writeConfig(entry);
		const fingerprint = serverConfigFingerprint("demo", entry);
		const cache = await CatalogCache.open(agentDir);
		await cache.put({
			serverName: "demo",
			fingerprint,
			timestamp: Date.now(),
			identity: {
				protocolVersion: "2025-06-18",
				serverName: "cached-server",
				instructions: "Use the cached MCP contract.",
			},
			tools: [{ name: "ping", description: "cached ping", inputSchema: { type: "object" } }],
		});
		installFakeServer({ gate: new Promise<void>(() => undefined), instructions: "live instructions" });
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });

		expect(extension.tools.has("mcp_demo_ping")).toBe(true);
		const beforeStart = await invoke(extension, "before_agent_start", {
			type: "before_agent_start",
			prompt: "first",
			systemPrompt: "BASE",
			systemPromptOptions: {},
		});
		expect((beforeStart[0] as { systemPrompt: string }).systemPrompt).toContain("Use the cached MCP contract.");
	});

	it("does not wait for a live refresh when cached identity records no instructions", async () => {
		writeConfig();
		const entry = { type: "http", url: "http://mcp.test/mcp" };
		const cache = await CatalogCache.open(agentDir);
		await cache.put({
			serverName: "demo",
			fingerprint: serverConfigFingerprint("demo", entry),
			timestamp: Date.now(),
			identity: { protocolVersion: "2025-06-18", serverName: "cached-server" },
			tools: [{ name: "ping", description: "cached ping", inputSchema: { type: "object" } }],
		});
		installFakeServer({ gate: new Promise<void>(() => undefined) });
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });

		const beforeStart = invoke(extension, "before_agent_start", {
			type: "before_agent_start",
			prompt: "first",
			systemPrompt: "BASE",
			systemPromptOptions: {},
		});
		await expect(
			Promise.race([
				beforeStart.then(() => "ready"),
				new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
			]),
		).resolves.toBe("ready");
	});

	it("redacts credentials from fingerprints, expires stale cache, and writes mode 0600 atomically", async () => {
		const first = {
			type: "http",
			url: "https://mcp.example.test/tools?access_token=first-secret",
			headers: { Authorization: "Bearer first-secret" },
		};
		const second = {
			...first,
			url: "https://mcp.example.test/tools?access_token=second-secret",
			headers: { Authorization: "Bearer second-secret" },
		};
		const changed = { ...first, url: "https://mcp.example.test/other" };
		const positionalSecret = {
			type: "stdio",
			command: "server",
			args: ["serve", "sk-first-secret", "--token=first-secret"],
		};
		const changedPositionalSecret = {
			...positionalSecret,
			args: ["serve", "sk-second-secret", "--token=second-secret"],
		};
		expect(serverConfigFingerprint("demo", first)).toBe(serverConfigFingerprint("demo", second));
		expect(serverConfigFingerprint("demo", first)).not.toBe(serverConfigFingerprint("demo", changed));
		expect(serverConfigFingerprint("demo", positionalSecret)).toBe(
			serverConfigFingerprint("demo", changedPositionalSecret),
		);

		const cache = await CatalogCache.open(agentDir);
		await cache.put({
			serverName: "demo",
			fingerprint: serverConfigFingerprint("demo", first),
			timestamp: Date.now(),
			tools: [{ name: "safe", title: "Safe", description: "safe", inputSchema: { type: "object" } }],
		});
		const cachePath = catalogCachePath(agentDir);
		const raw = readFileSync(cachePath, "utf8");
		expect(raw).not.toContain("first-secret");
		expect(raw).not.toContain("second-secret");
		expect(statSync(cachePath).mode & 0o777).toBe(0o600);

		writeFileSync(
			cachePath,
			JSON.stringify({
				version: 1,
				servers: [
					{
						serverName: "demo",
						fingerprint: serverConfigFingerprint("demo", first),
						timestamp: Date.now() - DEFAULT_CATALOG_CACHE_TTL_MS - 1,
						tools: [],
					},
				],
			}),
			"utf8",
		);
		expect(await loadCatalogCache(agentDir)).toEqual(new Map());
	});

	it("redacts a 200 JSON-RPC error from the transport and tool before OAuth recovery", async () => {
		const endpoint = "http://mcp.test/mcp?configured-query-secret=1";
		writeConfig({ type: "http", url: endpoint });
		const remoteMarker = `remote-marker ${endpoint}`;
		installFakeServer({ callError: { code: -32001, message: remoteMarker } });
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });
		await vi.waitFor(() => expect(extension.tools.has("mcp_demo_ping")).toBe(true));

		const tool = definition(extension, "mcp_demo_ping");
		let failure: unknown;
		try {
			await tool.execute("call", {}, undefined, undefined, toolContext(context));
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).not.toContain(remoteMarker);
		expect(message).not.toContain(endpoint);
		expect(message).not.toContain("configured-query-secret");
		expect(message).toContain("MCP OAuth server rejected the request");
	});

	it("invalidates and refetches after an MCP schema/tool error", async () => {
		writeConfig();
		let listCalls = 0;
		let calls = 0;
		fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			if (init?.method === "DELETE") return new Response("", { status: 204 });
			const body = JSON.parse(String(init?.body)) as { id?: number; method?: string };
			if (body.method === "initialize") {
				return jsonRpc({ protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } }, body.id ?? 1);
			}
			if (body.method === "notifications/initialized") return new Response("", { status: 202 });
			if (body.method === "tools/list") {
				listCalls++;
				const tools =
					listCalls === 1
						? [{ name: "old", description: "old", inputSchema: { type: "object" } }]
						: [{ name: "new", description: "new", inputSchema: { type: "object" } }];
				return jsonRpc({ tools }, body.id ?? 1);
			}
			if (body.method === "tools/call" && calls++ === 0) {
				return jsonRpcError({ code: -32602, message: "unknown tool" }, body.id ?? 1);
			}
			if (body.method === "tools/call") return jsonRpc({ content: [{ type: "text", text: "ok" }] }, body.id ?? 1);
			if (body.method === undefined) return new Response("", { status: 202 });
			if (init?.method === "DELETE") return new Response("", { status: 204 });
			return new Response("not found", { status: 404 });
		});
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });
		await vi.waitFor(() => expect(extension.tools.has("mcp_demo_old")).toBe(true));

		const oldTool = definition(extension, "mcp_demo_old");
		await expect(oldTool.execute("old-call", {}, undefined, undefined, toolContext(context))).rejects.toThrow(
			"MCP OAuth server rejected the request.",
		);
		await vi.waitFor(() => expect(extension.tools.has("mcp_demo_new")).toBe(true));
		expect(extension.tools.has("mcp_demo_new")).toBe(true);
	});

	it("cleans up a superseded generation without unhandled rejections", async () => {
		writeConfig();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		installFakeServer({ gate });
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const extension = await load();
			await invoke(extension, "session_start", { type: "session_start" });
			await invoke(extension, "session_start", { type: "session_start" });
			release();
			await invoke(extension, "session_shutdown", { type: "session_shutdown" });
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("reconnects one live server through the direct command without changing enablement", async () => {
		writeConfig();
		installFakeServer();
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("✓ MCP connected — 1 server, 1 tool ready", "info"));
		const before = fetchMock.mock.calls.length;
		const command = extension.commands.get("mcp");
		if (!command) throw new Error("MCP command was not registered");
		await command.handler("reconnect demo", context);
		expect(notify).toHaveBeenLastCalledWith("MCP reconnected 1 server.", "info");
		expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
	});

	it("persists direct enablement actions and keeps raw config unchanged", async () => {
		const raw = `${JSON.stringify({ mcpServers: { demo: { type: "http", url: "http://mcp.test/mcp" } } })}`;
		writeFileSync(configPath, raw, "utf8");
		installFakeServer();
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("✓ MCP connected — 1 server, 1 tool ready", "info"));
		const command = extension.commands.get("mcp");
		if (!command) throw new Error("MCP command was not registered");

		await command.handler("disable demo", context);
		expect(notify).toHaveBeenLastCalledWith("MCP disabled 1 server.", "info");
		await command.handler("status", context);
		expect(notify.mock.lastCall?.[0]).toContain("demo — disabled");
		expect(readFileSync(configPath, "utf8")).toBe(raw);

		await command.handler("enable demo", context);
		expect(notify).toHaveBeenLastCalledWith("MCP enabled 1 server.", "info");
		await vi.waitFor(() => expect(extension.tools.has("mcp_demo_ping")).toBe(true));
	});

	it("parses eagerTools for lazy servers and warns when it cannot apply", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: {
					listed: { type: "http", url: "http://a.test/mcp", eagerTools: ["run", "run", "observe"] },
					eager: { type: "http", url: "http://b.test/mcp", toolMode: "eager", eagerTools: ["run"] },
					malformed: { type: "http", url: "http://c.test/mcp", eagerTools: "run" },
					mixed: { type: "http", url: "http://d.test/mcp", eagerTools: ["run", 7] },
				},
			}),
			"utf8",
		);
		const config = await loadBridgeConfig(agentDir);
		const byName = new Map(config.servers.map((entry) => [entry.name, entry]));
		expect(byName.get("listed")).toMatchObject({ toolMode: "lazy", eagerTools: ["run", "observe"] });
		expect(byName.get("eager")).toMatchObject({ toolMode: "eager", eagerTools: [] });
		expect(byName.get("malformed")).toMatchObject({ toolMode: "lazy", eagerTools: [] });
		expect(byName.get("mixed")).toMatchObject({ toolMode: "lazy", eagerTools: ["run"] });
		expect(config.manifest.find((entry) => entry.name === "listed")?.eagerTools).toEqual(["run", "observe"]);
		expect(config.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining('Server "eager" "eagerTools" only applies when "toolMode" is "lazy"'),
				expect.stringContaining('Server "malformed" "eagerTools" is not an array'),
				expect.stringContaining('Server "mixed" "eagerTools" has non-string entries'),
			]),
		);
		// toolMode/eagerTools are presentation of the catalogue, not transport identity.
		expect(byName.get("listed")?.fingerprint).toBe(
			serverConfigFingerprint("listed", { type: "http", url: "http://a.test/mcp" }),
		);
	});

	it("activates only the eagerTools of a lazy server from the first turn", async () => {
		writeConfig({ type: "http", url: "http://mcp.test/mcp", eagerTools: ["ping", "missing"] });
		installFakeServer({
			instructions: "Use ping first.",
			tools: [
				{ name: "ping", description: "ping the test server", inputSchema: { type: "object" } },
				{ name: "pong", description: "answer a ping", inputSchema: { type: "object" } },
			],
		});
		const extension = await load();
		await invoke(extension, "session_start", { type: "session_start" });
		await vi.waitFor(() => expect(extensionActiveTools).toContain("mcp_demo_ping"));
		expect(extensionActiveTools).toContain(FINDER_TOOL_NAME);
		expect(extensionActiveTools).not.toContain("mcp_demo_pong");

		const inactiveContext = { systemPrompt: "", messages: [], tools: [] };
		const ping = definition(extension, "mcp_demo_ping");
		const pong = definition(extension, "mcp_demo_pong");
		if (typeof ping.autoActivateOnCall !== "function" || typeof pong.autoActivateOnCall !== "function")
			throw new Error("MCP tools lack an eligibility predicate");
		expect(ping.autoActivateOnCall(inactiveContext)).toBe(true);
		expect(pong.autoActivateOnCall(inactiveContext)).toBe(false);

		await vi.waitFor(() =>
			expect(notify).toHaveBeenCalledWith('mcp: demo "eagerTools" names unknown tool(s): missing', "warning"),
		);
		expect(notify.mock.calls.filter(([message]) => String(message).includes('"eagerTools"'))).toHaveLength(1);

		const beforeStart = await invoke(extension, "before_agent_start", {
			type: "before_agent_start",
			prompt: "first",
			systemPrompt: "BASE",
			systemPromptOptions: {},
		});
		const prompt = (beforeStart[0] as { systemPrompt: string }).systemPrompt;
		expect(prompt).toContain("Already in your tool list: `mcp_demo_ping`.");
		expect(prompt).toContain(FINDER_TOOL_NAME);

		// Calling an eager-listed tool must not persist a redundant finder load.
		await ping.execute("call", {} as never, undefined, undefined, toolContext(context));
		expect(persistedEntries).toEqual([]);

		const command = extension.commands.get("mcp");
		if (!command) throw new Error("MCP command was not registered");
		await command.handler("status", context);
		expect(notify.mock.lastCall?.[0]).toContain("2 tools — lazy + 2 eager, 1/2 loaded");

		const finder = definition(extension, FINDER_TOOL_NAME);
		const found = await finder.execute(
			"find",
			{ query: "pong" } as never,
			undefined,
			undefined,
			toolContext(context),
		);
		expect(extensionActiveTools).toEqual(expect.arrayContaining(["mcp_demo_ping", "mcp_demo_pong"]));
		// The instructions are already in the system prompt; the finder must not repeat them.
		expect(JSON.stringify(found.content)).not.toContain("Use ping first.");
	});
});
