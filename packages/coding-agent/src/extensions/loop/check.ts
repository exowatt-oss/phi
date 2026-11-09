import { spawn } from "node:child_process";
import type { CheckOutcome } from "./types.ts";

/** Uses a detached process group so descendants are terminated with the check. */
export async function runCheck(options: {
	command: string;
	cwd: string;
	timeoutMs: number;
	maxOutputBytes: number;
	signal?: AbortSignal;
}): Promise<CheckOutcome> {
	const started = Date.now();
	if (options.signal?.aborted) return outcome(options, started, null, "SIGTERM", false, "", "", false, "error");
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(options.command, { shell: true, cwd: options.cwd, detached: true });
	} catch {
		return outcome(options, started, null, null, false, "", "", false, "error");
	}

	let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let truncated = false;
	const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
		const combined = Buffer.concat([current, chunk]);
		if (combined.length > options.maxOutputBytes) truncated = true;
		return combined.subarray(Math.max(0, combined.length - Math.max(0, options.maxOutputBytes)));
	};
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout = append(stdout, chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = append(stderr, chunk);
	});

	let timedOut = false;
	let aborted = Boolean(options.signal?.aborted);
	let forcedSignal: string | null = aborted ? "SIGTERM" : null;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const terminate = () => {
		if (child.pid === undefined) return;
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}
		setTimeout(() => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				/* already gone */
			}
		}, 2000).unref();
	};
	const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error = false): CheckOutcome => {
		if (timer) clearTimeout(timer);
		const effectiveSignal = forcedSignal ?? signal;
		const verdict =
			!error && !timedOut && !aborted && !effectiveSignal && exitCode === 0
				? "satisfied"
				: !error && !timedOut && !aborted && !effectiveSignal && exitCode === 1
					? "unsatisfied"
					: "error";
		return outcome(
			options,
			started,
			exitCode,
			effectiveSignal,
			timedOut,
			stdout.toString(),
			stderr.toString(),
			truncated,
			verdict,
		);
	};
	return await new Promise<CheckOutcome>((resolve) => {
		const settle = (result: CheckOutcome) => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};
		child.once("error", () => settle(finish(null, null, true)));
		child.once("close", (code, signal) => settle(finish(code, signal)));
		timer = setTimeout(
			() => {
				timedOut = true;
				forcedSignal = "SIGTERM";
				terminate();
			},
			Math.max(0, options.timeoutMs),
		);
		if (options.signal)
			options.signal.addEventListener(
				"abort",
				() => {
					if (!settled) {
						aborted = true;
						forcedSignal = "SIGTERM";
						terminate();
					}
				},
				{ once: true },
			);
		if (aborted) terminate();
	});
}

function outcome(
	options: { command: string; cwd: string },
	started: number,
	exitCode: number | null,
	signal: string | null,
	timedOut: boolean,
	stdoutTail: string,
	stderrTail: string,
	truncated: boolean,
	verdict: CheckOutcome["verdict"],
): CheckOutcome {
	return {
		command: options.command,
		cwd: options.cwd,
		exitCode,
		signal,
		timedOut,
		durationMs: Date.now() - started,
		stdoutTail,
		stderrTail,
		truncated,
		verdict,
	};
}
