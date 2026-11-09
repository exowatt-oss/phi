/**
 * How long to wait for the first byte of piped stdin when the CLI already has a
 * prompt (message or @file). A caller that leaves stdin open without writing to
 * it (agent shells, CI runners, `ssh` without `-n`) would otherwise block the run
 * forever waiting for EOF.
 */
export const PIPED_STDIN_FIRST_DATA_TIMEOUT_MS = 3000;

export interface ReadPipedStdinOptions {
	/**
	 * Give up if neither data nor EOF arrives within this many milliseconds.
	 * Once the first chunk arrives the stream is read to EOF with no timeout.
	 * Omit to wait for EOF indefinitely.
	 */
	firstDataTimeoutMs?: number;
	/** Called when the first-data timeout elapses and stdin is skipped. */
	onTimeout?: () => void;
}

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal), empty, or idle past
 * the first-data timeout.
 */
export function readPipedStdin(
	stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
	options: ReadPipedStdinOptions = {},
): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (stdin.isTTY) {
		return Promise.resolve(undefined);
	}

	return new Promise((resolve) => {
		let data = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onData = (chunk: string) => {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			data += chunk;
		};
		const onEnd = () => {
			if (timer) clearTimeout(timer);
			resolve(data.trim() || undefined);
		};
		stdin.setEncoding("utf8");
		stdin.on("data", onData);
		stdin.once("end", onEnd);
		if (options.firstDataTimeoutMs !== undefined) {
			timer = setTimeout(() => {
				timer = undefined;
				stdin.off("data", onData);
				stdin.off("end", onEnd);
				// Stop reading so the idle handle does not keep the process alive.
				stdin.pause();
				options.onTimeout?.();
				resolve(undefined);
			}, options.firstDataTimeoutMs);
		}
		stdin.resume();
	});
}
