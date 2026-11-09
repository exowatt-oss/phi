/**
 * The overseer's link to the phi remote hub (`hub.sock` ctl frames).
 *
 * Reads (`sessions.list`, snapshots, transcripts) share one long-lived connection that is
 * re-opened once when it dropped; they are idempotent, so a retry is safe. Everything that
 * changes a session runs on its own short connection and is never retried (it may have reached
 * the hub). When no hub listens, actions start it the way `/remote` does and connect once more;
 * the background monitor never starts a hub.
 */

import { HubControlError } from "../../remote/hub/control.ts";
import type { HubControlOp } from "../../remote/hub/frames.ts";
import type { CtlClientLike, OverseerDeps } from "./types.ts";

const CONNECTION_CLOSED = "hub connection closed";

function isConnectionLoss(error: unknown): boolean {
	return error instanceof HubControlError && error.code === "session_offline" && error.message === CONNECTION_CLOSED;
}

/** Hub error with an actionable message for the model. */
export function hubError(op: string, error: unknown): Error {
	if (error instanceof HubControlError) {
		if (error.code === "bad_request" && /unknown control op/i.test(error.message)) {
			return new Error(
				`The running phi remote hub does not support "${op}" (it predates overseer control). It picks up this phi version when it restarts (phi remote stop, then phi remote start; headless sessions it runs end).`,
			);
		}
		return new Error(`hub ${op}: ${error.code}: ${error.message}`);
	}
	return error instanceof Error ? error : new Error(String(error));
}

export class HubConnection {
	private shared: CtlClientLike | undefined;
	private opening: Promise<CtlClientLike> | undefined;
	private openingStarts = false;
	private readonly deps: Pick<OverseerDeps, "connect" | "startHub" | "hubLog">;

	constructor(deps: Pick<OverseerDeps, "connect" | "startHub" | "hubLog">) {
		this.deps = deps;
	}

	/** Connect; with `start`, start the hub when none listens and connect once more. */
	async open(start: boolean): Promise<CtlClientLike> {
		try {
			return await this.deps.connect();
		} catch (first) {
			if (!start) {
				const reason = first instanceof Error ? first.message : String(first);
				throw new Error(`The phi remote hub is not reachable (${reason}).`);
			}
			const started = await this.deps.startHub().catch(() => "failed" as const);
			try {
				return await this.deps.connect();
			} catch (second) {
				const reason = second instanceof Error ? second.message : String(second);
				throw new Error(
					`The phi remote hub is not running and ${started === "failed" ? "could not be started" : "did not accept a connection after starting"} (${reason}). See ${this.deps.hubLog()}; start it with \`phi remote start\`.`,
				);
			}
		}
	}

	private begin(start: boolean): Promise<CtlClientLike> {
		const pending: Promise<CtlClientLike> = this.open(start).finally(() => {
			if (this.opening === pending) this.opening = undefined;
		});
		this.opening = pending;
		this.openingStarts = start;
		return pending;
	}

	private async sharedClient(start: boolean): Promise<CtlClientLike> {
		if (this.shared) return this.shared;
		const pending = this.opening;
		let client: CtlClientLike;
		if (!pending) client = await this.begin(start);
		else if (this.openingStarts || !start) client = await pending;
		// A concurrent non-starting open (the monitor) may fail where this caller may start the hub.
		else client = await pending.catch(() => this.begin(true));
		if (this.shared && this.shared !== client) {
			client.close();
			return this.shared;
		}
		this.shared = client;
		return client;
	}

	/** Idempotent request on the shared connection (re-opened once if it dropped). */
	async read<T>(op: HubControlOp, options: { timeoutMs?: number; start?: boolean } = {}): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const client = await this.sharedClient(options.start ?? false);
			try {
				return await client.request<T>(op, options.timeoutMs ?? 10_000);
			} catch (error) {
				if (!isConnectionLoss(error) || attempt > 0) throw hubError(op.op, error);
				this.drop(client);
			}
		}
	}

	/** Mutating request on its own connection; never retried. */
	async call<T>(op: HubControlOp, timeoutMs = 15_000): Promise<T> {
		const client = await this.open(true);
		try {
			return await client.request<T>(op, timeoutMs);
		} catch (error) {
			throw hubError(op.op, error);
		} finally {
			client.close();
		}
	}

	private drop(client: CtlClientLike): void {
		if (this.shared === client) this.shared = undefined;
		try {
			client.close();
		} catch {
			// already closed
		}
	}

	close(): void {
		const client = this.shared;
		this.shared = undefined;
		if (client) this.drop(client);
	}
}
