import type { WorkspaceStateRecord } from "./types.ts";

type Subscriber = (record: WorkspaceStateRecord | undefined) => void;

/**
 * Deep-copy a record for handing out.
 *
 * A shallow spread would leave `open_items` and `feads` shared with the copy that was
 * appended to the session, so a consumer mutating either would silently rewrite what
 * every other consumer sees and what the durable entry meant.
 */
function snapshot(record: WorkspaceStateRecord): WorkspaceStateRecord {
	return {
		...record,
		...(record.open_items ? { open_items: [...record.open_items] } : {}),
		...(record.feads ? { feads: { ...record.feads } } : {}),
	};
}

/**
 * The one in-process holder of the latest applicable workspace-state record.
 *
 * Two other built-in extensions consume it (`superview-feed` publishes it on the feed,
 * `feads-agent` writes the awaiting-human case to the board) and both must see exactly
 * what the emitter appended, not their own reconstruction of it. It also owns
 * **supersession**: the contract says a record stops applying the moment a new turn
 * starts, so `clear()` at `agent_start` is what makes a stale question disappear from
 * every consumer at once instead of per-consumer.
 */
export class WorkspaceStateStore {
	private record: WorkspaceStateRecord | undefined;
	/**
	 * Keyed, not a set: extensions are re-loaded on session replacement and `ctx.reload()`,
	 * and a plain add would leave the previous session's sink subscribed — every awaiting-human
	 * record would then be written to the board once per reload.
	 */
	private readonly subscribers = new Map<string, Subscriber>();

	/** The latest record while it still applies, or undefined once a new turn started. */
	get current(): WorkspaceStateRecord | undefined {
		return this.record ? snapshot(this.record) : undefined;
	}

	publish(record: WorkspaceStateRecord): void {
		// Copy on the way in too: the caller keeps its own reference to the record it appended.
		this.record = snapshot(record);
		this.notify();
	}

	/** Supersede the current record (a new turn started, or the session was replaced). */
	clear(): void {
		if (this.record === undefined) return;
		this.record = undefined;
		this.notify();
	}

	/** Subscribe under `key`, replacing any earlier subscriber registered with the same key. */
	subscribe(key: string, subscriber: Subscriber): () => void {
		this.subscribers.set(key, subscriber);
		return () => {
			if (this.subscribers.get(key) === subscriber) this.subscribers.delete(key);
		};
	}

	private notify(): void {
		for (const subscriber of this.subscribers.values()) {
			try {
				// Per subscriber, so one mutating its copy cannot affect the next.
				subscriber(this.current);
			} catch {
				// A consumer must never affect the emitter or the session lifecycle.
			}
		}
	}
}

export const workspaceStateStore = new WorkspaceStateStore();
