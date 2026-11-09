/**
 * Emission limits of phi remote (docs/remote-protocol.md) and a keyed, trailing-edge throttle.
 */

/** Item upserts (streaming text, partial tool output): at most 8 per second per item. */
export const ITEM_INTERVAL_MS = 125;
/** `state` events: at most 4 per second, trailing edge (the final state is always delivered). */
export const STATE_INTERVAL_MS = 250;
/** Session summary upserts: at most 2 per second. */
export const SUMMARY_INTERVAL_MS = 500;

interface Slot {
	lastSent: number;
	timer?: ReturnType<typeof setTimeout>;
	build?: () => void;
}

/**
 * One slot per key: `schedule` runs `fire` at once when the key's interval has passed (or
 * `immediate`), else once at the end of the interval with the latest `fire` (trailing edge).
 */
export class KeyedThrottle {
	private readonly slots = new Map<string, Slot>();
	private readonly now: () => number;
	private readonly guard: (fn: () => void) => void;

	constructor(now: () => number, guard: (fn: () => void) => void) {
		this.now = now;
		this.guard = guard;
	}

	schedule(key: string, intervalMs: number, fire: () => void, immediate: boolean): void {
		let slot = this.slots.get(key);
		if (!slot) {
			slot = { lastSent: 0 };
			this.slots.set(key, slot);
		}
		slot.build = fire;
		const elapsed = this.now() - slot.lastSent;
		if (immediate || elapsed >= intervalMs) {
			this.flushSlot(slot);
			return;
		}
		if (slot.timer) return;
		const pending = slot;
		pending.timer = setTimeout(() => {
			pending.timer = undefined;
			this.guard(() => this.flushSlot(pending));
		}, intervalMs - elapsed);
		pending.timer.unref?.();
	}

	/** Forget a key (its pending trailing call is dropped). */
	delete(key: string): void {
		const slot = this.slots.get(key);
		if (slot?.timer) clearTimeout(slot.timer);
		this.slots.delete(key);
	}

	/** Run pending trailing calls now (all of them, or the keys with this prefix). */
	flush(prefix = ""): void {
		for (const [key, slot] of this.slots) {
			if (slot.build && key.startsWith(prefix)) this.guard(() => this.flushSlot(slot));
		}
	}

	/** Drop pending calls and forget the keys (all of them, or the keys with this prefix). */
	cancel(prefix = ""): void {
		for (const [key, slot] of this.slots) {
			if (!key.startsWith(prefix)) continue;
			if (slot.timer) clearTimeout(slot.timer);
			this.slots.delete(key);
		}
	}

	private flushSlot(slot: Slot): void {
		if (slot.timer) clearTimeout(slot.timer);
		slot.timer = undefined;
		const build = slot.build;
		slot.build = undefined;
		if (!build) return;
		slot.lastSent = this.now();
		build();
	}
}
