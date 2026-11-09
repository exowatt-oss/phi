/**
 * stdio transport: the server is a child process, and JSON-RPC messages are
 * newline-delimited JSON on its stdin/stdout. stderr is kept as a rolling tail
 * so a crashed server reports why instead of just "connection closed".
 *
 * The process is spawned by `connect()`, never at extension load, and killed
 * from `close()` on `session_shutdown`.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { asRecord, errorMessage, readString, safeJsonParse } from "./json.ts";
import {
	handleServerRequest,
	isResponseTo,
	McpError,
	type McpRequestHandler,
	type McpTransport,
	unwrapJsonRpcResult,
} from "./protocol.ts";

const STDERR_TAIL_LINES = 20;

export interface StdioTransportOptions {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

interface Pending {
	resolve: (payload: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	cleanup: () => void;
}

export function createStdioTransport(options: StdioTransportOptions): McpTransport {
	const endpoint = [options.command, ...(options.args ?? [])].join(" ");
	const pending = new Map<number, Pending>();
	const stderrTail: string[] = [];
	let child: ChildProcessWithoutNullStreams | undefined;
	let stdoutBuffer = "";
	let nextId = 1;
	let exitReason: string | undefined;
	let requestHandler: McpRequestHandler | undefined;
	let closed = false;

	const failAll = (error: Error): void => {
		for (const [id, entry] of pending) {
			pending.delete(id);
			entry.cleanup();
			entry.reject(error);
		}
	};

	const describeExit = (): string => (stderrTail.length > 0 ? `\nstderr:\n${stderrTail.join("\n")}` : "");

	const handleLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed) return;
		const payload = safeJsonParse(trimmed);
		if (payload === undefined) return; // Servers sometimes print banners on stdout; ignore non-JSON.
		for (const [id, entry] of pending) {
			if (!isResponseTo(payload, id)) continue;
			pending.delete(id);
			entry.cleanup();
			entry.resolve(payload);
			return;
		}
		const record = asRecord(payload);
		const method = readString(record, "method");
		const id = record?.id;
		if (!method || (typeof id !== "string" && typeof id !== "number")) return;
		const params = asRecord(record?.params) ?? {};
		void handleServerRequest(id, method, params, requestHandler).then(write);
	};

	const ensureStarted = (): ChildProcessWithoutNullStreams => {
		if (closed) throw new McpError(`${endpoint} transport is closed.`);
		if (child) return child;

		let spawned: ChildProcessWithoutNullStreams;
		try {
			spawned = spawn(options.command, options.args ?? [], {
				cwd: options.cwd,
				// Inherit the user's environment so PATH-resolved launchers such as uvx work.
				env: { ...process.env, ...options.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			throw new McpError(`Could not start "${endpoint}": ${errorMessage(error)}`);
		}

		spawned.stdout.setEncoding("utf-8");
		spawned.stdout.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			let newline = stdoutBuffer.indexOf("\n");
			while (newline !== -1) {
				const line = stdoutBuffer.slice(0, newline);
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				handleLine(line);
				newline = stdoutBuffer.indexOf("\n");
			}
		});

		spawned.stderr.setEncoding("utf-8");
		spawned.stderr.on("data", (chunk: string) => {
			for (const line of chunk.split("\n")) {
				if (!line.trim()) continue;
				stderrTail.push(line);
				if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
			}
		});

		spawned.on("error", (error) => {
			exitReason = `failed to start: ${error.message}`;
			failAll(new McpError(`"${endpoint}" ${exitReason}${describeExit()}`));
		});

		spawned.on("exit", (code, signal) => {
			exitReason = signal ? `was killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
			child = undefined;
			if (!closed) failAll(new McpError(`"${endpoint}" ${exitReason}${describeExit()}`));
		});

		child = spawned;
		return spawned;
	};

	const write = (message: Record<string, unknown>): void => {
		const active = ensureStarted();
		active.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
			if (error) failAll(new McpError(`Writing to "${endpoint}" failed: ${error.message}`));
		});
	};

	return {
		endpoint,

		request(method, params, requestOptions) {
			if (requestOptions.signal?.aborted) {
				return Promise.reject(new McpError(`Request to "${endpoint}" was cancelled.`));
			}
			const id = nextId++;
			return new Promise<unknown>((resolve, reject) => {
				const onAbort = (): void => {
					const entry = pending.get(id);
					if (!entry) return;
					pending.delete(id);
					entry.cleanup();
					reject(new McpError(`Request to "${endpoint}" was cancelled.`));
				};
				const timer = setTimeout(() => {
					const entry = pending.get(id);
					if (!entry) return;
					pending.delete(id);
					entry.cleanup();
					reject(
						new McpError(
							`"${endpoint}" did not answer ${method} within ${requestOptions.timeoutMs}ms.${describeExit()}`,
						),
					);
				}, requestOptions.timeoutMs);
				const cleanup = (): void => {
					clearTimeout(timer);
					requestOptions.signal?.removeEventListener("abort", onAbort);
				};

				pending.set(id, {
					resolve: (payload) => {
						try {
							resolve(unwrapJsonRpcResult(payload, method, `"${endpoint}"`));
						} catch (error) {
							reject(error instanceof Error ? error : new McpError(String(error)));
						}
					},
					reject,
					timer,
					cleanup,
				});
				requestOptions.signal?.addEventListener("abort", onAbort, { once: true });

				try {
					write({ jsonrpc: "2.0", id, method, params });
				} catch (error) {
					pending.delete(id);
					cleanup();
					reject(error instanceof Error ? error : new McpError(String(error)));
				}
			});
		},

		async notify(method, params) {
			if (closed) return;
			write({ jsonrpc: "2.0", method, params });
		},

		setRequestHandler(handler) {
			requestHandler = handler;
		},

		async close() {
			if (closed) return;
			closed = true;
			failAll(new McpError(`"${endpoint}" transport closed.`));
			const active = child;
			child = undefined;
			if (!active) return;
			active.stdin.end();
			active.kill("SIGTERM");
			// Give a well-behaved server a moment to flush and exit before forcing it.
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					active.kill("SIGKILL");
					resolve();
				}, 2000);
				active.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		},
	};
}
