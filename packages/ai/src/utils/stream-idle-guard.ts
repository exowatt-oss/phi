import type { Api, AssistantMessage, FetchFunction, KnownApi, Model, StreamOptions } from "../types.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";

/**
 * Default raw-transport inactivity window before a stream is considered dead.
 *
 * This must exceed LiteLLM's 300s per-attempt `stream_timeout` with margin:
 * some gateways forward no keepalives while an upstream model reasons.
 * 420s matches the gateway `request_timeout`. Lowering this below 300s will
 * abort valid long-reasoning calls on `gateway/*` models.
 *
 * Source: proxmox-management `litellm/config.yaml`.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 420_000;

/** Largest delay Node timers can represent without overflowing to an immediate timeout. */
export const MAX_STREAM_IDLE_TIMEOUT_MS = 2_147_483_647;

/**
 * Raw-activity capability for every built-in streaming API. Enabled entries
 * receive observation hooks, but the watchdog does not arm until the selected
 * implementation invokes the wrapped fetch or installs the WebSocket frame
 * hook. SDK-decoded items never count as the transport boundary.
 */
export const STREAM_IDLE_GUARD_CAPABILITIES = {
	"anthropic-messages": { enabled: true, observation: "fetch-body" },
	"azure-openai-responses": { enabled: true, observation: "fetch-body" },
	"bedrock-converse-stream": { enabled: false, observation: "unobservable-sdk" },
	"google-generative-ai": { enabled: false, observation: "unobservable-sdk" },
	"google-vertex": { enabled: false, observation: "unobservable-sdk" },
	"mistral-conversations": { enabled: true, observation: "fetch-body" },
	"openai-codex-responses": { enabled: true, observation: "fetch-body-or-websocket-frame" },
	"openai-completions": { enabled: true, observation: "fetch-body" },
	"openai-responses": { enabled: true, observation: "fetch-body" },
	"pi-messages": { enabled: true, observation: "fetch-body" },
} as const satisfies Record<
	KnownApi,
	{
		/** False when the pinned SDK exposes only decoded stream items. */
		enabled: boolean;
		observation: "fetch-body" | "fetch-body-or-websocket-frame" | "unobservable-sdk";
	}
>;

/** How long after aborting the transport to wait for its terminal event. */
const DEFAULT_SETTLE_GRACE_MS = 1_000;
const STREAM_IDLE_GUARDED = Symbol("streamIdleGuarded");

let defaultIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS;

/** A typed transport failure used when a model stream stops producing raw data. */
export class StreamIdleTimeoutError extends Error {
	readonly provider: string;
	readonly model: string;
	readonly idleTimeoutMs: number;

	constructor(provider: string, model: string, idleTimeoutMs: number) {
		const seconds = idleTimeoutMs / 1000;
		super(`no data from ${provider}/${model} for ${Number.isInteger(seconds) ? seconds : seconds.toFixed(3)}s`);
		this.name = "StreamIdleTimeoutError";
		this.provider = provider;
		this.model = model;
		this.idleTimeoutMs = idleTimeoutMs;
	}
}

export function isStreamIdleTimeoutError(error: unknown): boolean {
	return (
		error instanceof StreamIdleTimeoutError ||
		(typeof error === "string" && error.startsWith(`${StreamIdleTimeoutError.name}:`))
	);
}

/** Set the process-wide default. Per-call `StreamOptions.idleTimeoutMs` wins. */
export function setDefaultStreamIdleTimeoutMs(ms: number | undefined): void {
	defaultIdleTimeoutMs = ms === undefined ? DEFAULT_STREAM_IDLE_TIMEOUT_MS : resolveStreamIdleTimeoutMs(ms);
}

export function getDefaultStreamIdleTimeoutMs(): number {
	return defaultIdleTimeoutMs;
}

/** Resolve the effective timeout for a call. Non-positive and non-finite values disable it. */
export function resolveStreamIdleTimeoutMs(optionMs: number | undefined): number {
	const ms = optionMs ?? defaultIdleTimeoutMs;
	if (!Number.isFinite(ms) || ms <= 0) return 0;
	if (ms > MAX_STREAM_IDLE_TIMEOUT_MS) {
		throw new RangeError(`idleTimeoutMs must be <= ${MAX_STREAM_IDLE_TIMEOUT_MS}, received ${ms}`);
	}
	return Math.floor(ms);
}

export interface StreamIdleGuardOptions {
	idleTimeoutMs: number;
	abortTransport: () => void;
	callerSignal?: AbortSignal;
	model?: Model<Api>;
	settleGraceMs?: number;
}

interface StreamActivity {
	install(): void;
	touch(): void;
	subscribeInstalled(listener: () => void): () => void;
	subscribe(listener: () => void): () => void;
}

function createStreamActivity(): StreamActivity {
	let installed = false;
	const installListeners = new Set<() => void>();
	const listeners = new Set<() => void>();
	return {
		install(): void {
			if (installed) return;
			installed = true;
			for (const listener of installListeners) listener();
			installListeners.clear();
		},
		touch(): void {
			if (!installed) return;
			for (const listener of listeners) listener();
		},
		subscribeInstalled(listener: () => void): () => void {
			if (installed) listener();
			else installListeners.add(listener);
			return () => installListeners.delete(listener);
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function trackResponseBody(response: Response, activity: StreamActivity, signal?: AbortSignal | null): Response {
	if (!response.body) return response;
	const body = response.body;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let cancelled = false;
	const removeAbortListener = (): void => signal?.removeEventListener("abort", cancelForAbort);
	const cancelUnderlying = async (reason?: unknown): Promise<void> => {
		if (cancelled) return;
		cancelled = true;
		removeAbortListener();
		if (reader) await reader.cancel(reason);
		else if (!body.locked) await body.cancel(reason);
	};
	function cancelForAbort(): void {
		void cancelUnderlying(signal?.reason).catch(() => {
			// The provider adapter still observes the abort signal; cancellation is best effort.
		});
	}
	if (signal?.aborted) cancelForAbort();
	else signal?.addEventListener("abort", cancelForAbort, { once: true });

	const trackedBody = new ReadableStream<Uint8Array>({
		async pull(controller): Promise<void> {
			if (cancelled) {
				controller.close();
				return;
			}
			reader ??= body.getReader();
			const { done, value } = await reader.read();
			if (done) {
				removeAbortListener();
				if (!cancelled) controller.close();
				return;
			}
			if (value.byteLength > 0) activity.touch();
			controller.enqueue(value);
		},
		async cancel(reason): Promise<void> {
			await cancelUnderlying(reason);
		},
	});

	const trackedResponse = new Response(trackedBody, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
	Object.defineProperties(trackedResponse, {
		url: { value: response.url },
		redirected: { value: response.redirected },
		type: { value: response.type },
	});
	return trackedResponse;
}

const isBunRuntime = typeof process !== "undefined" && typeof process.versions?.bun === "string";

/**
 * Bun's fetch aborts any request whose socket is silent for 300 s with
 * `TimeoutError: The operation timed out.` — before response headers (surfaced by
 * the Anthropic SDK as "Request timed out.") and while reading the body. That
 * hidden limit preempts this guard's longer window (420 s by default, sized for
 * long silent reasoning), so a model that thinks quietly for 5 minutes fails
 * with a transport timeout. Once the guard is armed it owns stream idleness:
 * disable Bun's own idle timeout (`timeout: false`, a Bun-only RequestInit
 * field) unless the caller set one explicitly. Node ignores the field.
 */
export function withoutBunTransportTimeout(
	init: RequestInit | undefined,
	isBun = isBunRuntime,
): RequestInit | undefined {
	if (!isBun) return init;
	if (init && "timeout" in init) return init;
	return { ...init, timeout: false } as RequestInit;
}

function wrapFetch(fetch: FetchFunction, activity: StreamActivity): FetchFunction {
	return async (input, init) => {
		// Invocation proves that this call installed the raw response-body wrapper.
		// Merely recognizing an API id is not sufficient to arm the watchdog.
		activity.install();
		return trackResponseBody(await fetch(input, withoutBunTransportTimeout(init)), activity, init?.signal);
	};
}

function buildIdleTimeoutMessage(
	base: AssistantMessage | undefined,
	options: StreamIdleGuardOptions,
	error: StreamIdleTimeoutError,
): AssistantMessage {
	const skeleton: AssistantMessage = base
		? { ...base, content: base.content ?? [] }
		: {
				role: "assistant",
				content: [],
				api: options.model?.api ?? "openai-completions",
				provider: options.model?.provider ?? "unknown",
				model: options.model?.id ?? "unknown",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				timestamp: Date.now(),
			};
	skeleton.stopReason = "error";
	skeleton.errorMessage = error.toString();
	skeleton.providerErrorMessage = skeleton.errorMessage;
	return skeleton;
}

function guardStreamIdleWithActivity(
	source: AssistantMessageEventStream,
	options: StreamIdleGuardOptions,
	activity: StreamActivity,
): AssistantMessageEventStream {
	const guarded = new AssistantMessageEventStream();
	const settleGraceMs = options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
	const timeoutError = new StreamIdleTimeoutError(
		options.model?.provider ?? "unknown",
		options.model?.id ?? "unknown",
		options.idleTimeoutMs,
	);
	let idleTripped = false;
	let finished = false;
	let lastPartial: AssistantMessage | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;

	const clearTimers = (): void => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		if (settleTimer !== undefined) clearTimeout(settleTimer);
		idleTimer = undefined;
		settleTimer = undefined;
	};

	const finish = (event: Parameters<AssistantMessageEventStream["push"]>[0]): void => {
		if (finished) return;
		finished = true;
		clearTimers();
		unsubscribeActivity();
		unsubscribeInstalled();
		guarded.push(event);
		guarded.end();
	};

	const onIdleTimeout = (): void => {
		if (finished || options.callerSignal?.aborted) return;
		idleTripped = true;
		try {
			options.abortTransport();
		} catch {
			// A dead transport must not prevent the typed timeout from surfacing.
		}
		settleTimer = setTimeout(() => {
			finish({ type: "error", reason: "error", error: buildIdleTimeoutMessage(lastPartial, options, timeoutError) });
		}, settleGraceMs);
		settleTimer.unref?.();
	};

	function armIdleTimer(): void {
		if (finished || idleTripped || options.callerSignal?.aborted) return;
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = setTimeout(onIdleTimeout, options.idleTimeoutMs);
		idleTimer.unref?.();
	}

	const unsubscribeActivity = activity.subscribe(() => armIdleTimer());
	const unsubscribeInstalled = activity.subscribeInstalled(() => armIdleTimer());

	void (async () => {
		try {
			for await (const event of source) {
				if (finished) return;
				if ("partial" in event && event.partial) lastPartial = event.partial;

				if (event.type === "error" || event.type === "done") {
					if (idleTripped && !options.callerSignal?.aborted && event.type === "error") {
						finish({
							type: "error",
							reason: "error",
							error: buildIdleTimeoutMessage(event.error, options, timeoutError),
						});
					} else {
						finish(event);
					}
					return;
				}

				guarded.push(event);
			}
			if (!finished) {
				if (idleTripped && !options.callerSignal?.aborted) {
					finish({
						type: "error",
						reason: "error",
						error: buildIdleTimeoutMessage(lastPartial, options, timeoutError),
					});
					return;
				}

				// Some programmatic providers resolve result() and close iteration
				// without enqueuing a terminal event. Preserve that valid stream shape.
				const result = await source.result();
				if (finished) return;
				if (result.stopReason === "error" || result.stopReason === "aborted") {
					finish({ type: "error", reason: result.stopReason, error: result });
				} else if (
					result.stopReason === "stop" ||
					result.stopReason === "length" ||
					result.stopReason === "toolUse"
				) {
					finish({ type: "done", reason: result.stopReason, message: result });
				} else {
					finish({
						type: "error",
						reason: "error",
						error: {
							...result,
							stopReason: "error",
							errorMessage: `Stream ended with non-terminal stop reason: ${result.stopReason}`,
						},
					});
				}
			}
		} catch (error) {
			const message = buildIdleTimeoutMessage(lastPartial, options, timeoutError);
			message.errorMessage = idleTripped
				? timeoutError.toString()
				: error instanceof Error
					? error.message
					: String(error);
			message.providerErrorMessage = message.errorMessage;
			finish({ type: "error", reason: "error", error: message });
		}
	})();

	return guarded;
}

/** Wrap an already-created assistant stream with event and external activity tracking. */
export function guardStreamIdle(
	source: AssistantMessageEventStream,
	options: StreamIdleGuardOptions,
): AssistantMessageEventStream {
	const activity = createStreamActivity();
	activity.install();
	return guardStreamIdleWithActivity(source, options, activity);
}

/**
 * Produce a guarded provider stream. Fetch-based APIs are observed at the raw
 * response-body boundary, so SSE comments, blank frames, and provider ping
 * events reset the timer even when their parsers intentionally discard them.
 */
export function withStreamIdleGuard<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
	produce: (guardedOptions: TOptions | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const internalOptions = options as (TOptions & { [STREAM_IDLE_GUARDED]?: boolean }) | undefined;
	if (internalOptions?.[STREAM_IDLE_GUARDED]) return produce(options);

	const capability = (STREAM_IDLE_GUARD_CAPABILITIES as Partial<Record<Api, { enabled: boolean }>>)[model.api];
	// Unknown API ids and SDK-only built-ins receive no raw hook. Enabled ids are
	// only candidates: the timer still waits for the selected implementation to
	// positively install a wrapped fetch or WebSocket frame observer.
	if (!capability?.enabled) return produce(options);

	const idleTimeoutMs = resolveStreamIdleTimeoutMs(options?.idleTimeoutMs);
	if (idleTimeoutMs <= 0) return produce(options);

	const idleController = new AbortController();
	const callerSignal = options?.signal;
	const signal = callerSignal ? AbortSignal.any([callerSignal, idleController.signal]) : idleController.signal;
	const activity = createStreamActivity();
	const previousActivity = options?.onStreamActivity;
	const previousActivityInstalled = options?.onStreamActivityInstalled;
	const reportActivity = (): void => {
		activity.touch();
		previousActivity?.();
	};
	const reportActivityInstalled = (): void => {
		activity.install();
		previousActivityInstalled?.();
	};
	const fetch = wrapFetch(options?.fetch ?? globalThis.fetch, activity);
	const guardedOptions = {
		...(options ?? {}),
		signal,
		fetch,
		onStreamActivity: reportActivity,
		onStreamActivityInstalled: reportActivityInstalled,
		[STREAM_IDLE_GUARDED]: true,
	} as TOptions & { [STREAM_IDLE_GUARDED]: true };
	const source = produce(guardedOptions);
	return guardStreamIdleWithActivity(
		source,
		{
			idleTimeoutMs,
			abortTransport: () =>
				idleController.abort(new StreamIdleTimeoutError(model.provider, model.id, idleTimeoutMs)),
			callerSignal,
			model,
		},
		activity,
	);
}
