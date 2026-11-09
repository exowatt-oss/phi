import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { cancelPendingReply, isSubagentControlEnabled, registerPendingReply } from "../../core/subagent-control.ts";

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1800;

const MessageParentParams = Type.Object({
	message: Type.String({
		minLength: 1,
		maxLength: 8192,
		description: "The milestone, question, or blocker for your parent agent",
	}),
	kind: Type.Optional(StringEnum(["progress", "question", "blocker"] as const, { description: "Default: question" })),
	timeoutSeconds: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: MAX_TIMEOUT_SECONDS,
			description: "Reply wait in seconds (default 600, max 1800)",
		}),
	),
});

/** Install only in a child with the opt-in stdin control channel. Never expose to a parent session. */
export function registerChildMessageTool(pi: ExtensionAPI): void {
	if (!process.env.PI_SUBAGENT_ID || !isSubagentControlEnabled()) return;
	pi.registerTool({
		name: "message_parent",
		label: "Message parent",
		description:
			"Report progress to the parent agent or ask it a question without ending this run. Questions and blockers wait for a bounded reply only if the parent is free to answer.",
		promptSnippet: "Message your parent agent: report a milestone or ask a question without ending your run",
		promptGuidelines: [
			"Use message_parent with kind:'question' when an ambiguity or missing fact would change the outcome — ask instead of guessing, and instead of ending your run early to ask.",
			"Use kind:'blocker' when you cannot continue (missing access, broken environment, contradictory instructions).",
			"Use kind:'progress' sparingly, at real milestones in long tasks (not every step); it does not interrupt the parent.",
			"Messages that start with [message from your parent agent] are instructions from the agent that launched you; follow them.",
		],
		parameters: MessageParentParams,
		async execute(toolCallId, params, signal) {
			const kind = params.kind ?? "question";
			if (kind === "progress") return { content: [{ type: "text", text: "Reported to parent." }], details: {} };
			if (process.env.PI_SUBAGENT_PARENT_LISTENING !== "1") {
				return {
					content: [
						{
							type: "text",
							text: "Your parent is blocked waiting for your final answer and cannot reply. Proceed with your best judgment and state the assumption in your final answer.",
						},
					],
					details: {},
				};
			}

			const seconds = Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS));
			let timer: ReturnType<typeof setTimeout> | undefined;
			let abort: (() => void) | undefined;
			try {
				if (signal?.aborted) throw signal.reason ?? new Error("message_parent cancelled");
				const reply = registerPendingReply(toolCallId);
				// The tool wait is not part of the model loop's steering queue. A reply from
				// stdin resolves this promise even while the tool is still executing.
				const outcome = await Promise.race([
					reply.then((text) => ({ type: "reply" as const, text })),
					new Promise<{ type: "timeout" }>((resolve) => {
						timer = setTimeout(() => resolve({ type: "timeout" }), seconds * 1000);
					}),
					new Promise<never>((_resolve, reject) => {
						abort = () => reject(signal?.reason ?? new Error("message_parent cancelled"));
						signal?.addEventListener("abort", abort, { once: true });
					}),
				]);
				return {
					content: [
						{
							type: "text",
							text:
								outcome.type === "reply"
									? `Parent replied: ${outcome.text}`
									: `No reply within ${seconds} s. Proceed with your best judgment and state the assumption in your final answer.`,
						},
					],
					details: {},
				};
			} catch (error) {
				if (signal?.aborted) throw error;
				return {
					content: [
						{
							type: "text",
							text: "Parent closed the channel. Proceed with your best judgment and state the assumption in your final answer.",
						},
					],
					details: {},
				};
			} finally {
				if (timer) clearTimeout(timer);
				if (abort) signal?.removeEventListener("abort", abort);
				cancelPendingReply(toolCallId);
			}
		},
	});
}
