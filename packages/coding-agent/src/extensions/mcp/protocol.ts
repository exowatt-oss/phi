/**
 * The slice of the Model Context Protocol this bridge speaks: JSON-RPC 2.0
 * `initialize` -> `notifications/initialized` -> `tools/list` -> `tools/call`.
 *
 * Implemented directly against the wire format rather than the official SDK so
 * the extension stays dependency-free and loadable straight from
 * `~/.pi/agent/extensions/`.
 */

import { asArray, asRecord, readNumber, readString } from "./json.ts";

/** Version we advertise. Servers may negotiate down; we follow whatever they answer with. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Offered on retry when a server rejects the newer revision outright. */
export const MCP_FALLBACK_PROTOCOL_VERSION = "2025-03-26";

export const CLIENT_INFO = { name: "phi-mcp-bridge", version: "0.1.0" } as const;

/** A JSON-RPC or transport failure, carrying the JSON-RPC code when the server sent one. */
export class McpError extends Error {
	readonly code: number | undefined;

	constructor(message: string, code?: number) {
		super(message);
		this.name = "McpError";
		this.code = code;
	}
}

/**
 * One direction-agnostic request channel. Both transports resolve a request to
 * its JSON-RPC `result` and throw `McpError` for a JSON-RPC `error`.
 */
export type McpRequestId = string | number;
export type McpRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface McpTransport {
	/** Human-readable endpoint, used verbatim in error messages. */
	readonly endpoint: string;
	request(method: string, params: Record<string, unknown>, options: RequestOptions): Promise<unknown>;
	notify(method: string, params: Record<string, unknown>, options: RequestOptions): Promise<void>;
	/** Handle server-initiated JSON-RPC requests received while a client request is in flight. */
	setRequestHandler(handler: McpRequestHandler): void;
	/** Record the negotiated protocol version, where the transport needs it (HTTP sends it as a header). */
	setProtocolVersion?(version: string): void;
	close(): Promise<void>;
}

/** Convert a handler result/failure into a JSON-RPC response envelope. */
export async function handleServerRequest(
	id: McpRequestId,
	method: string,
	params: Record<string, unknown>,
	handler: McpRequestHandler | undefined,
): Promise<Record<string, unknown>> {
	try {
		if (!handler) throw new McpError(`Unsupported server request: ${method}`, -32601);
		return { jsonrpc: "2.0", id, result: await handler(method, params) };
	} catch (error) {
		const code = error instanceof McpError && error.code !== undefined ? error.code : -32603;
		const message = error instanceof Error ? error.message : "Internal error";
		return { jsonrpc: "2.0", id, error: { code, message } };
	}
}

export interface RequestOptions {
	signal?: AbortSignal;
	timeoutMs: number;
}

export interface McpToolInfo {
	name: string;
	title?: string;
	description?: string;
	/** Raw JSON Schema from the server, passed through to the model unchanged. */
	inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
	/** Concatenated text blocks. */
	text: string;
	/** One line per non-text block, so the model knows content was returned that it cannot see. */
	notes: string[];
	isError: boolean;
}

export interface McpServerIdentity {
	protocolVersion: string;
	serverName?: string;
	serverVersion?: string;
	instructions?: string;
}

/** Compose an abort signal that also fires on timeout, and say which one tripped. */
export function withTimeout(options: RequestOptions): { signal: AbortSignal; timedOut: () => boolean } {
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	return { signal, timedOut: () => timeoutSignal.aborted };
}

/**
 * Unwrap a JSON-RPC response envelope into its `result`, or throw its `error`.
 */
export function unwrapJsonRpcResult(payload: unknown, method: string, endpoint: string, safeErrors = false): unknown {
	const record = asRecord(payload);
	if (!record) {
		throw new McpError(
			safeErrors
				? "The MCP OAuth server returned an invalid response."
				: `${endpoint} returned a non-object response to ${method}.`,
		);
	}
	const error = asRecord(record.error);
	if (error) {
		const code = readNumber(error, "code");
		if (safeErrors) throw new McpError("The MCP OAuth server rejected the request.", code);
		const message = readString(error, "message") ?? "unknown error";
		throw new McpError(`${endpoint} rejected ${method}: ${message}`, code);
	}
	if (!("result" in record)) {
		throw new McpError(
			safeErrors ? "The MCP OAuth server returned no result." : `${endpoint} returned no result for ${method}.`,
		);
	}
	return record.result;
}

/** True when a decoded JSON-RPC message is the response to `id` rather than a server-initiated one. */
export function isResponseTo(payload: unknown, id: number): boolean {
	const record = asRecord(payload);
	if (!record) return false;
	if (record.id !== id) return false;
	return "result" in record || "error" in record;
}

export function parseInitializeResult(payload: unknown): McpServerIdentity {
	const record = asRecord(payload);
	const serverInfo = asRecord(record?.serverInfo);
	return {
		protocolVersion: readString(record, "protocolVersion") ?? MCP_PROTOCOL_VERSION,
		serverName: readString(serverInfo, "name"),
		serverVersion: readString(serverInfo, "version"),
		instructions: readString(record, "instructions"),
	};
}

export function parseToolsListResult(payload: unknown): { tools: McpToolInfo[]; nextCursor?: string } {
	const record = asRecord(payload);
	const tools: McpToolInfo[] = [];
	for (const entry of asArray(record?.tools) ?? []) {
		const tool = asRecord(entry);
		const name = readString(tool, "name");
		if (!name) continue;
		tools.push({
			name,
			title: readString(tool, "title"),
			description: readString(tool, "description"),
			inputSchema: normalizeInputSchema(asRecord(tool?.inputSchema)),
		});
	}
	return { tools, nextCursor: readString(record, "nextCursor") };
}

/**
 * Providers read `properties` and `required` straight off the schema object, so
 * guarantee both exist and that the schema is an object schema.
 */
function normalizeInputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
	const base = schema ? { ...schema } : {};
	base.type = "object";
	if (!asRecord(base.properties)) base.properties = {};
	if (!asArray(base.required)) base.required = [];
	return base;
}

/**
 * Flatten a `tools/call` result. Text blocks are concatenated; every other block
 * kind is summarized so the model is told something came back that it cannot read.
 */
export function parseCallToolResult(payload: unknown): McpCallResult {
	const record = asRecord(payload);
	const chunks: string[] = [];
	const notes: string[] = [];

	for (const entry of asArray(record?.content) ?? []) {
		const block = asRecord(entry);
		const type = readString(block, "type") ?? "unknown";
		if (type === "text") {
			chunks.push(readString(block, "text") ?? "");
			continue;
		}
		notes.push(describeNonTextBlock(type, block));
	}

	if (chunks.length === 0 && record && "structuredContent" in record) {
		// Servers may answer with structured output only; JSON is still readable to the model.
		chunks.push(JSON.stringify(record.structuredContent, null, 2));
	}

	return {
		text: chunks.join("\n"),
		notes,
		isError: record?.isError === true,
	};
}

function describeNonTextBlock(type: string, block: Record<string, unknown> | undefined): string {
	if (type === "image" || type === "audio") {
		const mime = readString(block, "mimeType") ?? "unknown type";
		return `[${type} content omitted: ${mime}]`;
	}
	if (type === "resource_link") {
		const uri = readString(block, "uri") ?? "unknown uri";
		return `[resource link: ${uri}]`;
	}
	if (type === "resource") {
		const resource = asRecord(block?.resource);
		const uri = readString(resource, "uri") ?? "unknown uri";
		const text = readString(resource, "text");
		return text ? `[resource ${uri}]\n${text}` : `[binary resource omitted: ${uri}]`;
	}
	return `[${type} content omitted]`;
}
