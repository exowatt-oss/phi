import { describe, expect, it } from "vitest";
import {
	buildBoardLines,
	renderAuditEntry,
	renderFooterText,
	renderIterationEntry,
} from "../src/extensions/loop/render.ts";
import type { LoopAuditRecord, LoopIterationRecord, LoopStateSnapshot } from "../src/extensions/loop/types.ts";
import { emptyUsageTotals } from "../src/extensions/loop/usage.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const now = Date.parse("2026-01-01T00:00:00.000Z");
function makeSnapshot(overrides: Partial<LoopStateSnapshot> = {}): LoopStateSnapshot {
	return {
		schemaVersion: 1,
		loopId: "l",
		iterationIndex: 4,
		revision: 1,
		phase: "running",
		config: {
			task: "Fix all failing tests",
			maxIterations: 12,
			checkCommand: "npm test",
			checkTimeoutMs: 1000,
			everyMs: 0,
			timeoutMs: 7200000,
			budgetUsd: 10,
			evaluatorConfidence: 0.85,
			cwd: ".",
			startedAt: new Date(now - 60_000).toISOString(),
		},
		cumulative: { ...emptyUsageTotals(), costUsd: 2.41 },
		startedAt: new Date(now - 60_000).toISOString(),
		updatedAt: new Date(now).toISOString(),
		...overrides,
	};
}
function makeRecord(overrides: Partial<LoopIterationRecord> = {}): LoopIterationRecord {
	return {
		schemaVersion: 1,
		loopId: "l",
		iterationId: "i",
		index: 4,
		startedAt: new Date(now - 180_000).toISOString(),
		endedAt: new Date(now).toISOString(),
		phaseOutcome: "continue",
		decisionPrecedence: "check",
		usage: { ...emptyUsageTotals(), costUsd: 0.62 },
		toolCalls: 6,
		toolErrors: 0,
		retries: 0,
		compactions: 0,
		controlCalls: [],
		protocolAnomalies: [],
		summary: "still working",
		nextStep: "rerun",
		...overrides,
	};
}
function plain(component: { render(width: number): string[] }): string {
	return component.render(120).map(stripAnsi).join("\n");
}

describe("loop render", () => {
	it("renders phase glyphs and active cost", () => {
		for (const phase of ["running", "verifying_check", "pacing"] as const)
			expect(renderFooterText(makeSnapshot({ phase }), now)).toContain("↻");
		expect(renderFooterText(makeSnapshot({ phase: "paused", pauseCause: "permission_required" }), now)).toContain(
			"⏸",
		);
		expect(renderFooterText(makeSnapshot({ phase: "terminal", terminalReason: "check_passed" }), now)).toContain("✓");
		expect(renderFooterText(makeSnapshot({ phase: "terminal", terminalReason: "iteration_limit" }), now)).toContain(
			"■",
		);
		expect(renderFooterText(makeSnapshot(), now)).toContain("4/12");
		expect(renderFooterText(makeSnapshot(), now)).toContain("$2.41");
	});
	it("keeps board width and phase details", async () => {
		initTheme("dark");
		const { theme } = await import("../src/modes/interactive/theme/theme.ts");
		for (const width of [40, 20])
			for (const phase of ["running", "pacing", "paused"] as const) {
				const lines = buildBoardLines({
					snapshot: makeSnapshot({ phase, pauseCause: "permission_required" }),
					records: [makeRecord()],
					countdownMs: 27_000,
					nowMs: now,
					width,
					theme,
				});
				expect(lines.length).toBeLessThanOrEqual(7);
				for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
				if (phase === "pacing") expect(lines.join(" ")).toContain("27s");
				if (phase === "paused") expect(lines.join(" ")).toContain("permission");
			}
	});
	it("renders iteration and audit cards", async () => {
		initTheme("dark");
		const { theme } = await import("../src/modes/interactive/theme/theme.ts");
		const record = makeRecord({
			check: {
				command: "npm test",
				cwd: ".",
				exitCode: 1,
				signal: null,
				timedOut: false,
				durationMs: 1,
				stdoutTail: "fail",
				stderrTail: "",
				truncated: false,
				verdict: "unsatisfied",
			},
			evaluator: {
				model: "m",
				usage: emptyUsageTotals(),
				costUsd: 0,
				verdict: { satisfied: false, confidence: 0.4, rationale: "no", missing: ["x"] },
			},
			protocolAnomalies: ["duplicate"],
		});
		expect(plain(renderIterationEntry(record, { expanded: false }, theme)!)).toContain("continue");
		expect(plain(renderIterationEntry(record, { expanded: false }, theme)!)).toContain("$0.62");
		expect(plain(renderIterationEntry(record, { expanded: false }, theme)!)).toContain("exit 1");
		expect(plain(renderIterationEntry(record, { expanded: true }, theme)!)).toContain("confidence");
		const audit: LoopAuditRecord = {
			schemaVersion: 1,
			loopId: "l",
			reason: "check_passed",
			iterations: 4,
			totals: { ...emptyUsageTotals(), costUsd: 3.08 },
			startedAt: new Date(now - 1000).toISOString(),
			endedAt: new Date(now).toISOString(),
			config: makeSnapshot().config,
			iterationTable: [],
		};
		expect(plain(renderAuditEntry(audit, { expanded: false }, theme)!)).toContain("4 iterations");
	});
});
