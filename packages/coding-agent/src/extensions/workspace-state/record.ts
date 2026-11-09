import type { Classification } from "./classify.ts";
import type { WorkspaceStateNotes, WorkspaceStateRecord } from "./types.ts";

/** Longest `question` written into a record; the field is a card line, not a report. */
const MAX_QUESTION_CHARS = 500;
/** Longest single `open_items` entry, and how many are kept. */
const MAX_OPEN_ITEM_CHARS = 300;
const MAX_OPEN_ITEMS = 20;

function bounded(value: string, limit: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit - 1)}…`;
}

function openItems(values: string[] | undefined): string[] | undefined {
	if (!Array.isArray(values)) return undefined;
	const items = values
		.filter((value) => typeof value === "string")
		.map((value) => bounded(value, MAX_OPEN_ITEM_CHARS))
		.filter((value) => value.length > 0)
		.slice(0, MAX_OPEN_ITEMS);
	return items.length > 0 ? items : undefined;
}

export interface BuildRecordInput {
	sessionId: string;
	sessionFile: string | undefined;
	cwd: string;
	host: string;
	ts: number;
	notes?: WorkspaceStateNotes;
	classification: Classification;
}

/**
 * Build one contract-v1 record.
 *
 * `question` is present **iff** `end_state` is `awaiting-human`: the contract makes that
 * an invariant, and a consumer that renders "awaiting: <question>" has no sensible way to
 * show a question attached to `complete`. `open_items` and `feads` are dropped when empty
 * rather than written as `[]` / `{}`, so the JSON of a plain completion stays small and a
 * consumer can use presence as the test.
 */
export function buildWorkspaceStateRecord(input: BuildRecordInput): WorkspaceStateRecord {
	const endState = input.classification.end_state;
	const rawQuestion = input.classification.question;
	const question =
		endState === "awaiting-human" && typeof rawQuestion === "string" && rawQuestion.trim().length > 0
			? bounded(rawQuestion, MAX_QUESTION_CHARS)
			: undefined;
	const items = openItems(input.notes?.open_items);
	const epic = typeof input.notes?.feads_epic === "string" ? input.notes.feads_epic.trim() : "";
	return {
		v: 1,
		session_id: input.sessionId,
		session_file: input.sessionFile ?? "",
		cwd: input.cwd,
		host: input.host,
		end_state: endState,
		...(question ? { question } : {}),
		...(items ? { open_items: items } : {}),
		...(epic.length > 0 ? { feads: { epic } } : {}),
		source: "classifier",
		ts: input.ts,
	};
}

export const __testing = { MAX_QUESTION_CHARS, MAX_OPEN_ITEM_CHARS, MAX_OPEN_ITEMS };
