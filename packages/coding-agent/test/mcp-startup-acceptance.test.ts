import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The extension is loaded from source in this package. Its production self-import
// resolves through package exports, which intentionally points at dist; keep this
// black-box test on the source harness without changing the extension or package.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => process.env.PHI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? "",
	DEFAULT_MAX_BYTES: 50 * 1024,
	DEFAULT_MAX_LINES: 2_000,
	formatSize: (bytes: number) => `${bytes} B`,
	truncateHead: (content: string) => ({
		content,
		truncated: false,
		outputLines: content.split("\n").length,
		totalLines: content.split("\n").length,
		outputBytes: Buffer.byteLength(content),
		totalBytes: Buffer.byteLength(content),
	}),
}));

import type { ExtensionContext } from "../src/core/extensions/types.ts";
import mcpExtension from "../src/extensions/mcp/index.ts";
import { createHarness } from "./suite/harness.ts";
import { toolContext } from "./tool-context.ts";

const SERVER_NAME = "held-http";
const TOOL_NAME = "query_metrics";
const REGISTERED_TOOL_NAME = "mcp_held_http_query_metrics";
const FINDER_TOOL_NAME = "mcp_find_tools";
const SECRET = "mcp-acceptance-secret-7f4e";
const CACHE_FILE = "mcp-catalog-v1.json";

interface FakeMcpServer {
	fetch: ReturnType<typeof vi.fn>;
	calls: string[];
	initializeStarted: boolean;
	initializeAborted: number;
	released: boolean;
	releaseInitialize: () => void;
}

interface JsonRpcMessage {
	id?: number;
	method?: string;
}

function jsonRpcResponse(id: number | undefined, result: unknown): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"mcp-session-id": "acceptance-session",
		},
	});
}

function createFakeMcpServer(options: { holdInitialize: boolean }): FakeMcpServer {
	const calls: string[] = [];
	let initializeStarted = false;
	let initializeAborted = 0;
	let released = !options.holdInitialize;
	let releaseInitialize = (): void => {};

	const server = {
		fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const method = init?.method ?? "GET";
			if (method === "DELETE") {
				calls.push("DELETE");
				return new Response(null, { status: 204 });
			}

			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as JsonRpcMessage) : {};
			calls.push(body.method ?? "");
			if (body.method === "initialize") {
				initializeStarted = true;
				if (options.holdInitialize && !released) {
					return new Promise<Response>((resolve, reject) => {
						const signal = init?.signal;
						const onAbort = (): void => {
							initializeAborted++;
							signal?.removeEventListener("abort", onAbort);
							reject(new DOMException("The operation was aborted", "AbortError"));
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						releaseInitialize = (): void => {
							if (released) return;
							released = true;
							signal?.removeEventListener("abort", onAbort);
							resolve(jsonRpcResponse(body.id, initializeResult()));
						};
					});
				}
				return jsonRpcResponse(body.id, initializeResult());
			}
			if (body.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			if (body.method === "tools/list") {
				return jsonRpcResponse(body.id, {
					tools: [
						{
							name: TOOL_NAME,
							description: "Query metrics from the held fake server",
							inputSchema: { type: "object", properties: {} },
						},
					],
				});
			}
			if (body.method === "tools/call") {
				return jsonRpcResponse(body.id, { content: [{ type: "text", text: "fake result" }] });
			}

			throw new Error(`Unexpected fake MCP request to ${String(input)}: ${body.method ?? "unknown"}`);
		}),
		calls,
		get initializeStarted() {
			return initializeStarted;
		},
		get initializeAborted() {
			return initializeAborted;
		},
		get released() {
			return released;
		},
		releaseInitialize,
	} as FakeMcpServer;

	server.releaseInitialize = (): void => {
		releaseInitialize();
	};
	return server;
}

function initializeResult(): Record<string, unknown> {
	return {
		protocolVersion: "2025-06-18",
		serverInfo: { name: "fake-mcp", version: "1.0.0" },
		instructions: "Use query_metrics for the acceptance fixture.",
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

async function resolveWithin<T>(promise: Promise<T>, timeoutMs = 1_500): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Promise did not resolve within ${timeoutMs}ms`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function createAgentDir(): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "phi-mcp-startup-"));
	await writeFile(
		join(agentDir, "mcp.json"),
		JSON.stringify(
			{
				mcpServers: {
					[SERVER_NAME]: {
						type: "http",
						url: "https://fake-mcp.test/rpc",
						headers: {
							Authorization: `Bearer ${SECRET}`,
							"X-Acceptance-Token": "$PHI_MCP_ACCEPTANCE_TOKEN",
						},
						toolMode: "lazy",
						timeoutMs: 1_000,
					},
				},
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	return agentDir;
}

async function shutdown(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
	await resolveWithin(harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
	harness.cleanup();
}

async function executeFinder(
	harness: Awaited<ReturnType<typeof createHarness>>,
	params: { query: string; server?: string },
): Promise<unknown> {
	const finder = harness.session.getToolDefinition(FINDER_TOOL_NAME);
	if (!finder) throw new Error(`${FINDER_TOOL_NAME} was not registered`);
	return finder.execute("acceptance-finder", params, undefined, undefined, toolContext({} as ExtensionContext));
}

describe("native MCP startup acceptance", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("does not hold session_start on initialize and waits in a scoped finder request", async () => {
		const agentDir = await createAgentDir();
		const fake = createFakeMcpServer({ holdInitialize: true });
		vi.stubEnv("PHI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PHI_MCP_ACCEPTANCE_TOKEN", SECRET);
		vi.stubGlobal("fetch", fake.fetch);
		const harness = await createHarness({ extensionFactories: [mcpExtension] });

		try {
			const startedAt = Date.now();
			await resolveWithin(harness.session.bindExtensions({}));
			expect(Date.now() - startedAt).toBeLessThan(1_500);
			await waitFor(() => fake.initializeStarted);

			expect(harness.session.getToolDefinition(FINDER_TOOL_NAME)).toBeDefined();
			expect(harness.session.getActiveToolNames()).toContain(FINDER_TOOL_NAME);
			expect(harness.session.getToolDefinition(REGISTERED_TOOL_NAME)).toBeUndefined();

			const finderRequest = executeFinder(harness, { query: "query metrics", server: SERVER_NAME });
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			expect(fake.released).toBe(false);
			expect(harness.session.getActiveToolNames()).not.toContain(REGISTERED_TOOL_NAME);

			fake.releaseInitialize();
			const result = await resolveWithin(finderRequest);
			expect(JSON.stringify(result)).toContain(REGISTERED_TOOL_NAME);
			expect(harness.session.getToolDefinition(REGISTERED_TOOL_NAME)).toBeDefined();
			expect(harness.session.getActiveToolNames()).toContain(REGISTERED_TOOL_NAME);
		} finally {
			fake.releaseInitialize();
			await shutdown(harness);
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("uses a valid catalog cache for immediate discovery without persisting header or env secrets", async () => {
		const agentDir = await createAgentDir();
		vi.stubEnv("PHI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PHI_MCP_ACCEPTANCE_TOKEN", SECRET);

		const seedServer = createFakeMcpServer({ holdInitialize: false });
		vi.stubGlobal("fetch", seedServer.fetch);
		const seedHarness = await createHarness({ extensionFactories: [mcpExtension] });
		try {
			await resolveWithin(seedHarness.session.bindExtensions({}));
			await waitFor(() => seedServer.calls.includes("tools/list"));
			await waitFor(() => existsSync(join(agentDir, "cache", CACHE_FILE)));
		} finally {
			await shutdown(seedHarness);
		}

		try {
			const cacheBytes = await readFile(join(agentDir, "cache", CACHE_FILE), "utf8");
			expect(cacheBytes).not.toContain(SECRET);

			const heldServer = createFakeMcpServer({ holdInitialize: true });
			vi.stubGlobal("fetch", heldServer.fetch);
			const harness = await createHarness({ extensionFactories: [mcpExtension] });
			try {
				await resolveWithin(harness.session.bindExtensions({}));
				await waitFor(() => heldServer.initializeStarted);
				expect(harness.session.getToolDefinition(REGISTERED_TOOL_NAME)).toBeDefined();
				expect(harness.session.getActiveToolNames()).toContain(FINDER_TOOL_NAME);
				expect(harness.session.getActiveToolNames()).not.toContain(REGISTERED_TOOL_NAME);

				const result = await resolveWithin(executeFinder(harness, { query: "query metrics" }), 500);
				expect(JSON.stringify(result)).toContain(REGISTERED_TOOL_NAME);
				expect(harness.session.getActiveToolNames()).toContain(REGISTERED_TOOL_NAME);
				expect(heldServer.calls).toEqual(["initialize"]);
			} finally {
				heldServer.releaseInitialize();
				await shutdown(harness);
			}
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("aborts a held connection on session_shutdown without late registration or unhandled rejection", async () => {
		const agentDir = await createAgentDir();
		const fake = createFakeMcpServer({ holdInitialize: true });
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		vi.stubEnv("PHI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PHI_MCP_ACCEPTANCE_TOKEN", SECRET);
		vi.stubGlobal("fetch", fake.fetch);
		process.on("unhandledRejection", onUnhandled);
		const harness = await createHarness({ extensionFactories: [mcpExtension] });

		try {
			await resolveWithin(harness.session.bindExtensions({}));
			await waitFor(() => fake.initializeStarted);
			await resolveWithin(harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
			await waitFor(() => fake.initializeAborted > 0);
			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			expect(fake.initializeAborted).toBeGreaterThan(0);
			expect(harness.session.getToolDefinition(REGISTERED_TOOL_NAME)).toBeUndefined();
			expect(harness.session.getAllTools().some((tool) => tool.name === REGISTERED_TOOL_NAME)).toBe(false);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			fake.releaseInitialize();
			harness.cleanup();
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
