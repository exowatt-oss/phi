import {
	LOOP_DEFAULT_CHECK_TIMEOUT_MS,
	LOOP_DEFAULT_EVALUATOR_CONFIDENCE,
	LOOP_DEFAULT_MAX_ITERATIONS,
	LOOP_DEFAULT_TIMEOUT_MS,
	LOOP_MAX_ITERATIONS_CEILING,
	LOOP_MAX_WALL_TIME_MS_CEILING,
	type LoopConfig,
} from "./types.ts";

export type LoopSubcommand = "dashboard" | "status" | "pause" | "resume" | "stop" | "verify";
export type LoopParseResult =
	| { readonly kind: "dashboard" }
	| { readonly kind: "status" | "pause" | "resume" | "stop" | "verify" }
	| { readonly kind: "start"; readonly config: LoopConfig }
	| { readonly kind: "error"; readonly message: string };

interface Token {
	readonly value: string;
	readonly start: number;
	readonly end: number;
}

function tokenize(input: string): { tokens: Token[]; error?: string } {
	const tokens: Token[] = [];
	let i = 0;
	while (i < input.length) {
		while (/\s/.test(input[i] ?? "")) i++;
		if (i >= input.length) break;
		const start = i;
		let value = "";
		let quote = "";
		while (i < input.length) {
			const char = input[i];
			if (quote) {
				if (char === quote) {
					quote = "";
					i++;
				} else if (quote === '"' && char === "\\") {
					i++;
					if (i >= input.length) return { tokens, error: `unterminated escape near position ${i}` };
					value += input[i++];
				} else {
					value += char;
					i++;
				}
			} else if (char === "'" || char === '"') {
				quote = char;
				i++;
			} else if (char === "\\") {
				i++;
				if (i >= input.length) return { tokens, error: `unterminated escape near position ${i}` };
				value += input[i++];
			} else if (/\s/.test(char)) {
				break;
			} else {
				value += char;
				i++;
			}
		}
		if (quote) return { tokens, error: `unterminated quote near token '${input.slice(start)}'` };
		tokens.push({ value, start, end: i });
	}
	return { tokens };
}

function duration(token: string, option: string): number | string {
	if (!/^\d+(s|m|h)$/.test(token))
		return `${option} requires an integer duration such as 10s, 5m, or 2h; got '${token}'`;
	const amount = Number.parseInt(token.slice(0, -1), 10);
	const unit = token.at(-1);
	const multiplier = unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
	return amount * multiplier;
}

function duplicate(seen: Set<string>, option: string): string | undefined {
	if (seen.has(option)) return `duplicate option '${option}'`;
	seen.add(option);
	return undefined;
}

/** cwd and startedAt are intentionally empty placeholders; the controller fills them in. */
export function parseLoopCommand(
	args: string,
	defaults: {
		maxIterations: number;
		timeoutMs: number;
		checkTimeoutMs: number;
		evaluatorConfidence: number;
	},
): LoopParseResult {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "dashboard" };
	const first = tokenize(trimmed);
	if (first.error) return { kind: "error", message: first.error };
	if (first.tokens.length === 1 && ["status", "pause", "resume", "stop", "verify"].includes(first.tokens[0].value)) {
		return { kind: first.tokens[0].value as LoopSubcommand };
	}

	const parsed = tokenize(args);
	if (parsed.error) return { kind: "error", message: parsed.error };
	const tokens = parsed.tokens;
	const values: Record<string, string> = {};
	const seen = new Set<string>();
	let taskStart: number | undefined;
	let i = 0;
	if (/^\d+(s|m|h)$/.test(tokens[0]?.value ?? "")) {
		values["--every"] = tokens[0].value;
		seen.add("--every");
		i = 1;
		if (i === tokens.length) return { kind: "error", message: "task is required and cannot be empty" };
	}
	while (i < tokens.length) {
		const token = tokens[i];
		if (token.value === "--") {
			taskStart = token.end;
			break;
		}
		if (!token.value.startsWith("-")) {
			taskStart = token.start;
			break;
		}
		const option = token.value;
		const duplicateError = duplicate(seen, option);
		if (duplicateError) return { kind: "error", message: duplicateError };
		const known = new Set([
			"--max",
			"--until",
			"--check",
			"--check-timeout",
			"--every",
			"--timeout",
			"--budget",
			"--model",
			"--evaluator",
		]);
		if (!known.has(option)) return { kind: "error", message: `unknown option '${option}'` };
		const valueToken = tokens[i + 1];
		const valueWasQuoted = valueToken && ["'", '"'].includes(args[valueToken.start] ?? "");
		if (
			!valueToken ||
			valueToken.value === "--" ||
			(valueToken.value.startsWith("--") && !valueWasQuoted) ||
			(i + 1 === tokens.length - 1 &&
				["--max", "--every", "--timeout", "--check-timeout", "--budget"].includes(option))
		) {
			return { kind: "error", message: `missing value for option '${option}'` };
		}
		values[option] = valueToken.value;
		i += 2;
	}
	const task = taskStart === undefined ? "" : args.slice(taskStart).trim();
	if (!task || !task.trim()) return { kind: "error", message: "task is required and cannot be empty" };

	const maxIterations = values["--max"] === undefined ? defaults.maxIterations : Number(values["--max"]);
	if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > LOOP_MAX_ITERATIONS_CEILING) {
		return {
			kind: "error",
			message: `--max must be an integer from 1 to ${LOOP_MAX_ITERATIONS_CEILING}; got '${values["--max"]}'`,
		};
	}
	const timeoutMsValue =
		values["--timeout"] === undefined ? defaults.timeoutMs : duration(values["--timeout"], "--timeout");
	if (typeof timeoutMsValue === "string") return { kind: "error", message: timeoutMsValue };
	if (timeoutMsValue > LOOP_MAX_WALL_TIME_MS_CEILING)
		return { kind: "error", message: `--timeout cannot exceed 24h; got '${values["--timeout"]}'` };
	const checkTimeoutMsValue =
		values["--check-timeout"] === undefined
			? defaults.checkTimeoutMs
			: duration(values["--check-timeout"], "--check-timeout");
	if (typeof checkTimeoutMsValue === "string") return { kind: "error", message: checkTimeoutMsValue };
	if (checkTimeoutMsValue > timeoutMsValue)
		return { kind: "error", message: "--check-timeout cannot exceed --timeout" };
	const everyMsValue = values["--every"] === undefined ? 0 : duration(values["--every"], "--every");
	if (typeof everyMsValue === "string") return { kind: "error", message: everyMsValue };
	if (everyMsValue > timeoutMsValue) return { kind: "error", message: "--every cannot exceed --timeout" };
	const budget = values["--budget"] === undefined ? undefined : Number(values["--budget"].replace(/^\$/, ""));
	if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0))
		return {
			kind: "error",
			message: `--budget must be a finite number greater than 0; got '${values["--budget"]}'`,
		};
	for (const option of ["--model", "--evaluator"] as const) {
		const value = values[option];
		if (value !== undefined && !/^[^/]+\/[^/:]+(?::[^/]+)?$/.test(value)) {
			return { kind: "error", message: `${option} must be in provider/model format; got '${value}'` };
		}
	}
	if (
		![maxIterations, timeoutMsValue, checkTimeoutMsValue, everyMsValue, budget].every(
			(value) => value === undefined || Number.isFinite(value),
		)
	)
		return { kind: "error", message: "numeric option value must be finite" };

	return {
		kind: "start",
		config: {
			task,
			maxIterations,
			untilCondition: values["--until"],
			checkCommand: values["--check"],
			checkTimeoutMs: checkTimeoutMsValue,
			everyMs: everyMsValue,
			timeoutMs: timeoutMsValue,
			budgetUsd: budget,
			workerModel: values["--model"],
			evaluatorModel: values["--evaluator"],
			evaluatorConfidence: defaults.evaluatorConfidence,
			cwd: "",
			startedAt: "",
		},
	};
}

export function formatResolvedConfig(config: LoopConfig): string {
	return [
		`task: ${config.task}`,
		`max iterations: ${config.maxIterations}`,
		`timeout: ${config.timeoutMs}ms`,
		`budget: ${config.budgetUsd === undefined ? "unlimited" : `$${config.budgetUsd}`}`,
		`check timeout: ${config.checkTimeoutMs}ms`,
		`every: ${config.everyMs}ms`,
		`evaluator confidence: ${config.evaluatorConfidence}`,
		`until: ${config.untilCondition ?? "(none)"}`,
		`check: ${config.checkCommand ?? "(none)"}`,
		`model: ${config.workerModel ?? "(default)"}`,
		`evaluator: ${config.evaluatorModel ?? "(default)"}`,
		`cwd: ${config.cwd}`,
		`started at: ${config.startedAt}`,
	].join("\n");
}

export const DEFAULT_LOOP_CONFIG = {
	maxIterations: LOOP_DEFAULT_MAX_ITERATIONS,
	timeoutMs: LOOP_DEFAULT_TIMEOUT_MS,
	checkTimeoutMs: LOOP_DEFAULT_CHECK_TIMEOUT_MS,
	evaluatorConfidence: LOOP_DEFAULT_EVALUATOR_CONFIDENCE,
} as const;
