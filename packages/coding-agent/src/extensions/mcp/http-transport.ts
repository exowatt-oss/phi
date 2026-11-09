/**
 * Streamable HTTP transport: every JSON-RPC message is a POST to a single URL.
 *
 * Two response shapes are legal for the same endpoint, so both are handled:
 * a plain `application/json` body, and a `text/event-stream` body whose
 * `data:` events carry the JSON-RPC messages. The SSE branch reads
 * incrementally and stops at the matching response id, because servers are
 * allowed to hold the stream open after answering.
 *
 * A 401 is not terminal. When the server entry allows OAuth, an authorizer
 * attaches the cached bearer token to every request and gets one chance to renew
 * it after a rejection, after which the request is retried exactly once. A server
 * with static `headers` and no authorizer keeps the original behaviour, down to
 * the error text.
 */

import { asRecord, errorMessage, readString, safeJsonParse } from "./json.ts";
import type { McpAuthorizer } from "./oauth/provider.ts";
import {
	CLIENT_INFO,
	handleServerRequest,
	isResponseTo,
	MCP_PROTOCOL_VERSION,
	McpError,
	type McpRequestHandler,
	type McpRequestId,
	type McpTransport,
	parseInitializeResult,
	type RequestOptions,
	unwrapJsonRpcResult,
	withTimeout,
} from "./protocol.ts";

export interface HttpTransportOptions {
	url: string;
	headers?: Record<string, string>;
	/** Absent for a server that opted out of OAuth, or for one using static headers. */
	authorizer?: McpAuthorizer;
}

export function createHttpTransport(options: HttpTransportOptions): McpTransport {
	const endpoint = options.url;
	const configuredHeaders = options.headers ?? {};
	const authorizer = options.authorizer;
	const oauthSafe = authorizer !== undefined;
	let nextId = 1;
	let sessionId: string | undefined;
	let protocolVersion: string | undefined;
	let reinitializePromise: Promise<void> | undefined;
	let lastAuthorization: string | undefined;
	let requestHandler: McpRequestHandler | undefined;
	let closed = false;

	const buildHeaders = (authorization?: string): Record<string, string> => {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			// Both are legal response bodies; advertise support for each.
			Accept: "application/json, text/event-stream",
			...configuredHeaders,
		};
		// A configured Authorization header stays authoritative; the authorizer only
		// exists for entries that did not set one.
		if (authorization && !hasAuthorizationHeader(configuredHeaders)) headers.Authorization = authorization;
		if (sessionId) headers["Mcp-Session-Id"] = sessionId;
		if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
		return headers;
	};

	const post = async (message: Record<string, unknown>, requestOptions: RequestOptions): Promise<Response> => {
		const authorization = await authorizer?.authorization(requestOptions);
		if (authorization) lastAuthorization = authorization;
		const { signal, timedOut } = withTimeout(requestOptions);
		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				headers: buildHeaders(authorization),
				body: JSON.stringify(message),
				signal,
			});
		} catch (error) {
			if (requestOptions.signal?.aborted)
				throw new McpError(
					oauthSafe ? "The MCP OAuth request was cancelled." : `Request to ${endpoint} was cancelled.`,
				);
			if (timedOut()) {
				throw new McpError(
					oauthSafe
						? "The MCP OAuth server did not respond in time."
						: `${endpoint} did not respond within ${requestOptions.timeoutMs}ms.`,
				);
			}
			throw new McpError(
				oauthSafe
					? "Could not reach the MCP OAuth server. Check network or VPN."
					: `Could not reach ${endpoint} (${errorMessage(error)}). Check network or VPN.`,
			);
		}

		// The server assigns the session on the initialize response and expects it echoed thereafter.
		const assigned = response.headers.get("mcp-session-id");
		if (assigned) sessionId = assigned;

		return response;
	};

	/**
	 * One recovery and one retry per request. The authorizer itself decides whether
	 * that means a silent refresh or a browser login, and serializes concurrent
	 * attempts, so several tool calls hitting a stale token cost one renewal.
	 */
	const postAuthorized = async (
		message: Record<string, unknown>,
		requestOptions: RequestOptions,
	): Promise<Response> => {
		const response = await post(message, requestOptions);
		if (response.status !== 401 || !authorizer) return response;
		const recovered = await authorizer
			.handleUnauthorized(response.headers.get("www-authenticate") ?? undefined, requestOptions)
			.catch(() => false);
		// Leave the body intact when nothing was recovered: it carries the error the
		// caller is about to report.
		if (!recovered) return response;
		await response.body?.cancel().catch(() => {});
		return post(message, requestOptions);
	};

	const dispatchServerRequest = async (
		id: McpRequestId,
		method: string,
		params: Record<string, unknown>,
		requestOptions: RequestOptions,
	): Promise<void> => {
		const envelope = await handleServerRequest(id, method, params, requestHandler);
		const response = await postAuthorized(envelope, requestOptions);
		if (!response.ok) throw await httpError(endpoint, response, authorizer);
		await response.body?.cancel().catch(() => {});
	};

	const reinitialize = async (requestOptions: RequestOptions): Promise<void> => {
		if (reinitializePromise) return reinitializePromise;

		const attempt = (async (): Promise<void> => {
			const id = nextId++;
			const response = await postAuthorized(
				{
					jsonrpc: "2.0",
					id,
					method: "initialize",
					params: {
						protocolVersion: protocolVersion ?? MCP_PROTOCOL_VERSION,
						capabilities: { elicitation: {} },
						clientInfo: CLIENT_INFO,
					},
				},
				requestOptions,
			);
			if (!response.ok) throw await httpError(endpoint, response, authorizer);

			const payload = await readResponsePayload(
				response,
				id,
				endpoint,
				requestOptions,
				oauthSafe,
				dispatchServerRequest,
			);
			const identity = parseInitializeResult(unwrapJsonRpcResult(payload, "initialize", endpoint, oauthSafe));
			protocolVersion = identity.protocolVersion;

			const initialized = await postAuthorized(
				{ jsonrpc: "2.0", method: "notifications/initialized", params: {} },
				requestOptions,
			);
			if (!initialized.ok) throw await httpError(endpoint, initialized, authorizer);
			await initialized.body?.cancel().catch(() => {});
		})();

		reinitializePromise = attempt;
		try {
			await attempt;
		} finally {
			if (reinitializePromise === attempt) reinitializePromise = undefined;
		}
	};

	const postWithRecovery = async (
		message: Record<string, unknown>,
		requestOptions: RequestOptions,
	): Promise<Response> => {
		// Do not send a request without a session while another call is minting one.
		// This matters when phi executes several MCP tools in one turn.
		if (reinitializePromise) await reinitializePromise;

		// Capture the exact id this request carries. A later stale response may arrive
		// after another call has already replaced it, and must not tear down that fresh
		// session or start a second concurrent handshake.
		const requestSessionId = sessionId;
		const response = await postAuthorized(message, requestOptions);
		if (!requestSessionId || !isStaleSessionStatus(response.status)) return response;

		const originalError = await httpError(endpoint, response, authorizer);
		if (reinitializePromise) {
			try {
				await reinitializePromise;
			} catch {
				// Preserve the useful error that triggered recovery rather than hiding it
				// behind a failed handshake.
				throw originalError;
			}
			// Another call owns recovery; this call gets the one permitted retry.
			return postAuthorized(message, requestOptions);
		}
		if (sessionId !== requestSessionId) {
			// Another call completed recovery after this request was sent. Reuse its
			// fresh session instead of invalidating it with a redundant handshake.
			return postAuthorized(message, requestOptions);
		}

		sessionId = undefined;
		try {
			await reinitialize(requestOptions);
		} catch {
			// Preserve the useful error that triggered recovery rather than hiding it
			// behind a failed handshake.
			throw originalError;
		}
		// Recovery is deliberately capped at one reinitialize and one retry.
		return postAuthorized(message, requestOptions);
	};

	return {
		endpoint,

		async request(method, params, requestOptions) {
			if (closed)
				throw new McpError(oauthSafe ? "MCP OAuth transport is closed." : `${endpoint} transport is closed.`);
			const id = nextId++;
			const response = await postWithRecovery({ jsonrpc: "2.0", id, method, params }, requestOptions);
			if (!response.ok) throw await httpError(endpoint, response, authorizer);
			const payload = await readResponsePayload(
				response,
				id,
				endpoint,
				requestOptions,
				oauthSafe,
				dispatchServerRequest,
			);
			return unwrapJsonRpcResult(payload, method, endpoint, oauthSafe);
		},

		async notify(method, params, requestOptions) {
			if (closed) return;
			// Notifications carry no id; a compliant server answers 202 with an empty body.
			const response = await postWithRecovery({ jsonrpc: "2.0", method, params }, requestOptions);
			if (!response.ok) throw await httpError(endpoint, response, authorizer);
			await response.body?.cancel().catch(() => {});
		},

		setRequestHandler(handler) {
			requestHandler = handler;
		},

		setProtocolVersion(version) {
			protocolVersion = version;
		},

		async close() {
			closed = true;
			if (!sessionId) return;
			// Best effort: releasing the server-side session is politeness, not correctness.
			try {
				// Releasing a session must not trigger a renewal, so reuse the last header.
				await fetch(endpoint, {
					method: "DELETE",
					headers: buildHeaders(lastAuthorization),
					signal: AbortSignal.timeout(3000),
				});
			} catch {
				// The session expires on its own.
			}
			sessionId = undefined;
		},
	};
}

async function readResponsePayload(
	response: Response,
	id: number,
	endpoint: string,
	requestOptions: RequestOptions,
	safeErrors: boolean,
	onRequest?: (
		id: McpRequestId,
		method: string,
		params: Record<string, unknown>,
		options: RequestOptions,
	) => Promise<void>,
): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		let payload: unknown;
		try {
			payload = await readSseResponse(response, id, requestOptions, onRequest);
		} catch (error) {
			if (error instanceof McpError) throw error;
			throw new McpError(
				safeErrors
					? "The MCP OAuth event stream could not be read."
					: `${endpoint} event stream failed (${errorMessage(error)}).`,
			);
		}
		if (payload === undefined) {
			throw new McpError(
				safeErrors
					? "The MCP OAuth server closed its event stream before answering."
					: `${endpoint} closed its event stream before answering request ${id}.`,
			);
		}
		return payload;
	}

	let text: string;
	try {
		text = await response.text();
	} catch {
		throw new McpError(
			safeErrors ? "The MCP OAuth response could not be read." : `${endpoint} response could not be read.`,
		);
	}
	if (!text.trim()) {
		throw new McpError(
			safeErrors
				? "The MCP OAuth server returned an empty body."
				: `${endpoint} returned an empty body for request ${id}.`,
		);
	}
	const payload = safeJsonParse(text);
	if (payload === undefined) {
		throw new McpError(
			safeErrors
				? "The MCP OAuth server returned a non-JSON body."
				: `${endpoint} returned a non-JSON body: ${truncate(text)}`,
		);
	}
	// A batched array response is legal; pick out our own id.
	if (Array.isArray(payload)) {
		const match = payload.find((entry) => isResponseTo(entry, id));
		if (!match)
			throw new McpError(
				safeErrors
					? "The MCP OAuth server returned no response for the request."
					: `${endpoint} returned a batch without a response to request ${id}.`,
			);
		return match;
	}
	return payload;
}

/**
 * Consume `text/event-stream` frames until the response to `id` arrives, then
 * stop reading. Server-initiated requests interleaved on the stream are
 * dispatched and answered before reading continues; notifications are ignored.
 */
async function readSseResponse(
	response: Response,
	id: number,
	requestOptions: RequestOptions,
	onRequest?: (
		id: McpRequestId,
		method: string,
		params: Record<string, unknown>,
		options: RequestOptions,
	) => Promise<void>,
): Promise<unknown> {
	const body = response.body;
	if (!body) return undefined;

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");

			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const payload = decodeSseFrame(frame);
				if (payload !== undefined && isResponseTo(payload, id)) return payload;
				await dispatchSseRequest(payload, requestOptions, onRequest);
				boundary = buffer.indexOf("\n\n");
			}

			if (requestOptions.signal?.aborted) return undefined;
		}
		// A stream that ends without a blank-line terminator still has a usable last frame.
		const trailing = decodeSseFrame(buffer);
		if (trailing !== undefined && isResponseTo(trailing, id)) return trailing;
		await dispatchSseRequest(trailing, requestOptions, onRequest);
		return undefined;
	} finally {
		await reader.cancel().catch(() => {});
	}
}

async function dispatchSseRequest(
	payload: unknown,
	requestOptions: RequestOptions,
	onRequest?: (
		id: McpRequestId,
		method: string,
		params: Record<string, unknown>,
		options: RequestOptions,
	) => Promise<void>,
): Promise<void> {
	if (!onRequest) return;
	const record = asRecord(payload);
	const method = readString(record, "method");
	const id = record?.id;
	if (!method || (typeof id !== "string" && typeof id !== "number")) return;
	await onRequest(id, method, asRecord(record?.params) ?? {}, requestOptions);
}

function decodeSseFrame(frame: string): unknown {
	const data: string[] = [];
	for (const line of frame.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const value = line.slice(5);
		data.push(value.startsWith(" ") ? value.slice(1) : value);
	}
	if (data.length === 0) return undefined;
	// Keep-alive comments and non-JSON events decode to undefined and are skipped by the caller.
	return safeJsonParse(data.join("\n"));
}

function isStaleSessionStatus(status: number): boolean {
	return status === 400 || status === 404;
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

async function httpError(endpoint: string, response: Response, authorizer?: McpAuthorizer): Promise<McpError> {
	const body = await response.text().catch(() => "");
	// A surviving 401 means OAuth could not produce a credential; say why, since
	// the server's own body usually just says "unauthorized". OAuth responses are
	// deliberately reduced to status and the authorizer's local failure message.
	const reason = response.status === 401 ? authorizer?.describeFailure() : undefined;
	if (authorizer) {
		return new McpError(
			`The MCP OAuth server returned HTTP ${response.status}${reason ? ` (${reason})` : ""}.`,
			response.status,
		);
	}
	return new McpError(
		`${endpoint} returned HTTP ${response.status}${body ? `: ${truncate(body)}` : ""}`,
		response.status,
	);
}

function truncate(text: string): string {
	const flat = text.replaceAll("\n", " ").trim();
	return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}
