import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { WorkspaceStateNotes } from "./types.ts";

export const SESSION_NOTES_DESCRIPTION =
	"Record facts for the session's state record: the feads tracking epic id and follow-ups you flagged but did not file. Call it whenever these change, at any point in the turn. End-of-turn state (complete / awaiting-human / mid-work / blocked-approval) is classified automatically after your final message — never call anything to end a turn.";

export function registerSessionNotesTool(pi: ExtensionAPI, update: (notes: WorkspaceStateNotes) => void): void {
	pi.registerTool({
		name: "session_notes",
		label: "Session notes",
		description: SESSION_NOTES_DESCRIPTION,
		parameters: Type.Object({
			feads_epic: Type.Optional(Type.String()),
			open_items: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params) {
			const notes: WorkspaceStateNotes = {};
			if (typeof params.feads_epic === "string") notes.feads_epic = params.feads_epic.trim();
			if (Array.isArray(params.open_items)) {
				notes.open_items = params.open_items.filter((item): item is string => typeof item === "string");
			}
			update(notes);
			return { content: [{ type: "text", text: "Session notes recorded." }], details: {} };
		},
	});
}
