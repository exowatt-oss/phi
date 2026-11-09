/**
 * App-connection lines for hub.log: one line per upgrade, hello, failure, missed pong and close,
 * so a phone that shows the computer offline leaves a trace on the hub side.
 *
 * A reconnect storm must not flood the log. Per remote IP and kind of line, at most `limit` lines
 * per `windowMs` (default 1 s) are written: 1 for failures and missed pongs, 4 for connects, hellos
 * and closes (an app may race two URLs of one hub). Lines dropped that way are counted, and the
 * next line of that kind from that IP says how many (`+N suppressed`). Lines never carry tokens or
 * headers.
 */

export type ConnLogKind = "connect" | "hello" | "fail" | "pong" | "close";

const LIMITS: Record<ConnLogKind, number> = { connect: 4, hello: 4, close: 4, fail: 1, pong: 1 };

/** Throttled entries kept at most (a scan from many addresses cannot grow the map unboundedly). */
const MAX_KEYS = 1024;

interface ThrottleEntry {
	start: number;
	count: number;
	suppressed: number;
}

export class ConnLog {
	private readonly write: (line: string) => void;
	private readonly windowMs: number;
	private readonly now: () => number;
	private readonly entries = new Map<string, ThrottleEntry>();

	constructor(write: (line: string) => void, options: { windowMs?: number; now?: () => number } = {}) {
		this.write = write;
		this.windowMs = options.windowMs ?? 1000;
		this.now = options.now ?? Date.now;
	}

	/** Write `line` unless this kind of line from `ip` is over its limit for the current window. */
	line(kind: ConnLogKind, ip: string, line: string): boolean {
		const key = `${kind} ${ip}`;
		const now = this.now();
		let entry = this.entries.get(key);
		if (entry && now - entry.start >= this.windowMs) {
			entry.start = now;
			entry.count = 0;
		}
		if (entry && entry.count >= LIMITS[kind]) {
			entry.suppressed++;
			return false;
		}
		if (!entry) {
			if (this.entries.size >= MAX_KEYS) this.prune(now);
			entry = { start: now, count: 0, suppressed: 0 };
			this.entries.set(key, entry);
		}
		const suppressed = entry.suppressed;
		entry.count++;
		entry.suppressed = 0;
		this.write(suppressed > 0 ? `${line} (+${suppressed} suppressed)` : line);
		return true;
	}

	private prune(now: number): void {
		for (const [key, entry] of this.entries) {
			if (now - entry.start >= this.windowMs && entry.suppressed === 0) this.entries.delete(key);
		}
		// Still full: drop the oldest windows (Map keeps insertion order).
		while (this.entries.size >= MAX_KEYS) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}
}

/** `1.2.3.4:5678`, `[fd7a::1]:5678`; an IPv4-mapped IPv6 address is shown as IPv4. */
export function formatAddr(address: string | undefined, port: number | undefined): string {
	const ip = plainIp(address);
	const host = ip.includes(":") ? `[${ip}]` : ip;
	return port === undefined ? host : `${host}:${port}`;
}

export function plainIp(address: string | undefined): string {
	if (!address) return "?";
	return address.startsWith("::ffff:") && address.includes(".") ? address.slice(7) : address;
}

/** `850ms`, `12.3s`, `4m05s`, `2h03m`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.floor(ms / 1000);
	if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** A client-supplied value as a short, single-line, quoted log field. */
export function logValue(value: unknown, max = 40): string {
	if (typeof value !== "string" && typeof value !== "number") return "?";
	const text = String(value)
		.replace(/[\u0000-\u001f\u007f"\\]/g, "")
		.slice(0, max);
	return text || "?";
}
