/**
 * Theme-free formatting helpers for subagent displays.
 *
 * Everything here returns plain strings; callers apply theme colors so the
 * same formatting drives the live widget, the transcript renderer, and the
 * /subagents board.
 */

import * as os from "node:os";
import type { SubagentRunSnapshot, SubagentStatus, SubagentUsageTotals } from "./types.ts";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(now: number): string {
	return SPINNER_FRAMES[Math.floor(now / 120) % SPINNER_FRAMES.length];
}

/** Plain status glyph; running gets an animated spinner frame. */
export function statusGlyph(status: SubagentStatus, now: number): string {
	switch (status) {
		case "pending":
			return "◌";
		case "running":
			return spinnerFrame(now);
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "aborted":
			return "⊘";
	}
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatCost(cost: number): string {
	if (cost === 0) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

export function runElapsedMs(run: SubagentRunSnapshot, now: number): number {
	if (run.startedAt === undefined) return 0;
	return (run.endedAt ?? now) - run.startedAt;
}

/** Context usage as a percentage of the model's window, or undefined when unknown. */
export function contextPercent(run: SubagentRunSnapshot): number | undefined {
	if (!run.contextWindow || run.usage.contextTokens <= 0) return undefined;
	return Math.min(999, Math.round((run.usage.contextTokens / run.contextWindow) * 100));
}

/** Short model label for row displays: strips the provider, keeps a thinking suffix. */
export function shortModelLabel(model: string | undefined, thinkingLevel?: string): string | undefined {
	if (!model) return undefined;
	const slashIndex = model.indexOf("/");
	const base = slashIndex === -1 ? model : model.slice(slashIndex + 1);
	if (thinkingLevel && thinkingLevel !== "off") return `${base}:${thinkingLevel}`;
	return base;
}

function modelIdentifiersMatch(requested: string | undefined, served: string): boolean {
	if (!requested) return false;
	return requested === served || requested.endsWith(`/${served}`);
}

/** Safe, compact diagnostics for model routing and child recovery. */
export function subagentDiagnostics(run: SubagentRunSnapshot): string | undefined {
	const parts: string[] = [];
	if (run.servedModel && !modelIdentifiersMatch(run.model, run.servedModel)) parts.push(`served ${run.servedModel}`);

	const recovery = run.recovery;
	if (recovery?.retryCount) {
		parts.push(`retry ×${recovery.retryCount}${recovery.retryRecovered ? " recovered" : ""}`);
	}
	if (recovery && recovery.fallbackTransitions.length > 0) {
		const last = recovery.fallbackTransitions[recovery.fallbackTransitions.length - 1];
		parts.push(`fallback ${last.from} → ${last.to}`);
	}
	if (recovery?.fallbackRestored) parts.push("fallback restored");
	if (recovery?.fallbackExhausted) parts.push("fallback exhausted");
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function shortenHomePath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** One-line plain-text description of a tool call, e.g. `$ npm test` or `edit src/foo.ts`. */
export function describeToolCall(toolName: string, args: Record<string, unknown>): string {
	const pathArg = (): string => {
		const raw = (args.path ?? args.file_path ?? "") as string;
		return raw ? shortenHomePath(raw) : "…";
	};
	switch (toolName) {
		case "bash": {
			const command = ((args.command as string) || "…").replace(/\s+/g, " ").trim();
			return `$ ${truncateText(command, 80)}`;
		}
		case "read":
			return `read ${pathArg()}`;
		case "write":
			return `write ${pathArg()}`;
		case "edit":
			return `edit ${pathArg()}`;
		case "ls":
			return `ls ${shortenHomePath((args.path as string) || ".")}`;
		case "find":
			return `find ${(args.pattern as string) || "*"}`;
		case "grep":
			return `grep /${(args.pattern as string) || ""}/`;
		default: {
			let argsStr: string;
			try {
				argsStr = JSON.stringify(args);
			} catch {
				argsStr = "…";
			}
			return `${toolName} ${truncateText(argsStr, 60)}`;
		}
	}
}

/** Compact usage summary: `3t · 12 tools · ↑4.2k ↓12k · $0.14`. Parts with zero value are omitted. */
export function formatUsageSummary(usage: SubagentUsageTotals): string {
	const parts: string[] = [];
	if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.toolCalls > 0) parts.push(`${usage.toolCalls} tool${usage.toolCalls === 1 ? "" : "s"}`);
	if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost > 0) parts.push(formatCost(usage.cost));
	return parts.join(" · ");
}

export function aggregateUsage(runs: SubagentRunSnapshot[]): SubagentUsageTotals {
	const total: SubagentUsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
		toolCalls: 0,
	};
	for (const run of runs) {
		total.input += run.usage.input;
		total.output += run.usage.output;
		total.cacheRead += run.usage.cacheRead;
		total.cacheWrite += run.usage.cacheWrite;
		total.cost += run.usage.cost;
		total.contextTokens += run.usage.contextTokens;
		total.turns += run.usage.turns;
		total.toolCalls += run.usage.toolCalls;
	}
	return total;
}
