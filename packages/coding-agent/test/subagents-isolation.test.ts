import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cgroupPathForPid,
	childEnvironmentHints,
	defaultCpuCores,
	defaultMemoryMaxBytes,
	describeIsolation,
	formatBytes,
	ISOLATION_ENV_SWITCH,
	oomAdviceText,
	PARENT_PID_ENV,
	parentGuardVerdict,
	parseCpuSetting,
	parseKeyedCounters,
	parseMemorySetting,
	probeIsolation,
	readCgroupMemory,
	resetProbeCache,
	resolveChildIsolation,
	scopeProperties,
	scopeUnitName,
	wrapInvocation,
} from "../src/extensions/subagents/isolation.ts";
import { executeRun, newUsage, runOutputForModel } from "../src/extensions/subagents/runner.ts";
import { newUsageTotals, type SubagentRunSnapshot } from "../src/extensions/subagents/types.ts";

const GIB = 1024 ** 3;
const linuxHost = { platform: "linux" as const, totalMemoryBytes: 32 * GIB, cpuCount: 48 };

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

describe("subagent child isolation — settings resolution", () => {
	it("parses memory sizes, percentages and off switches", () => {
		expect(parseMemorySetting(undefined, 32 * GIB)).toBeUndefined();
		expect(parseMemorySetting("8G", 32 * GIB)).toBe(8 * GIB);
		expect(parseMemorySetting("8GiB", 32 * GIB)).toBe(8 * GIB);
		expect(parseMemorySetting("512M", 32 * GIB)).toBe(512 * 1024 ** 2);
		expect(parseMemorySetting("1.5g", 32 * GIB)).toBe(Math.floor(1.5 * GIB));
		expect(parseMemorySetting("25%", 32 * GIB)).toBe(8 * GIB);
		expect(parseMemorySetting(4 * GIB, 32 * GIB)).toBe(4 * GIB);
		for (const off of [0, "0", "off", "none", false, ""]) expect(parseMemorySetting(off, 32 * GIB)).toBeNull();
		// Garbage falls back to the default rather than silently disabling.
		expect(parseMemorySetting("lots", 32 * GIB)).toBeUndefined();
		expect(parseMemorySetting(-5, 32 * GIB)).toBeUndefined();
	});

	it("parses the CPU setting", () => {
		expect(parseCpuSetting(undefined)).toBeUndefined();
		expect(parseCpuSetting(8)).toBe(8);
		expect(parseCpuSetting("6")).toBe(6);
		expect(parseCpuSetting(0.4)).toBe(1);
		for (const off of [0, "off", false]) expect(parseCpuSetting(off)).toBeNull();
		expect(parseCpuSetting("many")).toBeUndefined();
	});

	it("defaults: 30% of RAM clamped to [2, 16] GiB; max(4, cpus/6) cores", () => {
		expect(defaultMemoryMaxBytes(32 * GIB)).toBe(Math.floor(32 * GIB * 0.3));
		expect(defaultMemoryMaxBytes(4 * GIB)).toBe(2 * GIB);
		expect(defaultMemoryMaxBytes(256 * GIB)).toBe(16 * GIB);
		expect(defaultCpuCores(48)).toBe(8);
		expect(defaultCpuCores(16)).toBe(4);
		expect(defaultCpuCores(2)).toBe(2);
	});

	it("is on by default on Linux with sane ceilings for the incident box", () => {
		const config = resolveChildIsolation(
			{},
			{},
			{ platform: "linux", totalMemoryBytes: 31226024 * 1024, cpuCount: 48 },
		);
		expect(config.enabled).toBe(true);
		expect(config.memoryMaxBytes).toBe(Math.floor(31226024 * 1024 * 0.3));
		expect(config.cpuCores).toBe(8);
		expect(config.workerCap).toBe(8);
		expect(scopeProperties(config)).toEqual([
			`MemoryMax=${config.memoryMaxBytes}`,
			"CPUQuota=800%",
			"OOMPolicy=continue",
		]);
		expect(describeIsolation(config)).toBe("MemoryMax=8.9 GiB, CPUQuota=8 CPUs");
	});

	it("honours explicit settings", () => {
		const config = resolveChildIsolation({ childMemoryMax: "4G", childCpuCores: 12 }, {}, linuxHost);
		expect(config).toMatchObject({ enabled: true, memoryMaxBytes: 4 * GIB, cpuCores: 12, workerCap: 12 });
		const memOnly = resolveChildIsolation({ childCpuCores: "off" }, {}, linuxHost);
		expect(memOnly.enabled).toBe(true);
		expect(memOnly.cpuCores).toBeUndefined();
		expect(memOnly.workerCap).toBeUndefined();
		expect(scopeProperties(memOnly)).not.toContainEqual(expect.stringMatching(/^CPUQuota/));
		const cpuOnly = resolveChildIsolation({ childMemoryMax: 0 }, {}, linuxHost);
		expect(cpuOnly.enabled).toBe(true);
		expect(cpuOnly.memoryMaxBytes).toBeUndefined();
	});

	it("turns off via setting, env switch, both-ceilings-off, and non-Linux — but keeps the worker-cap hint", () => {
		expect(resolveChildIsolation({ childIsolation: "off" }, {}, linuxHost)).toMatchObject({
			enabled: false,
			workerCap: 8,
		});
		expect(resolveChildIsolation({}, { [ISOLATION_ENV_SWITCH]: "off" }, linuxHost).enabled).toBe(false);
		expect(resolveChildIsolation({}, { [ISOLATION_ENV_SWITCH]: "0" }, linuxHost).enabled).toBe(false);
		expect(resolveChildIsolation({ childMemoryMax: "off", childCpuCores: 0 }, {}, linuxHost).enabled).toBe(false);
		const mac = resolveChildIsolation({}, {}, { platform: "darwin", totalMemoryBytes: 64 * GIB, cpuCount: 12 });
		expect(mac.enabled).toBe(false);
		expect(mac.workerCap).toBe(4);
		expect(mac.reason).toContain("darwin");
	});
});

describe("subagent child isolation — invocation and environment", () => {
	it("wraps the child in systemd-run --user --scope, exec-in-place style", () => {
		const config = resolveChildIsolation({ childMemoryMax: "2G", childCpuCores: 4 }, {}, linuxHost);
		const wrapped = wrapInvocation(
			{ command: "/usr/bin/phi", args: ["--mode", "json", "-p"] },
			config,
			"phi-subagent-abc",
			"desc",
		);
		expect(wrapped.command).toBe("systemd-run");
		expect(wrapped.args).toEqual([
			"--user",
			"--scope",
			"--quiet",
			"--collect",
			"--unit",
			"phi-subagent-abc",
			"--description",
			"desc",
			"-p",
			`MemoryMax=${2 * GIB}`,
			"-p",
			"CPUQuota=400%",
			"-p",
			"OOMPolicy=continue",
			"--",
			"/usr/bin/phi",
			"--mode",
			"json",
			"-p",
		]);
	});

	it("derives a valid unit name from the run id", () => {
		expect(scopeUnitName("01a0ca8b-6067-7ed7-95fc-48b0b4f1b456")).toBe(
			"phi-subagent-01a0ca8b-6067-7ed7-95fc-48b0b4f1b456",
		);
		expect(scopeUnitName("ws a/b")).toBe("phi-subagent-ws-a-b");
		expect(scopeUnitName("///")).toBe("phi-subagent-run");
	});

	it("exports the parent pid and worker caps without clobbering user values", () => {
		const config = resolveChildIsolation({}, {}, linuxHost);
		const hints = childEnvironmentHints(config, 4242, { VITEST_MAX_THREADS: "2" });
		expect(hints[PARENT_PID_ENV]).toBe("4242");
		expect(hints.VITEST_MAX_THREADS).toBeUndefined();
		expect(hints.VITEST_MAX_FORKS).toBe("8");
		expect(hints.PYTEST_XDIST_AUTO_NUM_WORKERS).toBe("8");
		expect(hints.PI_SUBAGENT_WORKER_CAP).toBe("8");
		const none = childEnvironmentHints({ enabled: false }, 1, {});
		expect(Object.keys(none)).toEqual([PARENT_PID_ENV]);
	});
});

describe("subagent child isolation — cgroup telemetry parsing", () => {
	let tmp: string | undefined;
	afterEach(() => {
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
		tmp = undefined;
	});

	it("parses memory.events counters", () => {
		expect(parseKeyedCounters("low 0\nhigh 12\nmax 3\noom 2\noom_kill 2\noom_group_kill 0\n")).toEqual({
			low: 0,
			high: 12,
			max: 3,
			oom: 2,
			oom_kill: 2,
			oom_group_kill: 0,
		});
	});

	it("resolves a pid's unified cgroup path and reads memory files", () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phi-iso-"));
		const proc = path.join(tmp, "proc", "123");
		const cg = path.join(tmp, "cg", "user.slice", "phi-subagent-x.scope");
		fs.mkdirSync(proc, { recursive: true });
		fs.mkdirSync(cg, { recursive: true });
		fs.writeFileSync(path.join(proc, "cgroup"), "0::/user.slice/phi-subagent-x.scope\n");
		fs.writeFileSync(path.join(cg, "memory.peak"), "734003200\n");
		fs.writeFileSync(path.join(cg, "memory.events"), "low 0\nhigh 0\nmax 9\noom 3\noom_kill 3\n");
		fs.writeFileSync(path.join(cg, "memory.max"), String(8 * GIB));
		const dir = cgroupPathForPid(123, path.join(tmp, "proc"), path.join(tmp, "cg"));
		expect(dir).toBe(cg);
		expect(readCgroupMemory(dir!)).toEqual({ peakBytes: 734003200, oomKills: 3, maxBytes: 8 * GIB });
		expect(cgroupPathForPid(999, path.join(tmp, "proc"), path.join(tmp, "cg"))).toBeUndefined();
		expect(readCgroupMemory(path.join(tmp, "nope"))).toBeUndefined();
	});

	it("formats bytes and writes model-facing OOM advice", () => {
		expect(formatBytes(9.4 * GIB)).toBe("9.4 GiB");
		expect(formatBytes(12 * GIB)).toBe("12 GiB");
		expect(formatBytes(700 * 1024 ** 2)).toBe("700 MiB");
		const advice = oomAdviceText(3, 8.9 * GIB, "MemoryMax=9 GiB, CPUQuota=8 CPUs");
		expect(advice).toContain("OOM-killed 3 processes");
		expect(advice).toContain("peak 8.9 GiB");
		expect(advice).toContain("under MemoryMax=9 GiB");
		expect(advice).toContain("--maxWorkers=4");
	});

	it("surfaces OOM kills in the model-facing run output for failed and successful runs", () => {
		const failed = makeRun({
			status: "failed",
			exitCode: 137,
			oomKills: 2,
			memoryPeakBytes: 8 * GIB,
			isolation: { unit: "phi-subagent-x", summary: "MemoryMax=8 GiB" },
		});
		const failedText = runOutputForModel(failed);
		expect(failedText).toContain("## Run failed");
		expect(failedText).toContain("## Memory ceiling hit");
		const done = makeRun({ status: "done", finalText: "all green", oomKills: 1 });
		const doneText = runOutputForModel(done);
		expect(doneText.startsWith("all green")).toBe(true);
		expect(doneText).toContain("## Memory ceiling hit");
		expect(runOutputForModel(makeRun({ status: "done", finalText: "ok" }))).toBe("ok");
		const suspected = makeRun({
			status: "failed",
			exitCode: 137,
			suspectedOomKill: true,
			isolation: { unit: "u", summary: "MemoryMax=2 GiB" },
		});
		expect(runOutputForModel(suspected)).toContain("SIGKILLed inside its memory-capped cgroup");
	});
});

describe("subagent child isolation — parent liveness guard", () => {
	it("only fires when the advertised parent was our PPID and is no longer", () => {
		expect(parentGuardVerdict(undefined, 100, 100)).toBe("not-applicable");
		expect(parentGuardVerdict("abc", 100, 100)).toBe("not-applicable");
		// An intermediary between parent and child means we cannot judge — stay out of the way.
		expect(parentGuardVerdict("100", 555, 555)).toBe("not-applicable");
		expect(parentGuardVerdict("100", 100, 100)).toBe("parent-alive");
		expect(parentGuardVerdict("100", 100, 1)).toBe("parent-gone");
	});
});

// Real systemd: only where a user manager is reachable (Linux devbox/CI with a session bus).
const canUseSystemd = (() => {
	if (process.platform !== "linux") return false;
	resetProbeCache();
	return probeIsolation({ enabled: true, memoryMaxBytes: GIB, cpuCores: 1 });
})();

describe.skipIf(!canUseSystemd)("subagent child isolation — live systemd scope", () => {
	afterEach(() => resetProbeCache());

	it("runs the child inside its own capped scope, exec-in-place, with the pane untouched", async () => {
		const run = makeRun({ runId: `live-${process.pid}-${Date.now()}` });
		const config = { enabled: true, memoryMaxBytes: GIB, cpuCores: 1, workerCap: 1 };
		const script =
			"const fs=require('fs');const cg=fs.readFileSync('/proc/self/cgroup','utf8').trim().slice(3);" +
			"const max=fs.readFileSync('/sys/fs/cgroup'+cg+'/memory.max','utf8').trim();" +
			"const par=require('os').availableParallelism();" +
			"console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({cg,max,par,ppid:process.ppid,env:process.env.PI_SUBAGENT_PARENT_PID})}]}}));";
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			onChange: () => {},
			groupUsage: newUsage(),
			isolation: config,
			invocation: { command: process.execPath, args: ["-e", script, "--"] },
		});
		expect(run.status).toBe("done");
		expect(run.isolation?.unit).toBe(scopeUnitName(run.runId!));
		const report = JSON.parse(run.finalText) as { cg: string; max: string; par: number; ppid: number; env: string };
		expect(report.cg).toContain(run.isolation!.unit);
		expect(report.max).toBe(String(GIB));
		// CPUQuota=100% → libuv reports one CPU → jest/vitest would size to 1 worker.
		expect(report.par).toBe(1);
		// systemd-run --scope execs in place: the child's parent is still this process.
		expect(report.ppid).toBe(process.pid);
		expect(report.env).toBe(String(process.pid));
	});

	it("records OOM kills inside the child's cgroup and explains them to the model", async () => {
		const run = makeRun({ runId: `oom-${process.pid}-${Date.now()}` });
		const config = { enabled: true, memoryMaxBytes: 64 * 1024 ** 2, workerCap: 1 };
		// Allocate well past 64 MiB; the kernel kills this process inside its own cgroup.
		const script = "const a=[];for(;;){a.push(Buffer.alloc(16*1024*1024,1));}";
		await executeRun({
			defaultCwd: process.cwd(),
			run,
			onChange: () => {},
			groupUsage: newUsage(),
			isolation: config,
			invocation: { command: process.execPath, args: ["--max-old-space-size=4096", "-e", script, "--"] },
		});
		expect(run.status).toBe("failed");
		expect(run.exitCode).toBe(137);
		expect(run.isolation?.summary).toBe("MemoryMax=64 MiB");
		// The child itself was the victim, so its scope is gone before we can read
		// memory.events; the SIGKILL-we-did-not-send heuristic must still explain it.
		expect((run.oomKills ?? 0) > 0 || run.suspectedOomKill === true).toBe(true);
		expect(run.errorMessage).toContain("OOM killer");
		expect(runOutputForModel(run)).toContain("## Memory ceiling hit");
	}, 30_000);

	it("probe fails open on a property systemd refuses", () => {
		resetProbeCache();
		expect(probeIsolation({ enabled: true, memoryMaxBytes: -1 as number })).toBe(false);
		expect(spawnSync("systemd-run", ["--version"]).status).toBe(0);
	});
});

describe.skipIf(!canUseSystemd)(
	"subagent child isolation — live systemd scope, worker OOM while child survives",
	() => {
		it("records oom_kill from the child's cgroup while the child keeps running", async () => {
			const run = makeRun({ runId: `oomw-${process.pid}-${Date.now()}` });
			const config = { enabled: true, memoryMaxBytes: 96 * 1024 ** 2, workerCap: 1 };
			// Parent stays small and alive; a forked worker blows past the ceiling and is OOM-killed
			// inside the scope (OOMPolicy=continue keeps the parent up). Then the parent reports.
			const script =
				"const {spawnSync}=require('child_process');" +
				"const r=spawnSync(process.execPath,['--max-old-space-size=4096','-e','const a=[];for(;;){a.push(Buffer.alloc(16*1024*1024,1));}']);" +
				"setTimeout(()=>{console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'worker signal '+r.signal}]}}));},2600);";
			await executeRun({
				defaultCwd: process.cwd(),
				run,
				onChange: () => {},
				groupUsage: newUsage(),
				isolation: config,
				invocation: { command: process.execPath, args: ["-e", script, "--"] },
			});
			expect(run.status).toBe("done");
			expect(run.finalText).toBe("worker signal SIGKILL");
			expect(run.oomKills).toBeGreaterThan(0);
			expect(run.memoryPeakBytes).toBeGreaterThan(64 * 1024 ** 2);
			expect(run.timeline.some((item) => item.kind === "text" && item.text.includes("memory ceiling hit"))).toBe(
				true,
			);
			expect(runOutputForModel(run)).toContain("## Memory ceiling hit: the kernel OOM-killed 1 process inside");
		}, 30_000);
	},
);
