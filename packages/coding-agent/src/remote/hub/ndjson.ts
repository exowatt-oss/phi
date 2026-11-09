/**
 * LF-only NDJSON framing for the local hub socket and headless children's stdout.
 *
 * Same rules as RPC mode (see `src/modes/rpc/jsonl.ts`): split on `\n` only, strip a trailing
 * `\r`, never use `readline` (it also splits on U+2028/U+2029, which are valid inside JSON).
 * Adds a per-line byte cap so a misbehaving peer cannot grow the buffer without bound.
 */

import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export interface NdjsonReaderOptions {
	/** Largest accepted line in UTF-16 code units (≈ bytes for JSON). Default 64 MiB. */
	maxLineLength?: number;
	/** Called once when a line exceeds the cap. The partial line is discarded. */
	onOverflow?: () => void;
}

/** Attach a reader; `onValue` gets each parsed JSON value, `onInvalid` each unparsable line. */
export function attachNdjsonReader(
	stream: Readable,
	onValue: (value: unknown) => void,
	onInvalid?: (line: string) => void,
	options: NdjsonReaderOptions = {},
): () => void {
	const maxLine = options.maxLineLength ?? 64 * 1024 * 1024;
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	/** Length of `buffer` already known to hold no newline: a long line is scanned once, not per chunk. */
	let scanned = 0;
	let discarding = false;

	const emit = (raw: string) => {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.trim().length === 0) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			onInvalid?.(line);
			return;
		}
		onValue(value);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		let start = 0;
		let nl = buffer.indexOf("\n", scanned);
		while (nl !== -1) {
			const line = buffer.slice(start, nl);
			start = nl + 1;
			if (discarding) discarding = false;
			else emit(line);
			nl = buffer.indexOf("\n", start);
		}
		buffer = start === 0 ? buffer : buffer.slice(start);
		scanned = buffer.length;
		if (buffer.length > maxLine) {
			buffer = "";
			scanned = 0;
			if (!discarding) {
				discarding = true;
				options.onOverflow?.();
			}
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0 && !discarding) emit(buffer);
		buffer = "";
	};

	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

/** Serialize one NDJSON record. */
export function ndjson(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}
