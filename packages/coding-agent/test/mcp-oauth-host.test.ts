import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createCommandMcpOAuthHost,
	createMcpOAuthHostIntegration,
	MCP_OAUTH_BRIDGE_COMMAND_ENV,
	MCP_OAUTH_BRIDGE_ERROR_CODES,
	MCP_OAUTH_BRIDGE_TIMEOUT_MS,
} from "../src/extensions/mcp/oauth/command-host.ts";
import { DEFAULT_BROWSER_FLOW_TIMEOUT_MS, runAuthorizationCodeFlow } from "../src/extensions/mcp/oauth/flow.ts";
import {
	isValidMcpOAuthRequestId,
	MCP_OAUTH_CALLBACK_PATH,
	MCP_OAUTH_MAX_LEASE_TTL_MS,
	McpOAuthHostError,
	type McpOAuthHostIntegration,
	validateLoopbackRedirectUri,
} from "../src/extensions/mcp/oauth/host.ts";

const FIXTURE_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const FIXTURE_AUTHORIZATION_URL =
	"https://issuer.example.test/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Foauth%2Fcallback&state=fixture-state&code_challenge=fixture-challenge&code_challenge_method=S256";
const FIXTURE_READY_RESPONSE =
	'{"schema":1,"status":"ready","requestId":"11111111-1111-4111-8111-111111111111","leaseId":"lease-fixture-1","redirectUri":"http://127.0.0.1:49152/oauth/callback","expiresInMs":300000}';
const FIXTURE_OPENED_RESPONSE = '{"schema":1,"status":"opened"}';
const FIXTURE_CLOSED_RESPONSE = '{"schema":1,"status":"closed"}';

describe("MCP OAuth host validation", () => {
	it("accepts only an exact HTTP loopback callback URI and preserves its spelling", () => {
		const uri = "http://127.0.0.1:49152/oauth/callback";
		expect(validateLoopbackRedirectUri(uri)).toBe(uri);
		expect(validateLoopbackRedirectUri("http://localhost:49152/oauth/callback")).toBe(
			"http://localhost:49152/oauth/callback",
		);
		expect(validateLoopbackRedirectUri("http://[::1]:49152/oauth/callback")).toBe(
			"http://[::1]:49152/oauth/callback",
		);
		expect(() => validateLoopbackRedirectUri("http://127.0.0.1:80/oauth/callback")).toThrow(McpOAuthHostError);
		expect(() => validateLoopbackRedirectUri("https://127.0.0.1:49152/oauth/callback")).toThrow(McpOAuthHostError);
		expect(() => validateLoopbackRedirectUri("http://example.test:49152/oauth/callback")).toThrow(McpOAuthHostError);
		expect(() => validateLoopbackRedirectUri("http://127.0.0.1:49152/oauth/callback?state=secret")).toThrow(
			McpOAuthHostError,
		);
		expect(() => validateLoopbackRedirectUri("http://127.0.0.1:49152/other")).toThrow(McpOAuthHostError);
		expect(() => validateLoopbackRedirectUri("http://127.0.0.1:49152/oauth/\tcallback")).toThrow(McpOAuthHostError);
		expect(() => validateLoopbackRedirectUri("http://127.0.0.1:49152/oauth/callback\u0000")).toThrow(
			McpOAuthHostError,
		);
	});

	it("matches Forca UUID version and RFC variant validation", () => {
		for (const requestId of [
			"11111111-1111-1111-8111-111111111111",
			"11111111-1111-2111-9111-111111111111",
			"11111111-1111-3111-a111-111111111111",
			FIXTURE_REQUEST_ID,
			"aaaaaaaa-aaaa-5aaa-baaa-aaaaaaaaaaaa",
			"AAAAAAAA-AAAA-5AAA-BAAA-AAAAAAAAAAAA",
		]) {
			expect(isValidMcpOAuthRequestId(requestId)).toBe(true);
		}
		for (const requestId of [
			"11111111-1111-0111-8111-111111111111",
			"11111111-1111-6111-8111-111111111111",
			"11111111-1111-4111-0111-111111111111",
			"11111111-1111-4111-c111-111111111111",
		]) {
			expect(isValidMcpOAuthRequestId(requestId)).toBe(false);
		}
	});
});

describe("MCP OAuth command host", () => {
	let directory: string;
	let command: string;
	let capture: string;
	let responseCapture: string;
	let previousBridgeCommand: string | undefined;

	beforeEach(() => {
		previousBridgeCommand = process.env[MCP_OAUTH_BRIDGE_COMMAND_ENV];
		delete process.env[MCP_OAUTH_BRIDGE_COMMAND_ENV];
		directory = mkdtempSync(join(tmpdir(), "phi-mcp-oauth-host-"));
		command = join(directory, "bridge.mjs");
		capture = join(directory, "requests.jsonl");
		responseCapture = join(directory, "responses.jsonl");
		writeFileSync(
			command,
			`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
let body = "";
for await (const chunk of process.stdin) body += chunk;
const request = JSON.parse(body);
appendFileSync(process.env.PHI_TEST_CAPTURE, JSON.stringify({ argv: process.argv, request }) + "\\n");
if (request.op === "prepare" && process.env.PHI_TEST_SPAWN_DESCENDANT === "1") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.PHI_TEST_DESCENDANT_PID, String(descendant.pid));
}
if (request.op !== "close" && process.env.PHI_TEST_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.PHI_TEST_DELAY_MS)));
if (request.op !== "close" && process.env.PHI_TEST_SLEEP === "1") await new Promise(() => undefined);
let response;
if (request.op === "close" && process.env.PHI_TEST_CLOSE_ERROR === "1") {
  response = JSON.stringify({ schema: 1, status: "error", code: "bridge_error", message: "access_token=secret" });
} else if (process.env.PHI_TEST_REASON === "1") {
  response = JSON.stringify({ schema: 1, status: "error", reason: "browser_open_failed", message: "https://secret.example.test/?code=secret" });
} else if (process.env.PHI_TEST_ERROR === "1") {
  process.stderr.write("authorizationUrl=https://secret.example.test/?code=secret\\n");
  response = JSON.stringify({ schema: 1, status: "error", code: "browser_open_failed", message: "The system browser could not be opened." });
} else if (request.op === "prepare") {
  const ready = { schema: 1, status: "ready", requestId: process.env.PHI_TEST_RESPONSE_REQUEST_ID ?? request.requestId, leaseId: process.env.PHI_TEST_OMIT_LEASE === "1" ? undefined : process.env.PHI_TEST_LEASE ?? "lease-1", redirectUri: process.env.PHI_TEST_REDIRECT, expiresInMs: Number(process.env.PHI_TEST_EXPIRES_IN_MS ?? 300000), ...(process.env.PHI_TEST_INCLUDE_EXPIRES_AT === "1" ? { expiresAt: Date.now() + 300000 } : {}) };
  response = JSON.stringify(ready);
} else if (request.op === "open") {
  response = JSON.stringify({ schema: 1, status: "opened" });
} else {
  response = JSON.stringify({ schema: 1, status: "closed" });
}
if (process.env.PHI_TEST_RESPONSE_CAPTURE) appendFileSync(process.env.PHI_TEST_RESPONSE_CAPTURE, response + "\\n");
process.stdout.write(response);
`,
			{ mode: 0o700 },
		);
		chmodSync(command, 0o700);
		process.env.PHI_TEST_CAPTURE = capture;
		process.env.PHI_TEST_RESPONSE_CAPTURE = responseCapture;
		process.env.PHI_TEST_REDIRECT = "http://127.0.0.1:49152/oauth/callback";
		delete process.env.PHI_TEST_ERROR;
		delete process.env.PHI_TEST_REASON;
		delete process.env.PHI_TEST_SLEEP;
		delete process.env.PHI_TEST_DELAY_MS;
		delete process.env.PHI_TEST_LEASE;
		delete process.env.PHI_TEST_EXPIRES_IN_MS;
		delete process.env.PHI_TEST_INCLUDE_EXPIRES_AT;
		delete process.env.PHI_TEST_OMIT_LEASE;
		delete process.env.PHI_TEST_RESPONSE_REQUEST_ID;
		delete process.env.PHI_TEST_SPAWN_DESCENDANT;
		delete process.env.PHI_TEST_DESCENDANT_PID;
		delete process.env.PHI_TEST_CLOSE_ERROR;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PHI_TEST_CAPTURE;
		delete process.env.PHI_TEST_RESPONSE_CAPTURE;
		delete process.env.PHI_TEST_REDIRECT;
		if (previousBridgeCommand === undefined) delete process.env[MCP_OAUTH_BRIDGE_COMMAND_ENV];
		else process.env[MCP_OAUTH_BRIDGE_COMMAND_ENV] = previousBridgeCommand;
		delete process.env.PHI_TEST_ERROR;
		delete process.env.PHI_TEST_REASON;
		delete process.env.PHI_TEST_SLEEP;
		delete process.env.PHI_TEST_DELAY_MS;
		delete process.env.PHI_TEST_LEASE;
		delete process.env.PHI_TEST_EXPIRES_IN_MS;
		delete process.env.PHI_TEST_INCLUDE_EXPIRES_AT;
		delete process.env.PHI_TEST_OMIT_LEASE;
		delete process.env.PHI_TEST_RESPONSE_REQUEST_ID;
		delete process.env.PHI_TEST_SPAWN_DESCENDANT;
		delete process.env.PHI_TEST_DESCENDANT_PID;
		delete process.env.PHI_TEST_CLOSE_ERROR;
		rmSync(directory, { recursive: true, force: true });
	});

	it("uses one executable with stdin/stdout JSON and never puts the URL in argv", async () => {
		const authorizationUrl = "https://issuer.example.test/authorize?code=secret&state=secret";
		const host = createCommandMcpOAuthHost(command);
		const prepared = await host.prepareCallback({
			serverName: "serval",
			remotePort: 41783,
			path: MCP_OAUTH_CALLBACK_PATH,
			preferredRedirectUri: "http://127.0.0.1:49152/oauth/callback",
		});
		await host.presentAuthorization({
			leaseId: prepared.leaseId,
			serverName: "serval",
			authorizationUrl,
			redirectUri: prepared.redirectUri,
		});
		await host.close({ leaseId: prepared.leaseId, outcome: "complete" });

		const records = readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { argv: string[]; request: Record<string, unknown> });
		expect(records.map((record) => record.request.op)).toEqual(["prepare", "open", "close"]);
		expect(records[0]?.request.preferredRedirectUri).toBe("http://127.0.0.1:49152/oauth/callback");
		expect(records[1]?.request.authorizationUrl).toBe(authorizationUrl);
		expect(records[0]?.request).toMatchObject({
			schema: 1,
			op: "prepare",
			serverName: "serval",
			remotePort: 41783,
			path: "/oauth/callback",
			preferredRedirectUri: "http://127.0.0.1:49152/oauth/callback",
		});
		expect(records[0]?.request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(JSON.stringify(records[1]?.request)).toBe(
			`{"schema":1,"op":"open","leaseId":"lease-1","authorizationUrl":"${authorizationUrl}","redirectUri":"http://127.0.0.1:49152/oauth/callback"}`,
		);
		expect(records[2]?.request).toEqual({
			schema: 1,
			op: "close",
			requestId: records[0]?.request.requestId,
			leaseId: "lease-1",
			outcome: "complete",
		});
		expect(records.every((record) => !record.argv.includes(authorizationUrl))).toBe(true);
	});

	it("reports an unavailable helper without echoing the command or payload", async () => {
		const host = createCommandMcpOAuthHost(join(directory, "missing-helper"));
		await expect(
			host.prepareCallback({ serverName: "serval", remotePort: 41783, path: MCP_OAUTH_CALLBACK_PATH }),
		).rejects.toMatchObject({ code: "command_failed" });
	});

	it("mirrors the paired protocol-v1 fixture vectors byte-for-byte", async () => {
		process.env.PHI_TEST_LEASE = "lease-fixture-1";
		const authorizationUrl = FIXTURE_AUTHORIZATION_URL;
		const host = createCommandMcpOAuthHost(command, {}, () => FIXTURE_REQUEST_ID);
		const prepared = await host.prepareCallback({
			serverName: "fixture-mcp",
			remotePort: 43123,
			path: MCP_OAUTH_CALLBACK_PATH,
			preferredRedirectUri: "http://localhost:49152/oauth/callback",
		});
		await host.presentAuthorization({
			leaseId: prepared.leaseId,
			serverName: "fixture-mcp",
			authorizationUrl,
			redirectUri: prepared.redirectUri,
		});
		await host.close({ leaseId: prepared.leaseId, outcome: "complete" });
		const records = readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { request: Record<string, unknown> });
		expect(JSON.stringify(records[0]?.request)).toBe(
			'{"schema":1,"op":"prepare","requestId":"11111111-1111-4111-8111-111111111111","serverName":"fixture-mcp","remotePort":43123,"path":"/oauth/callback","preferredRedirectUri":"http://localhost:49152/oauth/callback"}',
		);
		expect(JSON.stringify(records[1]?.request)).toBe(
			`{"schema":1,"op":"open","leaseId":"lease-fixture-1","authorizationUrl":"${authorizationUrl}","redirectUri":"http://127.0.0.1:49152/oauth/callback"}`,
		);
		expect(JSON.stringify(records[2]?.request)).toBe(
			'{"schema":1,"op":"close","requestId":"11111111-1111-4111-8111-111111111111","leaseId":"lease-fixture-1","outcome":"complete"}',
		);
		const responses = readFileSync(responseCapture, "utf8").trim().split("\n");
		expect(responses).toEqual([FIXTURE_READY_RESPONSE, FIXTURE_OPENED_RESPONSE, FIXTURE_CLOSED_RESPONSE]);
	});

	it("selects the command from the environment without changing the absent-host default", () => {
		process.env[MCP_OAUTH_BRIDGE_COMMAND_ENV] = command;
		expect(createMcpOAuthHostIntegration()).toBeDefined();
		delete process.env[MCP_OAUTH_BRIDGE_COMMAND_ENV];
		expect(createMcpOAuthHostIntegration()).toBeUndefined();
	});

	it.each([
		["unsafe redirect", "https://issuer.example.test/oauth/callback", undefined, false],
		["invalid relative TTL", undefined, "0", false],
		["unsafe redirect when close fails", "https://issuer.example.test/oauth/callback", undefined, true],
	])("closes a lease when prepare returns invalid %s fields", async (_name, redirect, expiry, closeFails) => {
		if (redirect !== undefined) process.env.PHI_TEST_REDIRECT = redirect;
		if (expiry !== undefined) process.env.PHI_TEST_EXPIRES_IN_MS = expiry;
		if (closeFails) process.env.PHI_TEST_CLOSE_ERROR = "1";
		const host = createCommandMcpOAuthHost(command);
		await expect(
			host.prepareCallback({ serverName: "serval", remotePort: 41783, path: MCP_OAUTH_CALLBACK_PATH }),
		).rejects.toMatchObject({ code: "invalid_response" });
		const records = readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { request: Record<string, unknown> });
		expect(records.map((record) => record.request.op)).toEqual(["prepare", "close"]);
		expect(records[1]?.request.outcome).toBe("failed");
	});

	it("rejects a relative lease TTL beyond 30 minutes", async () => {
		process.env.PHI_TEST_EXPIRES_IN_MS = String(30 * 60_000 + 1);
		const host = createCommandMcpOAuthHost(command);
		await expect(
			host.prepareCallback({ serverName: "serval", remotePort: 41783, path: MCP_OAUTH_CALLBACK_PATH }),
		).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("rejects an absolute ready expiry even when a relative TTL is present", async () => {
		process.env.PHI_TEST_INCLUDE_EXPIRES_AT = "1";
		const host = createCommandMcpOAuthHost(command, {}, () => FIXTURE_REQUEST_ID);
		await expect(
			host.prepareCallback({ serverName: "serval", remotePort: 41783, path: MCP_OAUTH_CALLBACK_PATH }),
		).rejects.toMatchObject({ code: "invalid_response" });
		const records = readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { request: Record<string, unknown> });
		expect(records[1]?.request).toMatchObject({
			requestId: FIXTURE_REQUEST_ID,
			leaseId: "lease-1",
			outcome: "failed",
		});
	});

	it("validates the ready request echo before closing by the known request ID", async () => {
		process.env.PHI_TEST_RESPONSE_REQUEST_ID = "00000000-0000-4000-8000-000000000002";
		const host = createCommandMcpOAuthHost(command, {}, () => FIXTURE_REQUEST_ID);
		await expect(
			host.prepareCallback({ serverName: "serval", remotePort: 41783, path: MCP_OAUTH_CALLBACK_PATH }),
		).rejects.toMatchObject({ code: "invalid_response" });
		const records = readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { request: Record<string, unknown> });
		expect(records[1]?.request).toEqual({
			schema: 1,
			op: "close",
			requestId: FIXTURE_REQUEST_ID,
			leaseId: "lease-1",
			outcome: "failed",
		});
	});

	it.each([
		["missing", undefined, true],
		["overlong", "x".repeat(129), false],
		["control", "lease-\u0001", false],
	] as const)("best-effort closes a prepare response with a %s lease", async (_name, leaseId, omitted) => {
		if (omitted) process.env.PHI_TEST_OMIT_LEASE = "1";
		else process.env.PHI_TEST_LEASE = leaseId;
		const host = createCommandMcpOAuthHost(command, {}, () => FIXTURE_REQUEST_ID);
		await expect(
			host.prepareCallback({ serverName: "serval", remotePort: 41783, path: MCP_OAUTH_CALLBACK_PATH }),
		).rejects.toMatchObject({ code: "invalid_response" });
		const records = readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { request: Record<string, unknown> });
		expect(records.map((record) => record.request.op)).toEqual(["prepare", "close"]);
		expect(records[1]?.request).toEqual({
			schema: 1,
			op: "close",
			requestId: FIXTURE_REQUEST_ID,
			outcome: "failed",
		});
	});

	it("best-effort closes a failed ready response by request ID", async () => {
		process.env.PHI_TEST_ERROR = "1";
		const host = createCommandMcpOAuthHost(command, {}, () => FIXTURE_REQUEST_ID);
		await expect(
			host.prepareCallback({ serverName: "serval", remotePort: 41783, path: MCP_OAUTH_CALLBACK_PATH }),
		).rejects.toMatchObject({ code: "browser_open_failed" });
		const records = readFileSync(capture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { request: Record<string, unknown> });
		expect(records.map((record) => record.request.op)).toEqual(["prepare", "close"]);
		expect(records[1]?.request).toMatchObject({ requestId: FIXTURE_REQUEST_ID, outcome: "failed" });
	});

	it.each([-10 * 60_000, 10 * 60_000])(
		"accepts the maximum relative lease TTL with a %sms local clock offset",
		async (offset) => {
			process.env.PHI_TEST_EXPIRES_IN_MS = String(MCP_OAUTH_MAX_LEASE_TTL_MS);
			const localNow = Date.now() + offset;
			vi.spyOn(Date, "now").mockReturnValue(localNow);
			const host = createCommandMcpOAuthHost(command, {}, () => FIXTURE_REQUEST_ID);
			const prepared = await host.prepareCallback({
				serverName: "serval",
				remotePort: 41783,
				path: MCP_OAUTH_CALLBACK_PATH,
			});
			expect(prepared.expiresAt).toBe(localNow + MCP_OAUTH_MAX_LEASE_TTL_MS);
			await host.close({ leaseId: prepared.leaseId, outcome: "complete" });
			const records = readFileSync(capture, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { request: Record<string, unknown> });
			expect(records[0]?.request).not.toHaveProperty("expiresAt");
			expect(records[1]?.request).toEqual({
				schema: 1,
				op: "close",
				requestId: FIXTURE_REQUEST_ID,
				leaseId: prepared.leaseId,
				outcome: "complete",
			});
		},
	);

	it("aborts a command without waiting for its bounded timeout", async () => {
		process.env.PHI_TEST_SLEEP = "1";
		const host = createCommandMcpOAuthHost(command);
		const controller = new AbortController();
		const pending = host.prepareCallback({
			serverName: "serval",
			remotePort: 41783,
			path: MCP_OAUTH_CALLBACK_PATH,
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
	});

	it("uses a 30-minute human-authorization bound without changing short operations", () => {
		expect(DEFAULT_BROWSER_FLOW_TIMEOUT_MS).toBe(30 * 60_000);
		expect(MCP_OAUTH_MAX_LEASE_TTL_MS).toBe(30 * 60_000);
		expect(MCP_OAUTH_BRIDGE_TIMEOUT_MS).toEqual({
			prepare: 15_000,
			open: 30 * 60_000,
			close: 15_000,
		});
	});

	it("times out a bounded command and uses the wire code field", async () => {
		process.env.PHI_TEST_DELAY_MS = "2000";
		const host = createCommandMcpOAuthHost(command, { prepare: 100 });
		await expect(
			host.prepareCallback({ serverName: "serval", remotePort: 41783, path: MCP_OAUTH_CALLBACK_PATH }),
		).rejects.toMatchObject({ code: "timeout" });
		expect(MCP_OAUTH_BRIDGE_TIMEOUT_MS.open).toBeGreaterThan(MCP_OAUTH_BRIDGE_TIMEOUT_MS.prepare);
		expect(MCP_OAUTH_BRIDGE_ERROR_CODES).toEqual([
			"unsupported_protocol",
			"invalid_request",
			"user_denied",
			"local_port_unavailable",
			"connection_lost",
			"expired",
			"browser_open_failed",
			"bridge_error",
		]);
	});

	it.each(["abort", "timeout"] as const)("terminates helper descendants on %s", async (mode) => {
		const pidFile = join(directory, "descendant.pid");
		process.env.PHI_TEST_SPAWN_DESCENDANT = "1";
		process.env.PHI_TEST_DESCENDANT_PID = pidFile;
		process.env.PHI_TEST_SLEEP = "1";
		const controller = new AbortController();
		const host = createCommandMcpOAuthHost(command, { prepare: mode === "timeout" ? 500 : 5_000 });
		const pending = host.prepareCallback({
			serverName: "serval",
			remotePort: 41783,
			path: MCP_OAUTH_CALLBACK_PATH,
			signal: mode === "abort" ? controller.signal : undefined,
		});
		const settled = pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		await waitForFile(pidFile);
		if (mode === "abort") controller.abort();
		if (mode === "timeout") {
			await expect(settled).resolves.toMatchObject({ code: "timeout" });
		} else {
			await expect(settled).resolves.toMatchObject({ code: "aborted" });
		}
		const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		await waitForProcessGone(pid);
		expect(isProcessAlive(pid)).toBe(false);
	});

	it("rejects the legacy reason field without leaking its message", async () => {
		process.env.PHI_TEST_REASON = "1";
		const host = createCommandMcpOAuthHost(command);
		await expect(
			host.presentAuthorization({
				leaseId: "lease-1",
				serverName: "serval",
				authorizationUrl: "https://issuer.example.test/authorize?code=secret",
				redirectUri: "http://127.0.0.1:49152/oauth/callback",
			}),
		).rejects.toMatchObject({ code: "bridge_error" });
		await expect(
			host.presentAuthorization({
				leaseId: "lease-1",
				serverName: "serval",
				authorizationUrl: "https://issuer.example.test/authorize?code=secret",
				redirectUri: "http://127.0.0.1:49152/oauth/callback",
			}),
		).rejects.not.toThrow("secret");
	});

	it("redacts command stderr and structured bridge errors", async () => {
		process.env.PHI_TEST_ERROR = "1";
		const host = createCommandMcpOAuthHost(command);
		await expect(
			host.presentAuthorization({
				leaseId: "lease-1",
				serverName: "serval",
				authorizationUrl: "https://issuer.example.test/authorize?code=secret",
				redirectUri: "http://127.0.0.1:49152/oauth/callback",
			}),
		).rejects.toMatchObject({ code: "browser_open_failed" });
		await expect(
			host.presentAuthorization({
				leaseId: "lease-1",
				serverName: "serval",
				authorizationUrl: "https://issuer.example.test/authorize?code=secret",
				redirectUri: "http://127.0.0.1:49152/oauth/callback",
			}),
		).rejects.not.toThrow("secret");
	});
});

describe("MCP OAuth host flow", () => {
	let server: ReturnType<typeof createServer>;
	let origin: string;
	let serverPort: number;
	let requests: { registration?: string; authorization?: string; token?: string };

	beforeEach(async () => {
		requests = {};
		server = createServer((request, response) => void handle(request, response));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		serverPort = (server.address() as AddressInfo).port;
		origin = `http://127.0.0.1:${serverPort}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("uses the prepared URI unchanged and closes the lease before the listener", async () => {
		const redirectUri = "http://127.0.0.1:49152/oauth/callback";
		let remotePort = 0;
		let closeProbeStatus = 0;
		const calls: string[] = [];
		const host: McpOAuthHostIntegration = {
			async prepareCallback(input) {
				calls.push("prepare");
				expect(input.preferredRedirectUri).toBe("http://localhost:49152/oauth/callback");
				remotePort = input.remotePort;
				return { leaseId: "lease-1", redirectUri, expiresAt: Date.now() + 300_000 };
			},
			async presentAuthorization(input) {
				calls.push("open");
				const authorization = new URL(input.authorizationUrl);
				requests.authorization = authorization.search;
				expect(authorization.searchParams.get("redirect_uri")).toBe(redirectUri);
				await fetch(
					`http://127.0.0.1:${remotePort}${MCP_OAUTH_CALLBACK_PATH}?code=code-1&state=${authorization.searchParams.get("state")}`,
				);
			},
			async close(input) {
				calls.push(`close:${input.outcome}`);
				const probe = await fetch(`http://127.0.0.1:${remotePort}${MCP_OAUTH_CALLBACK_PATH}`);
				closeProbeStatus = probe.status;
			},
		};

		const result = await runAuthorizationCodeFlow({
			metadata: {
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
			},
			serverName: "serval",
			client: { client_id: "old-client", redirect_uris: ["http://localhost:49152/oauth/callback"] },
			openBrowser: () => {
				throw new Error("local browser must not be used");
			},
			onCallbackPort: () => {
				calls.push("listener");
			},
			host,
		});

		expect(result.tokens.access_token).toBe("access-1");
		expect(requests.registration).toContain(redirectUri);
		expect(requests.authorization).toContain(encodeURIComponent(redirectUri));
		expect(requests.token).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
		expect(calls).toEqual(["listener", "prepare", "open", "close:complete"]);
		expect(closeProbeStatus).toBe(400);
	});

	it("closes an invalid prepared lease before rejecting and cleans up the listener", async () => {
		let remotePort = 0;
		let closeOutcome: string | undefined;
		const host: McpOAuthHostIntegration = {
			async prepareCallback(input) {
				remotePort = input.remotePort;
				return {
					leaseId: "lease-invalid-redirect",
					redirectUri: "https://issuer.example.test/oauth/callback",
					expiresAt: Date.now() + 300_000,
				};
			},
			async presentAuthorization() {
				throw new Error("must not open a browser for an invalid prepared lease");
			},
			async close(input) {
				closeOutcome = input.outcome;
			},
		};

		await expect(
			runAuthorizationCodeFlow({
				metadata: {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
				},
				serverName: "serval",
				openBrowser: () => undefined,
				host,
			}),
		).rejects.toMatchObject({ code: "invalid_response" });
		expect(closeOutcome).toBe("failed");
		await expect(fetch(`http://127.0.0.1:${remotePort}${MCP_OAUTH_CALLBACK_PATH}`)).rejects.toThrow();
	});

	it("closes a prepared lease when the callback state is rejected", async () => {
		const redirectUri = "http://127.0.0.1:49152/oauth/callback";
		let remotePort = 0;
		let closeOutcome: string | undefined;
		const host: McpOAuthHostIntegration = {
			async prepareCallback(input) {
				remotePort = input.remotePort;
				return { leaseId: "lease-2", redirectUri, expiresAt: Date.now() + 300_000 };
			},
			async presentAuthorization() {
				await fetch(`http://127.0.0.1:${remotePort}${MCP_OAUTH_CALLBACK_PATH}?code=code-2&state=wrong-state`);
			},
			async close(input) {
				closeOutcome = input.outcome;
			},
		};

		await expect(
			runAuthorizationCodeFlow({
				metadata: {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
				},
				serverName: "serval",
				openBrowser: () => {
					throw new Error("local browser must not be used");
				},
				host,
			}),
		).rejects.toThrow(/state/);
		expect(closeOutcome).toBe("failed");
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", origin);
		if (url.pathname === "/register") {
			requests.registration = await body(request);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ client_id: "new-client" }));
			return;
		}
		if (url.pathname === "/authorize") {
			requests.authorization = url.search;
			response.writeHead(200).end("ok");
			return;
		}
		if (url.pathname === "/token") {
			requests.token = await body(request);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ access_token: "access-1", token_type: "Bearer" }));
			return;
		}
		response.writeHead(404).end();
	}
});

function body(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let value = "";
		request.on("data", (chunk) => {
			value += String(chunk);
		});
		request.on("end", () => resolve(value));
	});
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`test helper did not write ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (isProcessAlive(pid)) {
		if (Date.now() >= deadline) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
