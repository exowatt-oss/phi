import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession system prompt runtime context", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("sends date/time, model, thinking level and speed, stable within a run and current on the next", async () => {
		const noop: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Does nothing",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const harness = await createHarness({
			tools: [noop],
			models: [{ id: "faux-reasoner", reasoning: true }],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\nEXTENSION TEXT` }));
				},
			],
		});
		harnesses.push(harness);
		const sent: string[] = [];
		// The prompt the provider sees is replayed from the transcript's system messages (pi ≥ 0.86);
		// phi's runtime line is a `runtime` section patched in place when it changes.
		const record = (text: string) => (context: TranscriptContext) => {
			sent.push(getCurrentSystemPrompt(context.messages));
			return text === "tool"
				? fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })
				: fauxAssistantMessage(text);
		};

		harness.session.setThinkingLevel("low");
		harness.setResponses([record("tool"), record("done")]);
		await harness.session.prompt("first");

		const model = harness.getModel();
		expect(sent).toHaveLength(2);
		expect(sent[0]).toMatch(/\nCurrent date and time: \w+day, \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2}/);
		expect(sent[0]).toContain(`\nCurrent model: ${model.provider}/${model.id} (thinking: low, speed: standard)`);
		expect(sent[0]).toMatch(/\n\nEXTENSION TEXT$/);
		expect(sent[1]).toBe(sent[0]);

		harness.session.setThinkingLevel("high");
		harness.session.setFastMode(true);
		harness.setResponses([record("again")]);
		await harness.session.prompt("second");

		// Fast mode does not apply to the faux API, so the request still runs standard.
		expect(sent[2]).toContain("(thinking: high, speed: standard)");
		expect(sent[2]).toMatch(/\n\nEXTENSION TEXT$/);
	});
});
