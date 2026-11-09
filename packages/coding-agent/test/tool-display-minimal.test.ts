import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

const PAYLOAD_LINES = 63;
const payload = Array.from({ length: PAYLOAD_LINES }, (_, i) => `payload-${String(i + 1).padStart(4, "0")}`).join("\n");

function renderRows(component: ToolExecutionComponent, width = 120): string[] {
	return component.render(width).map(stripAnsi);
}

function nonBlankRows(component: ToolExecutionComponent, width = 120): string[] {
	return renderRows(component, width).filter((row) => row.trim() !== "");
}

describe("minimal tool display", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("collapses a successful bash call to intent plus a one-line summary", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-minimal",
			{ command: "python3 - <<'PY'\nprint(1)\nPY" },
			{ display: "minimal" },
			createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: payload }], details: undefined, isError: false }, false);

		const rows = nonBlankRows(component);
		expect(rows.length).toBeLessThanOrEqual(3);
		const rendered = rows.join("\n");
		expect(rendered).toContain("$ python3 - <<'PY'");
		expect(rendered).toContain("(+2 lines)");
		expect(rendered).toContain("63 lines");
		expect(rendered).not.toContain("payload-");
		expect(rendered).not.toContain("print(1)");
	});

	test("keeps the output tail for a failed bash call in minimal display", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-minimal-error",
			{ command: "false" },
			{ display: "minimal" },
			createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: `${payload}\n\nCommand exited with code 1` }],
				details: undefined,
				isError: true,
			},
			false,
		);

		const rendered = renderRows(component).join("\n");
		expect(rendered).toContain("Command exited with code 1");
		expect(rendered).toContain(`payload-${String(PAYLOAD_LINES).padStart(4, "0")}`);
	});

	test("expanding a minimal bash call restores the full command and output", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-minimal-expanded",
			{ command: "python3 - <<'PY'\nprint(1)\nPY" },
			{ display: "minimal" },
			createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: payload }], details: undefined, isError: false }, false);
		component.setExpanded(true);

		const rendered = renderRows(component).join("\n");
		expect(rendered).toContain("print(1)");
		expect(rendered).toContain("payload-0001");
		expect(rendered).toContain(`payload-${String(PAYLOAD_LINES).padStart(4, "0")}`);
	});

	test("compact display keeps the upstream bash rendering", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-compact",
			{ command: "python3 - <<'PY'\nprint(1)\nPY" },
			{ display: "compact" },
			createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: payload }], details: undefined, isError: false }, false);

		const rendered = renderRows(component).join("\n");
		// Whole command, budgeted output tail, and the "earlier lines" hint: today's look.
		expect(rendered).toContain("print(1)");
		expect(rendered).toContain(`payload-${String(PAYLOAD_LINES).padStart(4, "0")}`);
		expect(rendered).toContain("earlier lines");
		expect(rendered).not.toContain("63 lines");
	});

	test("collapses a write call to one line with the line count and no content", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-write-minimal",
			{ path: "notes.txt", content: payload },
			{ display: "minimal" },
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		const rows = nonBlankRows(component);
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain("notes.txt");
		expect(rows[0]).toContain(`(${PAYLOAD_LINES} lines)`);
		expect(rows[0]).not.toContain("payload-");
	});

	test("pluralizes the write line count", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-write-minimal-single",
			{ path: "notes.txt", content: "only-one-line" },
			{ display: "minimal" },
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		const rows = nonBlankRows(component);
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain("(1 line)");
		expect(rows[0]).not.toContain("only-one-line");
	});

	test("collapses a renderer-less tool result to the fallback header alone", () => {
		const toolDefinition: ToolDefinition = {
			name: "mcp_thing_query",
			label: "mcp_thing_query",
			description: "no renderers",
			parameters: Type.Any(),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};

		const component = new ToolExecutionComponent(
			"mcp_thing_query",
			"tool-fallback-minimal",
			{ query: "everything" },
			{ display: "minimal" },
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: payload }], details: {}, isError: false }, false);

		const rows = nonBlankRows(component);
		// Tool name header plus the single summary line.
		expect(rows.length).toBe(2);
		expect(rows[0]).toContain("mcp_thing_query");
		expect(rows[1]).toContain(`${PAYLOAD_LINES} lines`);
		expect(rows.join("\n")).not.toContain("payload-");

		component.setExpanded(true);
		expect(renderRows(component).join("\n")).toContain("payload-0001");
	});

	test("collapses grep results to a match count", () => {
		const matches = Array.from({ length: 8 }, (_, i) => `src/file-${i}.ts:${i + 1}: match ${i}`).join("\n");
		const component = new ToolExecutionComponent(
			"grep",
			"tool-grep-minimal",
			{ pattern: "match" },
			{ display: "minimal" },
			createGrepToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: matches }], details: {}, isError: false }, false);

		const rows = nonBlankRows(component);
		expect(rows.length).toBe(2);
		expect(rows[1]).toContain("8 matches");
		expect(rows.join("\n")).not.toContain("src/file-0.ts");
	});

	test("collapses find results to a file count", () => {
		const files = Array.from({ length: 4 }, (_, i) => `src/file-${i}.ts`).join("\n");
		const component = new ToolExecutionComponent(
			"find",
			"tool-find-minimal",
			{ pattern: "*.ts" },
			{ display: "minimal" },
			createFindToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: files }], details: {}, isError: false }, false);

		const rows = nonBlankRows(component);
		expect(rows.length).toBe(2);
		expect(rows[1]).toContain("4 files");
		expect(rows.join("\n")).not.toContain("src/file-0.ts");
	});

	test("collapses ls results to an entry count", () => {
		const entries = Array.from({ length: 3 }, (_, i) => `entry-${i}`).join("\n");
		const component = new ToolExecutionComponent(
			"ls",
			"tool-ls-minimal",
			{ path: "." },
			{ display: "minimal" },
			createLsToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: entries }], details: {}, isError: false }, false);

		const rows = nonBlankRows(component);
		expect(rows.length).toBe(2);
		expect(rows[1]).toContain("3 entries");
		expect(rows.join("\n")).not.toContain("entry-0");
	});
});

describe("toolDisplay setting", () => {
	const testDir = join(process.cwd(), "test-tool-display-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	test("defaults to minimal", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getToolDisplay()).toBe("minimal");
	});

	test("round-trips compact and full", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);

		manager.setToolDisplay("compact");
		expect(manager.getToolDisplay()).toBe("compact");

		manager.setToolDisplay("full");
		expect(manager.getToolDisplay()).toBe("full");
		await manager.flush();

		expect(SettingsManager.create(projectDir, agentDir).getToolDisplay()).toBe("full");

		manager.setToolDisplay("minimal");
		expect(manager.getToolDisplay()).toBe("minimal");
	});
});
