/**
 * Subagent model policy: pin which models the `subagent` tool may launch and
 * which model a task gets when it names none.
 *
 * Sources, per key (env wins; an empty env string means "unset" for that key):
 * - default: `PHI_SUBAGENT_MODEL_DEFAULT` ?? `subagents.models.default`
 * - allow:   `PHI_SUBAGENT_MODEL_ALLOW` (comma-separated) ?? `subagents.models.allow`
 *
 * Pattern grammar: `provider/id` (any thinking level, including none),
 * `provider/id:level`, `provider/id:l1|l2`; `*` globs inside the provider or
 * the id (`gateway/*`, `anthropic/claude-opus-*:high|xhigh`). A pattern with
 * no `/` matches the id under any provider. Provider and id compare
 * case-insensitively, the level exactly.
 *
 * The extension resolves each task's model to its canonical
 * `provider/id[:level]` with the same resolver the runner uses, then checks
 * every task against the allowlist before anything spawns. The resolved policy
 * is also exported in the children's env, but subagent children have no
 * `subagent` tool (the extension stays off under `PI_SUBAGENT_ID`), so there
 * are no nested subagent calls to bind; the export only keeps the policy
 * visible to anything a child starts.
 */

import { isValidThinkingLevel } from "../../cli/args.ts";
import type { SubagentsSettings } from "../../core/settings-manager.ts";

export const SUBAGENT_MODEL_DEFAULT_ENV = "PHI_SUBAGENT_MODEL_DEFAULT";
export const SUBAGENT_MODEL_ALLOW_ENV = "PHI_SUBAGENT_MODEL_ALLOW";

export interface SubagentModelPolicy {
	/** Model for tasks whose input and agent definition name none. */
	default?: string;
	/** Allowed model patterns. Empty = no allowlist. */
	allow: string[];
}

export interface ModelPattern {
	raw: string;
	provider: RegExp;
	id: RegExp;
	/** Allowed thinking levels; undefined = any level, including none. */
	levels?: ReadonlySet<string>;
}

/** Where a task's effective model came from. */
export type SubagentModelSource = "task" | "agent" | "default" | "inherited";

export interface ResolvedTaskModel {
	name: string;
	/** Canonical `provider/id`, or undefined when nothing could be resolved. */
	model?: string;
	thinkingLevel?: string;
	source?: SubagentModelSource;
}

function splitList(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

/** Resolve the effective policy from settings and env (env wins per key; empty env = unset). */
export function resolveSubagentModelPolicy(
	settings: SubagentsSettings | undefined,
	env: NodeJS.ProcessEnv = process.env,
): SubagentModelPolicy {
	const models = settings?.models;
	const envDefault = env[SUBAGENT_MODEL_DEFAULT_ENV]?.trim();
	const envAllow = env[SUBAGENT_MODEL_ALLOW_ENV]?.trim();
	const settingsDefault = typeof models?.default === "string" ? models.default.trim() : "";
	const settingsAllow = Array.isArray(models?.allow)
		? models.allow.filter((p): p is string => typeof p === "string").flatMap(splitList)
		: [];
	const defaultModel = envDefault || settingsDefault || undefined;
	const allow = envAllow ? splitList(envAllow) : settingsAllow;
	return { default: defaultModel, allow };
}

export function isPolicyActive(policy: SubagentModelPolicy): boolean {
	return policy.default !== undefined || policy.allow.length > 0;
}

function globToRegExp(glob: string): RegExp {
	const source = glob
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i");
}

/** Parse one allowlist pattern. Returns undefined for an empty pattern. */
export function parseModelPattern(raw: string): ModelPattern | undefined {
	let text = raw.trim();
	if (!text) return undefined;
	let levels: Set<string> | undefined;
	// A trailing `:l1|l2` is a level list only when every part is a thinking level
	// (model ids may themselves contain `:`), mirroring the runner's strict suffix rule.
	const colon = text.lastIndexOf(":");
	if (colon > text.lastIndexOf("/")) {
		const parts = text.substring(colon + 1).split("|");
		if (parts.length > 0 && parts.every((part) => isValidThinkingLevel(part))) {
			levels = new Set(parts);
			text = text.substring(0, colon);
		}
	}
	const slash = text.indexOf("/");
	const provider = slash === -1 ? "*" : text.substring(0, slash);
	const id = slash === -1 ? text : text.substring(slash + 1);
	return { raw: raw.trim(), provider: globToRegExp(provider || "*"), id: globToRegExp(id || "*"), levels };
}

/** Whether a canonical `provider/id` + optional level matches a pattern. */
export function matchesModelPattern(pattern: ModelPattern, model: string, thinkingLevel?: string): boolean {
	const slash = model.indexOf("/");
	if (slash === -1) return false;
	const provider = model.substring(0, slash);
	const id = model.substring(slash + 1);
	if (!pattern.provider.test(provider) || !pattern.id.test(id)) return false;
	if (!pattern.levels) return true;
	return thinkingLevel !== undefined && pattern.levels.has(thinkingLevel);
}

export function isModelAllowed(policy: SubagentModelPolicy, model: string, thinkingLevel?: string): boolean {
	if (policy.allow.length === 0) return true;
	return policy.allow.some((raw) => {
		const pattern = parseModelPattern(raw);
		return pattern ? matchesModelPattern(pattern, model, thinkingLevel) : false;
	});
}

/** One line for the tool description when a policy is set; undefined otherwise. */
export function describeModelPolicy(policy: SubagentModelPolicy): string | undefined {
	if (!isPolicyActive(policy)) return undefined;
	const parts: string[] = [];
	if (policy.allow.length > 0) parts.push(`allowed ${policy.allow.join(", ")}`);
	if (policy.default) parts.push(`default ${policy.default}`);
	const line = `Subagent models are pinned: ${parts.join("; ")}.`;
	return policy.allow.length > 0 ? `${line} Tasks with any other model are refused.` : line;
}

function sourceLabel(source: SubagentModelSource | undefined): string {
	switch (source) {
		case "task":
			return "task model";
		case "agent":
			return "agent definition";
		case "default":
			return "pinned default";
		case "inherited":
			return "inherited from this session";
		default:
			return "no model resolved";
	}
}

/**
 * Check every task against the allowlist. Returns the refusal message when any
 * task's effective model is not allowed, undefined when the call may launch.
 */
export function checkModelPolicy(policy: SubagentModelPolicy, tasks: readonly ResolvedTaskModel[]): string | undefined {
	if (policy.allow.length === 0) return undefined;
	const offending = tasks.filter((task) => !task.model || !isModelAllowed(policy, task.model, task.thinkingLevel));
	if (offending.length === 0) return undefined;
	const list = offending
		.map((task) => {
			const model = task.model ? `${task.model}${task.thinkingLevel ? `:${task.thinkingLevel}` : ""}` : "(none)";
			return `${task.name} → ${model} (${sourceLabel(task.source)})`;
		})
		.join("; ");
	const inherited = offending.some((task) => task.source === "inherited" || !task.source);
	const hint = policy.default
		? `Set "model" on those tasks to an allowed model; tasks that name no model (directly or through their agent) get the default ${policy.default}.`
		: inherited
			? `No default is configured, so tasks without "model" inherit this session's model. Set "model" on every task to an allowed model, or configure subagents.models.default / ${SUBAGENT_MODEL_DEFAULT_ENV}.`
			: `Set "model" to an allowed model.`;
	return [
		`Subagent call refused by the subagent model policy; nothing was launched.`,
		`Not allowed: ${list}.`,
		`Allowed: ${policy.allow.join(", ")}. Default: ${policy.default ?? "none"}.`,
		hint,
	].join(" ");
}

/** Env that carries the resolved policy to a phi process started with it (e.g. an overseer thread); subagent children cannot call subagent. */
export function modelPolicyEnv(policy: SubagentModelPolicy): Record<string, string> {
	const env: Record<string, string> = {};
	if (policy.default) env[SUBAGENT_MODEL_DEFAULT_ENV] = policy.default;
	if (policy.allow.length > 0) env[SUBAGENT_MODEL_ALLOW_ENV] = policy.allow.join(",");
	return env;
}
