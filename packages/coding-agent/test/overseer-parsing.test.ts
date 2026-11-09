import { describe, expect, it } from "vitest";
import {
	formatAge,
	formatEvents,
	formatTranscript,
	shortIds,
	table,
	toolActivityText,
} from "../src/extensions/overseer/format.ts";
import {
	frameSend,
	normalizeSubagentModels,
	resolveCwd,
	threadEnv,
	validateThreadName,
} from "../src/extensions/overseer/manager.ts";
import {
	nearModelMatches,
	parseModelRef,
	resolveModelRef,
	validateThinking,
} from "../src/extensions/overseer/model.ts";
import { resolveTarget, ThreadRegistry } from "../src/extensions/overseer/registry.ts";
import { DEFAULT_WATCH, type ThreadRecord } from "../src/extensions/overseer/types.ts";
import { fakeModels } from "./overseer-helpers.ts";

const models = fakeModels([
	"gateway/example-medium",
	"gateway/example-large",
	"anthropic/claude-opus-5-5",
	"anthropic/claude-sonnet-5",
	"openrouter/anthropic/claude-opus-5-5",
	"ollama/llama3:8b",
	"bedrock/shared-id",
	"vertex/shared-id",
]);

describe("overseer model references", () => {
	it("parses provider/id with and without a thinking suffix", () => {
		expect(parseModelRef("gateway/example-medium")).toMatchObject({ provider: "gateway", modelId: "example-medium" });
		expect(parseModelRef("gateway/example-medium:max")).toMatchObject({
			provider: "gateway",
			modelId: "example-medium",
			thinking: "max",
		});
		expect(parseModelRef(" anthropic/claude-opus-5-5:xhigh ")).toMatchObject({
			provider: "anthropic",
			modelId: "claude-opus-5-5",
			thinking: "xhigh",
		});
		// An unknown suffix is part of the id.
		expect(parseModelRef("ollama/llama3:8b")).toMatchObject({ provider: "ollama", modelId: "llama3:8b" });
		expect(parseModelRef("example-medium:high")).toMatchObject({ modelId: "example-medium", thinking: "high" });
		expect(() => parseModelRef("")).toThrow(/Empty model/);
		expect(() => parseModelRef("/example-medium")).toThrow(/provider\/id/);
		expect(() => parseModelRef("gateway/")).toThrow(/provider\/id/);
		expect(() => parseModelRef("gateway/example-medium max")).toThrow(/no spaces/);
	});

	it("resolves against the registry, with the thinking argument overriding the suffix", () => {
		expect(resolveModelRef("gateway/example-medium:max", models)).toEqual({
			provider: "gateway",
			modelId: "example-medium",
			thinking: "max",
			label: "gateway/example-medium",
		});
		expect(resolveModelRef("gateway/example-medium:max", models, "low").thinking).toBe("low");
		expect(resolveModelRef("gateway/example-medium", models).thinking).toBeUndefined();
		expect(resolveModelRef("openrouter/anthropic/claude-opus-5-5:high", models)).toMatchObject({
			provider: "openrouter",
			modelId: "anthropic/claude-opus-5-5",
			thinking: "high",
		});
		expect(resolveModelRef("ollama/llama3:8b", models).modelId).toBe("llama3:8b");
		expect(resolveModelRef("example-large", models).label).toBe("gateway/example-large");
	});

	it("rejects unknown models with near matches and ambiguous bare ids", () => {
		expect(() => resolveModelRef("gateway/example-mediun:max", models)).toThrow(
			/Unknown model "gateway\/example-mediun:max".*gateway\/example-medium/,
		);
		expect(() => resolveModelRef("anthropic/claude-opus-5", models)).toThrow(/claude-opus-5-5/);
		expect(() => resolveModelRef("shared-id", models)).toThrow(/several providers.*bedrock\/shared-id/);
		expect(() => resolveModelRef("gateway/example-medium", models, "ultra")).toThrow(
			/Invalid thinking level "ultra"/,
		);
	});

	it("validates thinking levels and ranks near matches", () => {
		expect(validateThinking("xhigh")).toBe("xhigh");
		expect(() => validateThinking("extreme")).toThrow(/Valid: off, minimal, low, medium, high, xhigh, max/);
		expect(nearModelMatches("gateway/example-medi", models.getAll())[0]).toBe("gateway/example-medium");
	});
});

describe("overseer targets and names", () => {
	const record = (name: string, sessionId: string, state: ThreadRecord["state"] = "running"): ThreadRecord => ({
		name,
		sessionId,
		backend: "headless",
		cwd: "/tmp",
		createdAt: 0,
		watch: { ...DEFAULT_WATCH },
		state,
		registered: true,
	});

	it("resolves by name, full id and unique prefix; ambiguity lists candidates", () => {
		const items = [
			record("api", "0190aaaa-1111-7000-8000-000000000001"),
			record("docs", "0190aaaa-2222-7000-8000-000000000002"),
			record("web", "0191bbbb-3333-7000-8000-000000000003"),
		];
		const keys = {
			name: (r: ThreadRecord) => r.name,
			id: (r: ThreadRecord) => r.sessionId,
			describe: (r: ThreadRecord) => r.name,
		};
		expect(resolveTarget("API", items, keys).name).toBe("api");
		expect(resolveTarget("0190aaaa-2222-7000-8000-000000000002", items, keys).name).toBe("docs");
		expect(resolveTarget("0191", items, keys).name).toBe("web");
		expect(resolveTarget("0190aaaa-1", items, keys).name).toBe("api");
		expect(() => resolveTarget("0190aaaa", items, keys)).toThrow(/Ambiguous thread "0190aaaa": api; docs/);
		expect(() => resolveTarget("nope", items, keys)).toThrow(/No thread "nope". Known: api; docs; web/);
		expect(() => resolveTarget(" ", items, keys)).toThrow(/target is required/);
	});

	it("prefers live threads and reaches closed ones only on request", () => {
		const registry = new ThreadRegistry("/nonexistent", "overseer");
		registry.threads = [
			record("api", "0190aaaa-1111-7000-8000-000000000001", "closed"),
			record("api", "0190aaaa-9999-7000-8000-000000000009"),
			record("old", "0190cccc-1111-7000-8000-000000000001", "closed"),
		];
		expect(registry.resolve("api").sessionId).toBe("0190aaaa-9999-7000-8000-000000000009");
		expect(() => registry.resolve("old")).toThrow(/No thread "old"/);
		expect(registry.resolve("old", { includeClosed: true }).state).toBe("closed");
		expect(() => registry.assertNameFree("API")).toThrow(/already exists/);
		expect(() => registry.assertNameFree("old")).not.toThrow();
		expect(registry.freeName("api")).toBe("api-2");
	});

	it("validates thread names", () => {
		expect(validateThreadName("  api-filters ")).toBe("api-filters");
		expect(() => validateThreadName("")).toThrow(/needs "name"/);
		expect(() => validateThreadName("a\nb")).toThrow(/control characters/);
		expect(() => validateThreadName("-rf")).toThrow(/cannot start with "-"/);
		expect(() => validateThreadName("all")).toThrow(/reserved/);
		expect(() => validateThreadName("x".repeat(65))).toThrow(/longer than 64/);
	});

	it("resolves cwd from ~, relative paths and rejects missing folders", () => {
		expect(resolveCwd(undefined, "/tmp")).toMatch(/tmp$/);
		expect(resolveCwd(".", "/tmp")).toMatch(/tmp$/);
		expect(() => resolveCwd("/definitely/not/here", "/tmp")).toThrow(/cwd does not exist/);
	});
});

describe("overseer framing and env", () => {
	it("frames sends: slash commands raw, everything else headed by the overseer", () => {
		expect(frameSend("/compact keep the plan", "boss", "0190aaaa-0000")).toBe("/compact keep the plan");
		expect(frameSend("  /skill:use-subs go", "boss", "0190aaaa-0000")).toBe("/skill:use-subs go");
		expect(frameSend("Please run the tests\nthen report", "boss\nname", "0190aaaa-0000-7000")).toBe(
			"[overseer boss name (0190aaaa)]\nPlease run the tests\nthen report",
		);
	});

	it("builds the thread env per contract", () => {
		expect(
			threadEnv("sid", "boss", "api", {
				default: "gateway/example-medium:max",
				allow: ["gateway/*", "anthropic/claude-sonnet-5:medium"],
			}),
		).toEqual({
			PHI_OVERSEER_SESSION_ID: "sid",
			PHI_OVERSEER_NAME: "boss",
			PHI_OVERSEER_THREAD: "api",
			PHI_SUBAGENT_MODEL_DEFAULT: "gateway/example-medium:max",
			PHI_SUBAGENT_MODEL_ALLOW: "gateway/*,anthropic/claude-sonnet-5:medium",
		});
		expect(threadEnv("sid", "boss", "api", undefined)).not.toHaveProperty("PHI_SUBAGENT_MODEL_DEFAULT");
	});

	it("normalizes subagent model policy and validates the default", () => {
		expect(
			normalizeSubagentModels({ default: "gateway/example-medium:max", allow: [" gateway/* ", ""] }, models),
		).toEqual({
			default: "gateway/example-medium:max",
			allow: ["gateway/*"],
		});
		expect(normalizeSubagentModels({ allow: [] }, models)).toBeUndefined();
		expect(() => normalizeSubagentModels({ default: "nope/model" }, models)).toThrow(/Unknown model/);
		expect(() => normalizeSubagentModels({ allow: ["a,b"] }, models)).toThrow(/spaces or commas/);
	});
});

describe("overseer text formatting", () => {
	it("names the running tool once, whether or not the session's summary starts with it", () => {
		// What a live session sends: toolSummary() output, which starts with the tool's name.
		expect(toolActivityText({ tool: "bash", summary: "bash  sleep 200 && echo slept" }, 100)).toBe(
			"bash sleep 200 && echo slept",
		);
		expect(toolActivityText({ tool: "bash", summary: "npm test" }, 100)).toBe("bash npm test");
		expect(toolActivityText({ tool: "read" }, 100)).toBe("read");
	});

	it("short ids use one length per board: the shortest (at least 8) that keeps every id unique", () => {
		const ids = shortIds(["0190aaaa-1111", "0190aaaa-2222", "0191ffff-0000"]);
		expect(ids.get("0190aaaa-1111")).toBe("0190aaaa-1");
		expect(ids.get("0190aaaa-2222")).toBe("0190aaaa-2");
		expect(ids.get("0191ffff-0000")).toBe("0191ffff-0");
		// The live e2e board showed 01a1a8ee-c0 / -cd / -d; c0 vs cd needs 11 characters, so all get 11.
		const live = shortIds([
			"01a1a8ee-c0f6-7033-af7a-e18a9c2c6966",
			"01a1a8ee-cdcf-7358-af10-83abb51e0305",
			"01a1a8ee-d587-757c-afb6-b73db427b978",
		]);
		expect([...live.values()]).toEqual(["01a1a8ee-c0", "01a1a8ee-cd", "01a1a8ee-d5"]);
		expect([...shortIds(["0190aaaa-1111", "0191ffff-0000"]).values()]).toEqual(["0190aaaa", "0191ffff"]);
		expect([...shortIds(["abc", "abd"]).values()]).toEqual(["abc", "abd"]);
		expect(shortIds([]).size).toBe(0);
	});

	it("ages, tables and transcripts are compact", () => {
		expect(formatAge(5_000)).toBe("5s");
		expect(formatAge(4 * 60_000)).toBe("4m");
		expect(formatAge(185 * 60_000)).toBe("3h05m");
		expect(formatAge(50 * 3_600_000)).toBe("2d");
		expect(table(["A", "BB"], [["xxx", "y"]])).toEqual(["A    BB", "xxx  y"]);
		const text = formatTranscript(
			"api (id) · idle",
			[
				{ id: "1", ts: Number.NaN, kind: "user", text: "do it" },
				{
					id: "2",
					ts: Number.NaN,
					kind: "tool",
					toolCallId: "t",
					name: "bash",
					summary: "bash  npm test",
					status: "ok",
					output: "12 passed\n",
				},
				{ id: "3", ts: Number.NaN, kind: "assistant", text: "Done." },
			],
			true,
		);
		expect(text).toBe(
			"api (id) · idle\n(older items exist)\nuser: do it\ntool bash npm test → ok · 12 passed\nassistant: Done.",
		);
	});

	it("formats one batched event message with a header, blocks and a reply hint", () => {
		const text = formatEvents([
			{
				kind: "idle",
				thread: "api",
				at: 2,
				summary: "turn finished · gateway/example-medium:max",
				text: "All tests pass.",
			},
			{ kind: "stalled", thread: "docs", at: 1, summary: "working with no activity for 16m (bash  npm test)" },
		]);
		expect(text.split("\n")).toEqual([
			"[overseer] 2 thread updates",
			"── docs · stalled · working with no activity for 16m (bash  npm test)",
			"── api · idle · turn finished · gateway/example-medium:max",
			"All tests pass.",
			'Reply with overseer {action:"send", target:"<thread>", message}; inspect with overseer {action:"read", target:"<thread>"}. These are thread reports, not user messages.',
		]);
		expect(
			formatEvents([
				{ kind: "heartbeat", thread: "", at: 1, summary: "2 threads (1 working)", text: "BOARD" },
			]).split("\n")[0],
		).toBe("[overseer] heartbeat · 2 threads (1 working)");
	});
});
