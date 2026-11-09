import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { estimateTokens } from "../src/core/compaction/compaction.ts";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager, sessionEntryToContextMessages } from "../src/core/session-manager.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomMessageComponent", () => {
	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});
});

describe("ephemeral custom messages", () => {
	test("round-trips ephemeral state from a session entry", () => {
		const manager = SessionManager.inMemory();
		const id = manager.appendCustomMessageEntry("test", "reminder", false, undefined, true);
		const entry = manager.getEntry(id);

		expect(entry).toMatchObject({ type: "custom_message", ephemeral: true });
		if (!entry || entry.type !== "custom_message") throw new Error("custom message entry was not appended");
		expect(sessionEntryToContextMessages(entry)[0]).toMatchObject({ role: "custom", ephemeral: true });
	});

	test("does not count ephemeral custom messages for compaction", () => {
		expect(
			estimateTokens({
				role: "custom",
				customType: "test",
				content: "reminder",
				display: false,
				ephemeral: true,
				timestamp: Date.now(),
			}),
		).toBe(0);
	});

	test("converts an ephemeral custom message only before an assistant message", () => {
		const ephemeral = {
			role: "custom" as const,
			customType: "test",
			content: "reminder",
			display: false,
			ephemeral: true,
			timestamp: Date.now(),
		};
		const assistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "done" }],
			timestamp: Date.now(),
		} as AgentMessage;

		expect(convertToLlm([ephemeral])).toHaveLength(1);
		expect(convertToLlm([ephemeral, assistant])).toEqual([assistant]);
	});
});
