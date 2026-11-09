/**
 * The heartbeat: while this overseer has threads, poll the hub's `sessions.list` (one local socket
 * request every 15 s), detect per-thread transitions and wake the overseer with ONE batched
 * `overseer_event` message per ~3 s window.
 *
 * - idle: working → idle (or a turn finished between two polls), with the last reply (≤ 1,500
 *   chars), when `watch.onIdle`;
 * - error: `summary.lastError` appeared (once per distinct error);
 * - stalled: working and `lastActivityAt` unchanged for `stallMinutes` (once per stall);
 * - exited: registered before, gone from the hub now, and its process is gone;
 * - heartbeat: a board digest every `heartbeatMinutes` while any thread works (opt-in).
 *
 * Never throws into the session: a failed poll marks the hub as down and tries again next tick.
 */

import type { CtlSessionsData, CtlSnapshotData, SessionSummary } from "../../remote/protocol.ts";
import type { HubConnection } from "./ctl.ts";
import {
	clip,
	formatAge,
	formatBoard,
	IDLE_REPLY_LIMIT,
	lastAssistantModel,
	lastAssistantText,
	toolActivityText,
} from "./format.ts";
import { modelLabel } from "./model.ts";
import { applySummary, type ThreadRegistry } from "./registry.ts";
import type { OverseerEvent, ThreadRecord } from "./types.ts";

export const POLL_MS = 15_000;
export const COALESCE_MS = 3_000;
/** Activity this long after a sent message, seen idle, means the reply turn already ended. */
const AWAIT_SLACK_MS = 2_000;

export interface MonitorHost {
	registry(): ThreadRegistry | undefined;
	hub: Pick<HubConnection, "read">;
	now(): number;
	pidAlive(pid: number): boolean;
	/** Deliver one batch (pi.sendMessage). */
	wake(events: OverseerEvent[]): void;
	/** Footer status; undefined clears it. */
	status(text: string | undefined): void;
}

export class ThreadMonitor {
	private timer: ReturnType<typeof setInterval> | undefined;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private pending: OverseerEvent[] = [];
	private polling: Promise<void> | undefined;
	private lastHeartbeatAt: number | undefined;
	private readonly expectIdle = new Set<string>();
	private disposed = false;
	/** Last `sessions.list` result by session id (empty until the first successful poll). */
	live = new Map<string, SessionSummary>();
	hubDown = false;
	private readonly host: MonitorHost;

	constructor(host: MonitorHost) {
		this.host = host;
	}

	get running(): boolean {
		return this.timer !== undefined;
	}

	/** Start polling when there are threads to watch, stop when there are none. */
	sync(): void {
		if (this.disposed) return;
		const active = this.host.registry()?.active().length ?? 0;
		if (active > 0 && !this.timer) {
			this.timer = setInterval(() => void this.poll(), POLL_MS);
			this.timer.unref?.();
		} else if (active === 0 && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.updateStatus();
	}

	/** The next working → idle of this thread is the overseer's own doing (abort): do not report it. */
	expectIdleOf(sessionId: string): void {
		this.expectIdle.add(sessionId);
	}

	/** One poll; concurrent callers share it. Never rejects. */
	poll(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (!this.polling) {
			this.polling = this.pollOnce()
				.catch(() => undefined)
				.finally(() => {
					this.polling = undefined;
				});
		}
		return this.polling;
	}

	private async pollOnce(): Promise<void> {
		const registry = this.host.registry();
		if (!registry || registry.active().length === 0) {
			this.sync();
			return;
		}
		let sessions: SessionSummary[];
		try {
			sessions = (await this.host.hub.read<CtlSessionsData>({ op: "sessions.list" })).sessions ?? [];
		} catch {
			this.hubDown = true;
			this.updateStatus();
			return;
		}
		if (this.disposed) return;
		this.hubDown = false;
		const events = await this.observe(registry, sessions);
		try {
			registry.save();
		} catch {
			// The registry is advisory; a failed write is retried on the next poll.
		}
		if (events.length) this.queue(events);
		this.sync();
	}

	/** Apply one `sessions.list` result to the registry and return the transitions it shows. */
	async observe(registry: ThreadRegistry, sessions: readonly SessionSummary[]): Promise<OverseerEvent[]> {
		const now = this.host.now();
		this.live = new Map(sessions.map((summary) => [summary.sessionId, summary]));
		registry.rematch(sessions, now);
		const events: OverseerEvent[] = [];
		for (const record of registry.active()) {
			const summary = this.live.get(record.sessionId);
			const event = summary ? await this.observeLive(record, summary, now) : this.observeMissing(record, now);
			if (event) events.push(event);
		}
		const heartbeat = this.heartbeat(registry, now);
		if (heartbeat) events.push(heartbeat);
		return events;
	}

	private observeMissing(record: ThreadRecord, now: number): OverseerEvent | undefined {
		if (record.state !== "running" || !record.registered) return undefined;
		if (record.pid && this.host.pidAlive(record.pid)) return undefined; // re-registering (hub restart)
		record.state = "exited";
		record.exitedAt = now;
		record.lastStatus = undefined;
		const hints: string[] = [];
		if (record.terminal)
			hints.push(`FORCA tab may still be open: forca terminal read --terminal ${record.terminal} --screen`);
		if (record.tmuxSession) hints.push(`tmux session: tmux capture-pane -p -t ${record.tmuxSession}`);
		hints.push(`resume it with overseer {action:"resume", target:"${record.name}"}, or close it`);
		return {
			kind: "exited",
			thread: record.name,
			sessionId: record.sessionId,
			at: now,
			summary: "the session left the hub and its process is gone",
			text: hints.join("\n"),
		};
	}

	private async observeLive(
		record: ThreadRecord,
		summary: SessionSummary,
		now: number,
	): Promise<OverseerEvent | undefined> {
		const prevStatus = record.lastStatus;
		const prevText = record.lastText;
		const prevActivity = record.lastActivityAt;
		record.state = "running";
		delete record.exitedAt;
		applySummary(record, summary, now);
		const base = { thread: record.name, sessionId: record.sessionId, at: now };
		const current = summary.model
			? modelLabel(`${summary.model.provider}/${summary.model.id}`, summary.thinkingLevel)
			: undefined;
		// Label a turn with the model it started on, not the one the thread has now (a `model`
		// switch mid-turn applies from the next turn).
		if (summary.status === "working" && record.turnModel === undefined && current) record.turnModel = current;
		const turnModel = record.turnModel;
		if (summary.status !== "working") delete record.turnModel;
		const model = turnModel ?? current;

		if (summary.lastError && summary.lastError !== record.notifiedError) {
			record.notifiedError = summary.lastError;
			// The overseer aborted (or closed) this turn: however the turn ended, that is not news.
			if (this.expectIdle.delete(record.sessionId) && summary.status !== "working") return undefined;
			return {
				...base,
				kind: "error",
				summary: `the last turn ended in an error${model ? ` (${model})` : ""}`,
				text: summary.lastError,
			};
		}
		if (!summary.lastError) delete record.notifiedError;

		if (summary.status === "working") {
			delete record.awaitingReplySince;
			if (record.watch.stallMinutes > 0) {
				const quiet = now - summary.lastActivityAt;
				if (quiet >= record.watch.stallMinutes * 60_000 && record.notifiedStallAt !== summary.lastActivityAt) {
					record.notifiedStallAt = summary.lastActivityAt;
					const tool = summary.activity ? ` (${toolActivityText(summary.activity, 100)})` : "";
					return { ...base, kind: "stalled", summary: `working with no activity for ${formatAge(quiet)}${tool}` };
				}
			}
			return undefined;
		}

		// A turn can start and end between two polls: a changed reply, or activity well after a message
		// this overseer sent, counts as a finished turn too. (The hub moves lastActivityAt on every
		// working/idle change.)
		const awaiting = record.awaitingReplySince;
		const finished =
			prevStatus === "working" ||
			(summary.lastText !== undefined && summary.lastText !== prevText && summary.lastActivityAt !== prevActivity) ||
			(awaiting !== undefined && summary.lastActivityAt >= awaiting + AWAIT_SLACK_MS);
		if (!finished) return undefined;
		delete record.awaitingReplySince;
		if (this.expectIdle.delete(record.sessionId)) return undefined;
		if (!record.watch.onIdle) return undefined;
		const { text: reply, model: replyModel } = await this.lastReply(record, summary);
		// A turn never seen working: the model id stored on its reply wins over a different current
		// model (switched since); its thinking level is unknown then, so none is shown.
		const label = turnModel ?? (replyModel && replyModel !== summary.model?.id ? replyModel : current);
		return {
			...base,
			kind: "idle",
			summary: `turn finished${label ? ` · ${label}` : ""}${summary.usage?.costUsd !== undefined ? ` · $${summary.usage.costUsd.toFixed(2)}` : ""}`,
			text: reply
				? clip(reply, IDLE_REPLY_LIMIT, `overseer read ${record.name} for the rest`)
				: "(no reply text; read the thread for details)",
		};
	}

	/** The last reply and the model id stored on it (from the transcript tail). */
	private async lastReply(
		record: ThreadRecord,
		summary: SessionSummary,
	): Promise<{ text: string | undefined; model?: string }> {
		try {
			const snapshot = await this.host.hub.read<CtlSnapshotData>(
				{ op: "session.snapshot", sessionId: record.sessionId, limit: 8 },
				{ timeoutMs: 5000 },
			);
			const items = snapshot.items ?? [];
			return { text: lastAssistantText(items) ?? summary.lastText, model: lastAssistantModel(items) };
		} catch {
			return { text: summary.lastText };
		}
	}

	private heartbeat(registry: ThreadRegistry, now: number): OverseerEvent | undefined {
		const active = registry.active();
		const minutes = active
			.map((record) => record.watch.heartbeatMinutes)
			.filter((value) => value > 0)
			.reduce<number | undefined>((min, value) => (min === undefined ? value : Math.min(min, value)), undefined);
		if (minutes === undefined) {
			this.lastHeartbeatAt = undefined;
			return undefined;
		}
		const working = active.filter((record) => this.live.get(record.sessionId)?.status === "working").length;
		if (working === 0 || this.lastHeartbeatAt === undefined) {
			this.lastHeartbeatAt = now;
			return undefined;
		}
		if (now - this.lastHeartbeatAt < minutes * 60_000) return undefined;
		this.lastHeartbeatAt = now;
		return {
			kind: "heartbeat",
			thread: "",
			at: now,
			summary: `${active.length} thread${active.length === 1 ? "" : "s"} (${working} working)`,
			text: formatBoard(active, this.live, now),
		};
	}

	/** Coalesce: everything queued within COALESCE_MS goes out as one message. */
	queue(events: OverseerEvent[]): void {
		if (this.disposed || events.length === 0) return;
		this.pending.push(...events);
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => this.flush(), COALESCE_MS);
		this.flushTimer.unref?.();
	}

	flush(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.disposed || this.pending.length === 0) return;
		// One event per thread and kind: the latest wins.
		const byKey = new Map<string, OverseerEvent>();
		for (const event of this.pending) byKey.set(`${event.kind}\u0000${event.thread}`, event);
		this.pending = [];
		try {
			this.host.wake([...byKey.values()]);
		} catch {
			// The session may be shutting down.
		}
	}

	/** `threads 2 working · 1 idle` for the footer; undefined when there are no threads. */
	statusText(): string | undefined {
		const active = this.host.registry()?.active() ?? [];
		if (active.length === 0) return undefined;
		if (this.hubDown) return `threads ${active.length} · hub offline`;
		const counts = { working: 0, idle: 0, exited: 0, starting: 0 };
		for (const record of active) {
			const summary = this.live.get(record.sessionId);
			if (record.state === "exited") counts.exited++;
			else if (summary) counts[summary.status]++;
			else if (!record.registered) counts.starting++;
			else if (record.lastStatus) counts[record.lastStatus]++;
			else counts.idle++;
		}
		const parts = (["working", "idle", "starting", "exited"] as const)
			.filter((key) => counts[key] > 0)
			.map((key) => `${counts[key]} ${key}`);
		return `threads ${parts.join(" · ")}`;
	}

	updateStatus(): void {
		try {
			this.host.status(this.statusText());
		} catch {
			// stale UI context
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.timer = undefined;
		this.flushTimer = undefined;
		this.pending = [];
	}
}
