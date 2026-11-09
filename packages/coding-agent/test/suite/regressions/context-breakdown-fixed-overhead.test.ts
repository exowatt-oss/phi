import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateSystemPromptTokens, estimateToolDefinitionTokens } from "../../../src/core/compaction/index.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

// Measured on a real anthropic/claude-sonnet-5-5 request with an empty conversation: a 46,097-char
// system prompt plus 63 tool definitions totalling 64,895 chars of JSON billed 40,845 input tokens.
// The previous chars/4 breakdown reported 22,933.
const MEASURED_PROMPT_CHARS = 46_097;
const MEASURED_TOOL_JSON_CHARS = 64_895;
const MEASURED_INPUT_TOKENS = 40_845;

function expectWithin(actual: number, expected: number, tolerance: number): void {
	expect(actual).toBeGreaterThanOrEqual(expected * (1 - tolerance));
	expect(actual).toBeLessThanOrEqual(expected * (1 + tolerance));
}

function proseOfLength(chars: number): string {
	return "Use the read tool before editing files. ".repeat(Math.ceil(chars / 40)).slice(0, chars);
}

function toolOfJsonLength(chars: number) {
	const tool = { name: "big_tool", description: "", parameters: { type: "object", properties: {} } };
	tool.description = "d".repeat(chars - JSON.stringify(tool).length);
	expect(JSON.stringify(tool).length).toBe(chars);
	return tool;
}

describe("context breakdown fixed overhead", () => {
	it("estimates tool JSON and prompt prose near the measured provider token counts", () => {
		const promptTokens = estimateSystemPromptTokens(proseOfLength(MEASURED_PROMPT_CHARS));
		const toolTokens = estimateToolDefinitionTokens([toolOfJsonLength(MEASURED_TOOL_JSON_CHARS)]);

		expectWithin(toolTokens, 32_600, 0.2);
		expectWithin(promptTokens, 13_000, 0.2);
		expectWithin(promptTokens + toolTokens, MEASURED_INPUT_TOKENS, 0.1);
	});

	it("measures the system prompt as last sent, not the base prompt left in state after a tool refresh", async () => {
		const appended = proseOfLength(14_263);
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${appended}` }));
			},
		];
		const harness = await createHarness({ extensionFactories });
		try {
			let sentPrompt = "";
			let sentTools: Parameters<typeof estimateToolDefinitionTokens>[0] = [];
			harness.setResponses([
				(context) => {
					// The prompt and tool declarations travel in the transcript's system messages.
					sentPrompt = getCurrentSystemPrompt(context.messages);
					sentTools = getCurrentTools(context.messages);
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");
			expect(sentPrompt.endsWith(appended)).toBe(true);

			// Refreshing tools (e.g. an MCP server connecting) rebuilds the base prompt into agent state.
			harness.session.setActiveToolsByName(harness.session.getActiveToolNames());
			expect(harness.session.systemPrompt.length).toBeLessThan(sentPrompt.length);

			const breakdown = harness.session.getContextBreakdown();
			expect(breakdown?.systemPrompt.tokens).toBe(estimateSystemPromptTokens(sentPrompt));
			expect(breakdown?.tools.tokens).toBe(estimateToolDefinitionTokens(sentTools));
		} finally {
			harness.cleanup();
		}
	});
});
