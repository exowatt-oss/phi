import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectServer } from "../src/extensions/mcp/client.ts";
import { elicitForm, type McpElicitationUi } from "../src/extensions/mcp/elicitation.ts";
import { createHttpTransport } from "../src/extensions/mcp/http-transport.ts";
import { McpError } from "../src/extensions/mcp/protocol.ts";
import { createStdioTransport } from "../src/extensions/mcp/stdio-transport.ts";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MCP elicitation forms", () => {
	it("maps form fields, validates input, and accepts content", async () => {
		const ui = fakeUi({
			select: ["Friendly", "No", "Accept"],
			input: ["not-a-number", "42", "person@example.com"],
		});
		const result = await elicitForm(
			{
				message: "Configure the job",
				requestedSchema: {
					type: "object",
					properties: {
						mode: { type: "string", enum: ["friendly", "strict"], enumNames: ["Friendly", "Strict"] },
						retries: { type: "integer", minimum: 1 },
						email: { type: "string", format: "email" },
						notify: { type: "boolean" },
					},
					required: ["mode", "retries", "email"],
				},
			},
			ui,
		);
		expect(result).toEqual({
			action: "accept",
			content: { mode: "friendly", retries: 42, email: "person@example.com", notify: false },
		});
		expect(ui.notify).toHaveBeenCalledWith("retries must be an integer.", "warning");
	});

	it("distinguishes decline, dialog cancellation, and non-interactive cancellation", async () => {
		const schema = { message: "Continue?", requestedSchema: { type: "object", properties: {} } };
		expect(await elicitForm(schema, fakeUi({ select: ["Decline"] }))).toEqual({ action: "decline" });
		expect(await elicitForm(schema, fakeUi({ select: [undefined] }))).toEqual({ action: "cancel" });
		const headless = fakeUi({ hasUI: false });
		expect(await elicitForm(schema, headless)).toEqual({ action: "cancel" });
		expect(headless.notify).toHaveBeenCalledOnce();
	});

	it("rejects URL mode and unsupported nested fields", async () => {
		await expect(elicitForm({ mode: "url" }, fakeUi())).rejects.toMatchObject({ code: -32602 });
		await expect(
			elicitForm(
				{
					message: "Nested",
					requestedSchema: { type: "object", properties: { nested: { type: "object" } } },
				},
				fakeUi(),
			),
		).rejects.toMatchObject({ code: -32602 });
	});
});

describe("server-initiated MCP requests", () => {
	it("dispatches and answers a stdio request while tools/call is pending", async () => {
		const script = temporaryScript(`
const readline = require("node:readline");
let callId;
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "tools/call") {
    callId = message.id;
    send({ jsonrpc: "2.0", id: "ask-1", method: "elicitation/create", params: { message: "Name?", requestedSchema: { type: "object", properties: {} } } });
  } else if (message.id === "ask-1") {
    send({ jsonrpc: "2.0", id: callId, result: { echoed: message.result } });
  }
});
`);
		const transport = createStdioTransport({ command: process.execPath, args: [script] });
		transport.setRequestHandler(async (method) => ({
			action: method === "elicitation/create" ? "accept" : "cancel",
		}));
		await expect(transport.request("tools/call", {}, { timeoutMs: 2_000 })).resolves.toEqual({
			echoed: { action: "accept" },
		});
		await transport.close();
	});

	it("returns method-not-found for unsupported stdio requests", async () => {
		const script = temporaryScript(`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "tools/call") send({ jsonrpc: "2.0", id: 99, method: "unknown/request", params: {} });
  else if (message.id === 99) send({ jsonrpc: "2.0", id: 1, result: message.error });
});
`);
		const transport = createStdioTransport({ command: process.execPath, args: [script] });
		transport.setRequestHandler(async (method) => {
			throw new McpError(`Unsupported server request: ${method}`, -32601);
		});
		await expect(transport.request("tools/call", {}, { timeoutMs: 2_000 })).resolves.toMatchObject({ code: -32601 });
		await transport.close();
	});

	it("answers an interleaved HTTP/SSE request on the same session", async () => {
		let pendingResponse: import("node:http").ServerResponse | undefined;
		let answerHeaders: import("node:http").IncomingHttpHeaders | undefined;
		const server = createServer(async (request, response) => {
			if (request.method === "DELETE") {
				response.writeHead(204).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += chunk;
			const message = JSON.parse(body);
			if (message.method === "tools/call") {
				pendingResponse = response;
				response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "session-1" });
				response.write('data: {"jsonrpc":"2.0","id":"ask-http","method":"elicitation/create","params":{}}\n\n');
				return;
			}
			if (message.id === "ask-http") {
				answerHeaders = request.headers;
				response.writeHead(202).end();
				pendingResponse?.end('data: {"jsonrpc":"2.0","id":1,"result":{"done":true}}\n\n');
			}
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind");
		const transport = createHttpTransport({ url: `http://127.0.0.1:${address.port}` });
		transport.setRequestHandler(async () => ({ action: "cancel" }));
		await expect(transport.request("tools/call", {}, { timeoutMs: 2_000 })).resolves.toEqual({ done: true });
		expect(answerHeaders?.["mcp-session-id"]).toBe("session-1");
		await transport.close();
	});

	it("advertises elicitation during initialize", async () => {
		const script = temporaryScript(`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (!message.params.capabilities.elicitation) process.exit(2);
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" }, capabilities: { tools: {} } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
  }
});
`);
		const client = await connectServer("test", { type: "stdio", command: process.execPath, args: [script] });
		expect(client.identity.protocolVersion).toBe("2025-06-18");
		await client.close();
	});
});

function temporaryScript(source: string): string {
	const directory = mkdtempSync(join(tmpdir(), "phi-mcp-elicit-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "server.cjs");
	writeFileSync(path, source);
	return path;
}

function fakeUi(
	options: { hasUI?: boolean; select?: Array<string | undefined>; input?: Array<string | undefined> } = {},
) {
	const selections = [...(options.select ?? ["Accept"])];
	const inputs = [...(options.input ?? [])];
	const notify = vi.fn((_message: string, _type?: "info" | "warning" | "error") => undefined);
	return {
		hasUI: options.hasUI ?? true,
		select: vi.fn(async () => selections.shift()),
		input: vi.fn(async () => inputs.shift()),
		notify,
	} satisfies McpElicitationUi;
}
