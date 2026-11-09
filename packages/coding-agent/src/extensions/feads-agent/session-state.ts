import { uuidv7 } from "@earendil-works/pi-ai";

const NO_FEADS_ENV = "PI_NO_FEADS";

export type FeadsDisableReason = "environment" | "command";

export interface FeadsSessionSnapshot {
	sessionId: string | undefined;
	runtimeId: string | undefined;
	disabled: boolean;
	disabledReason: FeadsDisableReason | undefined;
}

type SessionStartMarker = object;
type Subscriber = (snapshot: FeadsSessionSnapshot) => void;

function copy(snapshot: FeadsSessionSnapshot): FeadsSessionSnapshot {
	return { ...snapshot };
}

/** Shared runtime identity and guard state for Feads-aware extensions. */
export class FeadsSessionState {
	private snapshot: FeadsSessionSnapshot = {
		sessionId: undefined,
		runtimeId: undefined,
		disabled: process.env[NO_FEADS_ENV] === "1",
		disabledReason: process.env[NO_FEADS_ENV] === "1" ? "environment" : undefined,
	};
	private lastStartMarker: SessionStartMarker | undefined;
	private readonly subscribers = new Set<Subscriber>();

	get current(): FeadsSessionSnapshot {
		return copy(this.snapshot);
	}

	/**
	 * Begin one real session-start generation. The marker makes several built-in
	 * listeners observing the same event share one UUID, while a later event with
	 * the same durable session id still gets a fresh runtime incarnation.
	 */
	startSession(sessionId: string, marker?: SessionStartMarker): FeadsSessionSnapshot {
		if (marker && marker === this.lastStartMarker && this.snapshot.sessionId === sessionId) {
			return this.current;
		}

		this.lastStartMarker = marker;
		this.snapshot = {
			sessionId,
			runtimeId: uuidv7(),
			disabled: process.env[NO_FEADS_ENV] === "1",
			disabledReason: process.env[NO_FEADS_ENV] === "1" ? "environment" : undefined,
		};
		delete process.env[NO_FEADS_ENV];
		this.notify();
		return this.current;
	}

	/** Ensure standalone listeners have a generation without replacing one started by Feads. */
	ensureSession(sessionId: string, marker?: SessionStartMarker): FeadsSessionSnapshot {
		if (
			this.snapshot.runtimeId === undefined ||
			this.snapshot.sessionId !== sessionId ||
			(marker !== undefined && marker === this.lastStartMarker)
		) {
			return this.startSession(sessionId, marker);
		}
		return this.current;
	}

	disable(reason: FeadsDisableReason = "command"): void {
		if (this.snapshot.disabled && this.snapshot.disabledReason === reason) return;
		this.snapshot = { ...this.snapshot, disabled: true, disabledReason: reason };
		this.notify();
	}

	subscribe(subscriber: Subscriber): () => void {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}

	private notify(): void {
		const snapshot = this.current;
		for (const subscriber of this.subscribers) {
			try {
				subscriber(snapshot);
			} catch {
				// A telemetry subscriber must never affect the session lifecycle.
			}
		}
	}
}

export const feadsSessionState = new FeadsSessionState();

export const __testing = { NO_FEADS_ENV };
