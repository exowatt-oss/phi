/**
 * One-time pairing codes and the `/v1/pair` rate limiter.
 *
 * Codes: 8 characters of Crockford base32 (no I/L/O/U), single use, 10-minute TTL, minted only
 * over the local socket. Input is case-insensitive; spaces/hyphens are ignored and the Crockford
 * look-alikes (O→0, I/L→1) are folded so a hand-typed code still matches.
 */

import { randomInt } from "node:crypto";

export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIR_CODE_LENGTH = 8;
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_OUTSTANDING_CODES = 32;

export function generatePairCode(): string {
	let code = "";
	for (let i = 0; i < PAIR_CODE_LENGTH; i++) code += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)];
	return code;
}

export function normalizePairCode(input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
	if (code.length !== PAIR_CODE_LENGTH) return undefined;
	for (const ch of code) if (!CROCKFORD_ALPHABET.includes(ch)) return undefined;
	return code;
}

export class PairCodes {
	private readonly codes = new Map<string, number>();
	private readonly ttlMs: number;

	constructor(ttlMs = PAIR_CODE_TTL_MS) {
		this.ttlMs = ttlMs;
	}

	create(now = Date.now()): { code: string; expiresAt: number } {
		this.prune(now);
		while (this.codes.size >= MAX_OUTSTANDING_CODES) {
			const oldest = this.codes.keys().next().value;
			if (oldest === undefined) break;
			this.codes.delete(oldest);
		}
		let code = generatePairCode();
		while (this.codes.has(code)) code = generatePairCode();
		const expiresAt = now + this.ttlMs;
		this.codes.set(code, expiresAt);
		return { code, expiresAt };
	}

	/** Consume a code: true once for a live code, false for unknown/expired/reused. */
	redeem(input: unknown, now = Date.now()): boolean {
		const code = normalizePairCode(input);
		if (!code) return false;
		const expiresAt = this.codes.get(code);
		if (expiresAt === undefined) return false;
		this.codes.delete(code);
		return expiresAt > now;
	}

	private prune(now: number): void {
		for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
	}
}

/** Sliding-window limiter: at most `limit` attempts per `windowMs` per key. */
export class RateLimiter {
	private readonly hits = new Map<string, number[]>();
	private readonly limit: number;
	private readonly windowMs: number;

	constructor(limit = 5, windowMs = 60_000) {
		this.limit = limit;
		this.windowMs = windowMs;
	}

	/** Record an attempt; false when the key is over the limit (the attempt is not counted). */
	take(key: string, now = Date.now()): boolean {
		const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
		if (recent.length >= this.limit) {
			this.hits.set(key, recent);
			return false;
		}
		recent.push(now);
		this.hits.set(key, recent);
		if (this.hits.size > 1024) this.sweep(now);
		return true;
	}

	private sweep(now: number): void {
		for (const [key, times] of this.hits) {
			if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
		}
	}
}
