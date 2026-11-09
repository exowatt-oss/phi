import { isTuiMode } from "./tui-mode.ts";

/**
 * Feature flag for the context-aware compaction ladder (late-applied background summary,
 * `context-budget` budget line, `checkpoint` tool, pinned constraints, summarizer default).
 *
 * `PI_CONTEXT_BUDGET` decides when it is set:
 * - truthy (`1`, `true`, `on`, `yes`) enables the ladder in any mode, so an embedding chat UI
 *   (P3 Code over RPC) can opt in without `PI_TUI_MODE`, which also changes terminal-only
 *   tool descriptions and rendering;
 * - `off`, `0`, or `false` disables it, including in TUI mode.
 *
 * Unset, the ladder follows `PI_TUI_MODE=1` (see tui-mode.ts), so embedders that set neither
 * flag keep today's behavior byte-for-byte. Read per call so tests can flip the environment.
 */
export const CONTEXT_BUDGET_ENV = "PI_CONTEXT_BUDGET";

const ENABLED_VALUES = new Set(["1", "true", "on", "yes"]);
const DISABLED_VALUES = new Set(["0", "false", "off"]);

export function contextAwareCompactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[CONTEXT_BUDGET_ENV]?.trim().toLowerCase();
	if (raw !== undefined && DISABLED_VALUES.has(raw)) return false;
	if (raw !== undefined && ENABLED_VALUES.has(raw)) return true;
	return isTuiMode(env);
}

/**
 * `PI_COMPACTION_SOFT_CEILING_TOKENS` — host default for `compaction.softCeilingTokens`.
 *
 * Lets an embedder (P3 Code) pick the soft ceiling for the sessions it launches without editing the
 * user's settings. Precedence: a model's `compaction.softCeilingTokens` in models.json, then the
 * settings value, then this variable, then the built-in 300k. A non-negative integer; `0` uses the
 * raw window. Anything else is ignored.
 */
export const SOFT_CEILING_ENV = "PI_COMPACTION_SOFT_CEILING_TOKENS";

export function softCeilingTokensFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env[SOFT_CEILING_ENV]?.trim();
	if (!raw || !/^\d+$/.test(raw)) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : undefined;
}
