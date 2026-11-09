/**
 * workspace-state contract v1.
 *
 * Source of truth: the workspace-state contract
 *
 * Field names are the contract's, not phi's: they are snake_case on the wire because
 * every consumer (Forca, feads, P3) diffs against the proposal text. Do not rename.
 */

/** The four end states a session can hand back in. */
export type WorkspaceEndState = "complete" | "awaiting-human" | "mid-work" | "blocked-approval";

export const WORKSPACE_END_STATES: readonly WorkspaceEndState[] = [
	"complete",
	"awaiting-human",
	"mid-work",
	"blocked-approval",
];

/** Session entry customTypes for hand-back records and sticky session metadata. */
export const WORKSPACE_STATE_ENTRY = "workspace-state";
export const WORKSPACE_STATE_NOTES_ENTRY = "workspace-state-notes";

/** What produced the record. `tool` remains in the wire type for older records. */
export type WorkspaceStateSource = "tool" | "classifier";

/** The feads coordinates of the session, when the agent named an epic. */
export interface WorkspaceStateFeads {
	epic: string;
	/**
	 * Open children of the epic. phi does not query the board (the emitter must never
	 * depend on a network read), so this is only present when a consumer fills it in.
	 */
	open_children?: number;
}

/** One hand-back record, appended to the session at `agent_settled`. */
export interface WorkspaceStateRecord {
	v: 1;
	session_id: string;
	/** Absolute session JSONL path; empty when the session is not persisted. */
	session_file: string;
	cwd: string;
	host: string;
	end_state: WorkspaceEndState;
	/** The exact decision requested. Present iff `end_state` is `awaiting-human`. */
	question?: string;
	/** Follow-ups the agent flagged but did not file. */
	open_items?: string[];
	feads?: WorkspaceStateFeads;
	source: WorkspaceStateSource;
	ts: number;
}

/** Sticky facts updated by `session_notes`, independent of turn classification. */
export interface WorkspaceStateNotes {
	open_items?: string[];
	feads_epic?: string;
}
