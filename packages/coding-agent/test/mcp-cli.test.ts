import dns from "node:dns";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http, { createServer, type Server } from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectMcpEvents,
	collectMcpStatus,
	formatHumanEvents,
	formatHumanStatus,
	handleMcpCommand,
	loginMcpServer,
	logoutMcpServer,
	setMcpServerEnabled,
} from "../src/extensions/mcp/cli.ts";
import { AUTH_LOG_ENV_VAR, DEFAULT_AUTH_LOG_NAME, recordOAuthEvent } from "../src/extensions/mcp/oauth/audit.ts";
import { CredentialStore, MCP_AUTH_DIR_ENV_VAR } from "../src/extensions/mcp/oauth/store.ts";

let agentDir: string;
let authDir: string;
let previousAuthDir: string | undefined;
let servers: Server[];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "phi-mcp-cli-agent-"));
	authDir = mkdtempSync(join(tmpdir(), "phi-mcp-cli-auth-"));
	previousAuthDir = process.env[MCP_AUTH_DIR_ENV_VAR];
	process.env[MCP_AUTH_DIR_ENV_VAR] = authDir;
	servers = [];
});

afterEach(async () => {
	await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	vi.restoreAllMocks();
	if (previousAuthDir === undefined) delete process.env[MCP_AUTH_DIR_ENV_VAR];
	else process.env[MCP_AUTH_DIR_ENV_VAR] = previousAuthDir;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(authDir, { recursive: true, force: true });
});

function writeConfig(mcpServers: Record<string, unknown>): void {
	const path = join(agentDir, "mcp.json");
	writeFileSync(path, `${JSON.stringify({ mcpServers }, null, 2)}\n`, "utf8");
	chmodSync(path, 0o600);
}

/** Every outbound network primitive the transport could reach; status must touch none of them. */
function spyOnNetwork(): Array<ReturnType<typeof vi.spyOn>> {
	return [
		vi.spyOn(globalThis, "fetch"),
		vi.spyOn(http, "request"),
		vi.spyOn(https, "request"),
		vi.spyOn(net, "connect"),
		vi.spyOn(dns, "lookup"),
		vi.spyOn(dns.promises, "lookup"),
	];
}

function expectNoNetwork(spies: Array<ReturnType<typeof vi.spyOn>>): void {
	for (const spy of spies) expect(spy).not.toHaveBeenCalled();
}

/** `${NAME}` as it appears in mcp.json, assembled so the lint does not read it as a template placeholder. */
function braced(name: string): string {
	return `$\{${name}}`;
}

function withEnv(overrides: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
	const previous = new Map(Object.keys(overrides).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(overrides)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	return run().finally(() => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}

async function startAuthorizedMcpServer(accessToken: string): Promise<{ url: string; requests: string[] }> {
	const requests: string[] = [];
	const server = createServer(async (request, response) => {
		requests.push(`${request.method} ${request.url}`);
		if (request.headers.authorization !== `Bearer ${accessToken}`) {
			response.writeHead(401, {
				"content-type": "application/json",
				"www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/never-used"',
			});
			response.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		let raw = "";
		for await (const chunk of request) raw += String(chunk);
		const message = JSON.parse(raw) as Record<string, unknown>;
		if (message.method === "notifications/initialized") {
			response.writeHead(202);
			response.end();
			return;
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "test-mcp", version: "1.0.0" },
					}
				: { tools: [] };
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${address.port}/mcp`, requests };
}

describe("phi mcp control CLI", () => {
	it("returns the exact stable no-network status envelope", async () => {
		const endpoint = "https://monday.example/mcp";
		writeConfig({ monday: { type: "http", url: endpoint, auth: "oauth" } });
		const store = await CredentialStore.open(endpoint);
		await store.writeTokens({
			access_token: "stored-token",
			token_type: "Bearer",
			expires_at: Date.UTC(2026, 8, 4, 16, 0, 0),
		});
		const network = spyOnNetwork();

		await expect(collectMcpStatus(agentDir, { now: () => Date.UTC(2026, 8, 4, 15, 0, 0) })).resolves.toEqual({
			schema: 1,
			capabilities: { enablement: true },
			servers: [
				{
					name: "monday",
					transport: "http",
					enabled: true,
					authMode: "oauth",
					credential: "valid",
					expiresAt: "2026-09-04T16:00:00Z",
					needsLogin: false,
					loginInProgress: false,
					configError: null,
					missingEnv: [],
				},
			],
		});
		expectNoNetwork(network);
	});

	it("reports a static-header server whose token variable is unset as a config error, not ready", async () => {
		writeConfig({
			slack: {
				type: "http",
				url: "https://slack.example/mcp",
				headers: { Authorization: `Bearer ${braced("PHI_TEST_MCP_SLACK_TOKEN")}` },
			},
		});
		const network = spyOnNetwork();

		await withEnv({ PHI_TEST_MCP_SLACK_TOKEN: undefined }, async () => {
			const envelope = await collectMcpStatus(agentDir);
			expect(envelope.servers).toEqual([
				{
					name: "slack",
					transport: "http",
					enabled: true,
					authMode: "static",
					credential: "n/a",
					needsLogin: false,
					loginInProgress: false,
					configError:
						"slack.headers.Authorization references $PHI_TEST_MCP_SLACK_TOKEN, which is not set in the environment.",
					missingEnv: ["PHI_TEST_MCP_SLACK_TOKEN"],
				},
			]);
			const text = formatHumanStatus(envelope);
			expect(text).toBe(
				"slack: http, enabled, static, credential n/a, config error: missing $PHI_TEST_MCP_SLACK_TOKEN",
			);
			expect(text).not.toContain("ready");
		});
		expectNoNetwork(network);
	});

	it("reports every unset variable, not only the first one interpolation tripped on", async () => {
		writeConfig({
			demo: {
				type: "http",
				url: `https://${braced("PHI_TEST_MCP_HOST")}/mcp`,
				headers: { Authorization: "Bearer $PHI_TEST_MCP_TOKEN", "X-Team": braced("PHI_TEST_MCP_PRESENT") },
			},
		});
		const network = spyOnNetwork();

		await withEnv(
			{ PHI_TEST_MCP_HOST: undefined, PHI_TEST_MCP_TOKEN: undefined, PHI_TEST_MCP_PRESENT: "set-value" },
			async () => {
				const envelope = await collectMcpStatus(agentDir);
				const [demo] = envelope.servers;
				expect(demo?.missingEnv).toEqual(["PHI_TEST_MCP_HOST", "PHI_TEST_MCP_TOKEN"]);
				expect(demo?.configError).toMatch(/references \$PHI_TEST_MCP_(HOST|TOKEN), which is not set/);
				expect(demo?.configError).not.toContain("set-value");
				expect(formatHumanStatus(envelope)).toBe(
					"demo: http, enabled, static, credential n/a, config error: missing $PHI_TEST_MCP_HOST, $PHI_TEST_MCP_TOKEN",
				);
			},
		);
		expectNoNetwork(network);
	});

	it("reports a healthy static-header server with no config error once its variable is set", async () => {
		writeConfig({
			slack: {
				type: "http",
				url: "https://slack.example/mcp",
				headers: { Authorization: `Bearer ${braced("PHI_TEST_MCP_SLACK_TOKEN")}` },
			},
		});
		const network = spyOnNetwork();

		await withEnv({ PHI_TEST_MCP_SLACK_TOKEN: "xoxp-test-value" }, async () => {
			const envelope = await collectMcpStatus(agentDir);
			expect(envelope.servers[0]).toMatchObject({ name: "slack", configError: null, missingEnv: [] });
			expect(formatHumanStatus(envelope)).toBe("slack: http, enabled, static, credential n/a, ready");
			expect(JSON.stringify(envelope)).not.toContain("xoxp-test-value");
		});
		expectNoNetwork(network);
	});

	it("persists effective enablement in the sidecar and overrides the raw default", async () => {
		writeConfig({ demo: { type: "stdio", command: "demo-mcp", disabled: true } });
		const configBefore = readFileSync(join(agentDir, "mcp.json"), "utf8");

		await expect(setMcpServerEnabled(agentDir, "DEMO", true)).resolves.toEqual({
			schema: 1,
			server: "demo",
			enabled: true,
		});
		await expect(collectMcpStatus(agentDir)).resolves.toMatchObject({
			servers: [{ name: "demo", enabled: true }],
		});
		await expect(setMcpServerEnabled(agentDir, "demo", false)).resolves.toEqual({
			schema: 1,
			server: "demo",
			enabled: false,
		});
		await expect(collectMcpStatus(agentDir)).resolves.toMatchObject({
			servers: [{ name: "demo", enabled: false }],
		});

		expect(readFileSync(join(agentDir, "mcp.json"), "utf8")).toBe(configBefore);
		expect(JSON.parse(readFileSync(join(agentDir, "mcp-enablement-v1.json"), "utf8"))).toMatchObject({
			version: 1,
			entries: [{ serverName: "demo", enabled: false }],
		});
	});

	it("reports a committed enable even when status exposes a sanitized config error", async () => {
		writeConfig({
			demo: { type: "stdio", command: "$PHI_TEST_MCP_MISSING_COMMAND", disabled: true },
		});

		await withEnv({ PHI_TEST_MCP_MISSING_COMMAND: undefined }, async () => {
			await expect(setMcpServerEnabled(agentDir, "demo", true)).resolves.toEqual({
				schema: 1,
				server: "demo",
				enabled: true,
			});
			const [demo] = (await collectMcpStatus(agentDir)).servers;
			expect(demo).toMatchObject({
				name: "demo",
				enabled: true,
				missingEnv: ["PHI_TEST_MCP_MISSING_COMMAND"],
			});
			expect(demo?.configError).toContain("PHI_TEST_MCP_MISSING_COMMAND");
		});
	});

	it("uses the effective PHI_MCP_CONFIG path for enablement identity", async () => {
		const alternateDir = mkdtempSync(join(tmpdir(), "phi-mcp-cli-alternate-"));
		const alternatePath = join(alternateDir, "custom-mcp.json");
		writeFileSync(
			alternatePath,
			`${JSON.stringify({ mcpServers: { custom: { command: "custom-mcp" } } })}\n`,
			"utf8",
		);
		chmodSync(alternatePath, 0o600);
		try {
			await withEnv({ PHI_MCP_CONFIG: alternatePath }, async () => {
				await expect(setMcpServerEnabled(agentDir, "custom", false)).resolves.toMatchObject({
					server: "custom",
					enabled: false,
				});
				await expect(collectMcpStatus(agentDir)).resolves.toMatchObject({
					servers: [{ name: "custom", enabled: false }],
				});
			});
			expect(existsSync(join(agentDir, "mcp.json"))).toBe(false);
			expect(readFileSync(alternatePath, "utf8")).not.toContain("disabled");
		} finally {
			rmSync(alternateDir, { recursive: true, force: true });
		}
	});

	it("reuses a valid token for explicit login without starting OAuth", async () => {
		const fake = await startAuthorizedMcpServer("already-valid");
		writeConfig({
			demo: { type: "http", url: fake.url, auth: { mode: "oauth", browser: false } },
		});
		const store = await CredentialStore.open(fake.url);
		await store.writeTokens({
			access_token: "already-valid",
			token_type: "Bearer",
			expires_at: Date.now() + 600_000,
		});

		await expect(loginMcpServer(agentDir, "DEMO", 5_000)).resolves.toMatchObject({
			schema: 1,
			server: "demo",
			status: "ready",
			credential: "valid",
		});
		expect(fake.requests).toEqual(["POST /mcp", "POST /mcp", "POST /mcp"]);
	});

	it("logs out only the selected server's tokens and preserves its client registration", async () => {
		const firstUrl = "https://first.example/mcp";
		const secondUrl = "https://second.example/mcp";
		writeConfig({
			first: { type: "http", url: firstUrl, auth: "oauth" },
			second: { type: "http", url: secondUrl, auth: "oauth" },
		});
		const first = await CredentialStore.open(firstUrl);
		const second = await CredentialStore.open(secondUrl);
		await first.writeTokens({ access_token: "first-token" });
		await second.writeTokens({ access_token: "second-token" });
		await first.writeClientInfo({ client_id: "registered-client" });

		await expect(logoutMcpServer(agentDir, "FIRST")).resolves.toEqual({
			schema: 1,
			server: "first",
			loggedOut: true,
		});
		await expect(first.readTokens()).resolves.toBeUndefined();
		await expect(first.readClientInfo()).resolves.toMatchObject({ client_id: "registered-client" });
		await expect(second.readTokens()).resolves.toMatchObject({ access_token: "second-token" });
	});

	it("reads back the OAuth event trail, newest last, narrowed by server and window", async () => {
		recordOAuthEvent({ event: "refresh.failed", server: "monday", errorCode: "token_request_failed", status: 400 });
		recordOAuthEvent({ event: "login.ok", server: "serval" });

		const all = await collectMcpEvents({ limit: 50 });
		expect(all.logPath).toBe(join(authDir, DEFAULT_AUTH_LOG_NAME));
		expect(all.events.map((event) => event.event)).toEqual(["refresh.failed", "login.ok"]);

		const narrowed = await collectMcpEvents({ server: "MONDAY", limit: 50 });
		expect(narrowed.events).toHaveLength(1);
		expect(narrowed.events[0]?.server).toBe("monday");

		// The human rendering is what someone diagnosing a re-login actually reads.
		const text = formatHumanEvents(narrowed);
		expect(text).toContain("monday refresh.failed");
		expect(text).toContain("token_request_failed");
		expect(text).toContain("HTTP 400");

		expect((await collectMcpEvents({ limit: 50, sinceMs: Date.now() + 60_000 })).events).toEqual([]);
	});

	it("says why the trail is empty when recording is switched off", async () => {
		const previous = process.env[AUTH_LOG_ENV_VAR];
		process.env[AUTH_LOG_ENV_VAR] = "off";
		try {
			const envelope = await collectMcpEvents({ limit: 50 });
			expect(envelope).toEqual({ schema: 1, logPath: null, events: [] });
			expect(formatHumanEvents(envelope)).toContain("PHI_MCP_AUTH_LOG");
		} finally {
			if (previous === undefined) delete process.env[AUTH_LOG_ENV_VAR];
			else process.env[AUTH_LOG_ENV_VAR] = previous;
		}
	});

	it("rejects event options on commands that do not take them", async () => {
		writeConfig({ demo: { type: "http", url: "https://example.com/mcp", auth: "oauth" } });
		// Silently ignoring these would make `phi mcp status --limit 1` look like it
		// had filtered something.
		await expect(handleMcpCommandForTest(["mcp", "status", "--limit", "1"])).resolves.toBe(1);
		await expect(handleMcpCommandForTest(["mcp", "events", "--since", "09/13/2026"])).resolves.toBe(1);
		await expect(handleMcpCommandForTest(["mcp", "events", "--since", "24h"])).resolves.toBe(0);
		await expect(handleMcpCommandForTest(["mcp", "events", "--since", "2026-09-13T09:00:00Z"])).resolves.toBe(0);
		// The ISO 8601 basic form is as valid as the extended one.
		await expect(handleMcpCommandForTest(["mcp", "events", "--since", "20260913T090000Z"])).resolves.toBe(0);
	});
});

/** Run the argv entry point and return the exit code it set. */
async function handleMcpCommandForTest(args: string[]): Promise<number> {
	const previousExitCode = process.exitCode;
	const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const errorWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	try {
		await handleMcpCommand(args);
		return Number(process.exitCode ?? 0);
	} finally {
		write.mockRestore();
		errorWrite.mockRestore();
		process.exitCode = previousExitCode;
	}
}
