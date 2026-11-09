import type { SideQuestionFn } from "./evaluator.ts";
import { LOOP_MAX_ITERATIONS_CEILING, LOOP_MAX_WALL_TIME_MS_CEILING } from "./types.ts";

export interface InterpretedLoop {
	task: string;
	everyMs?: number;
	maxIterations?: number;
	timeoutMs?: number;
	untilCondition?: string;
	checkCommand?: string;
	rationale: string;
}

type Candidate = Record<string, unknown>;

function firstJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return text.slice(start, i + 1);
	}
	return undefined;
}

function number(value: unknown, name: string): number | string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		return `"${name}" must be a positive finite number`;
	return value;
}

function parseAnswer(answer: string): InterpretedLoop | { error: string } {
	const object = firstJsonObject(answer);
	if (!object) return { error: "response did not contain a complete JSON object" };
	let value: unknown;
	try {
		value = JSON.parse(object);
	} catch (error) {
		return { error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return { error: "JSON value must be an object" };
	const candidate = value as Candidate;
	if (typeof candidate.task !== "string" || !candidate.task.trim())
		return { error: '"task" must be a non-empty string' };
	if (typeof candidate.rationale !== "string" || !candidate.rationale.trim())
		return { error: '"rationale" must be a non-empty string' };
	const everySeconds = number(candidate.everySeconds, "everySeconds");
	const maxIterations = number(candidate.maxIterations, "maxIterations");
	const timeoutMinutes = number(candidate.timeoutMinutes, "timeoutMinutes");
	if (typeof everySeconds === "string") return { error: everySeconds };
	if (typeof maxIterations === "string") return { error: maxIterations };
	if (typeof timeoutMinutes === "string") return { error: timeoutMinutes };
	if (maxIterations !== undefined && !Number.isInteger(maxIterations))
		return { error: '"maxIterations" must be an integer' };
	for (const key of ["until", "check"] as const) {
		if (candidate[key] !== undefined && (typeof candidate[key] !== "string" || !candidate[key].trim()))
			return { error: `"${key}" must be a non-empty string` };
	}
	const result: InterpretedLoop = { task: candidate.task.trim(), rationale: candidate.rationale.trim() };
	if (everySeconds !== undefined) result.everyMs = Math.min(everySeconds * 1000, LOOP_MAX_WALL_TIME_MS_CEILING);
	if (maxIterations !== undefined) result.maxIterations = Math.min(maxIterations, LOOP_MAX_ITERATIONS_CEILING);
	if (timeoutMinutes !== undefined)
		result.timeoutMs = Math.min(timeoutMinutes * 60_000, LOOP_MAX_WALL_TIME_MS_CEILING);
	if (candidate.until !== undefined) result.untilCondition = candidate.until as string;
	if (candidate.check !== undefined) result.checkCommand = candidate.check as string;
	return result;
}

const systemPrompt = `You are a command interpreter for /loop. Given the user's freeform request, extract the underlying repeated task and any schedule or limits they imply. Answer ONLY strict JSON shaped exactly as {"task": string, "everySeconds"?: number, "maxIterations"?: number, "timeoutMinutes"?: number, "until"?: string, "check"?: string, "rationale": string}. Do not invent limits the user did not imply: omit them so defaults apply. Never invent a check command. Do not include a budget unless the user explicitly mentions one (and this schema has no budget field).`;

export async function interpretLoopRequest(options: {
	raw: string;
	sideQuestion: SideQuestionFn;
	model?: string;
	signal?: AbortSignal;
}): Promise<InterpretedLoop | { error: string }> {
	let retry = "";
	let lastError = "interpreter failed";
	for (let attempt = 0; attempt < 2; attempt++) {
		if (options.signal?.aborted) return { error: "interpreter aborted" };
		try {
			const result = await options.sideQuestion({
				messages: [{ role: "user", content: `${options.raw}${retry}`, timestamp: Date.now() }],
				systemPrompt,
				model: options.model,
				signal: options.signal,
			});
			const parsed = parseAnswer(result.answer);
			if (!("error" in parsed)) return parsed;
			lastError = parsed.error;
			retry = "\n\nYour previous answer was invalid. Return only the required strict JSON object.";
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	return { error: lastError };
}
