import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "../../core/extensions/types.ts";
import { recordCheckpoint } from "./state.ts";

const Params = Type.Object({
	notes: Type.String({ maxLength: 8000 }),
	keep: Type.Optional(Type.Array(Type.String())),
	mode: Type.Optional(
		Type.Union([Type.Literal("summarize"), Type.Literal("fresh")], {
			description: "Compaction mode (default: summarize)",
			default: "summarize",
		}),
	),
});

export type CheckpointMode = "summarize" | "fresh";

export interface CheckpointCompaction {
	notes: string;
	keep?: string[];
	mode: CheckpointMode;
}

export const CHECKPOINT_DESCRIPTION =
	"Call when a sub-task has resolved or the work is converging — PR merged, tests green, phase done, before a " +
	"long-running command — once the budget line says the window is open; never mid-edit, mid-derivation, or while " +
	"stuck. Below the window it only records notes; if never called, phi compacts at the hard line or at run end. " +
	"`notes` = what a fresh you needs (goal, decisions, state, next steps); `keep` = file paths/constraints to carry " +
	"verbatim across compaction; `mode: fresh` starts a clean context with `notes` as the handoff.";

export function registerCheckpointTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "checkpoint",
		label: "Checkpoint",
		description: CHECKPOINT_DESCRIPTION,
		parameters: Params,
		async execute(_id, params): Promise<AgentToolResult<unknown>> {
			const mode: CheckpointMode = params.mode === "fresh" ? "fresh" : "summarize";
			const compaction: CheckpointCompaction = {
				notes: params.notes,
				...(params.keep === undefined ? {} : { keep: params.keep }),
				mode,
			};
			recordCheckpoint();
			return {
				content: [{ type: "text", text: "Checkpoint recorded." }],
				details: {},
				compaction,
			};
		},
	});
}
