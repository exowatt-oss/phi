/**
 * Live feed of subagent runs for other built-in extensions (phi remote shows each run as a child
 * thread of the session that launched it).
 *
 * Published on the extension event bus (`pi.events`, channel {@link SUBAGENT_FEED_CHANNEL}), which
 * is scoped to one session runtime and dropped on session replacement. The payloads carry the live
 * run objects (mutated in place by the runner) and the child's parsed JSON event stream, unchanged:
 * listeners must treat both as read-only and must not keep raw events.
 */

import type { SubagentControlCommand } from "./runner.ts";
import type { SubagentMode, SubagentRunSnapshot } from "./types.ts";

export const SUBAGENT_FEED_CHANNEL = "phi:subagents";

/** What a listener may do to a live run. */
export interface SubagentFeedControl {
	/**
	 * Write a command to the child's stdin control channel. False when the channel is not open (the
	 * child is still starting, or already exiting).
	 */
	send(command: SubagentControlCommand): boolean;
	/** Kill the run (the `subagent` tool's kill action). False when it is no longer running. */
	kill(reason: string): boolean;
}

export type SubagentFeedEvent =
	| {
			type: "start";
			run: SubagentRunSnapshot;
			/** The parent's `subagent` tool call. */
			toolCallId: string;
			/** 0-based position in the call's tasks / chain. */
			index: number;
			mode: SubagentMode;
			background: boolean;
			/** The task's explicit `name`, if it had one. */
			taskName?: string;
			control: SubagentFeedControl;
	  }
	/** One parsed record of the child's `--mode json` stream (header, session events, ...). */
	| { type: "event"; run: SubagentRunSnapshot; event: Record<string, unknown> }
	/** The run settled; `run.status` is final. */
	| { type: "end"; run: SubagentRunSnapshot };

export function isSubagentFeedEvent(value: unknown): value is SubagentFeedEvent {
	if (!value || typeof value !== "object") return false;
	const type = (value as { type?: unknown }).type;
	return (
		(type === "start" || type === "event" || type === "end") &&
		typeof (value as { run?: unknown }).run === "object" &&
		(value as { run?: unknown }).run !== null
	);
}
