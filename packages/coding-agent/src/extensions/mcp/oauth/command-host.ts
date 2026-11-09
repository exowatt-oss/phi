/**
 * Protocol-v1 command adapter for remote MCP OAuth.
 *
 * The configured value is an executable path/name, never a shell command. Each
 * operation is one bounded JSON request on stdin and one bounded JSON response
 * on stdout. Authorization URLs therefore never appear in argv or shell text.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { asRecord, readNumber, readString, safeJsonParse } from "../json.ts";
import {
	isValidMcpOAuthLeaseId,
	isValidMcpOAuthLeaseTtl,
	isValidMcpOAuthRequestId,
	MCP_OAUTH_BRIDGE_ERROR_CODES,
	MCP_OAUTH_BRIDGE_SCHEMA,
	type MCP_OAUTH_CALLBACK_PATH,
	MCP_OAUTH_MAX_LEASE_ID_LENGTH,
	MCP_OAUTH_MAX_PORT,
	MCP_OAUTH_MAX_REQUEST_BYTES,
	MCP_OAUTH_MAX_RESPONSE_BYTES,
	MCP_OAUTH_MAX_SERVER_NAME_LENGTH,
	MCP_OAUTH_MAX_URL_LENGTH,
	MCP_OAUTH_MIN_PORT,
	type McpOAuthBridgeErrorCode,
	McpOAuthHostError,
	type McpOAuthHostIntegration,
	validateLoopbackRedirectUri,
} from "./host.ts";

export const MCP_OAUTH_BRIDGE_COMMAND_ENV = "PI_MCP_OAUTH_BRIDGE_COMMAND";
export const MCP_OAUTH_BRIDGE_PROTOCOL = "1";
export { MCP_OAUTH_BRIDGE_ERROR_CODES } from "./host.ts";

/** Keep prepare/close bounded while allowing a human to complete first-use consent. */
export const MCP_OAUTH_BRIDGE_TIMEOUT_MS = {
	prepare: 15_000,
	open: 30 * 60_000,
	close: 15_000,
} as const;

const MAX_KILL_GRACE_MS = 250;

type BridgeOperation = keyof typeof MCP_OAUTH_BRIDGE_TIMEOUT_MS;
export type McpOAuthBridgeTimeoutOverrides = Partial<Record<BridgeOperation, number>>;
export type McpOAuthRequestIdFactory = () => string;

interface PrepareRequest {
	schema: typeof MCP_OAUTH_BRIDGE_SCHEMA;
	op: "prepare";
	requestId: string;
	serverName: string;
	remotePort: number;
	path: typeof MCP_OAUTH_CALLBACK_PATH;
	preferredRedirectUri?: string;
}

interface OpenRequest {
	schema: typeof MCP_OAUTH_BRIDGE_SCHEMA;
	op: "open";
	leaseId: string;
	authorizationUrl: string;
	redirectUri: string;
}

interface CloseRequest {
	schema: typeof MCP_OAUTH_BRIDGE_SCHEMA;
	op: "close";
	requestId: string;
	leaseId?: string;
	outcome: "complete" | "cancelled" | "failed";
}

type BridgeRequest = PrepareRequest | OpenRequest | CloseRequest;

/** Return the command-backed host for the current session, or no host. */
export function createMcpOAuthHostIntegration(
	command = process.env[MCP_OAUTH_BRIDGE_COMMAND_ENV],
): McpOAuthHostIntegration | undefined {
	const executable = command?.trim();
	if (!executable || executable.includes("\0")) return undefined;
	return createCommandMcpOAuthHost(executable);
}

export function createCommandMcpOAuthHost(
	command: string,
	timeoutOverrides: McpOAuthBridgeTimeoutOverrides = {},
	requestIdFactory: McpOAuthRequestIdFactory = randomUUID,
): McpOAuthHostIntegration {
	const leaseRequestIds = new Map<string, string>();
	const timeoutFor = (operation: BridgeOperation): number => {
		const configured = timeoutOverrides[operation];
		const defaultTimeout = MCP_OAUTH_BRIDGE_TIMEOUT_MS[operation];
		if (!Number.isFinite(configured) || configured === undefined || configured <= 0) {
			return defaultTimeout;
		}
		return Math.max(1, Math.min(Math.floor(configured), defaultTimeout));
	};

	return {
		async prepareCallback(input): Promise<{
			leaseId: string;
			redirectUri: string;
			expiresAt: number;
		}> {
			if (
				!isBoundedRequestString(input.serverName, MCP_OAUTH_MAX_SERVER_NAME_LENGTH) ||
				!isLoopbackPort(input.remotePort) ||
				input.path !== "/oauth/callback"
			) {
				throw new McpOAuthHostError("invalid_request");
			}
			if (input.preferredRedirectUri !== undefined) {
				validateLoopbackRedirectUri(input.preferredRedirectUri, input.path);
			}
			const requestId = requestIdFactory();
			if (!isValidMcpOAuthRequestId(requestId)) throw new McpOAuthHostError("invalid_request");
			let response: Record<string, unknown> | undefined;
			let leaseId: string | undefined;
			try {
				response = await invoke(
					command,
					{
						schema: MCP_OAUTH_BRIDGE_SCHEMA,
						op: "prepare",
						requestId,
						serverName: input.serverName,
						remotePort: input.remotePort,
						path: input.path,
						...(input.preferredRedirectUri ? { preferredRedirectUri: input.preferredRedirectUri } : {}),
					},
					input.signal,
					timeoutFor("prepare"),
				);
				leaseId = readString(response, "leaseId");
				assertStatus(response, "ready");
				const echoedRequestId = readString(response, "requestId");
				const redirectUri = readString(response, "redirectUri");
				const expiresInMs = readNumber(response, "expiresInMs");
				if (
					echoedRequestId !== requestId ||
					"expiresAt" in response ||
					!isValidMcpOAuthLeaseId(leaseId) ||
					!redirectUri ||
					!isBoundedRequestString(redirectUri, MCP_OAUTH_MAX_URL_LENGTH) ||
					!isValidMcpOAuthLeaseTtl(expiresInMs)
				) {
					throw new McpOAuthHostError("invalid_response");
				}
				validateLoopbackRedirectUri(redirectUri, input.path);
				const expiresAt = Date.now() + expiresInMs;
				leaseRequestIds.set(leaseId, requestId);
				return { leaseId, redirectUri, expiresAt };
			} catch (error) {
				await bestEffortClose(
					command,
					requestId,
					isValidMcpOAuthLeaseId(leaseId) ? leaseId : undefined,
					timeoutFor("close"),
				);
				if (error instanceof McpOAuthHostError) throw error;
				throw new McpOAuthHostError("bridge_error");
			}
		},

		async presentAuthorization(input): Promise<void> {
			if (
				!isBoundedRequestString(input.leaseId, MCP_OAUTH_MAX_LEASE_ID_LENGTH) ||
				!isBoundedRequestString(input.authorizationUrl, MCP_OAUTH_MAX_URL_LENGTH) ||
				!isBoundedRequestString(input.redirectUri, MCP_OAUTH_MAX_URL_LENGTH)
			) {
				throw new McpOAuthHostError("invalid_request");
			}
			validateLoopbackRedirectUri(input.redirectUri);
			const response = await invoke(
				command,
				{
					schema: MCP_OAUTH_BRIDGE_SCHEMA,
					op: "open",
					leaseId: input.leaseId,
					authorizationUrl: input.authorizationUrl,
					redirectUri: input.redirectUri,
				},
				input.signal,
				timeoutFor("open"),
			);
			assertStatus(response, "opened");
		},

		async close(input): Promise<void> {
			if (
				!isBoundedRequestString(input.leaseId, MCP_OAUTH_MAX_LEASE_ID_LENGTH) ||
				(input.outcome !== "complete" && input.outcome !== "cancelled" && input.outcome !== "failed")
			) {
				throw new McpOAuthHostError("invalid_request");
			}
			const requestId = leaseRequestIds.get(input.leaseId);
			if (!requestId) throw new McpOAuthHostError("invalid_request");
			try {
				const response = await invoke(
					command,
					{
						schema: MCP_OAUTH_BRIDGE_SCHEMA,
						op: "close",
						requestId,
						leaseId: input.leaseId,
						outcome: input.outcome,
					},
					undefined,
					timeoutFor("close"),
				);
				assertStatus(response, "closed");
			} finally {
				leaseRequestIds.delete(input.leaseId);
			}
		},
	};
}

async function bestEffortClose(
	command: string,
	requestId: string,
	leaseId: string | undefined,
	timeoutMs: number,
): Promise<void> {
	try {
		const closeRequest: CloseRequest = {
			schema: MCP_OAUTH_BRIDGE_SCHEMA,
			op: "close",
			requestId,
			outcome: "failed",
		};
		if (leaseId !== undefined) closeRequest.leaseId = leaseId;
		const response = await invoke(command, closeRequest, undefined, timeoutMs);
		assertStatus(response, "closed");
	} catch {
		// The original prepare validation failure is the only diagnostic that may
		// leave this boundary. Closing a bad lease is deliberately best effort.
	}
}

async function invoke(
	command: string,
	request: BridgeRequest,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const payload = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(payload) > MCP_OAUTH_MAX_REQUEST_BYTES) throw new McpOAuthHostError("invalid_request");

	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(command, [], {
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			// On POSIX this makes the helper the process-group leader, so timeout
			// and abort can terminate descendants as well as the direct child.
			detached: process.platform !== "win32",
		});
	} catch {
		throw new McpOAuthHostError("command_failed");
	}

	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let responseBytes = 0;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let failure: McpOAuthHostError | undefined;
		let terminationRequested = false;

		const destroyStdio = (): void => {
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
		};
		const terminate = (): void => {
			if (terminationRequested) return;
			terminationRequested = true;
			destroyStdio();
			if (process.platform === "win32") {
				terminateWindowsProcessTree(child.pid);
				try {
					child.kill();
				} catch {
					// The child may have exited between the timeout/abort and termination.
				}
			} else {
				terminatePosixProcessGroup(child.pid, "SIGTERM", child);
			}
			killTimer = setTimeout(() => {
				destroyStdio();
				if (process.platform === "win32") terminateWindowsProcessTree(child.pid);
				else terminatePosixProcessGroup(child.pid, "SIGKILL", child);
			}, MAX_KILL_GRACE_MS);
			killTimer.unref();
		};
		const clearKillTimer = (): void => {
			if (killTimer && !terminationRequested) {
				clearTimeout(killTimer);
				killTimer = undefined;
			}
		};
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			// A terminated command may ignore SIGTERM. Leave the unref'ed grace
			// timer armed so the process group still gets a force-kill.
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error?: McpOAuthHostError): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) {
				destroyStdio();
				reject(error);
				return;
			}
			const parsed = safeJsonParse(Buffer.concat(chunks).toString("utf8"));
			const record = asRecord(parsed);
			if (!record) {
				reject(new McpOAuthHostError("invalid_response"));
				return;
			}
			resolve(record);
		};
		const onAbort = (): void => {
			failure = new McpOAuthHostError("aborted");
			terminate();
			finish(failure);
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			if (settled) return;
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			responseBytes += bytes.length;
			if (responseBytes > MCP_OAUTH_MAX_RESPONSE_BYTES) {
				failure = new McpOAuthHostError("invalid_response");
				terminate();
				finish(failure);
				return;
			}
			chunks.push(bytes);
		});
		// Stderr is deliberately drained but never included in an error.
		child.stderr.resume();
		child.stdin.once("error", () => undefined);
		child.once("error", () => finish(failure ?? new McpOAuthHostError("command_failed")));
		child.once("close", (code) => {
			clearKillTimer();
			if (settled) return;
			if (failure) {
				finish(failure);
				return;
			}
			if (code !== 0) {
				finish(new McpOAuthHostError("command_failed"));
				return;
			}
			finish();
		});
		timer = setTimeout(() => {
			failure = new McpOAuthHostError("timeout");
			terminate();
			finish(failure);
		}, timeoutMs);
		timer.unref();
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			child.stdin.end(payload);
		} catch {
			failure = new McpOAuthHostError("connection_lost");
			terminate();
			finish(failure);
		}
	});
}

function terminatePosixProcessGroup(
	pid: number | undefined,
	signal: NodeJS.Signals,
	child: ChildProcessWithoutNullStreams,
): void {
	if (pid === undefined || pid <= 0 || pid === process.pid) {
		try {
			child.kill(signal);
		} catch {
			// The child may have exited already.
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The child may have exited already.
		}
	}
}

/** Windows has no portable negative-PID group signal; taskkill /T is argv-safe. */
function terminateWindowsProcessTree(pid: number | undefined): void {
	if (pid === undefined || pid <= 0 || pid === process.pid) return;
	const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
		shell: false,
		windowsHide: true,
		stdio: "ignore",
	});
	killer.once("error", () => undefined);
}

function assertStatus(response: Record<string, unknown>, expected: string): void {
	if (readNumber(response, "schema") !== MCP_OAUTH_BRIDGE_SCHEMA) {
		throw new McpOAuthHostError("unsupported_protocol");
	}
	const status = readString(response, "status");
	if (status === expected) return;
	if (status === "error") {
		const code = readString(response, "code");
		throw new McpOAuthHostError(isBridgeErrorCode(code) ? code : "bridge_error");
	}
	throw new McpOAuthHostError("invalid_response");
}

function isBridgeErrorCode(value: string | undefined): value is McpOAuthBridgeErrorCode {
	return value !== undefined && (MCP_OAUTH_BRIDGE_ERROR_CODES as readonly string[]).includes(value);
}

function isBoundedRequestString(value: string, maxLength: number): boolean {
	return (
		value.length > 0 &&
		value.length <= maxLength &&
		!Array.from(value).some((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x1f || code === 0x7f;
		})
	);
}

function isLoopbackPort(value: number): boolean {
	return Number.isInteger(value) && value >= MCP_OAUTH_MIN_PORT && value <= MCP_OAUTH_MAX_PORT;
}
