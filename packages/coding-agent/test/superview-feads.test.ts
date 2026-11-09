import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FEADS_PRESENCE_DEBOUNCE_MS,
	FEADS_PRESENCE_HEARTBEAT_MS,
	FEADS_PRESENCE_MAX_ROWS,
	FEADS_PRESENCE_RETRY_BASE_MS,
	FeadsPresencePublisher,
	formatFeadsPresenceStatus,
	getFeadsPresenceStatus,
	__testing as presenceTesting,
} from "../src/extensions/feads-agent/presence-publisher.ts";
import { feadsSessionState } from "../src/extensions/feads-agent/session-state.ts";
import { isolateFeadsAgentDir } from "./feads-test-env.ts";

beforeEach(() => {
	isolateFeadsAgentDir();
});

const mainEvent = (overrides: Record<string, unknown> = {}, event = "subagent_update") => ({
	v: 1,
	event,
	ts: 1_000,
	agent: {
		agentKey: "session-key",
		handle: "main",
		displayName: "Review dashboard",
		kind: "main",
		model: "gateway/example-large",
		status: "working",
		safeActivity: { kind: "tool", name: "bash" },
		activity: { tool: "bash", argsPreview: "cat SECRET_PROMPT" },
		ctxPct: 37.5,
		cwd: "/private/worktree",
		pid: 42,
		startedAt: 900,
		tokens: { input: 100, output: 20 },
		costUsd: 0.3,
		...overrides,
	},
});

const childEvent = (overrides: Record<string, unknown> = {}) => ({
	v: 1,
	event: "subagent_update",
	ts: 1_001,
	agent: {
		agentKey: "child-agent-key",
		runId: "child-run-7",
		handle: "report-ui-x7k2",
		displayName: "report-ui",
		kind: "subagent",
		model: "gateway/example-medium",
		status: "working",
		safeActivity: { kind: "tool", name: "read" },
		activity: { tool: "read /private/secret" },
		ctxPct: 11,
		cwd: "/private/worktree",
		pid: 43,
		startedAt: 901,
		task: "Prompt and task must not be sent",
		...overrides,
	},
});

function bodyOf(call: unknown[]): Record<string, unknown> {
	return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("FeadsPresencePublisher", () => {
	const publishers: FeadsPresencePublisher[] = [];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv("FEADS_AGENT_TOKEN", "test-token");
		vi.stubEnv("FEADS_TOKEN", undefined);
		vi.stubEnv("FEADS_URL", "http://feads.test");
		vi.stubEnv("PHI_CLIENT", undefined);
		vi.stubEnv("TERM_PROGRAM", undefined);
		feadsSessionState.startSession(`session-${Math.random()}`);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
	});

	afterEach(() => {
		for (const publisher of publishers.splice(0)) publisher.dispose();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it("prefers the canonical token when both enrollment variables are present", async () => {
		vi.stubEnv("FEADS_AGENT_TOKEN", "canonical-token");
		vi.stubEnv("FEADS_TOKEN", "legacy-token");
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent());
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();

		const fetchMock = vi.mocked(fetch);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual(
			expect.objectContaining({ Authorization: "Bearer canonical-token" }),
		);
		expect(getFeadsPresenceStatus()).toMatchObject({ credentialSource: "canonical", tokenConfigured: true });
	});

	it("keeps an opaque canonical value authoritative for server-side validation", async () => {
		const invalidCanonical = "not-a-valid-feads-token";
		vi.stubEnv("FEADS_AGENT_TOKEN", invalidCanonical);
		vi.stubEnv("FEADS_TOKEN", "legacy-token");
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent());
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();

		const fetchMock = vi.mocked(fetch);
		expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual(
			expect.objectContaining({ Authorization: `Bearer ${invalidCanonical}` }),
		);
		expect(getFeadsPresenceStatus().credentialSource).toBe("canonical");
		expect(formatFeadsPresenceStatus()).not.toContain(invalidCanonical);
	});

	it("falls back to the legacy token only when the canonical value is absent", async () => {
		vi.stubEnv("FEADS_AGENT_TOKEN", "   ");
		vi.stubEnv("FEADS_TOKEN", " legacy-token ");
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent());
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();

		const fetchMock = vi.mocked(fetch);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual(
			expect.objectContaining({ Authorization: "Bearer legacy-token" }),
		);
		const status = getFeadsPresenceStatus();
		expect(status).toMatchObject({ credentialSource: "legacy", tokenConfigured: true });
		const rendered = formatFeadsPresenceStatus(status);
		expect(rendered).toContain("migration: rename FEADS_TOKEN to FEADS_AGENT_TOKEN and restart phi");
		expect(rendered).not.toContain("legacy-token");
	});

	it("treats blank and absent enrollment values as unconfigured without sending requests", async () => {
		for (const publisher of publishers.splice(0)) publisher.dispose();
		vi.stubEnv("FEADS_AGENT_TOKEN", "\t ");
		vi.stubEnv("FEADS_TOKEN", "");
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent());
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS + FEADS_PRESENCE_HEARTBEAT_MS);
		await settle();

		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		expect(presenceTesting.resolvePresenceCredential()).toEqual({ token: undefined, source: "none" });
		expect(getFeadsPresenceStatus()).toMatchObject({
			tokenConfigured: false,
			credentialSource: "none",
			disabledReason: "token-not-configured",
		});
	});

	it("projects separate main and child rows with frozen lineage and no private detail", async () => {
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent());
		publisher.publish(childEvent());

		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();

		const fetchMock = vi.mocked(fetch);
		expect(fetchMock).toHaveBeenCalledOnce();
		const body = bodyOf(fetchMock.mock.calls[0]);
		expect(body).toEqual({
			version: 1,
			rows: [
				expect.objectContaining({
					session_id: expect.any(String),
					runtime_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
					run_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
					parent_run_id: "",
					kind: "main",
					handle: "main",
					display_name: "Review dashboard",
					status: "working",
					model: "gateway/example-large",
					activity: "bash",
					context_percent: 37.5,
					started_at: 900,
				}),
				expect.objectContaining({
					run_id: "child-run-7",
					parent_run_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
					kind: "subagent",
					handle: "report-ui-x7k2",
					display_name: "report-ui",
					activity: "read",
				}),
			],
		});
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("SECRET_PROMPT");
		expect(serialized).not.toContain("private/secret");
		expect(serialized).not.toContain("Prompt and task");
		expect((body.rows as Array<Record<string, unknown>>)[0].runtime_id).toBe(
			(body.rows as Array<Record<string, unknown>>)[1].parent_run_id,
		);
	});

	it("uses an empty Feads display name for an unnamed main while preserving named rows", async () => {
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent({ displayName: "main" }));
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();
		expect(bodyOf(vi.mocked(fetch).mock.calls[0]).rows).toEqual([expect.objectContaining({ display_name: "" })]);
	});

	it.each([
		[{ PHI_CLIENT: "p3" }, "p3"],
		[{ PHI_CLIENT: " Forca ", TERM_PROGRAM: "iTerm.app" }, "forca"],
		[{ TERM_PROGRAM: "Orca" }, "forca"],
		[{ PHI_CLIENT: "P3 Code" }, undefined],
		[{ PHI_CLIENT: "a".repeat(33) }, undefined],
		[{}, undefined],
	])("attributes the launching ADE from %o", async (env, client) => {
		for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent());
		publisher.publish(childEvent());
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();

		const rows = bodyOf(vi.mocked(fetch).mock.calls[0]).rows as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			if (client === undefined) expect("client" in row).toBe(false);
			else expect(row.client).toBe(client);
		}
	});

	it("skips legacy children without a stable runId and only maps allowlisted phases", async () => {
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(
			childEvent({ runId: undefined, safeActivity: "raw private detail", activity: { tool: "raw private detail" } }),
		);
		publisher.publish(mainEvent({ safeActivity: "raw private detail", status: "idle" }));

		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();

		const body = bodyOf(vi.mocked(fetch).mock.calls[0]);
		expect(body.rows).toEqual([expect.objectContaining({ kind: "main", status: "idle", activity: "" })]);
		expect(JSON.stringify(body)).not.toContain("raw private detail");
	});

	it("keeps timeout failures fail-open and quiet", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchMock = vi.mocked(fetch).mockReset();
		fetchMock
			.mockImplementationOnce(
				(_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")), {
							once: true,
						});
					}),
			)
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const publisher = new FeadsPresencePublisher({ timeoutMs: 10 });
		publishers.push(publisher);
		publisher.publish(mainEvent());
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await vi.advanceTimersByTimeAsync(10);
		await settle();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(warn).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(getFeadsPresenceStatus().lastFailure).toBe("timeout"));
		warn.mockRestore();
		feadsSessionState.disable();
		publisher.dispose();
		await settle();
	});

	it("coalesces bursts, keeps one request in flight, and refreshes active rows", async () => {
		let resolveFirst: ((value: Response) => void) | undefined;
		const first = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const fetchMock = vi
			.mocked(fetch)
			.mockReset()
			.mockReturnValueOnce(first)
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent({ ctxPct: 1 }));
		publisher.publish(mainEvent({ ctxPct: 2 }));
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		expect(fetchMock).toHaveBeenCalledOnce();
		publisher.publish(mainEvent({ ctxPct: 3 }));
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		expect(fetchMock).toHaveBeenCalledOnce();

		resolveFirst?.(new Response("{}", { status: 200 }));
		await settle();
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(bodyOf(fetchMock.mock.calls[1]).rows).toEqual([expect.objectContaining({ context_percent: 3 })]);

		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_HEARTBEAT_MS);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("honors Retry-After seconds and coalesces events through the shared cooldown", async () => {
		const fetchMock = vi
			.mocked(fetch)
			.mockReset()
			.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "2" } }))
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const publisher = new FeadsPresencePublisher({ debounceMs: 10 });
		publishers.push(publisher);
		publisher.publish(mainEvent({ ctxPct: 1 }));
		await vi.advanceTimersByTimeAsync(10);
		await settle();
		expect(fetchMock).toHaveBeenCalledOnce();

		publisher.publish(mainEvent({ ctxPct: 2 }));
		await vi.advanceTimersByTimeAsync(1_999);
		expect(fetchMock).toHaveBeenCalledOnce();
		publisher.publish(mainEvent({ ctxPct: 3 }));
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(9);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(bodyOf(fetchMock.mock.calls[1]).rows).toEqual([expect.objectContaining({ context_percent: 3 })]);
	});

	it("honors Retry-After HTTP dates", async () => {
		const retryAt = Date.parse(new Date(Date.now() + 5_000).toUTCString());
		const fetchMock = vi
			.mocked(fetch)
			.mockReset()
			.mockResolvedValueOnce(
				new Response("", { status: 503, headers: { "Retry-After": new Date(retryAt).toUTCString() } }),
			)
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const publisher = new FeadsPresencePublisher({ debounceMs: 10 });
		publishers.push(publisher);
		publisher.publish(mainEvent({ ctxPct: 1 }));
		await vi.advanceTimersByTimeAsync(10);
		await settle();
		const remaining = Math.max(0, retryAt - Date.now());
		publisher.publish(mainEvent({ ctxPct: 2 }));
		if (remaining > 1) await vi.advanceTimersByTimeAsync(remaining - 1);
		expect(fetchMock).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("uses bounded exponential fallback backoff with deterministic jitter", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		const fetchMock = vi
			.mocked(fetch)
			.mockReset()
			.mockResolvedValueOnce(new Response("", { status: 503 }))
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const publisher = new FeadsPresencePublisher({ debounceMs: 10 });
		publishers.push(publisher);
		publisher.publish(mainEvent({ ctxPct: 1 }));
		await vi.advanceTimersByTimeAsync(10);
		await settle();
		publisher.publish(mainEvent({ ctxPct: 2 }));
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_RETRY_BASE_MS - 1);
		expect(fetchMock).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		random.mockRestore();
	});

	it("keeps a pending terminal row when its older active PUT fails", async () => {
		let resolveFirst: ((value: Response) => void) | undefined;
		const first = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const fetchMock = vi
			.mocked(fetch)
			.mockReset()
			.mockReturnValueOnce(first)
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent({ ctxPct: 1 }));
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		expect(fetchMock).toHaveBeenCalledOnce();

		publisher.publish(mainEvent({ status: "done", safeActivity: "done", ctxPct: 2 }, "agent_end"));
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		expect(fetchMock).toHaveBeenCalledOnce();

		resolveFirst?.(new Response("{}", { status: 503 }));
		await settle();
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_RETRY_BASE_MS + 1_000);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(bodyOf(fetchMock.mock.calls[0]).rows).toEqual([expect.objectContaining({ status: "working" })]);
		expect(bodyOf(fetchMock.mock.calls[1]).rows).toEqual([expect.objectContaining({ status: "done" })]);

		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_HEARTBEAT_MS);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("sends terminal rows once, then deletes only active rows on normal dispose", async () => {
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent());
		publisher.publish(childEvent());
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();

		publisher.publish(mainEvent({ status: "done", safeActivity: "done" }, "agent_end"));
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_HEARTBEAT_MS);
		await settle();
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);

		publisher.dispose();
		await settle();
		const fetchMock = vi.mocked(fetch);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[3][0]).toBe("http://feads.test/api/runtime-presence");
		expect((fetchMock.mock.calls[3][1] as RequestInit).method).toBe("DELETE");
		expect(bodyOf(fetchMock.mock.calls[3]).run_ids).toEqual(["child-run-7"]);
	});

	it("honors the initial environment guard without creating presence timers", async () => {
		for (const publisher of publishers.splice(0)) publisher.dispose();
		vi.stubEnv("PI_NO_FEADS", "1");
		feadsSessionState.startSession("initially-disabled");
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent());
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS + FEADS_PRESENCE_HEARTBEAT_MS);
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	});

	it("cancels debounce and heartbeat timers, aborts in-flight work, and restarts on a new session", async () => {
		const publisher = new FeadsPresencePublisher({ debounceMs: 50, heartbeatMs: 1000 });
		publishers.push(publisher);
		const fetchMock = vi.mocked(fetch).mockImplementation((_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
					once: true,
				});
			});
		});
		publisher.publish(mainEvent());
		expect(vi.getTimerCount()).toBe(2);
		await vi.advanceTimersByTimeAsync(50);
		expect(fetchMock).toHaveBeenCalledOnce();
		feadsSessionState.disable();
		await settle();
		expect(vi.getTimerCount()).toBe(0);
		expect(fetchMock).toHaveBeenCalledOnce();

		feadsSessionState.startSession("restarted-session");
		publisher.publish(mainEvent({ displayName: "restarted" }));
		expect(vi.getTimerCount()).toBe(2);
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		await vi.advanceTimersByTimeAsync(50);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("cancels pending work on the shared guard without cleanup traffic", async () => {
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent());
		feadsSessionState.disable();
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS + FEADS_PRESENCE_HEARTBEAT_MS);
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	});

	it("keeps HTTP failures quiet, including throttling responses", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchMock = vi
			.mocked(fetch)
			.mockReset()
			.mockResolvedValue(new Response("secret error body", { status: 429 }));
		const publisher = new FeadsPresencePublisher({ debounceMs: 1 });
		publishers.push(publisher);
		publisher.publish(mainEvent());
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("is inert without a token and tolerates server failures", async () => {
		for (const publisher of publishers.splice(0)) publisher.dispose();
		vi.stubEnv("FEADS_AGENT_TOKEN", undefined);
		const noToken = new FeadsPresencePublisher();
		noToken.publish(mainEvent());
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS + FEADS_PRESENCE_HEARTBEAT_MS);
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		expect(getFeadsPresenceStatus()).toMatchObject({
			tokenConfigured: false,
			enabled: false,
			disabledReason: "token-not-configured",
			publisherStarted: false,
		});

		vi.stubEnv("FEADS_AGENT_TOKEN", "test-token");
		const failures = [401, 403, 404, 409, 429, 500];
		for (const status of failures) {
			vi.mocked(fetch).mockResolvedValueOnce(new Response("secret error body", { status }));
			feadsSessionState.startSession(`failure-${status}`);
			const publisher = new FeadsPresencePublisher({ debounceMs: 1 });
			publishers.push(publisher);
			publisher.publish(mainEvent());
			await vi.advanceTimersByTimeAsync(1);
			await settle();
			expect(getFeadsPresenceStatus().lastFailure).toBe(status === 500 ? "other" : String(status));
		}
		expect(vi.mocked(fetch).mock.calls.length).toBe(failures.length);
		expect(formatFeadsPresenceStatus(getFeadsPresenceStatus())).not.toContain("secret error body");
	});

	it("reports safe accepted counts and never exposes credentials or error details", async () => {
		const token = "fdsa_example";
		vi.stubEnv("FEADS_AGENT_TOKEN", token);
		vi.stubEnv("FEADS_URL", "https://user:password@feads.example/private?secret=query-secret");
		vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 7 }), { status: 200 }));
		const publisher = new FeadsPresencePublisher({ debounceMs: 1 });
		publishers.push(publisher);
		publisher.publish(mainEvent({ activity: { tool: "read /private/task" } }));
		await vi.advanceTimersByTimeAsync(1);
		await settle();

		const status = getFeadsPresenceStatus();
		const rendered = formatFeadsPresenceStatus(status);
		expect(status).toMatchObject({
			tokenConfigured: true,
			effectiveHost: "feads.example",
			enabled: true,
			publisherStarted: true,
			lastSuccessfulAcceptedCount: 7,
			lastFailure: undefined,
		});
		expect(status.lastSuccessfulAt).toEqual(expect.any(Number));
		expect(
			presenceTesting.failureCategoryForError(new TypeError("network secret"), new AbortController().signal),
		).toBe("network");
		expect(
			presenceTesting.failureCategoryForError(new Error("raw server error body"), new AbortController().signal),
		).toBe("other");
		expect(rendered).not.toContain(token);
		for (const secret of ["password", "private", "query-secret", "SECRET_PROMPT", "secret error body"]) {
			expect(rendered).not.toContain(secret);
		}
	});

	it("creates a new runtime UUID for a resumed durable session", () => {
		const first = feadsSessionState.startSession("same-session").runtimeId;
		const second = feadsSessionState.startSession("same-session").runtimeId;
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
	});

	it("uses 64-row batches without dropping older active rows or stopping heartbeats", async () => {
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		const rowCount = FEADS_PRESENCE_MAX_ROWS + 5;
		for (let index = 0; index < rowCount; index++) {
			publisher.publish(childEvent({ runId: `child-${index}`, handle: `child-${index}` }));
		}
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();

		const fetchMock = vi.mocked(fetch);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect((bodyOf(fetchMock.mock.calls[0]).rows as unknown[]).length).toBe(FEADS_PRESENCE_MAX_ROWS);
		expect((bodyOf(fetchMock.mock.calls[1]).rows as unknown[]).length).toBe(5);
		expect(bodyOf(fetchMock.mock.calls[0]).rows).toEqual(
			expect.arrayContaining([expect.objectContaining({ run_id: "child-0" })]),
		);
		expect(
			[...fetchMock.mock.calls]
				.flatMap((call) => bodyOf(call).rows as Array<Record<string, unknown>>)
				.map((row) => row.run_id),
		).toEqual(Array.from({ length: rowCount }, (_value, index) => `child-${index}`));

		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_HEARTBEAT_MS);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect((bodyOf(fetchMock.mock.calls[2]).rows as unknown[]).length).toBe(FEADS_PRESENCE_MAX_ROWS);
		expect((bodyOf(fetchMock.mock.calls[3]).rows as unknown[]).length).toBe(5);
	});

	it("retains terminal updates for every active row across the same batch boundary", async () => {
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		const rowCount = FEADS_PRESENCE_MAX_ROWS + 5;
		for (let index = 0; index < rowCount; index++) {
			publisher.publish(childEvent({ runId: `child-${index}`, handle: `child-${index}` }));
		}
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();

		for (let index = 0; index < rowCount; index++) {
			publisher.publish(
				childEvent({ runId: `child-${index}`, handle: `child-${index}`, status: "done", safeActivity: "done" }),
			);
		}
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();

		const fetchMock = vi.mocked(fetch);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		for (const call of fetchMock.mock.calls.slice(2)) {
			expect((bodyOf(call).rows as Array<Record<string, unknown>>).every((row) => row.status === "done")).toBe(true);
		}
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_HEARTBEAT_MS);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("deletes active rows in 64-ID chunks using the captured runtime after a new session starts", async () => {
		let resolvePut: ((value: Response) => void) | undefined;
		const put = new Promise<Response>((resolve) => {
			resolvePut = resolve;
		});
		const fetchMock = vi
			.mocked(fetch)
			.mockReset()
			.mockReturnValueOnce(put)
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		for (let index = 0; index < FEADS_PRESENCE_MAX_ROWS + 1; index++) {
			publisher.publish(childEvent({ runId: `child-${index}`, handle: `child-${index}` }));
		}
		const oldRuntimeId = feadsSessionState.current.runtimeId;
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		expect(fetchMock).toHaveBeenCalledOnce();

		publisher.dispose();
		feadsSessionState.startSession("new-session-after-dispose");
		resolvePut?.(new Response("{}", { status: 200 }));
		await settle();
		await settle();
		await settle();
		await vi.advanceTimersByTimeAsync(0);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		for (const call of fetchMock.mock.calls.slice(1)) {
			expect((call[1] as RequestInit).method).toBe("DELETE");
			expect(bodyOf(call).runtime_id).toBe(oldRuntimeId);
		}
		expect((bodyOf(fetchMock.mock.calls[1]).run_ids as string[]).length).toBe(FEADS_PRESENCE_MAX_ROWS);
		expect((bodyOf(fetchMock.mock.calls[2]).run_ids as string[]).length).toBe(1);
	});

	it("retries a failed terminal delivery once on the next heartbeat and never heartbeats it after success", async () => {
		const fetchMock = vi
			.mocked(fetch)
			.mockReset()
			.mockResolvedValueOnce(new Response("{}", { status: 503 }))
			.mockResolvedValueOnce(new Response("{}", { status: 200 }));
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent({ status: "done", safeActivity: "done" }, "agent_end"));
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();
		expect(fetchMock).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_HEARTBEAT_MS);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_HEARTBEAT_MS);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("includes a failed terminal retry in dispose cleanup without duplicate rows", async () => {
		const fetchMock = vi
			.mocked(fetch)
			.mockReset()
			.mockResolvedValueOnce(new Response("{}", { status: 503 }))
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent({ status: "failed", safeActivity: "failed" }, "agent_end"));
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();
		expect(fetchMock).toHaveBeenCalledOnce();

		publisher.dispose();
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const initialRows = bodyOf(fetchMock.mock.calls[0]).rows as Array<Record<string, unknown>>;
		const cleanupRows = bodyOf(fetchMock.mock.calls[1]).rows as Array<Record<string, unknown>>;
		expect(cleanupRows).toHaveLength(1);
		expect(cleanupRows[0]).toEqual(expect.objectContaining({ status: "failed" }));
		expect(cleanupRows[0].run_id).toBe(initialRows[0].run_id);
	});

	it("bounds a failed terminal retry to one attempt", async () => {
		const fetchMock = vi
			.mocked(fetch)
			.mockReset()
			.mockResolvedValue(new Response("{}", { status: 503 }));
		const publisher = new FeadsPresencePublisher();
		publishers.push(publisher);
		publisher.publish(mainEvent({ status: "failed", safeActivity: "failed" }, "agent_end"));
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_DEBOUNCE_MS);
		await settle();
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_HEARTBEAT_MS);
		await settle();
		await vi.advanceTimersByTimeAsync(FEADS_PRESENCE_HEARTBEAT_MS);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
