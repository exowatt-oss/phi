/**
 * Child-process isolation for the subagents extension (Linux + systemd).
 *
 * Why this exists: a subagent is a child process of the phi that launched it,
 * so by default it lives in the *parent's* cgroup. On a Devbox that cgroup is
 * the tmux pane's `tmux-spawn-<uuid>.scope`, whose systemd default
 * `OOMPolicy=stop` tears the whole unit down when the kernel OOM-kills any one
 * process in it. On 2026-09-22 a single subagent ran a bare `npm test`
 * (jest + ts-jest, no worker cap) on a 48-core box: 47 workers × ~750 MB ≈ 22 GB
 * on a ~30 GB VM with no swap. The kernel killed a 90 MB chrome renderer, systemd
 * killed the pane, and the phi session plus all ten background subagents died.
 *
 * The fix is to give every child its own transient scope via
 * `systemd-run --user --scope`, which execs the child in place (same PID, same
 * stdio, same PPID) inside a fresh cgroup with:
 *
 *   - `MemoryMax`   — a hard ceiling; a runaway fan-out is killed *inside the
 *                     child's cgroup* and can never take the parent's pane with it;
 *   - `CPUQuota`    — bandwidth, not pinning. libuv's `uv_available_parallelism`
 *                     honours cgroup `cpu.max`, so `os.availableParallelism()`
 *                     (which jest/vitest size their worker pools from) shrinks to
 *                     the quota and the fan-out never happens in the first place;
 *   - `OOMPolicy=continue` — one OOM-killed worker does not stop the whole child;
 *                     the agent sees a failed test run and can retry with a cap.
 *
 * Everything here fails open: no systemd, no user bus, a refused property, a
 * non-Linux host, or `subagents.childIsolation: "off"` all mean "spawn the child
 * directly, exactly as before". The parent also samples the child's cgroup
 * (`memory.peak`, `memory.events oom_kill`) so a ceiling hit is reported back to
 * the model instead of surfacing as an inexplicable exit code.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { SubagentsSettings } from "../../core/settings-manager.ts";

const GIB = 1024 ** 3;
const DEFAULT_MEMORY_FRACTION = 0.3;
const MIN_DEFAULT_MEMORY_BYTES = 2 * GIB;
const MAX_DEFAULT_MEMORY_BYTES = 16 * GIB;
const MIN_DEFAULT_CPU_CORES = 4;
const DEFAULT_CPU_DIVISOR = 6;
const PROBE_TIMEOUT_MS = 5_000;

/** Environment variable that disables isolation for a whole process tree. */
export const ISOLATION_ENV_SWITCH = "PI_SUBAGENT_ISOLATION";
/** Set on every child so it can notice its parent is gone (see `parentGuardVerdict`). */
export const PARENT_PID_ENV = "PI_SUBAGENT_PARENT_PID";

export interface ChildIsolationConfig {
	/** False = spawn children directly (non-Linux, disabled, or no usable systemd). */
	enabled: boolean;
	/** systemd `MemoryMax=` value in bytes; undefined = no memory ceiling. */
	memoryMaxBytes?: number;
	/** Whole CPUs the child cgroup may use (systemd `CPUQuota=<n*100>%`); undefined = no quota. */
	cpuCores?: number;
	/** Worker-count hint exported to the child for runners that read env (vitest, pytest-xdist). */
	workerCap?: number;
	/** Why isolation is off, for diagnostics. */
	reason?: string;
}

export interface HostFacts {
	platform: NodeJS.Platform;
	totalMemoryBytes: number;
	cpuCount: number;
}

export function hostFacts(): HostFacts {
	let cpuCount = 1;
	try {
		cpuCount = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
	} catch {
		cpuCount = os.cpus().length || 1;
	}
	return { platform: process.platform, totalMemoryBytes: os.totalmem(), cpuCount: Math.max(1, cpuCount) };
}

/**
 * Parse a memory size setting: a number is bytes; strings accept `8G`, `512M`,
 * `2GiB`, `1.5g`, or a percentage of host memory (`25%`). `0`, `"0"`, `"off"`,
 * `"none"` and `false` disable the ceiling. Unparseable values return null so
 * the caller can fall back to the default rather than silently disabling.
 */
export function parseMemorySetting(value: unknown, totalMemoryBytes: number): number | null | undefined {
	if (value === undefined) return undefined;
	if (value === false || value === 0) return null;
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
	if (typeof value !== "string") return undefined;
	const text = value.trim().toLowerCase();
	if (text === "" || text === "0" || text === "off" || text === "none" || text === "false") return null;
	const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
	if (percent) {
		const fraction = Number(percent[1]) / 100;
		if (!(fraction > 0)) return undefined;
		return Math.floor(totalMemoryBytes * fraction);
	}
	const sized = /^(\d+(?:\.\d+)?)\s*([kmgt])?(?:i?b)?$/.exec(text);
	if (!sized) return undefined;
	const amount = Number(sized[1]);
	if (!(amount > 0)) return undefined;
	const unit = sized[2];
	const multiplier =
		unit === "k" ? 1024 : unit === "m" ? 1024 ** 2 : unit === "g" ? GIB : unit === "t" ? 1024 ** 4 : 1;
	return Math.floor(amount * multiplier);
}

/** Parse the CPU-cores setting. `0`/`"off"`/`false` disable the quota; undefined = default. */
export function parseCpuSetting(value: unknown): number | null | undefined {
	if (value === undefined) return undefined;
	if (value === false || value === 0) return null;
	if (typeof value === "string") {
		const text = value.trim().toLowerCase();
		if (text === "" || text === "0" || text === "off" || text === "none" || text === "false") return null;
		const parsed = Number(text);
		return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.round(parsed)) : undefined;
	}
	if (typeof value === "number")
		return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : undefined;
	return undefined;
}

/** Default memory ceiling: 30 % of host RAM, clamped to [2 GiB, 16 GiB]. */
export function defaultMemoryMaxBytes(totalMemoryBytes: number): number {
	const fraction = Math.floor(totalMemoryBytes * DEFAULT_MEMORY_FRACTION);
	return Math.min(MAX_DEFAULT_MEMORY_BYTES, Math.max(MIN_DEFAULT_MEMORY_BYTES, fraction));
}

/** Default CPU quota: a sixth of the host's CPUs, at least 4, never more than the host has. */
export function defaultCpuCores(cpuCount: number): number {
	return Math.max(1, Math.min(cpuCount, Math.max(MIN_DEFAULT_CPU_CORES, Math.floor(cpuCount / DEFAULT_CPU_DIVISOR))));
}

/**
 * Resolve the isolation config from settings + environment + host facts. Pure:
 * it does not probe systemd. `enabled` here means "wanted"; `probeIsolation`
 * decides whether the host can actually deliver it.
 */
export function resolveChildIsolation(
	settings: SubagentsSettings,
	env: NodeJS.ProcessEnv,
	host: HostFacts,
): ChildIsolationConfig {
	const cpuParsed = parseCpuSetting(settings.childCpuCores);
	const cpuCores = cpuParsed === null ? undefined : (cpuParsed ?? defaultCpuCores(host.cpuCount));
	// The worker-cap hint is useful even without cgroups (macOS, no systemd):
	// vitest/pytest-xdist read it from the environment.
	const workerCap = cpuCores;

	const envSwitch = env[ISOLATION_ENV_SWITCH]?.trim().toLowerCase();
	if (envSwitch === "off" || envSwitch === "0" || envSwitch === "false") {
		return { enabled: false, workerCap, reason: `${ISOLATION_ENV_SWITCH}=${env[ISOLATION_ENV_SWITCH]}` };
	}
	if (settings.childIsolation === "off") {
		return { enabled: false, workerCap, reason: "subagents.childIsolation is off" };
	}
	if (host.platform !== "linux") {
		return { enabled: false, workerCap, reason: `no systemd on ${host.platform}` };
	}

	const memoryParsed = parseMemorySetting(settings.childMemoryMax, host.totalMemoryBytes);
	const memoryMaxBytes =
		memoryParsed === null ? undefined : (memoryParsed ?? defaultMemoryMaxBytes(host.totalMemoryBytes));

	if (memoryMaxBytes === undefined && cpuCores === undefined) {
		return { enabled: false, workerCap, reason: "both childMemoryMax and childCpuCores are off" };
	}
	return { enabled: true, memoryMaxBytes, cpuCores, workerCap };
}

/** The `-p` property assignments for a config. Exported for tests and diagnostics. */
export function scopeProperties(config: ChildIsolationConfig): string[] {
	const props: string[] = [];
	if (config.memoryMaxBytes !== undefined) props.push(`MemoryMax=${config.memoryMaxBytes}`);
	if (config.cpuCores !== undefined) props.push(`CPUQuota=${config.cpuCores * 100}%`);
	// One OOM-killed worker must not stop the whole child; the child sees a
	// failed command and can retry with an explicit worker cap.
	props.push("OOMPolicy=continue");
	return props;
}

/** systemd unit names allow `[A-Za-z0-9:_.\\-]`; keep the run id recognisable. */
export function scopeUnitName(runId: string): string {
	const safe = runId.replace(/[^A-Za-z0-9:_.-]+/g, "-").replace(/^-+|-+$/g, "");
	return `phi-subagent-${safe || "run"}`;
}

export interface Invocation {
	command: string;
	args: string[];
}

/**
 * Wrap a child invocation in `systemd-run --user --scope`. `--scope` execs the
 * command in place: the child keeps the same PID, stdio and PPID, so the runner's
 * pipe handling, kill escalation and the child's parent-liveness guard all work
 * unchanged.
 */
export function wrapInvocation(
	invocation: Invocation,
	config: ChildIsolationConfig,
	unitName: string,
	description: string,
): Invocation {
	const args = ["--user", "--scope", "--quiet", "--collect", "--unit", unitName, "--description", description];
	for (const prop of scopeProperties(config)) args.push("-p", prop);
	args.push("--", invocation.command, ...invocation.args);
	return { command: "systemd-run", args };
}

let probeCache: { key: string; ok: boolean; reason?: string } | undefined;

/**
 * Check once per process (per property set) that this host can actually start a
 * memory/CPU-capped user scope: `systemd-run` on PATH, a reachable user manager,
 * and every property accepted. Any failure → spawn children directly.
 */
export function probeIsolation(config: ChildIsolationConfig, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!config.enabled) return false;
	const key = scopeProperties(config).join(" ");
	if (probeCache?.key === key) return probeCache.ok;
	let ok = false;
	let reason: string | undefined;
	try {
		const args = [
			"--user",
			"--scope",
			"--quiet",
			"--collect",
			"--unit",
			`phi-subagent-probe-${process.pid}-${Date.now()}`,
		];
		for (const prop of scopeProperties(config)) args.push("-p", prop);
		args.push("--", "/bin/true");
		const result = spawnSync("systemd-run", args, {
			env,
			stdio: ["ignore", "ignore", "pipe"],
			timeout: PROBE_TIMEOUT_MS,
			encoding: "utf8",
		});
		ok = result.status === 0 && !result.error;
		if (!ok) reason = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
	} catch (error) {
		reason = error instanceof Error ? error.message : String(error);
	}
	probeCache = { key, ok, reason };
	return ok;
}

/** Why the last probe failed (undefined when it passed or never ran). Diagnostics only. */
export function lastProbeFailure(): string | undefined {
	return probeCache && !probeCache.ok ? probeCache.reason : undefined;
}

/** Test seam. */
export function resetProbeCache(): void {
	probeCache = undefined;
}

/** Environment the child gets so CPU-count-driven runners size themselves sanely. */
export function childEnvironmentHints(
	config: ChildIsolationConfig,
	parentPid: number,
	existing: NodeJS.ProcessEnv,
): Record<string, string> {
	const out: Record<string, string> = { [PARENT_PID_ENV]: String(parentPid) };
	if (config.workerCap !== undefined) {
		const cap = String(config.workerCap);
		// Only fill gaps: a user who set these on purpose keeps their values.
		for (const key of [
			"VITEST_MAX_THREADS",
			"VITEST_MAX_FORKS",
			"VITEST_MAX_WORKERS",
			"PYTEST_XDIST_AUTO_NUM_WORKERS",
			"PI_SUBAGENT_WORKER_CAP",
		]) {
			if (existing[key] === undefined || existing[key] === "") out[key] = cap;
		}
	}
	return out;
}

export interface CgroupMemorySample {
	/** `memory.peak` in bytes, when the kernel exposes it. */
	peakBytes?: number;
	/** Cumulative `oom_kill` count from `memory.events`. */
	oomKills?: number;
	/** `memory.max` in bytes, or undefined when unlimited ("max"). */
	maxBytes?: number;
}

/** Resolve a PID's cgroup v2 path under `/sys/fs/cgroup`, or undefined. */
export function cgroupPathForPid(pid: number, procRoot = "/proc", cgroupRoot = "/sys/fs/cgroup"): string | undefined {
	try {
		const text = fs.readFileSync(`${procRoot}/${pid}/cgroup`, "utf8");
		for (const line of text.split("\n")) {
			// cgroup v2 unified hierarchy: "0::/user.slice/.../phi-subagent-x.scope"
			if (line.startsWith("0::")) {
				const rel = line.slice(3).trim();
				if (rel && rel !== "/") return `${cgroupRoot}${rel}`;
			}
		}
	} catch {
		/* process gone or /proc unavailable */
	}
	return undefined;
}

/** Parse `memory.events`-style "key value" text into a number map. */
export function parseKeyedCounters(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of text.split("\n")) {
		const match = /^(\S+)\s+(\d+)\s*$/.exec(line.trim());
		if (match) out[match[1]] = Number(match[2]);
	}
	return out;
}

/** Read peak/oom_kill/max from a cgroup directory. Any missing file is simply absent. */
export function readCgroupMemory(cgroupDir: string): CgroupMemorySample | undefined {
	const sample: CgroupMemorySample = {};
	let any = false;
	try {
		const peak = fs.readFileSync(`${cgroupDir}/memory.peak`, "utf8").trim();
		if (/^\d+$/.test(peak)) {
			sample.peakBytes = Number(peak);
			any = true;
		}
	} catch {
		/* older kernels lack memory.peak */
	}
	try {
		const events = parseKeyedCounters(fs.readFileSync(`${cgroupDir}/memory.events`, "utf8"));
		if (events.oom_kill !== undefined) {
			sample.oomKills = events.oom_kill;
			any = true;
		}
	} catch {
		/* cgroup already removed */
	}
	try {
		const max = fs.readFileSync(`${cgroupDir}/memory.max`, "utf8").trim();
		if (/^\d+$/.test(max)) {
			sample.maxBytes = Number(max);
			any = true;
		}
	} catch {
		/* ignore */
	}
	return any ? sample : undefined;
}

/**
 * Kill every process left in a child's scope (jest workers, headless browsers,
 * dev servers the child forgot). Fire-and-forget; the scope is `--collect`ed by
 * systemd once empty.
 */
export function killScope(unitName: string, signal: "SIGTERM" | "SIGKILL", env: NodeJS.ProcessEnv = process.env): void {
	try {
		const proc = spawn("systemctl", ["--user", "kill", `--signal=${signal}`, `${unitName}.scope`], {
			env,
			stdio: "ignore",
			detached: false,
		});
		proc.on("error", () => {
			/* systemctl missing — nothing to clean */
		});
		proc.unref();
	} catch {
		/* ignore */
	}
}

export function formatBytes(bytes: number): string {
	if (bytes >= GIB) return `${(bytes / GIB).toFixed(bytes >= 10 * GIB ? 0 : 1)} GiB`;
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MiB`;
	return `${Math.round(bytes / 1024)} KiB`;
}

/** One-line human summary of the ceiling a child runs under, for receipts and reports. */
export function describeIsolation(config: ChildIsolationConfig): string {
	const parts: string[] = [];
	if (config.memoryMaxBytes !== undefined) parts.push(`MemoryMax=${formatBytes(config.memoryMaxBytes)}`);
	if (config.cpuCores !== undefined) parts.push(`CPUQuota=${config.cpuCores} CPUs`);
	return parts.join(", ");
}

/**
 * Advice appended to a run's report when its cgroup recorded OOM kills. Written
 * for the model that will decide what to do next.
 */
export function oomAdviceText(oomKills: number, peakBytes?: number, ceilingSummary?: string): string {
	const ceiling = ceilingSummary ? ` under ${ceilingSummary}` : "";
	const peak = peakBytes !== undefined ? ` (peak ${formatBytes(peakBytes)})` : "";
	const what =
		oomKills > 0
			? `the kernel OOM-killed ${oomKills} process${oomKills === 1 ? "" : "es"} inside this subagent's cgroup`
			: "this subagent was SIGKILLed inside its memory-capped cgroup by something other than phi (the kernel OOM killer, almost certainly)";
	return (
		`## Memory ceiling hit: ${what}${peak}${ceiling}. ` +
		"This is almost always a parallel test runner or build sizing its worker pool from the CPU count (jest, vitest, pytest-xdist, make -j). " +
		"If you relaunch, pin an explicit cap in the task: `jest --maxWorkers=4`, `vitest --maxWorkers=4`, `pytest -n 4`, `make -j4`."
	);
}

export type ParentGuardVerdict = "parent-alive" | "parent-gone" | "not-applicable";

/**
 * Decide whether a child should keep running. Pure so it can be unit-tested:
 * the child is considered orphaned when its PPID no longer matches the PID its
 * parent advertised at spawn (the kernel reparents orphans to init/a subreaper).
 * If the PPID never matched — an intermediary shell, a test harness — the guard
 * stays out of the way.
 */
export function parentGuardVerdict(
	advertisedParentPid: string | undefined,
	initialPpid: number,
	currentPpid: number,
): ParentGuardVerdict {
	const expected = Number(advertisedParentPid);
	if (!advertisedParentPid || !Number.isInteger(expected) || expected <= 0) return "not-applicable";
	if (initialPpid !== expected) return "not-applicable";
	return currentPpid === expected ? "parent-alive" : "parent-gone";
}

/**
 * In a child: exit when the launching phi is gone. Before isolation, children
 * died with the parent's cgroup; in their own scope they would otherwise keep
 * running (and spending) with nobody to deliver results to.
 */
export function installParentLivenessGuard(
	env: NodeJS.ProcessEnv = process.env,
	intervalMs = 5_000,
	exit: (code: number) => void = (code) => process.exit(code),
): (() => void) | undefined {
	const initialPpid = process.ppid;
	if (parentGuardVerdict(env[PARENT_PID_ENV], initialPpid, initialPpid) === "not-applicable") return undefined;
	const timer = setInterval(() => {
		if (parentGuardVerdict(env[PARENT_PID_ENV], initialPpid, process.ppid) === "parent-gone") {
			clearInterval(timer);
			try {
				process.stderr.write(
					`[subagent] parent phi (pid ${env[PARENT_PID_ENV]}) exited; stopping this subagent.\n`,
				);
			} catch {
				/* ignore */
			}
			exit(143);
		}
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
