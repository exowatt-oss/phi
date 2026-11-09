import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { FeadsPresencePublisher, type PresencePublisher } from "./feads-agent/presence-publisher.ts";
import { feadsSessionState } from "./feads-agent/session-state.ts";

export const SUPERVIEW_SOCKET_PATH = join(homedir(), ".pi", "agent", "superview.sock");
export const SUPERVIEW_SPOOL_PATH = join(homedir(), ".pi", "agent", "superview-feed.jsonl");
const MAX_SPOOL_BYTES = 5 * 1024 * 1024;

/** Best-effort, fire-and-forget transport for the local superview observer. */
export interface SuperviewTransportOptions {
	socketPath?: string;
	spoolPath?: string;
	/** Parent durable session whose transports share one Feads publisher. */
	parentSessionId?: string;
	/** Set to null to disable the optional Feads tee for local-only tests or callers. */
	feadsPublisher?: PresencePublisher | null;
}

type SharedFeadsPublisher = { publisher: FeadsPresencePublisher; references: number };
const sharedFeadsPublishers = new Map<string, SharedFeadsPublisher>();

function acquireFeadsPublisher(parentSessionId?: string): {
	publisher: PresencePublisher;
	release: () => void;
} {
	const key = parentSessionId ?? feadsSessionState.current.sessionId ?? "unknown";
	let shared = sharedFeadsPublishers.get(key);
	if (!shared) {
		shared = { publisher: new FeadsPresencePublisher(), references: 0 };
		sharedFeadsPublishers.set(key, shared);
	}
	shared.references++;
	let released = false;
	return {
		publisher: shared.publisher,
		release: () => {
			if (released) return;
			released = true;
			shared!.references--;
			if (shared!.references > 0) return;
			sharedFeadsPublishers.delete(key);
			shared!.publisher.dispose();
		},
	};
}

export class SuperviewTransport {
	private readonly socketPath: string;
	private readonly spoolPath: string;
	private readonly feadsPublisher: PresencePublisher | undefined;
	private readonly releaseFeadsPublisher: (() => void) | undefined;
	private socket: Socket | undefined;
	private disposed = false;

	constructor(options: SuperviewTransportOptions = {}) {
		this.socketPath = options.socketPath ?? process.env.PI_SUPERVIEW_SOCKET_PATH ?? SUPERVIEW_SOCKET_PATH;
		this.spoolPath = options.spoolPath ?? process.env.PI_SUPERVIEW_SPOOL_PATH ?? SUPERVIEW_SPOOL_PATH;
		if (options.feadsPublisher === null) {
			this.feadsPublisher = undefined;
			this.releaseFeadsPublisher = undefined;
		} else if (options.feadsPublisher) {
			this.feadsPublisher = options.feadsPublisher;
			this.releaseFeadsPublisher = undefined;
		} else {
			const lease = acquireFeadsPublisher(options.parentSessionId);
			this.feadsPublisher = lease.publisher;
			this.releaseFeadsPublisher = lease.release;
		}
	}
	private queue: string[] = [];
	private flushing = false;
	private reconnectAfter = 0;

	publish(event: unknown): void {
		try {
			this.queue.push(`${JSON.stringify(event)}\n`);
			this.flush();
		} catch {
			// Local telemetry must never affect the agent.
		}
		try {
			// Feads is an optional tee. It receives the original event only after the
			// local socket/spool path has accepted it, and it must never affect that path.
			this.feadsPublisher?.publish(event);
		} catch {
			// Remote presence is advisory and fail-open.
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.socket?.destroy();
		this.socket = undefined;
		this.queue = [];
		try {
			if (this.releaseFeadsPublisher) this.releaseFeadsPublisher();
			else this.feadsPublisher?.dispose();
		} catch {
			// Remote cleanup is best effort.
		}
	}

	private flush(): void {
		if (this.flushing || this.queue.length === 0) return;
		this.flushing = true;
		const line = this.queue.shift()!;
		void this.writeSocket(line)
			.then((sent) => {
				if (!sent) void this.writeSpool(line);
			})
			.catch(() => undefined)
			.finally(() => {
				this.flushing = false;
				this.flush();
			});
	}

	private async writeSocket(line: string): Promise<boolean> {
		if (!this.socket && Date.now() >= this.reconnectAfter) {
			this.socket = await new Promise<Socket | undefined>((resolve) => {
				const socket = createConnection(this.socketPath);
				const fail = () => {
					socket.destroy();
					resolve(undefined);
				};
				socket.once("connect", () => resolve(socket));
				socket.once("error", fail);
			});
			if (!this.socket) {
				this.reconnectAfter = Date.now() + 1000;
				return false;
			}
			this.socket.on("error", () => {
				this.socket?.destroy();
				this.socket = undefined;
			});
			this.socket.on("close", () => {
				this.socket = undefined;
			});
		}
		if (!this.socket || !this.socket.writable) {
			this.socket?.destroy();
			this.socket = undefined;
			return false;
		}
		return new Promise((resolve) => {
			this.socket!.write(line, (error) => {
				if (error) {
					this.socket?.destroy();
					this.socket = undefined;
					resolve(false);
				} else resolve(true);
			});
		});
	}

	private async writeSpool(line: string): Promise<void> {
		try {
			await mkdir(join(this.spoolPath, ".."), { recursive: true });
			try {
				const info = await stat(this.spoolPath);
				if (info.size + Buffer.byteLength(line) > MAX_SPOOL_BYTES) {
					await rename(this.spoolPath, `${this.spoolPath}.1`).catch(() => undefined);
				}
			} catch {
				/* file does not exist */
			}
			await appendFile(this.spoolPath, line, "utf8");
		} catch {
			/* inaccessible telemetry path */
		}
	}
}
