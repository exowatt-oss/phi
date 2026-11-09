import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "../../core/extensions/types.ts";
import { isTuiMode } from "../../core/tui-mode.ts";
import type { LoopControlCall } from "./types.ts";

const Params = Type.Object({
	action: Type.Union([Type.Literal("continue"), Type.Literal("complete"), Type.Literal("pause")]),
	summary: Type.String(),
	evidence: Type.Optional(Type.Array(Type.String())),
	nextStep: Type.Optional(Type.String()),
});

type Hooks = {
	isIterationActive(): { loopId: string; iterationId: string } | undefined;
	record(call: LoopControlCall): void;
};

/**
 * The default wording assumes an embedding chat UI that folds pre-tool text;
 * `PI_TUI_MODE` tells the model the terminal shows everything, so
 * the iteration's result belongs in the final message rather than in this tool's arguments.
 */
export function loopControlDescription(tuiMode: boolean): string {
	return (
		"Record the bounded loop decision for this iteration. It cannot change loop limits or configuration. " +
		"Call it as your last tool call, immediately before you write the iteration's final message — never after " +
		(tuiMode
			? "it or between its paragraphs; the human reads your final text in the terminal, so that message must " +
				"carry the iteration's result itself — `summary` is metadata, not the report."
			: "it or between its paragraphs; chat UIs fold away any text written before your final tool call.")
	);
}

export function registerLoopControlTool(pi: ExtensionAPI, hooks: Hooks): void {
	pi.registerTool({
		name: "loop_control",
		label: "Loop control",
		description: loopControlDescription(isTuiMode()),
		parameters: Params,
		async execute(_id, params): Promise<AgentToolResult<unknown>> {
			const active = hooks.isIterationActive();
			if (!active)
				return {
					content: [{ type: "text", text: "loop_control is only available during an active /loop iteration" }],
					details: {},
				};
			const invalid =
				typeof params.summary !== "string" || !["continue", "complete", "pause"].includes(params.action)
					? "invalid loop_control payload"
					: params.evidence !== undefined &&
							(!Array.isArray(params.evidence) || !params.evidence.every((x) => typeof x === "string"))
						? "evidence must be an array of strings"
						: params.nextStep !== undefined && typeof params.nextStep !== "string"
							? "nextStep must be a string"
							: undefined;
			const call: LoopControlCall = {
				action: params.action as LoopControlCall["action"],
				summary: params.summary,
				evidence: params.evidence,
				nextStep: params.nextStep,
				at: new Date().toISOString(),
				iterationId: active.iterationId,
				...(invalid ? { invalid } : {}),
			};
			hooks.record(call);
			if (invalid)
				return {
					content: [{ type: "text", text: `Invalid loop_control payload: ${invalid}` }],
					details: { invalid },
				};
			return { content: [{ type: "text", text: `Loop decision recorded: ${params.action}.` }], details: {} };
		},
	});
}
