import { describe, expect, it } from "vitest";
import { buildStatusText, stallNoteText } from "../src/extensions/subagents/index.ts";
import { executeRun, newUsage, runOutputForModel } from "../src/extensions/subagents/runner.ts";
import { newUsageTotals, type SubagentRunSnapshot } from "../src/extensions/subagents/types.ts";
import {
	budgetKillMessage,
	DEFAULT_WATCHDOG_CONFIG,
	evaluateWatchdog,
	hardCapKillMessage,
	MIN_SPAWN_GRACE_MS,
	resolveWatchdogConfig,
	type SubagentWatchdogConfig,
	stallKillMessage,
	toolRunawayKillMessage,
	type WatchdogVerdict,
} from "../src/extensions/subagents/watchdog.ts";

function makeRun(overrides: Partial<SubagentRunSnapshot> = {}): SubagentRunSnapshot {
	return {
		id: "run-1",
		name: "run-1",
		agentSource: "none",
		task: "do the thing",
		status: "pending",
		usage: newUsageTotals(),
		timeline: [],
		timelineDropped: 0,
		finalText: "",
		...overrides,
	};
}

const tinyConfig: SubagentWatchdogConfig = {
	enabled: true,
	streamSoftMs: 100,
	streamHardMs: 200,
	toolSoftMs: 400,
	toolHardMs: 800,
	maxRuntimeMs: 0,
	checkIntervalMs: 10,
	budgetRecheckMs: 150,
	spawnGraceMs: 0,
};
const base = { startedAt: 0, inTool: false, alreadyStalled: false, firstParsedEventAt: 1 };

describe("resolveWatchdogConfig", () => {
	it("returns defaults for empty settings", () => {
		expect(resolveWatchdogConfig(undefined)).toEqual(DEFAULT_WATCHDOG_CONFIG);
		expect(resolveWatchdogConfig({})).toEqual(DEFAULT_WATCHDOG_CONFIG);
	});

	it("converts minutes and keeps tool hard >= soft", () => {
		const config = resolveWatchdogConfig({
			stallSoftMinutes: 10,
			stallHardMinutes: 2,
			toolStallSoftMinutes: 30,
			toolStallHardMinutes: 90,
			maxRunMinutes: 45,
		});
		expect(config.streamSoftMs).toBe(10 * 60_000);
		expect(config.streamHardMs).toBe(Math.max(10 * 60_000, DEFAULT_WATCHDOG_CONFIG.streamHardMs));
		expect(config.toolSoftMs).toBe(30 * 60_000);
		expect(config.toolHardMs).toBe(90 * 60_000);
		expect(config.maxRuntimeMs).toBe(45 * 60_000);
		expect(config.spawnGraceMs).toBe(Math.max(config.streamHardMs, MIN_SPAWN_GRACE_MS));
	});

	it("floors stream hard at three times the provider stream guard", () => {
		expect(resolveWatchdogConfig({}, 600_000).streamHardMs).toBe(30 * 60_000);
	});

	it("downgrades stream-side hard kills when the provider guard is disabled", () => {
		const config = resolveWatchdogConfig({}, 0);
		expect(config.streamHardMs).toBe(0);
		expect(config.spawnGraceMs).toBe(MIN_SPAWN_GRACE_MS);
	});

	it("defaults the per-tool ceiling to 90m and the absolute run ceiling to 360m", () => {
		const config = resolveWatchdogConfig({});
		expect(config.toolMaxMs).toBe(90 * 60_000);
		expect(config.maxHardRuntimeMs).toBe(360 * 60_000);
	});

	it("converts toolMaxMinutes/maxHardRunMinutes, floors them at the idle thresholds, and lets 0 disable", () => {
		expect(resolveWatchdogConfig({ toolMaxMinutes: 30, maxHardRunMinutes: 200 })).toMatchObject({
			toolMaxMs: 60 * 60_000, // floored at toolStallHardMinutes (60)
			maxHardRuntimeMs: 200 * 60_000,
		});
		expect(resolveWatchdogConfig({ maxRunMinutes: 500 }).maxHardRuntimeMs).toBe(500 * 60_000);
		expect(resolveWatchdogConfig({ toolMaxMinutes: 0, maxHardRunMinutes: 0 })).toMatchObject({
			toolMaxMs: 0,
			maxHardRuntimeMs: 0,
		});
	});

	it("supports disabling the watchdog and the default budget", () => {
		const config = resolveWatchdogConfig({ watchdogEnabled: false, maxRunMinutes: 0 });
		expect(config.enabled).toBe(false);
		expect(config.maxRuntimeMs).toBe(0);
	});
});

describe("evaluateWatchdog policy", () => {
	it("is ok while semantic events are fresh", () => {
		expect(evaluateWatchdog(tinyConfig, { ...base, lastEventAt: 950 }, 1_000)).toEqual({ kind: "ok" });
	});

	it("soft-stalls after the stream threshold, only once", () => {
		expect(evaluateWatchdog(tinyConfig, { ...base, lastEventAt: 850 }, 1_000)).toEqual({
			kind: "soft-stall",
			idleMs: 150,
			inTool: false,
		});
		expect(evaluateWatchdog(tinyConfig, { ...base, lastEventAt: 850, alreadyStalled: true }, 1_000)).toEqual({
			kind: "ok",
		});
	});

	it("does not kill a healthy producing tool run after 70 minutes", () => {
		const seventyMinutes = 70 * 60_000;
		expect(
			evaluateWatchdog(
				{ ...tinyConfig, toolSoftMs: 20 * 60_000, toolHardMs: 60 * 60_000 },
				{ ...base, inTool: true, lastEventAt: seventyMinutes - 1 },
				seventyMinutes,
			),
		).toEqual({ kind: "ok" });
	});

	it("uses lenient thresholds while a tool execution is outstanding", () => {
		expect(evaluateWatchdog(tinyConfig, { ...base, inTool: true, lastEventAt: 700 }, 1_000)).toEqual({ kind: "ok" });
		expect(evaluateWatchdog(tinyConfig, { ...base, inTool: true, lastEventAt: 400 }, 1_000)).toEqual({
			kind: "soft-stall",
			idleMs: 600,
			inTool: true,
		});
		expect(evaluateWatchdog(tinyConfig, { ...base, inTool: true, lastEventAt: 100 }, 1_000)).toEqual({
			kind: "stall-kill",
			idleMs: 900,
			inTool: true,
		});
	});

	it("does not judge a child before spawn grace without a parsed event", () => {
		const config = { ...tinyConfig, spawnGraceMs: 500 };
		expect(evaluateWatchdog(config, { startedAt: 0, inTool: false, alreadyStalled: false }, 499)).toEqual({
			kind: "ok",
		});
		expect(evaluateWatchdog(config, { startedAt: 0, inTool: false, alreadyStalled: false }, 500)).toEqual({
			kind: "stall-kill",
			idleMs: 500,
			inTool: false,
		});
	});

	it("treats missing toolCallId as an in-tool, lenient state", () => {
		expect(evaluateWatchdog(tinyConfig, { ...base, inTool: true, lastEventAt: 700 }, 1_000)).toEqual({ kind: "ok" });
	});

	it("does not turn a producing child past the default budget into a kill", () => {
		const verdict = evaluateWatchdog(tinyConfig, { ...base, lastEventAt: 999, maxRuntimeMs: 1_000 }, 1_001);
		expect(verdict).toEqual({ kind: "over-budget", elapsedMs: 1_001, budgetMs: 1_000 });
	});

	it("kills an idle child past the default budget with an over-budget-and-idle verdict", () => {
		expect(evaluateWatchdog(tinyConfig, { ...base, lastEventAt: 700, maxRuntimeMs: 1_000 }, 1_001)).toEqual({
			kind: "budget-kill",
			elapsedMs: 1_001,
			budgetMs: 1_000,
			idleMs: 301,
			inTool: false,
			explicit: false,
		});
	});

	it("keeps checking an over-budget producing child at the 15-minute interval", () => {
		const state = { ...base, lastEventAt: 2_000, maxRuntimeMs: 1_000, overBudget: true, budgetLastCheckedAt: 1_001 };
		expect(evaluateWatchdog({ ...tinyConfig, budgetRecheckMs: 500 }, state, 1_200)).toEqual({ kind: "ok" });
		expect(evaluateWatchdog({ ...tinyConfig, budgetRecheckMs: 500 }, state, 1_501)).toEqual({
			kind: "over-budget",
			elapsedMs: 1_501,
			budgetMs: 1_000,
		});
	});

	it("treats explicit timeoutSeconds as a hard cap even when watchdog kills are disabled", () => {
		const disabled = { ...tinyConfig, enabled: false };
		expect(
			evaluateWatchdog(
				disabled,
				{ ...base, lastEventAt: 999, maxRuntimeMs: 1_000, explicitMaxRuntimeMs: true },
				1_001,
			),
		).toEqual({
			kind: "budget-kill",
			elapsedMs: 1_001,
			budgetMs: 1_000,
			idleMs: 2,
			inTool: false,
			explicit: true,
		});
	});

	it("disables the default budget when watchdogEnabled is false", () => {
		expect(evaluateWatchdog({ ...tinyConfig, enabled: false }, { ...base, maxRuntimeMs: 1_000 }, 2_000)).toEqual({
			kind: "ok",
		});
	});

	it("kills a tool call outstanding past toolMaxMs even while its update events keep arriving", () => {
		const config = { ...tinyConfig, toolSoftMs: 10_000, toolHardMs: 20_000, toolMaxMs: 500 };
		const streaming = { ...base, inTool: true, lastEventAt: 999, oldestToolStartedAt: 400 };
		expect(evaluateWatchdog(config, streaming, 899)).toEqual({ kind: "ok" });
		expect(evaluateWatchdog(config, streaming, 900)).toEqual({
			kind: "tool-runaway",
			toolMs: 500,
			toolMaxMs: 500,
			elapsedMs: 900,
		});
		expect(evaluateWatchdog({ ...config, toolMaxMs: 0 }, streaming, 5_000)).toEqual({ kind: "ok" });
		expect(evaluateWatchdog({ ...config, enabled: false }, streaming, 5_000)).toEqual({ kind: "ok" });
	});

	it("kills a producing run at the absolute ceiling unless an explicit timeout replaces it", () => {
		const config = { ...tinyConfig, maxRuntimeMs: 100, maxHardRuntimeMs: 1_000 };
		const producing = { ...base, lastEventAt: 1_499 };
		expect(evaluateWatchdog(config, producing, 1_500)).toEqual({
			kind: "hard-cap-kill",
			elapsedMs: 1_500,
			capMs: 1_000,
			inTool: false,
		});
		// Explicit timeoutSeconds (here 0 = deliberately uncapped) wins over the default ceiling.
		expect(evaluateWatchdog(config, { ...producing, maxRuntimeMs: 0, explicitMaxRuntimeMs: true }, 1_500)).toEqual({
			kind: "ok",
		});
		expect(evaluateWatchdog({ ...config, maxHardRuntimeMs: 0 }, producing, 1_500).kind).toBe("over-budget");
	});

	it("allows only a soft stream flag when the stream guard is off", () => {
		expect(evaluateWatchdog({ ...tinyConfig, streamHardMs: 0 }, { ...base, lastEventAt: 700 }, 1_000)).toEqual({
			kind: "soft-stall",
			idleMs: 300,
			inTool: false,
		});
	});
});

describe("watchdog messages", () => {
	it("mentions parsed events, safe relaunch, and file edits", () => {
		expect(stallKillMessage(16 * 60_000, false, undefined)).toMatch(/no parsed child events for 16m/);
		expect(stallKillMessage(60_000, false, undefined)).toMatch(/File edits stay in the working tree/);
	});

	it("names the runaway tool, its duration, and that edits stay in the tree", () => {
		const text = toolRunawayKillMessage("bash: $ createdb -h localhost dbname", 92 * 60_000, 90 * 60_000);
		expect(text).toMatch(/"bash: \$ createdb -h localhost dbname" had been running for 92m/);
		expect(text).toMatch(/limit 90m, subagents\.toolMaxMinutes/);
		expect(text).toMatch(/File edits stay in the working tree/);
		expect(hardCapKillMessage(361 * 60_000, 360 * 60_000)).toMatch(/360m absolute run ceiling.*ran 361m/);
	});

	it("names over-budget-and-idle and explicit timeout kills", () => {
		expect(budgetKillMessage(125 * 60_000, 120 * 60_000, 6 * 60_000, false)).toMatch(/over budget AND idle/);
		expect(budgetKillMessage(5_000, 5_000, 0, false, true)).toMatch(/explicit timeoutSeconds hard cap/);
	});

	it("covers TUI notice text for over-budget and kill verdicts", () => {
		expect(stallNoteText("t03-ci", { kind: "over-budget", elapsedMs: 1, budgetMs: 7_200_000 })).toMatch(
			/still producing.*only/,
		);
		expect(
			stallNoteText("t03-ci", {
				kind: "budget-kill",
				elapsedMs: 1,
				budgetMs: 7_200_000,
				idleMs: 1,
				inTool: false,
				explicit: false,
			}),
		).toMatch(/over budget and idle/);
	});
});

describe("buildStatusText", () => {
	it("reports liveness, over-budget state, and kill provenance", () => {
		const now = 1_000_000;
		const runs = [
			makeRun({
				name: "ws-a",
				status: "running",
				startedAt: now - 120_000,
				lastEventAt: now - 90_000,
				stalled: true,
				activity: "stalled — no parsed events for 1.5m",
				model: "gateway/example-medium",
				modelLabel: "example-medium:max",
			}),
			makeRun({
				name: "ws-b",
				status: "failed",
				startedAt: now - 300_000,
				endedAt: now - 60_000,
				killedBy: "budget",
			}),
		];
		const text = buildStatusText(runs, now);
		expect(text).toMatch(/Subagents \(1 active of 2\)/);
		expect(text).toMatch(/ws-a \[running, STALLED\]/);
		expect(text).toMatch(/idle 1m30s/);
		expect(text).toMatch(/killedBy: budget/);
	});
});

describe("executeRun semantic liveness and shutdown", () => {
	const nodeInvocation = (script: string) => ({ command: process.execPath, args: ["-e", script, "--"] });

	it("does not treat stderr-only retry bytes as liveness after spawn grace", async () => {
		const run = makeRun();
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			onChange: () => {},
			groupUsage: newUsage(),
			invocation: nodeInvocation("setInterval(() => process.stderr.write('retry\\n'), 10);"),
			watchdog: {
				enabled: true,
				streamSoftMs: 50,
				streamHardMs: 100,
				toolSoftMs: 50,
				toolHardMs: 100,
				maxRuntimeMs: 0,
				checkIntervalMs: 10,
				spawnGraceMs: 25,
			},
		});
		expect(run.killedBy).toBe("watchdog");
		expect(run.firstParsedEventAt).toBeUndefined();
		expect(run.lastEventAt).toBeUndefined();
	}, 5_000);

	it("captures message_update text and waits for the shutdown window before escalation", async () => {
		const run = makeRun();
		const started = Date.now();
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			onChange: () => {},
			groupUsage: newUsage(),
			invocation: nodeInvocation(
				"process.stdout.write(JSON.stringify({type:'message_update',message:{role:'assistant',content:[{type:'text',text:'partial output from a killed turn'}]},assistantMessageEvent:{type:'text_delta',delta:'partial output from a killed turn'}})+'\\n'); process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),5500)); setInterval(()=>{},1000);",
			),
			watchdog: {
				enabled: true,
				streamSoftMs: 25,
				streamHardMs: 60,
				toolSoftMs: 25,
				toolHardMs: 60,
				maxRuntimeMs: 0,
				checkIntervalMs: 10,
				spawnGraceMs: 0,
			},
			shutdownGraceMs: 20_000,
		});
		expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
		expect(run.status).toBe("failed");
		expect(run.killedBy).toBe("watchdog");
		expect(run.inFlightText).toMatch(/partial output from a killed turn/);
		expect(runOutputForModel(run)).toMatch(/In-flight partial output \(turn was killed\)/);
		expect(runOutputForModel(run)).toMatch(/partial output from a killed turn/);
	}, 10_000);

	it("kills a tool call that streams tool_execution_update past toolMaxMs", async () => {
		const run = makeRun();
		const verdicts: string[] = [];
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			onChange: () => {},
			onStall: (_run, verdict) => verdicts.push(verdict.kind),
			groupUsage: newUsage(),
			// The incident: createdb with no TTY and no password re-prints "Password: " forever.
			invocation: nodeInvocation(
				"const emit=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');" +
					"emit({type:'tool_execution_start',toolCallId:'t1',toolName:'bash',args:{command:'createdb -h localhost dbname'}});" +
					"setInterval(()=>emit({type:'tool_execution_update',toolCallId:'t1',toolName:'bash',partialResult:{content:[{type:'text',text:'Password: '}]}}),10);",
			),
			watchdog: {
				enabled: true,
				streamSoftMs: 50,
				streamHardMs: 100,
				// Idle-based tool thresholds never trip: updates arrive every 10ms.
				toolSoftMs: 60_000,
				toolHardMs: 120_000,
				toolMaxMs: 400,
				maxRuntimeMs: 0,
				checkIntervalMs: 10,
				spawnGraceMs: 0,
			},
			shutdownGraceMs: 1_000,
		});
		expect(run.status).toBe("failed");
		expect(run.killedBy).toBe("watchdog");
		expect(verdicts).toEqual(["tool-runaway"]);
		expect(run.errorMessage).toMatch(/runaway-tool guard: the tool call "bash: \$ createdb -h localhost dbname"/);
		expect(run.errorMessage).toMatch(/File edits stay in the working tree/);
		// Liveness was fresh right up to the kill: the old idle-only logic could never fire.
		expect((run.endedAt ?? 0) - (run.lastEventAt ?? 0)).toBeLessThan(1_000);
		expect((run.endedAt ?? 0) - (run.startedAt ?? 0)).toBeGreaterThanOrEqual(400);
	}, 5_000);

	it("kills a producing run without timeoutSeconds at the absolute ceiling", async () => {
		const run = makeRun();
		const verdicts: WatchdogVerdict["kind"][] = [];
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			onChange: () => {},
			onStall: (_run, verdict) => {
				if (verdict.kind !== "recovered") verdicts.push(verdict.kind);
			},
			groupUsage: newUsage(),
			invocation: nodeInvocation(
				"setInterval(()=>process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'.'}})+'\\n'),10);",
			),
			watchdog: {
				enabled: true,
				streamSoftMs: 60_000,
				streamHardMs: 120_000,
				toolSoftMs: 60_000,
				toolHardMs: 120_000,
				maxRuntimeMs: 100,
				maxHardRuntimeMs: 400,
				checkIntervalMs: 10,
				budgetRecheckMs: 60_000,
				spawnGraceMs: 0,
			},
			shutdownGraceMs: 1_000,
		});
		expect(verdicts).toEqual(["over-budget", "hard-cap-kill"]);
		expect(run.killedBy).toBe("budget");
		expect(run.status).toBe("failed");
		expect(run.errorMessage).toMatch(/absolute run ceiling \(subagents\.maxHardRunMinutes/);
		expect((run.endedAt ?? 0) - (run.startedAt ?? 0)).toBeGreaterThanOrEqual(400);
	}, 5_000);

	it("leaves an event-producing child alone when it exits before any fuse", async () => {
		const run = makeRun();
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			onChange: () => {},
			groupUsage: newUsage(),
			invocation: nodeInvocation("console.log(JSON.stringify({type:'turn_start'})); process.exit(0);"),
			watchdog: { ...DEFAULT_WATCHDOG_CONFIG, checkIntervalMs: 10, spawnGraceMs: 0 },
		});
		expect(run.status).toBe("done");
		expect(run.killedBy).toBeUndefined();
		expect(run.firstParsedEventAt).toBeDefined();
	}, 5_000);
});
