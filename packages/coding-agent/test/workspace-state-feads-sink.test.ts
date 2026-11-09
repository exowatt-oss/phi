import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import feadsAgentExtension from "../src/extensions/feads-agent/index.ts";
import { __testing as presenceTesting } from "../src/extensions/feads-agent/presence-publisher.ts";
import {
	AWAITING_COMMENT_PREFIX,
	awaitingComment,
	bindWorkspace,
	callSucceeded,
	publishAwaitingHuman,
	registerWorkspaceStateSink,
	restoreInProgress,
	__testing as sinkTesting,
} from "../src/extensions/feads-agent/workspace-state-sink.ts";
import { workspaceStateStore } from "../src/extensions/workspace-state/state.ts";
import type { WorkspaceStateRecord } from "../src/extensions/workspace-state/types.ts";
import { isolateFeadsAgentDir } from "./feads-test-env.ts";

beforeEach(() => {
	isolateFeadsAgentDir();
});

type Handlers = Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;

const context = { cwd: "/tmp", sessionManager: { getSessionId: () => "s" } } as never;

const awaiting = (overrides: Partial<WorkspaceStateRecord> = {}): WorkspaceStateRecord => ({
	v: 1,
	session_id: "s1",
	session_file: "/tmp/s1.jsonl",
	cwd: "/tmp/project",
	host: "workstation",
	end_state: "awaiting-human",
	question: "Promote 0.83.0-exo.30 or hold?",
	feads: { epic: "forca-w8u" },
	source: "tool",
	ts: 1_700_000_000_000,
	...overrides,
});

/** An MCP reply the way the real endpoint frames it: an SSE `data:` line, not bare JSON. */
const sseOk = (result: unknown) =>
	new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});

/** The same reply framed as plain JSON, which the MCP spec also allows. */
const jsonOk = (result: unknown) =>
	new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

const handshake = () => new Response("", { status: 200, headers: { "mcp-session-id": "sid-1" } });

type ToolCall = { name: string | undefined; args: unknown };

const toolCalls = (mock: { mock: { calls: unknown[][] } }): ToolCall[] => {
	const calls: ToolCall[] = [];
	for (const [, init] of mock.mock.calls) {
		const body = (init as RequestInit | undefined)?.body;
		if (typeof body !== "string") continue;
		const parsed = JSON.parse(body) as { method?: string; params?: { name?: string; arguments?: unknown } };
		if (parsed.method === "tools/call") calls.push({ name: parsed.params?.name, args: parsed.params?.arguments });
	}
	return calls;
};

beforeEach(() => {
	workspaceStateStore.clear();
	delete process.env.FEADS_URL;
	delete process.env.PI_SUBAGENT_ID;
});

afterEach(async () => {
	await sinkTesting.drain();
	vi.restoreAllMocks();
	workspaceStateStore.clear();
	delete process.env.FEADS_AGENT_TOKEN;
	delete process.env.FEADS_URL;
	presenceTesting.resetPresenceStatus(undefined, "http://127.0.0.1:8787");
});

describe("workspace-state feads sink wire format", () => {
	it("writes the contract comment text verbatim", () => {
		expect(AWAITING_COMMENT_PREFIX).toBe("[workspace-state] awaiting-human:");
		expect(awaitingComment("Merge or hold?")).toBe("[workspace-state] awaiting-human: Merge or hold?");
		// No question means no trailing space, so the comment never renders as a dangling colon-space.
		expect(awaitingComment(undefined)).toBe("[workspace-state] awaiting-human:");
	});

	it("routes SSE-vs-JSON parsing on content-type, not on the body containing `data:`", () => {
		// A plain-JSON reply whose *content* quotes `data:` used to be parsed as SSE, find no
		// frames, and report failure. On the status write that false negative stranded the epic
		// `blocked`, because the sink never recorded a block it had in fact made.
		const quoting = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { isError: false, content: [{ type: "text", text: "logged data: 1 row" }] },
		});
		expect(callSucceeded(quoting, "application/json")).toBe(true);
		expect(callSucceeded(quoting)).toBe(true);
		// An SSE body is only read as frames when the header says so.
		const framed = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"isError":false}}';
		expect(callSucceeded(framed, "text/event-stream; charset=utf-8")).toBe(true);
		expect(callSucceeded(framed, "application/json")).toBe(false);
		// A JSON-declared failure is still a failure, whichever framing carries it.
		expect(callSucceeded('{"jsonrpc":"2.0","id":1,"result":{"isError":true}}', "application/json")).toBe(false);
	});

	it("reads success and failure out of both MCP reply framings", () => {
		expect(callSucceeded('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"isError":false}}')).toBe(true);
		expect(callSucceeded('{"jsonrpc":"2.0","id":1,"result":{"isError":false}}')).toBe(true);
		expect(callSucceeded('data: {"jsonrpc":"2.0","id":1,"result":{"isError":true}}')).toBe(false);
		expect(callSucceeded('data: {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"no such issue"}}')).toBe(
			false,
		);
		// Unparseable is failure: the sink may not claim a write it cannot see.
		expect(callSucceeded("<html>502</html>")).toBe(false);
		expect(callSucceeded("")).toBe(false);
	});

	it("stops reading a body at the byte cap instead of buffering an endless stream", async () => {
		const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
		let pulls = 0;
		let cancelled = false;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			return new Response(endless, { status: 200 });
		});

		// A body that never ends must not hang the sink or grow without bound; the read stops at
		// the cap, the stream is cancelled, and an unparseable body counts as failure.
		const outcome = await publishAwaitingHuman({ token: "t", record: awaiting() });
		expect(outcome.blocked).toBe(false);
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThanOrEqual(sinkTesting.MAX_RESPONSE_BYTES / chunk.byteLength + 1);
	});

	it("comments then blocks the epic over the streamable-HTTP handshake", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			return sseOk({ isError: false, content: [] });
		});

		const outcome = await publishAwaitingHuman({ token: "fdsa_t", record: awaiting() });
		expect(outcome).toEqual({ blocked: true });
		expect(toolCalls(fetchMock)).toEqual([
			{
				name: "comment",
				args: { issue_id: "forca-w8u", text: "[workspace-state] awaiting-human: Promote 0.83.0-exo.30 or hold?" },
			},
			{ name: "update", args: { issue_id: "forca-w8u", status: "blocked" } },
		]);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:8788/mcp");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer fdsa_t");
		// The endpoint answers 406 unless both content types are accepted.
		expect(headers.Accept).toBe("application/json, text/event-stream");
		// The session id from the handshake must be echoed, or tools/call answers 400.
		const followUp = fetchMock.mock.calls[1] as [string, RequestInit];
		expect((followUp[1].headers as Record<string, string>)["mcp-session-id"]).toBe("sid-1");
		expect(fetchMock).toHaveBeenLastCalledWith(url, expect.objectContaining({ method: "DELETE" }));
	});

	it("honours FEADS_URL", async () => {
		process.env.FEADS_URL = "https://feads.internal.example/";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(handshake());
		await publishAwaitingHuman({ token: "t", record: awaiting() });
		expect(fetchMock.mock.calls[0][0]).toBe("https://feads.internal.example/mcp");
	});

	it("reports a rejected status write without claiming the epic is blocked", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			if (typeof body === "string" && body.includes('"update"')) {
				return sseOk({ isError: true, content: [{ type: "text", text: "not found" }] });
			}
			return sseOk({ isError: false, content: [] });
		});
		expect(await publishAwaitingHuman({ token: "t", record: awaiting() })).toEqual({
			blocked: false,
			error: "feads rejected the status write",
		});
	});

	it("fails open when the endpoint is unreachable or refuses the handshake", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		expect(await publishAwaitingHuman({ token: "t", record: awaiting() })).toEqual({
			blocked: false,
			error: "offline",
		});

		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
		expect(await publishAwaitingHuman({ token: "t", record: awaiting() })).toEqual({
			blocked: false,
			error: "feads MCP handshake failed",
		});
	});

	it("makes no request for a record without an epic", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		expect(await publishAwaitingHuman({ token: "t", record: awaiting({ feads: undefined }) })).toEqual({
			blocked: false,
			error: "record carries no feads epic",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("binds workspace_dir, session_id and host on the epic with feads' parameter names", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			return sseOk({ isError: false, content: [] });
		});
		expect(await bindWorkspace({ token: "t", record: awaiting() })).toEqual({ bound: true });
		// Names are feads #57's exactly; feads merges them per key, so other metadata survives.
		expect(toolCalls(fetchMock)).toEqual([
			{
				name: "update",
				args: {
					issue_id: "forca-w8u",
					workspace_dir: "/tmp/project",
					session_id: "s1",
					host: "workstation",
				},
			},
		]);
	});

	it("fails open when the endpoint does not accept the binding parameters yet", async () => {
		// feads #57 not deployed: `update` rejects the unknown arguments. Reported, never thrown.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			return jsonOk({ isError: true, content: [{ type: "text", text: "unexpected keyword argument" }] });
		});
		expect(await bindWorkspace({ token: "t", record: awaiting() })).toEqual({
			bound: false,
			error: "feads rejected the workspace binding",
		});

		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		expect(await bindWorkspace({ token: "t", record: awaiting() })).toEqual({ bound: false, error: "offline" });
	});

	it("makes no binding request for a record without an epic", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		expect(await bindWorkspace({ token: "t", record: awaiting({ feads: undefined }) })).toEqual({
			bound: false,
			error: "record carries no feads epic",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("restores in_progress, and keeps the epic marked blocked when the restore fails", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			return sseOk({ isError: false, content: [] });
		});
		expect(await restoreInProgress({ token: "t", epic: "forca-w8u" })).toEqual({ blocked: false });
		expect(toolCalls(fetchMock)).toEqual([
			{ name: "update", args: { issue_id: "forca-w8u", status: "in_progress" } },
		]);

		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		expect(await restoreInProgress({ token: "t", epic: "forca-w8u" })).toEqual({ blocked: true, error: "offline" });
	});
});

describe("feads-agent workspace-state sink wiring", () => {
	const load = async () => {
		const shared = createExtensionRuntime();
		return loadExtensionFromFactory(feadsAgentExtension, process.cwd(), createEventBus(), shared, "<inline>");
	};
	const invoke = async (extension: Awaited<ReturnType<typeof load>>, name: string, event: unknown) => {
		for (const handler of (extension.handlers as Handlers).get(name) ?? []) await handler(event, context);
	};

	it("writes awaiting-human to the board and restores in_progress on the next turn", async () => {
		process.env.FEADS_AGENT_TOKEN = "fdsa_t";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			return sseOk({ isError: false, content: [] });
		});
		const extension = await load();

		workspaceStateStore.publish(awaiting());
		await sinkTesting.drain();
		// The binding write comes first, then the awaiting-human pair.
		expect(toolCalls(fetchMock).map((call: ToolCall) => call.name)).toEqual(["update", "comment", "update"]);
		expect(toolCalls(fetchMock)[0].args).toEqual({
			issue_id: "forca-w8u",
			workspace_dir: "/tmp/project",
			session_id: "s1",
			host: "workstation",
		});
		expect(toolCalls(fetchMock)[2].args).toEqual({ issue_id: "forca-w8u", status: "blocked" });

		fetchMock.mockClear();
		await invoke(extension, "agent_start", { type: "agent_start" });
		await sinkTesting.drain();
		expect(toolCalls(fetchMock)).toEqual([
			{ name: "update", args: { issue_id: "forca-w8u", status: "in_progress" } },
		]);

		// Nothing left blocked, so a second turn writes nothing.
		fetchMock.mockClear();
		await invoke(extension, "agent_start", { type: "agent_start" });
		await sinkTesting.drain();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("never restores a blocked status it did not set", async () => {
		process.env.FEADS_AGENT_TOKEN = "fdsa_t";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			// The epic exists but the status write is refused, so the sink owns nothing.
			if (typeof body === "string" && body.includes('"update"')) return sseOk({ isError: true, content: [] });
			return sseOk({ isError: false, content: [] });
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const extension = await load();

		workspaceStateStore.publish(awaiting());
		await sinkTesting.drain();
		fetchMock.mockClear();
		await invoke(extension, "agent_start", { type: "agent_start" });
		await sinkTesting.drain();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(warn.mock.calls.flat().join(" ")).toContain("workspace-state sink");
	});

	it("binds the epic but comments and blocks nothing for the other three end states", async () => {
		process.env.FEADS_AGENT_TOKEN = "fdsa_t";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			return sseOk({ isError: false, content: [] });
		});
		await load();
		for (const end_state of ["complete", "mid-work", "blocked-approval"] as const) {
			workspaceStateStore.publish(awaiting({ end_state, question: undefined }));
			await sinkTesting.drain();
		}
		// One binding write for the three turns, and no comment or status write at all.
		expect(toolCalls(fetchMock)).toEqual([
			{
				name: "update",
				args: { issue_id: "forca-w8u", workspace_dir: "/tmp/project", session_id: "s1", host: "workstation" },
			},
		]);
	});

	it("re-binds when the epic changes, and stops retrying a binding feads keeps rejecting", async () => {
		process.env.FEADS_AGENT_TOKEN = "fdsa_t";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			return sseOk({ isError: false, content: [] });
		});
		await load();

		workspaceStateStore.publish(awaiting({ end_state: "complete", question: undefined }));
		await sinkTesting.drain();
		fetchMock.mockClear();
		// Same epic again: already bound, so nothing is written.
		workspaceStateStore.publish(awaiting({ end_state: "complete", question: undefined }));
		await sinkTesting.drain();
		expect(fetchMock).not.toHaveBeenCalled();

		// A different epic (the agent re-pointed the session) is bound once more.
		workspaceStateStore.publish(
			awaiting({ end_state: "complete", question: undefined, feads: { epic: "forca-x1y" } }),
		);
		await sinkTesting.drain();
		expect(toolCalls(fetchMock)).toEqual([
			{
				name: "update",
				args: { issue_id: "forca-x1y", workspace_dir: "/tmp/project", session_id: "s1", host: "workstation" },
			},
		]);

		// A feads that rejects the binding parameters is retried a bounded number of times, not
		// asked again on every turn for the life of the session.
		vi.restoreAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const rejecting = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			return jsonOk({ isError: true, content: [] });
		});
		for (let turn = 0; turn < sinkTesting.MAX_BIND_ATTEMPTS + 2; turn++) {
			workspaceStateStore.publish(
				awaiting({ end_state: "complete", question: undefined, feads: { epic: "forca-zzz" } }),
			);
			await sinkTesting.drain();
		}
		expect(toolCalls(rejecting)).toHaveLength(sinkTesting.MAX_BIND_ATTEMPTS);
	});

	it("keeps a failing restore for one epic when another epic blocks", async () => {
		process.env.FEADS_AGENT_TOKEN = "fdsa_t";
		let failRestores = true;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body !== "string") return sseOk({ isError: false, content: [] });
			if (body.includes('"initialize"')) return handshake();
			if (failRestores && body.includes('"in_progress"')) return sseOk({ isError: true, content: [] });
			return sseOk({ isError: false, content: [] });
		});
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const extension = await load();

		// Epic A blocks, then its restore fails, so it is kept for retry.
		workspaceStateStore.publish(awaiting());
		await sinkTesting.drain();
		await invoke(extension, "agent_start", { type: "agent_start" });
		await sinkTesting.drain();

		// Epic B blocks in the meantime. With a single slot this evicted A's pending retry.
		workspaceStateStore.publish(awaiting({ feads: { epic: "forca-x1y" } }));
		await sinkTesting.drain();

		failRestores = false;
		fetchMock.mockClear();
		await invoke(extension, "agent_start", { type: "agent_start" });
		await sinkTesting.drain();
		const restored = toolCalls(fetchMock)
			.map((call: ToolCall) => call.args as { issue_id?: string; status?: string })
			.filter((args) => args.status === "in_progress")
			.map((args) => args.issue_id);
		expect(new Set(restored)).toEqual(new Set(["forca-w8u", "forca-x1y"]));
	});

	it("cancels a queued write when a reload displaces the sink", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = (init as RequestInit | undefined)?.body;
			if (typeof body === "string" && body.includes('"initialize"')) return handshake();
			return sseOk({ isError: false, content: [] });
		});
		const stubPi = { on: () => undefined } as unknown as ExtensionAPI;

		// A write queued by the first sink, then a tokenless reload before the queue drains: the
		// displaced sink's work must not execute with the credential this session no longer has.
		registerWorkspaceStateSink(stubPi, { token: "stale_t" });
		workspaceStateStore.publish(awaiting());
		registerWorkspaceStateSink(stubPi, { token: undefined });
		await sinkTesting.drain();
		expect(fetchMock).not.toHaveBeenCalled();

		// Disposing has the same effect for work queued before the dispose call.
		const dispose = registerWorkspaceStateSink(stubPi, { token: "live_t" });
		workspaceStateStore.publish(awaiting({ feads: { epic: "forca-x1y" } }));
		dispose();
		await sinkTesting.drain();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is inert without a token and under /no-feads", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		await load();
		workspaceStateStore.publish(awaiting());
		await sinkTesting.drain();
		expect(fetchMock).not.toHaveBeenCalled();

		process.env.FEADS_AGENT_TOKEN = "fdsa_t";
		const extension = await load();
		await extension.commands.get("no-feads")?.handler("", { ui: { notify: vi.fn() } } as never);
		workspaceStateStore.publish(awaiting());
		await sinkTesting.drain();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
