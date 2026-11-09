import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { formatRoutingTrailer } from "../src/core/routing.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAssistantMessage(
	provider: string,
	model: string,
	routing?: AssistantMessage["routing"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "openai-completions",
		provider,
		model,
		usage,
		stopReason,
		routing,
		timestamp: Date.now(),
	};
}

function createFooterData(providerCount = 1): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: () => () => {},
	};
}

function createFooterSession(modelId: string, provider: string, entries: unknown[]): AgentSession {
	return {
		state: {
			model: {
				id: modelId,
				provider,
				contextWindow: 200_000,
				reasoning: false,
			},
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: { isUsingSubscription: () => false },
		serviceTier: "default",
		fastTierKind: undefined,
		lastResponseSpeed: undefined,
	} as unknown as AgentSession;
}

const routed = {
	requestedModel: "auto",
	servedModel: "example-medium",
	tier: "mid",
	intent: "code_edit",
	confidence: 0.91,
	costUsd: 0.00002,
	costSource: "estimate" as const,
};

describe("routing UI", () => {
	test("renders a routed assistant trailer with the shared formatter text", () => {
		initTheme("dark");
		const message = createAssistantMessage("gateway", "auto", routed);
		const rendered = stripAnsi(new AssistantMessageComponent(message).render(80).join("\n"));

		expect(rendered).toContain(`⇢ ${formatRoutingTrailer(routed)}`);
		expect(rendered).toContain("auto routed to example-medium");
		expect(rendered).toContain("(mid · code_edit · 0.91)");
	});

	test("does not render trailers for non-auto, missing-routing, or failed messages", () => {
		initTheme("dark");
		const messages = [
			createAssistantMessage("gateway", "example-medium", routed),
			createAssistantMessage("gateway", "auto"),
			createAssistantMessage("gateway", "auto", routed, "error"),
		];

		for (const message of messages) {
			const rendered = stripAnsi(new AssistantMessageComponent(message).render(80).join("\n"));
			expect(rendered).not.toContain("auto routed to");
			expect(rendered).not.toContain("⇢");
		}
	});

	test("shows the last served model or a placeholder in the auto footer", () => {
		initTheme("dark");
		const routedEntry = { type: "message", message: createAssistantMessage("gateway", "auto", routed) };
		const withRouting = new FooterComponent(
			createFooterSession("auto", "gateway", [routedEntry]),
			createFooterData(),
		);
		const noRouting = new FooterComponent(createFooterSession("auto", "gateway", []), createFooterData());

		expect(stripAnsi(withRouting.render(120)[1])).toContain("auto → example-medium");
		expect(stripAnsi(noRouting.render(120)[1])).toContain("auto → ?");
	});

	test("keeps the regular footer model rendering unchanged", () => {
		initTheme("dark");
		const routedEntry = { type: "message", message: createAssistantMessage("gateway", "auto", routed) };
		const footer = new FooterComponent(
			createFooterSession("example-medium", "gateway", [routedEntry]),
			createFooterData(),
		);
		const line = stripAnsi(footer.render(120)[1]);

		expect(line.endsWith("example-medium • default")).toBe(true);
		expect(line).not.toContain("→");
	});

	test("lists the routing slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "routing")).toBe(true);
	});
});
