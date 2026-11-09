import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { isTuiMode, TUI_MODE_ENV } from "../src/core/tui-mode.ts";
import { loopControlDescription } from "../src/extensions/loop/control-tool.ts";
import workspaceStateExtension from "../src/extensions/workspace-state/index.ts";
import { SESSION_NOTES_DESCRIPTION } from "../src/extensions/workspace-state/session-notes-tool.ts";

const LEGACY_LOOP_CONTROL_DESCRIPTION =
	"Record the bounded loop decision for this iteration. It cannot change loop limits or configuration. " +
	"Call it as your last tool call, immediately before you write the iteration's final message — never after " +
	"it or between its paragraphs; chat UIs fold away any text written before your final tool call.";

const load = async () => {
	const runtime = createExtensionRuntime();
	runtime.appendEntry = () => {};
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
	ctx: unknown,
	name: string,
	event: unknown = { type: name },
) => {
	for (const handler of extension.handlers.get(name) ?? []) await handler(event as never, ctx as never);
};
const context = (notify: ReturnType<typeof vi.fn>, mode: string = "tui") => ({
	cwd: "/tmp/project",
	mode,
	ui: { notify },
	sideQuestion: async () => ({ answer: '{"end_state":"awaiting-human","question":"Approve DNS?"}', usage: undefined }),
	sessionManager: {
		getSessionId: () => "s",
		getSessionFile: () => undefined,
		getEntries: () => [],
		getBranch: () => [],
	},
});

beforeEach(() => {
	vi.stubEnv("PI_SUBAGENT_ID", undefined);
	vi.stubEnv(TUI_MODE_ENV, undefined);
	vi.spyOn(SettingsManager, "create").mockImplementation(
		() => ({ getSessionStateSettings: () => ({ classifier: "llm" }) }) as never,
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("PI_TUI_MODE", () => {
	it("parses truthy values and keeps the old loop_control description by default", () => {
		expect(isTuiMode({})).toBe(false);
		expect(isTuiMode({ [TUI_MODE_ENV]: "false" })).toBe(false);
		for (const value of ["1", "true", "on", " yes "]) expect(isTuiMode({ [TUI_MODE_ENV]: value })).toBe(true);
		expect(loopControlDescription(false)).toBe(LEGACY_LOOP_CONTROL_DESCRIPTION);
		expect(loopControlDescription(true)).toContain("reads your final text in the terminal");
	});
	it("registers session_notes with no terminal-specific renderer or end-of-turn text", async () => {
		for (const enabled of [false, true]) {
			vi.stubEnv(TUI_MODE_ENV, enabled ? "1" : undefined);
			const extension = await load();
			const tool = extension.tools.get("session_notes")?.definition as ToolDefinition;
			expect(tool.description).toBe(SESSION_NOTES_DESCRIPTION);
			expect(tool.renderResult).toBeUndefined();
			expect(extension.tools.has("session_state")).toBe(false);
		}
	});
	it("prints awaiting-human from the settled record only in terminal mode", async () => {
		const notify = vi.fn();
		const ctx = context(notify);
		const extension = await load();
		await invoke(extension, ctx, "agent_settled");
		expect(notify).not.toHaveBeenCalled();
		vi.stubEnv(TUI_MODE_ENV, "1");
		await invoke(extension, ctx, "agent_settled");
		expect(notify).toHaveBeenCalledWith("Waiting on you: Approve DNS?", "warning");
		notify.mockClear();
		await invoke(extension, context(notify, "rpc"), "agent_settled");
		expect(notify).not.toHaveBeenCalled();
	});
	it("keeps other states quiet in the TUI", async () => {
		vi.stubEnv(TUI_MODE_ENV, "1");
		const notify = vi.fn();
		const ctx = {
			...context(notify),
			sideQuestion: async () => ({ answer: '{"end_state":"complete","question":null}', usage: undefined }),
		};
		await invoke(await load(), ctx, "agent_settled");
		expect(notify).not.toHaveBeenCalled();
	});
});
