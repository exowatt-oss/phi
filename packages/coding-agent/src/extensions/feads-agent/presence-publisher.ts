import { type FeadsCredential, type FeadsCredentialSource, resolveFeadsCredential } from "./credential.ts";
import { type FeadsSessionSnapshot, feadsSessionState } from "./session-state.ts";

export type { FeadsCredentialSource } from "./credential.ts";

const DEFAULT_FEADS_URL = "http://127.0.0.1:8788";
export const FEADS_PRESENCE_DEBOUNCE_MS = 250;
export const FEADS_PRESENCE_HEARTBEAT_MS = 30_000;
export const FEADS_PRESENCE_TIMEOUT_MS = 2_500;
export const FEADS_PRESENCE_MAX_ROWS = 64;
export const FEADS_PRESENCE_RETRY_BASE_MS = 1_000;
export const FEADS_PRESENCE_RETRY_MAX_MS = 30_000;
const FEADS_PRESENCE_RETRY_JITTER_MAX_MS = 1_000;

export type FeadsPresenceFailureCategory =
	| "400"
	| "401"
	| "403"
	| "404"
	| "409"
	| "429"
	| "timeout"
	| "network"
	| "other";
/** Rejections that will not fix themselves: alert on the first one. */
const IMMEDIATE_ALERT_CATEGORIES = new Set<FeadsPresenceFailureCategory>(["400", "401", "403", "404", "409"]);
/** Transient categories (timeout, network, 429, 5xx) alert only after this many consecutive failures. */
export const FEADS_PRESENCE_ALERT_AFTER_FAILURES = 3;
export type FeadsPresenceDisabledReason =
	| "token-not-configured"
	| "environment"
	| "command"
	| "publisher-not-started"
	| "publisher-disposed";

export interface FeadsPresenceStatus {
	tokenConfigured: boolean;
	credentialSource: FeadsCredentialSource;
	effectiveHost: string;
	enabled: boolean;
	disabledReason: FeadsPresenceDisabledReason | undefined;
	publisherStarted: boolean;
	lastSuccessfulAcceptedCount: number | undefined;
	lastSuccessfulAt: number | undefined;
	lastFailure: FeadsPresenceFailureCategory | undefined;
	/** HTTP status of the last failed response; undefined for transport failures. */
	lastFailureStatusCode: number | undefined;
	/** Failures since the last accepted request. */
	consecutiveFailures: number;
}

/** One-line, user-facing warning that this session's heartbeats are failing. */
export interface FeadsPresenceAlert {
	category: FeadsPresenceFailureCategory;
	statusCode: number | undefined;
	consecutiveFailures: number;
	message: string;
}

export type FeadsPresenceAlertListener = (alert: FeadsPresenceAlert) => void;

export type SafeActivityPhase = "starting" | "thinking" | "done" | "failed" | "aborted";
export type SafeActivity = SafeActivityPhase | { kind: "tool"; name: string };

export interface FeadsPresenceRow {
	session_id: string;
	runtime_id: string;
	run_id: string;
	parent_run_id: string;
	kind: "main" | "subagent";
	handle: string;
	display_name: string;
	status: "working" | "idle" | "done" | "failed" | "aborted" | "unknown";
	model: string;
	activity: string;
	context_percent: number;
	started_at: number;
	/** Launching ADE (e.g. `p3`, `forca`); omitted when unknown. */
	client?: string;
}

export interface FeadsPresencePublisherOptions {
	token?: string;
	url?: string;
	debounceMs?: number;
	heartbeatMs?: number;
	timeoutMs?: number;
}

export interface PresencePublisher {
	publish(event: unknown): void;
	dispose(): void;
}

type AgentRecord = Record<string, unknown>;
type PresenceStatus = FeadsPresenceRow["status"];
type PendingRequest = { controller: AbortController; suppressDiagnostic: boolean };
type MutableFeadsPresenceStatus = FeadsPresenceStatus;

function usableToken(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const token = value.trim();
	return token.length > 0 ? token : undefined;
}

type PresenceClientEnvironment = Partial<Pick<NodeJS.ProcessEnv, "PHI_CLIENT" | "TERM_PROGRAM">>;

function resolvePresenceClient(environment: PresenceClientEnvironment = process.env): string | undefined {
	const explicit = environment.PHI_CLIENT?.trim().toLowerCase();
	if (explicit && explicit.length <= 32 && /^[a-z0-9][a-z0-9-]*$/u.test(explicit)) return explicit;
	return environment.TERM_PROGRAM === "Orca" ? "forca" : undefined;
}

function resolvePresenceCredential(): FeadsCredential {
	return resolveFeadsCredential({ includeLegacy: true });
}

function hasConfiguredToken(token: string | undefined): boolean {
	return usableToken(token) !== undefined;
}

function explicitCredential(value: string): FeadsCredential {
	const token = usableToken(value);
	return { token, source: token ? "canonical" : "none" };
}

function effectiveHost(value: string | undefined, token?: string): string {
	try {
		const parsed = new URL(value ?? DEFAULT_FEADS_URL);
		const host = parsed.host;
		return host && (!token || !host.includes(token)) ? host : host ? "redacted" : "invalid";
	} catch {
		return "invalid";
	}
}

function statusForConfig(
	token: string | undefined,
	url: string | undefined,
	snapshot = feadsSessionState.current,
	credentialSource: FeadsCredentialSource = token ? "canonical" : "none",
): MutableFeadsPresenceStatus {
	const tokenConfigured = hasConfiguredToken(token);
	return {
		tokenConfigured,
		credentialSource,
		effectiveHost: effectiveHost(url, token),
		enabled: false,
		disabledReason: !tokenConfigured
			? "token-not-configured"
			: snapshot.disabled
				? snapshot.disabledReason === "environment"
					? "environment"
					: "command"
				: "publisher-not-started",
		publisherStarted: false,
		lastSuccessfulAcceptedCount: undefined,
		lastSuccessfulAt: undefined,
		lastFailure: undefined,
		lastFailureStatusCode: undefined,
		consecutiveFailures: 0,
	};
}

const initialCredential = resolvePresenceCredential();
let presenceStatus = statusForConfig(
	initialCredential.token,
	process.env.FEADS_URL,
	feadsSessionState.current,
	initialCredential.source,
);

function resetPresenceStatus(
	token: string | undefined,
	url: string,
	credentialSource: FeadsCredentialSource = token ? "canonical" : "none",
): void {
	presenceStatus = statusForConfig(token, url, feadsSessionState.current, credentialSource);
}

function statusDisabledReason(
	snapshot: FeadsSessionSnapshot,
	token: string | undefined,
): FeadsPresenceDisabledReason | undefined {
	if (!hasConfiguredToken(token)) return "token-not-configured";
	if (snapshot.disabled) return snapshot.disabledReason === "environment" ? "environment" : "command";
	return undefined;
}

function updatePublisherState(
	token: string | undefined,
	snapshot: FeadsSessionSnapshot,
	publisherStarted: boolean,
	disabledReason?: FeadsPresenceDisabledReason,
): void {
	presenceStatus = {
		...presenceStatus,
		tokenConfigured: hasConfiguredToken(token),
		enabled: publisherStarted && !snapshot.disabled,
		publisherStarted,
		disabledReason: disabledReason ?? statusDisabledReason(snapshot, token),
	};
}

function recordSuccess(acceptedCount: number): void {
	presenceStatus = {
		...presenceStatus,
		lastSuccessfulAcceptedCount: acceptedCount,
		lastSuccessfulAt: Date.now(),
		consecutiveFailures: 0,
	};
}

let alertListener: FeadsPresenceAlertListener | undefined;
const alertedCategories = new Set<FeadsPresenceFailureCategory>();

/**
 * Route heartbeat-failure alerts to the current session's UI. The publisher has no
 * extension context; the feads-agent extension registers one here per session. A
 * later registration replaces an earlier one; the returned disposer clears only its own.
 */
export function setFeadsPresenceAlertListener(listener: FeadsPresenceAlertListener): () => void {
	alertListener = listener;
	return () => {
		if (alertListener === listener) alertListener = undefined;
	};
}

export function formatFeadsPresenceAlert(category: FeadsPresenceFailureCategory, statusCode?: number): string {
	return `Feads Agentwatch heartbeats are failing (${statusCode ?? category}); this session won't show on Agentwatch. Run /feads-status for details.`;
}

function maybeAlert(category: FeadsPresenceFailureCategory, statusCode: number | undefined): void {
	const listener = alertListener;
	// Without a listener the alert is not spent, so the next failure can still surface it.
	if (!listener || alertedCategories.has(category) || feadsSessionState.current.disabled) return;
	const consecutiveFailures = presenceStatus.consecutiveFailures;
	if (!IMMEDIATE_ALERT_CATEGORIES.has(category) && consecutiveFailures < FEADS_PRESENCE_ALERT_AFTER_FAILURES) return;
	alertedCategories.add(category);
	try {
		listener({ category, statusCode, consecutiveFailures, message: formatFeadsPresenceAlert(category, statusCode) });
	} catch {
		// A UI failure must never affect presence publishing.
	}
}

function recordFailure(category: FeadsPresenceFailureCategory, statusCode?: number): void {
	presenceStatus = {
		...presenceStatus,
		lastFailure: category,
		lastFailureStatusCode: statusCode,
		consecutiveFailures: presenceStatus.consecutiveFailures + 1,
	};
	maybeAlert(category, statusCode);
}

async function acceptedCountFromResponse(response: Response, fallback: number): Promise<number> {
	try {
		const body = asRecord(await response.json());
		const accepted = body?.accepted;
		return typeof accepted === "number" && Number.isInteger(accepted) && accepted >= 0 ? accepted : fallback;
	} catch {
		return fallback;
	}
}

function failureCategoryForStatus(status: number): FeadsPresenceFailureCategory {
	switch (status) {
		case 400:
		case 401:
		case 403:
		case 404:
		case 409:
		case 429:
			return String(status) as FeadsPresenceFailureCategory;
		default:
			return "other";
	}
}

function errorName(value: unknown): string | undefined {
	if (value instanceof DOMException) return value.name;
	const record = asRecord(value);
	return typeof record?.name === "string" ? record.name : undefined;
}

function failureCategoryForError(error: unknown, signal: AbortSignal): FeadsPresenceFailureCategory {
	const signalName = errorName(signal.reason);
	const name = errorName(error);
	if (
		signalName === "TimeoutError" ||
		signalName === "AbortError" ||
		name === "TimeoutError" ||
		name === "AbortError"
	) {
		return "timeout";
	}
	if (name === "TypeError" || name === "NetworkError" || name === "FetchError") return "network";
	return "other";
}

export function getFeadsPresenceStatus(): FeadsPresenceStatus {
	// Before a publisher is constructed, reflect the current process environment.
	// Once it has run, preserve its last safe observation for /feads-status.
	if (
		!presenceStatus.publisherStarted &&
		presenceStatus.lastSuccessfulAt === undefined &&
		presenceStatus.lastFailure === undefined
	) {
		const credential = resolvePresenceCredential();
		const current = statusForConfig(
			credential.token,
			process.env.FEADS_URL,
			feadsSessionState.current,
			credential.source,
		);
		if (
			current.tokenConfigured !== presenceStatus.tokenConfigured ||
			current.credentialSource !== presenceStatus.credentialSource ||
			current.effectiveHost !== presenceStatus.effectiveHost
		) {
			presenceStatus = current;
		}
	}
	return { ...presenceStatus };
}

function formatCredentialSource(source: FeadsCredentialSource): string {
	return source === "file" ? "file (phi.env)" : source;
}

function formatDisabledReason(reason: FeadsPresenceDisabledReason | undefined): string {
	switch (reason) {
		case "token-not-configured":
			return "token not configured";
		case "environment":
			return "PI_NO_FEADS=1";
		case "command":
			return "/no-feads";
		case "publisher-not-started":
			return "publisher not started";
		case "publisher-disposed":
			return "publisher disposed";
		default:
			return "none";
	}
}

export function formatFeadsPresenceStatus(status: FeadsPresenceStatus = getFeadsPresenceStatus()): string {
	return [
		"Feads Agentwatch status",
		`configured token: ${status.tokenConfigured ? "yes" : "no"}`,
		`credential source: ${formatCredentialSource(status.credentialSource)}`,
		...(status.credentialSource === "legacy"
			? ["migration: rename FEADS_TOKEN to FEADS_AGENT_TOKEN and restart phi"]
			: []),
		`effective host: ${status.effectiveHost}`,
		`enabled: ${status.enabled ? "yes" : "no"}`,
		`disabled reason: ${formatDisabledReason(status.disabledReason)}`,
		`publisher started: ${status.publisherStarted ? "yes" : "no"}`,
		`last successful accepted count: ${status.lastSuccessfulAcceptedCount ?? "none"}`,
		`last successful time: ${status.lastSuccessfulAt === undefined ? "never" : new Date(status.lastSuccessfulAt).toISOString()}`,
		`last failure: ${status.lastFailure ?? "none"}`,
		...(status.lastFailureStatusCode === undefined
			? []
			: [`last failure status code: ${status.lastFailureStatusCode}`]),
		`consecutive failures: ${status.consecutiveFailures}`,
	].join("\n");
}

const SAFE_PHASES = new Set<SafeActivityPhase>(["starting", "thinking", "done", "failed", "aborted"]);
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function asRecord(value: unknown): AgentRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as AgentRecord) : undefined;
}

function boundedText(value: unknown, fallback: string, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTERS.test(value)) return fallback;
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let result = value;
	while (result.length > 0 && Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return result;
}

function statusOf(value: unknown): PresenceStatus {
	return value === "working" ||
		value === "idle" ||
		value === "done" ||
		value === "failed" ||
		value === "aborted" ||
		value === "unknown"
		? value
		: "unknown";
}

function statusIsTerminal(status: PresenceStatus): boolean {
	return status === "done" || status === "failed" || status === "aborted";
}

function rowKey(row: Pick<FeadsPresenceRow, "runtime_id" | "run_id">): string {
	return `${row.runtime_id}:${row.run_id}`;
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeToolName(value: unknown): SafeActivity | undefined {
	if (typeof value !== "string" || !TOOL_NAME.test(value)) return undefined;
	return { kind: "tool", name: value };
}

export function sanitizeSafeActivity(value: unknown): SafeActivity | undefined {
	if (typeof value === "string" && SAFE_PHASES.has(value as SafeActivityPhase)) {
		return value as SafeActivityPhase;
	}
	const record = asRecord(value);
	if (!record || Object.keys(record).length !== 2 || record.kind !== "tool") return undefined;
	return safeToolName(record.name);
}

export function phaseForStatus(status: PresenceStatus): SafeActivityPhase | undefined {
	if (status === "working") return "thinking";
	if (status === "done") return "done";
	if (status === "failed") return "failed";
	if (status === "aborted") return "aborted";
	return undefined;
}

function activityForAgent(agent: AgentRecord, status: PresenceStatus): string {
	const safe = sanitizeSafeActivity(agent.safeActivity);
	if (safe) return typeof safe === "string" ? safe : safe.name;
	return phaseForStatus(status) ?? "";
}

function runtimeEvent(event: unknown): { agent: AgentRecord; terminal: boolean } | undefined {
	const envelope = asRecord(event);
	const agent = asRecord(envelope?.agent);
	if (!envelope || !agent) return undefined;
	return {
		agent,
		terminal: envelope.event === "agent_end" || envelope.event === "subagent_end",
	};
}

function projectEvent(
	event: unknown,
	snapshot: FeadsSessionSnapshot,
	client?: string,
): { row: FeadsPresenceRow; terminal: boolean } | undefined {
	if (snapshot.disabled || !snapshot.sessionId || !snapshot.runtimeId) return undefined;
	const parsed = runtimeEvent(event);
	if (!parsed) return undefined;
	const { agent } = parsed;
	const kind = agent.kind === "main" || agent.kind === "subagent" ? agent.kind : undefined;
	if (!kind) return undefined;

	const runId = kind === "main" ? snapshot.runtimeId : boundedText(agent.runId, "", 128);
	if (!runId) return undefined;

	const status = statusOf(agent.status);
	const contextPercent = Math.min(100, Math.max(0, numberOr(agent.ctxPct, 0)));
	const startedAt = Math.max(0, Math.floor(numberOr(agent.startedAt, 0)));
	const terminal = parsed.terminal || statusIsTerminal(status);
	return {
		row: {
			session_id: snapshot.sessionId,
			runtime_id: snapshot.runtimeId,
			run_id: runId,
			parent_run_id: kind === "main" ? "" : snapshot.runtimeId,
			kind,
			handle: boundedText(agent.handle, kind === "main" ? "main" : "", 80),
			display_name: kind === "main" && agent.displayName === "main" ? "" : boundedText(agent.displayName, "", 80),
			status,
			model: boundedText(agent.model, "", 128),
			activity: activityForAgent(agent, status),
			context_percent: contextPercent,
			started_at: startedAt,
			...(client ? { client } : {}),
		},
		terminal,
	};
}

function urlFor(value: string | undefined): string {
	return (value ?? DEFAULT_FEADS_URL).replace(/\/$/u, "");
}

function retryAfterMs(response: Response, now = Date.now()): number | undefined {
	const value = response.headers.get("Retry-After")?.trim();
	if (!value) return undefined;
	if (/^\d+(?:\.\d+)?$/u.test(value)) {
		const milliseconds = Number(value) * 1000;
		return Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : undefined;
	}
	if (!/^[A-Za-z]{3},/u.test(value)) return undefined;
	const retryAt = Date.parse(value);
	return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : undefined;
}

/** Sanitized, owner-authenticated runtime-presence projection for Feads. */
export class FeadsPresencePublisher implements PresencePublisher {
	private readonly token: string | undefined;
	private readonly url: string;
	private readonly debounceMs: number;
	private readonly heartbeatMs: number;
	private readonly timeoutMs: number;
	private readonly client = resolvePresenceClient();
	private readonly active = new Map<string, FeadsPresenceRow>();
	private readonly pending = new Map<string, FeadsPresenceRow>();
	private readonly terminalRuns = new Set<string>();
	private readonly terminalRows = new Map<string, FeadsPresenceRow>();
	private readonly terminalRetries = new Map<string, FeadsPresenceRow>();
	private readonly terminalRetryAttempted = new Set<string>();
	private readonly unsubscribe: (() => void) | undefined;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private inFlight: Promise<boolean> | undefined;
	private request: PendingRequest | undefined;
	private disposed = false;
	private generation: string | undefined;
	private flushDueAt = 0;
	private cooldownUntil = 0;
	private failureStreak = 0;

	constructor(options: FeadsPresencePublisherOptions = {}) {
		const credential = options.token === undefined ? resolvePresenceCredential() : explicitCredential(options.token);
		this.token = credential.token;
		this.url = urlFor(options.url ?? process.env.FEADS_URL);
		this.debounceMs = options.debounceMs ?? FEADS_PRESENCE_DEBOUNCE_MS;
		this.heartbeatMs = options.heartbeatMs ?? FEADS_PRESENCE_HEARTBEAT_MS;
		this.timeoutMs = options.timeoutMs ?? FEADS_PRESENCE_TIMEOUT_MS;
		resetPresenceStatus(this.token, this.url, credential.source);
		if (process.env.PI_NO_FEADS === "1") feadsSessionState.disable("environment");
		if (!this.token) return;

		this.unsubscribe = feadsSessionState.subscribe((snapshot) => this.onSessionState(snapshot));
		const snapshot = feadsSessionState.current;
		this.generation = snapshot.runtimeId;
		if (!snapshot.disabled) this.startHeartbeat();
		else updatePublisherState(this.token, snapshot, false);
	}

	publish(event: unknown): void {
		if (this.disposed || !this.token) return;
		const snapshot = feadsSessionState.current;
		const projected = projectEvent(event, snapshot, this.client);
		if (!projected) return;
		const key = rowKey(projected.row);
		if (this.terminalRuns.has(key)) return;

		if (projected.terminal) {
			this.terminalRuns.add(key);
			this.terminalRows.set(key, projected.row);
			this.active.delete(key);
		} else {
			this.rememberActive(projected.row);
		}
		this.pending.delete(key);
		this.pending.set(key, projected.row);
		this.scheduleFlush(this.debounceMs);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.debounceTimer = undefined;
		this.heartbeatTimer = undefined;
		this.unsubscribe?.();
		const snapshot = feadsSessionState.current;
		updatePublisherState(
			this.token,
			snapshot,
			false,
			snapshot.disabled ? statusDisabledReason(snapshot, this.token) : "publisher-disposed",
		);

		const activeByRuntime = new Map<string, string[]>();
		for (const row of this.active.values()) {
			const runIds = activeByRuntime.get(row.runtime_id) ?? [];
			runIds.push(row.run_id);
			activeByRuntime.set(row.runtime_id, runIds);
		}
		this.active.clear();
		void this.finishDispose(activeByRuntime);
	}

	private onSessionState(snapshot: FeadsSessionSnapshot): void {
		if (snapshot.runtimeId !== this.generation) {
			this.cancelPending(true);
			this.generation = snapshot.runtimeId;
		}
		if (snapshot.disabled) {
			this.cancelPending(true);
			updatePublisherState(this.token, snapshot, false);
			return;
		}
		if (!this.disposed) this.startHeartbeat();
	}

	private startHeartbeat(): void {
		if (!this.token || this.disposed || this.heartbeatTimer) return;
		this.heartbeatTimer = setInterval(() => {
			if (this.disposed || feadsSessionState.current.disabled) return;
			for (const [key, row] of this.active) this.pending.set(key, row);
			for (const [key, row] of this.terminalRetries) {
				if (!this.terminalRetryAttempted.has(key)) this.pending.set(key, row);
			}
			if (this.pending.size > 0) this.scheduleFlush(0);
		}, this.heartbeatMs);
		updatePublisherState(this.token, feadsSessionState.current, true);
	}

	private rememberActive(row: FeadsPresenceRow): void {
		const key = rowKey(row);
		this.active.delete(key);
		this.active.set(key, row);
	}

	private scheduleFlush(delayMs: number): void {
		if (this.disposed || feadsSessionState.current.disabled || this.pending.size === 0) return;
		const now = Date.now();
		const dueAt = Math.max(now + Math.max(0, delayMs), this.cooldownUntil);
		// While throttled, keep the already scheduled release timer. Events only
		// replace the latest row in `pending`; they must not move the next request
		// ahead of the shared cooldown.
		if (this.debounceTimer && this.cooldownUntil > now && this.flushDueAt <= dueAt) return;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.flushDueAt = dueAt;
		this.debounceTimer = setTimeout(
			() => {
				this.debounceTimer = undefined;
				this.flushDueAt = 0;
				this.flush();
			},
			Math.max(0, dueAt - now),
		);
	}

	private flush(): void {
		if (this.disposed || feadsSessionState.current.disabled || this.inFlight || this.pending.size === 0) return;
		if (Date.now() < this.cooldownUntil) {
			this.scheduleFlush(0);
			return;
		}
		const rows: FeadsPresenceRow[] = [];
		for (const [key, row] of this.pending) {
			rows.push(row);
			this.pending.delete(key);
			if (rows.length >= FEADS_PRESENCE_MAX_ROWS) break;
		}
		void this.runPut(rows).then((accepted) => {
			this.reconcilePut(rows, accepted);
			if (!this.disposed && !feadsSessionState.current.disabled && this.pending.size > 0) {
				this.scheduleFlush(accepted ? this.debounceMs : 0);
			}
		});
	}

	private reconcilePut(rows: FeadsPresenceRow[], accepted: boolean): void {
		for (const row of rows) {
			const key = rowKey(row);
			const terminalRow = this.terminalRows.get(key);
			if (this.terminalRuns.has(key)) {
				if (terminalRow !== row) continue;
				if (accepted) {
					this.terminalRetries.delete(key);
					this.terminalRetryAttempted.delete(key);
					this.pending.delete(key);
				} else if (this.terminalRetries.has(key)) {
					this.terminalRetryAttempted.add(key);
					this.pending.delete(key);
				} else {
					this.terminalRetries.set(key, row);
					this.terminalRetryAttempted.delete(key);
					this.pending.delete(key);
				}
				continue;
			}
			if (accepted) continue;
			const current = this.active.get(key);
			if (current && !this.pending.has(key)) this.pending.set(key, current);
		}
	}

	private async runPut(rows: FeadsPresenceRow[]): Promise<boolean> {
		if (!this.token || rows.length === 0 || feadsSessionState.current.disabled) return false;
		return this.runRequest(async (signal) => {
			const response = await fetch(`${this.url}/api/runtime-presence`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ version: 1, rows }),
				signal,
			});
			if (!response.ok) {
				recordFailure(failureCategoryForStatus(response.status), response.status);
				this.applyCooldown(retryAfterMs(response));
				return false;
			}
			recordSuccess(await acceptedCountFromResponse(response, rows.length));
			return true;
		});
	}

	private async runDelete(runtimeId: string, runIds: string[]): Promise<boolean> {
		if (!this.token || runIds.length === 0 || feadsSessionState.current.disabled) return false;
		return this.runRequest(async (signal) => {
			const response = await fetch(`${this.url}/api/runtime-presence`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ runtime_id: runtimeId, run_ids: runIds }),
				signal,
			});
			if (!response.ok) {
				recordFailure(failureCategoryForStatus(response.status), response.status);
				this.applyCooldown(retryAfterMs(response));
				return false;
			}
			return true;
		});
	}

	private async runRequest(operation: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
		if (this.inFlight || !this.token) return false;
		const controller = new AbortController();
		const request: PendingRequest = { controller, suppressDiagnostic: false };
		this.request = request;
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = AbortSignal.any([controller.signal, timeout]);
		const promise = (async () => {
			try {
				const accepted = await operation(signal);
				if (accepted) this.clearCooldown();
				return accepted;
			} catch (error) {
				if (!request.suppressDiagnostic) {
					recordFailure(failureCategoryForError(error, signal));
					this.applyCooldown();
				}
				return false;
			}
		})();
		this.inFlight = promise;
		try {
			return await promise;
		} finally {
			if (this.inFlight === promise) this.inFlight = undefined;
			if (this.request === request) this.request = undefined;
		}
	}

	private async finishDispose(activeByRuntime: Map<string, string[]>): Promise<void> {
		if (this.inFlight) {
			await this.inFlight;
			await Promise.resolve();
		}
		const terminalRowsByKey = new Map<string, FeadsPresenceRow>();
		for (const [key, row] of this.pending) {
			if (this.terminalRuns.has(key)) terminalRowsByKey.set(key, row);
		}
		for (const [key, row] of this.terminalRetries) terminalRowsByKey.set(key, row);
		this.pending.clear();
		this.terminalRuns.clear();
		this.terminalRows.clear();
		this.terminalRetries.clear();
		this.terminalRetryAttempted.clear();
		if (!this.token || feadsSessionState.current.disabled) return;
		const terminalRows = [...terminalRowsByKey.values()];
		for (let offset = 0; offset < terminalRows.length; offset += FEADS_PRESENCE_MAX_ROWS) {
			if (feadsSessionState.current.disabled) return;
			await this.runPut(terminalRows.slice(offset, offset + FEADS_PRESENCE_MAX_ROWS));
		}
		for (const [runtimeId, runIds] of activeByRuntime) {
			for (let offset = 0; offset < runIds.length; offset += FEADS_PRESENCE_MAX_ROWS) {
				if (feadsSessionState.current.disabled) return;
				await this.runDelete(runtimeId, runIds.slice(offset, offset + FEADS_PRESENCE_MAX_ROWS));
			}
		}
	}

	private cancelPending(suppressDiagnostic: boolean): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.debounceTimer = undefined;
		this.heartbeatTimer = undefined;
		this.flushDueAt = 0;
		this.cooldownUntil = 0;
		this.failureStreak = 0;
		this.pending.clear();
		this.active.clear();
		this.terminalRuns.clear();
		this.terminalRows.clear();
		this.terminalRetries.clear();
		this.terminalRetryAttempted.clear();
		if (this.request) {
			this.request.suppressDiagnostic = suppressDiagnostic;
			this.request.controller.abort();
		}
	}

	private applyCooldown(retryAfter?: number): void {
		this.failureStreak = Math.min(this.failureStreak + 1, 31);
		const exponential = Math.min(
			FEADS_PRESENCE_RETRY_MAX_MS,
			FEADS_PRESENCE_RETRY_BASE_MS * 2 ** (this.failureStreak - 1),
		);
		const fallback = Math.min(
			FEADS_PRESENCE_RETRY_MAX_MS,
			exponential + Math.floor(Math.random() * Math.min(FEADS_PRESENCE_RETRY_JITTER_MAX_MS, exponential)),
		);
		const delay = retryAfter ?? fallback;
		this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
	}

	private clearCooldown(): void {
		this.failureStreak = 0;
		this.cooldownUntil = 0;
	}
}

export const __testing = {
	projectEvent,
	sanitizeSafeActivity,
	safeToolName,
	failureCategoryForStatus,
	failureCategoryForError,
	effectiveHost,
	resolvePresenceCredential,
	resolvePresenceClient,
	resetPresenceStatus,
	resetAlerts(): void {
		alertListener = undefined;
		alertedCategories.clear();
	},
};
