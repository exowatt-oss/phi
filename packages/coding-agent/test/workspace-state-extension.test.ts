import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { classifyHeuristic, parseClassifierAnswer } from "../src/extensions/workspace-state/classify.ts";
import workspaceStateExtension, { __testing } from "../src/extensions/workspace-state/index.ts";
import { buildWorkspaceStateRecord } from "../src/extensions/workspace-state/record.ts";
import { workspaceStateStore } from "../src/extensions/workspace-state/state.ts";
import {
	WORKSPACE_STATE_ENTRY,
	WORKSPACE_STATE_NOTES_ENTRY,
	type WorkspaceStateRecord,
} from "../src/extensions/workspace-state/types.ts";

type Handlers = Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
const appended: Array<{ customType: string; data: unknown }> = [];
const entries: Array<Record<string, unknown>> = [];
let sideQuestion:
	| ((req: {
			messages: Array<{ content: string }>;
			model?: string;
			signal?: AbortSignal;
	  }) => Promise<{ answer: string; usage: undefined }>)
	| undefined;
let settings: { classifier: "llm" | "heuristic"; model?: string } = {
	classifier: "llm",
	model: "gateway/example-medium",
};
const notify = vi.fn();
const context = {
	cwd: "/tmp/project",
	mode: "tui",
	ui: { notify },
	sessionManager: {
		getSessionId: () => "session-main",
		getSessionFile: () => "/tmp/project/session.jsonl",
		getEntries: () => entries,
		getBranch: () => entries,
	},
	get sideQuestion() {
		return sideQuestion;
	},
} as never;

const load = async () => {
	const runtime = createExtensionRuntime();
	runtime.appendEntry = (customType, data) => {
		appended.push({ customType, data });
	};
	return loadExtensionFromFactory(
		workspaceStateExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"<inline:workspace-state>",
	);
};
const invoke = async (
	extension: Awaited<ReturnType<typeof load>>,
	name: string,
	event: unknown = { type: name },
	ctx: unknown = context,
) => {
	for (const handler of (extension.handlers as Handlers).get(name) ?? []) await handler(event, ctx);
};
const tool = (extension: Awaited<ReturnType<typeof load>>): ToolDefinition => {
	const definition = extension.tools.get("session_notes")?.definition;
	expect(definition).toBeDefined();
	return definition!;
};
const assistant = (text: string) => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }] },
});
const record = (): WorkspaceStateRecord => {
	const last = appended.at(-1);
	expect(last?.customType).toBe(WORKSPACE_STATE_ENTRY);
	return last?.data as WorkspaceStateRecord;
};
const llmAnswer = (end_state: string, question: string | null = null) => {
	sideQuestion = vi.fn(async () => ({ answer: JSON.stringify({ end_state, question }), usage: undefined }));
};

beforeEach(() => {
	appended.length = 0;
	entries.length = 0;
	notify.mockClear();
	settings = { classifier: "llm", model: "gateway/example-medium" };
	sideQuestion = undefined;
	workspaceStateStore.clear();
	vi.stubEnv("PI_SUBAGENT_ID", undefined);
	vi.spyOn(SettingsManager, "create").mockImplementation(() => ({ getSessionStateSettings: () => settings }) as never);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	workspaceStateStore.clear();
});

describe("workspace-state classification", () => {
	it("uses the final ask for the heuristic fallback", () => {
		expect(classifyHeuristic("Done. Should I ship it?")).toEqual({
			end_state: "awaiting-human",
			question: "Should I ship it?",
		});
		expect(classifyHeuristic("Done.")).toEqual({ end_state: "complete" });
	});
	it("parses JSON and rejects invalid answers", () => {
		expect(parseClassifierAnswer('Answer: {"end_state":"mid-work","question":null}')).toEqual({
			end_state: "mid-work",
		});
		expect(parseClassifierAnswer('{"end_state":"unknown"}')).toHaveProperty("error");
	});
	it("defaults to offline heuristic classification", () => {
		vi.restoreAllMocks();
		expect(SettingsManager.inMemory().getSessionStateSettings()).toEqual({
			classifier: "heuristic",
			model: "",
		});
		expect(
			SettingsManager.inMemory({ sessionState: { classifier: "heuristic" } }).getSessionStateSettings().classifier,
		).toBe("heuristic");
	});
	it("builds classifier-only records with bounded notes", () => {
		const built = buildWorkspaceStateRecord({
			sessionId: "s",
			sessionFile: undefined,
			cwd: "/tmp",
			host: "h",
			ts: 1,
			classification: { end_state: "complete", question: "ignored" },
			notes: { feads_epic: " epic-1 ", open_items: [" next "] },
		});
		expect(built).toMatchObject({
			source: "classifier",
			end_state: "complete",
			feads: { epic: "epic-1" },
			open_items: ["next"],
		});
		expect(built.question).toBeUndefined();
	});
});

describe("workspace-state extension", () => {
	it("registers sticky session_notes with no end state or terminate hint", async () => {
		const extension = await load();
		const definition = tool(extension);
		expect(extension.tools.has("session_state")).toBe(false);
		const schema = definition.parameters as { properties: Record<string, unknown>; required?: string[] };
		expect(Object.keys(schema.properties)).toEqual(["feads_epic", "open_items"]);
		expect(schema.required).toBeUndefined();
		expect(definition.description).toContain("at any point in the turn");
		expect(definition.description).toContain("never call anything to end a turn");
		const result = await definition.execute(
			"id",
			{ feads_epic: "board-epic", open_items: ["docs"] },
			undefined,
			undefined,
			context,
		);
		expect(result).not.toHaveProperty("terminate");
		expect(appended.at(-1)).toEqual({
			customType: WORKSPACE_STATE_NOTES_ENTRY,
			data: { feads_epic: "board-epic", open_items: ["docs"] },
		});
	});
	it("always calls Luna at settle even when notes were set, with prior records and bounded recent context", async () => {
		const extension = await load();
		let input = "";
		sideQuestion = async (req) => {
			expect(req.model).toBe("gateway/example-medium");
			input = req.messages[0].content;
			return { answer: '{"end_state":"mid-work","question":null}', usage: undefined };
		};
		await invoke(extension, "session_start");
		await tool(extension).execute(
			"id",
			{ feads_epic: "board-epic", open_items: ["write docs"] },
			undefined,
			undefined,
			context,
		);
		entries.push({
			type: "custom",
			customType: WORKSPACE_STATE_ENTRY,
			data: { end_state: "awaiting-human", question: "old?" },
		});
		entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "Investigate" }] } });
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "SECRET" },
					{ type: "text", text: "Launching watcher" },
				],
			},
		});
		entries.push({
			type: "message",
			message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "Z".repeat(1000) }] },
		});
		await invoke(extension, "message_end", assistant("Watcher is still running."));
		await invoke(extension, "agent_settled");
		expect(record()).toMatchObject({
			source: "classifier",
			end_state: "mid-work",
			feads: { epic: "board-epic" },
			open_items: ["write docs"],
		});
		expect(input).toContain("Investigate");
		expect(input).toContain("old?");
		expect(input).toContain("write docs");
		expect(input).toContain("Watcher is still running.");
		expect(input).not.toContain("SECRET");
		expect(input).not.toContain("Z".repeat(601));
		expect(input.length).toBeLessThanOrEqual(__testing.MAX_CONTEXT_CHARS + 4100);
	});
	it("limits evidence to eight messages and three prior records", async () => {
		const extension = await load();
		let input = "";
		sideQuestion = async (req) => {
			input = req.messages[0].content;
			return { answer: '{"end_state":"complete","question":null}', usage: undefined };
		};
		for (let i = 0; i < 12; i++) {
			// Persisted user prompts are usually plain strings; alternate so both shapes are read.
			entries.push({
				type: "message",
				message:
					i % 2 === 0
						? { role: "user", content: `message-${i}` }
						: { role: "user", content: [{ type: "text", text: `message-${i}` }] },
			});
		}
		for (let i = 0; i < 5; i++) {
			entries.push({ type: "custom", customType: WORKSPACE_STATE_ENTRY, data: { question: `prior-${i}` } });
		}
		await invoke(extension, "agent_settled");
		expect(input).toContain("message-4");
		expect(input).not.toContain("message-3");
		expect(input).toContain("prior-2");
		expect(input).not.toContain("prior-1");
		expect(input.length).toBeLessThanOrEqual(__testing.MAX_CONTEXT_CHARS);
	});
	it("persists partial updates across turns and rehydrates on session restart", async () => {
		const extension = await load();
		llmAnswer("complete");
		await invoke(extension, "session_start");
		await tool(extension).execute("id", { feads_epic: "board-epic" }, undefined, undefined, context);
		await invoke(extension, "agent_start");
		await tool(extension).execute("id", { open_items: ["follow-up"] }, undefined, undefined, context);
		const snapshot = appended.at(-1)?.data;
		entries.push({ type: "custom", customType: WORKSPACE_STATE_NOTES_ENTRY, data: snapshot });
		const resumed = await load();
		await invoke(resumed, "session_start");
		await invoke(resumed, "message_end", assistant("Done."));
		await invoke(resumed, "agent_settled");
		expect(record()).toMatchObject({ feads: { epic: "board-epic" }, open_items: ["follow-up"] });
		await tool(resumed).execute("id", { open_items: [], feads_epic: "" }, undefined, undefined, context);
		await invoke(resumed, "agent_settled");
		expect(record()).not.toHaveProperty("feads");
		expect(record()).not.toHaveProperty("open_items");
	});
	it("auto-captures an epic only on a successful Feads epic create when unset", async () => {
		const extension = await load();
		llmAnswer("complete");
		await invoke(extension, "session_start");
		const result = (issue_type: string, isError = false) => ({
			type: "tool_result",
			toolName: "mcp_feads_create",
			input: { issue_type },
			isError,
			content: [{ type: "text", text: '{"id":"board-first"}' }],
		});
		await invoke(extension, "tool_result", result("task"));
		await invoke(extension, "tool_result", result("epic", true));
		await invoke(extension, "tool_result", result("epic"));
		await invoke(extension, "tool_result", {
			...result("epic"),
			content: [{ type: "text", text: '{"id":"board-second"}' }],
		});
		await invoke(extension, "agent_settled");
		expect(record().feads).toEqual({ epic: "board-first" });
		expect(appended.filter((item) => item.customType === WORKSPACE_STATE_NOTES_ENTRY)).toHaveLength(1);
	});
	it("falls back on malformed answers and on the 15s timeout", async () => {
		const extension = await load();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await invoke(extension, "message_end", assistant("Should I ship?"));
		sideQuestion = async () => ({ answer: "invalid", usage: undefined });
		await invoke(extension, "agent_settled");
		expect(record()).toMatchObject({ end_state: "awaiting-human", question: "Should I ship?" });
		vi.useFakeTimers();
		sideQuestion = ({ signal }) =>
			new Promise((_resolve, reject) =>
				signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true }),
			);
		const settling = invoke(extension, "agent_settled");
		await vi.advanceTimersByTimeAsync(__testing.CLASSIFIER_TIMEOUT_MS);
		await settling;
		expect(record().end_state).toBe("awaiting-human");
		// The warning goes to stderr, which would scribble over the TUI; it is logged only in other modes.
		expect(warn).not.toHaveBeenCalled();
		vi.useRealTimers();
		sideQuestion = async () => {
			throw new Error("gateway down");
		};
		await invoke(extension, "agent_settled", { type: "agent_settled" }, { ...(context as object), mode: "rpc" });
		expect(warn).toHaveBeenCalledTimes(1);
	});
	it("drops a classification that returns after the next turn has started", async () => {
		const extension = await load();
		await invoke(extension, "message_end", assistant("Should I ship?"));
		let answer: ((value: { answer: string; usage: undefined }) => void) | undefined;
		sideQuestion = () =>
			new Promise((resolve) => {
				answer = resolve;
			});
		const settling = invoke(extension, "agent_settled");
		await Promise.resolve();
		await invoke(extension, "agent_start");
		answer?.({ answer: '{"end_state":"awaiting-human","question":"Should I ship?"}', usage: undefined });
		await settling;
		expect(appended.filter((item) => item.customType === WORKSPACE_STATE_ENTRY)).toHaveLength(0);
		expect(workspaceStateStore.current).toBeUndefined();
	});
	it("uses heuristic on explicit opt-out or unavailable side channel", async () => {
		settings = { classifier: "heuristic" };
		llmAnswer("blocked-approval");
		const extension = await load();
		await invoke(extension, "message_end", assistant("Done."));
		await invoke(extension, "agent_settled");
		expect(record().end_state).toBe("complete");
		expect(sideQuestion).not.toHaveBeenCalled();
		settings = { classifier: "llm" };
		sideQuestion = undefined;
		await invoke(extension, "message_end", assistant("Should I ship?"));
		await invoke(extension, "agent_settled");
		expect(record()).toMatchObject({ end_state: "awaiting-human", question: "Should I ship?" });
	});
	it("supersedes the previous record on a new turn but keeps sticky notes", async () => {
		const extension = await load();
		llmAnswer("awaiting-human", "Ship?");
		await tool(extension).execute("id", { feads_epic: "board-epic" }, undefined, undefined, context);
		await invoke(extension, "message_end", assistant("Ship?"));
		await invoke(extension, "agent_settled");
		expect(workspaceStateStore.current?.question).toBe("Ship?");
		await invoke(extension, "agent_start");
		expect(workspaceStateStore.current).toBeUndefined();
		llmAnswer("complete");
		await invoke(extension, "message_end", assistant("Shipped."));
		await invoke(extension, "agent_settled");
		expect(record()).toMatchObject({ end_state: "complete", feads: { epic: "board-epic" } });
	});
	it("is inert under a subagent", async () => {
		vi.stubEnv("PI_SUBAGENT_ID", "child");
		const extension = await load();
		expect(extension.handlers.size).toBe(0);
		expect(extension.tools.size).toBe(0);
	});
});
