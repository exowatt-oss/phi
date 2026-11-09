/**
 * Subagent control channel shared state.
 *
 * A subagent child runs `--mode json -p` with `PI_SUBAGENT_CONTROL=stdin`. The parent
 * writes JSONL commands to the child's stdin (see print-mode.ts). `reply` commands
 * resolve a pending `message_parent` wait registered here by the child-side tool.
 */

export const SUBAGENT_CONTROL_ENV = "PI_SUBAGENT_CONTROL";

/** True when this process is a subagent child with a live parent control channel on stdin. */
export function isSubagentControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[SUBAGENT_CONTROL_ENV] === "stdin";
}

interface PendingReply {
	resolve: (text: string) => void;
	reject: (error: Error) => void;
}

const pending = new Map<string, PendingReply>();
let channelClosedReason: string | undefined;

/** Open the channel before an opt-in print-mode child starts its first prompt. */
export function openSubagentControlChannel(): void {
	channelClosedReason = undefined;
}

/** Close the channel and fail both current and later waits promptly. */
export function closeSubagentControlChannel(reason: string): void {
	channelClosedReason = reason;
	rejectAllPendingReplies(reason);
}

/** Register a wait for the parent's reply to the message_parent call `toolCallId`. */
export function registerPendingReply(toolCallId: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		if (channelClosedReason) {
			reject(new Error(channelClosedReason));
			return;
		}
		pending.set(toolCallId, {
			resolve: (text) => {
				pending.delete(toolCallId);
				resolve(text);
			},
			reject: (error) => {
				pending.delete(toolCallId);
				reject(error);
			},
		});
	});
}

/** Drop a pending wait without resolving it (timeout / abort in the waiting tool). */
export function cancelPendingReply(toolCallId: string): void {
	pending.delete(toolCallId);
}

/** Resolve a pending wait. Returns false when no wait with that id exists. */
export function resolvePendingReply(toolCallId: string, text: string): boolean {
	const entry = pending.get(toolCallId);
	if (!entry) return false;
	entry.resolve(text);
	return true;
}

/** Reject every pending wait (e.g. the parent closed stdin). */
export function rejectAllPendingReplies(reason: string): void {
	for (const entry of [...pending.values()]) entry.reject(new Error(reason));
}

export function pendingReplyCount(): number {
	return pending.size;
}
