/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import { createInterface } from "node:readline";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import {
	closeSubagentControlChannel,
	isSubagentControlEnabled,
	openSubagentControlChannel,
	resolvePendingReply,
} from "../core/subagent-control.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let lastAssistantMessage: AssistantMessage | undefined;
	let contextWindowStarted = false;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposed = false;
	const controlEnabled = mode === "json" && isSubagentControlEnabled();
	let controlInput: ReturnType<typeof createInterface> | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		if (controlEnabled) {
			controlInput?.close();
			closeSubagentControlChannel("parent closed the channel");
		}
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		lastAssistantMessage = undefined;
		contextWindowStarted = false;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end") {
				if (event.message.role === "assistant") {
					lastAssistantMessage = event.message;
					contextWindowStarted = false;
				} else if (event.message.role === "custom" && event.message.customType === "context-window") {
					contextWindowStarted = true;
				}
			}
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
				return;
			}
			// Text mode: a model escalation changes who answered, which a scripted
			// caller should be able to see. stderr, so stdout stays just the answer.
			if (event.type === "refusal_fallback") {
				console.error(
					`Safety classifier declined${event.category ? ` (${event.category})` : ""} on ${event.from} — escalating to ${event.to}`,
				);
			} else if (event.type === "refusal_fallback_exhausted") {
				console.error(
					`Safety classifier declined on ${event.from}; fallback chain exhausted (${event.tried.join(", ")})`,
				);
			} else if (event.type === "error_fallback") {
				console.error(`${event.from} unavailable — rerouting to ${event.to} (${event.reason})`);
			} else if (event.type === "error_fallback_exhausted") {
				console.error(
					`${event.from} unavailable (${event.reason}); error-fallback chain exhausted (${event.tried.join(", ")})`,
				);
			}
		});
		unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		// Only JSON subagent children interpret stdin as commands. Attach before the
		// initial prompt: a parent must be able to answer message_parent mid-tool.
		let inputClosed: Promise<void> | undefined;
		const runningPrompts = new Set<Promise<void>>();
		if (controlEnabled) {
			openSubagentControlChannel();
			controlInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
			let onControlClose!: () => void;
			inputClosed = new Promise<void>((resolve) => {
				let closed = false;
				onControlClose = () => {
					if (closed) return;
					closed = true;
					closeSubagentControlChannel("parent closed the channel");
					resolve();
				};
				controlInput?.once("close", onControlClose);
			});
			if (process.stdin.readableEnded) {
				onControlClose();
				controlInput.close();
			}

			controlInput.on("line", (line) => {
				let command: unknown;
				try {
					command = JSON.parse(line);
				} catch {
					console.error("Invalid subagent control command (ignored)");
					return;
				}
				if (!command || typeof command !== "object" || Array.isArray(command) || !("type" in command)) {
					console.error("Invalid subagent control command (ignored)");
					return;
				}

				const reportCommandError = (error: unknown): void => {
					console.error(error instanceof Error ? error.message : String(error));
					exitCode = 1;
				};
				const { type } = command;
				if (type === "steer" || type === "follow_up") {
					if (!("message" in command) || typeof command.message !== "string") {
						console.error("Invalid subagent control command (ignored)");
						return;
					}
					// An accepted prompt may still be in preflight before isStreaming flips.
					// In that case queue against it rather than starting a competing run.
					if (session.isStreaming || runningPrompts.size > 0) {
						const pending = type === "steer" ? session.steer(command.message) : session.followUp(command.message);
						void pending.catch(reportCommandError);
					} else {
						const turn = session.prompt(command.message);
						runningPrompts.add(turn);
						void turn.catch(reportCommandError).finally(() => runningPrompts.delete(turn));
					}
					return;
				}
				if (type === "reply") {
					if (
						!("toolCallId" in command) ||
						typeof command.toolCallId !== "string" ||
						!("text" in command) ||
						typeof command.text !== "string"
					) {
						console.error("Invalid subagent control command (ignored)");
						return;
					}
					if (!resolvePendingReply(command.toolCallId, command.text)) {
						console.error(`Unknown subagent reply id: ${command.toolCallId}`);
					}
					return;
				}
				if (type === "abort") {
					void session.abort().catch(reportCommandError);
					return;
				}
				console.error("Invalid subagent control command (ignored)");
			});
		}

		if (initialMessage) {
			const turn = session.prompt(initialMessage, { images: initialImages });
			if (controlEnabled) runningPrompts.add(turn);
			try {
				await turn;
			} catch (error: unknown) {
				if (!controlEnabled) throw error;
				console.error(error instanceof Error ? error.message : String(error));
				exitCode = 1;
			} finally {
				runningPrompts.delete(turn);
			}
		}

		for (const message of messages) {
			lastAssistantMessage = undefined;
			contextWindowStarted = false;
			const turn = session.prompt(message);
			if (controlEnabled) runningPrompts.add(turn);
			try {
				await turn;
			} catch (error: unknown) {
				if (!controlEnabled) throw error;
				console.error(error instanceof Error ? error.message : String(error));
				exitCode = 1;
			} finally {
				runningPrompts.delete(turn);
			}
		}

		if (inputClosed) {
			await inputClosed;
			// EOF does not abort a turn. Commands accepted just before close must
			// finish too, including tool waits rejected by the close handler.
			await Promise.all([...runningPrompts]);
			await session.waitForIdle();
		}

		if (mode === "text") {
			const activeLastMessage = session.state.messages.at(-1);
			const assistantMsg =
				activeLastMessage?.role === "assistant"
					? activeLastMessage
					: contextWindowStarted
						? lastAssistantMessage
						: undefined;

			if (assistantMsg) {
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
					if (assistantMsg.stopReason === "length") {
						console.error("Response was truncated: the model reached its output token limit.");
						exitCode = 1;
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		controlInput?.close();
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
