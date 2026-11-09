import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type { ExtensionAPI, ToolLoadoutChanges } from "../src/core/extensions/types.ts";
import {
	checkModelPolicy,
	describeModelPolicy,
	isModelAllowed,
	matchesModelPattern,
	modelPolicyEnv,
	parseModelPattern,
	resolveSubagentModelPolicy,
} from "../src/extensions/subagents/model-policy.ts";
import type { RunProcessOptions } from "../src/extensions/subagents/runner.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const fake = vi.hoisted(() => ({ calls: [] as RunProcessOptions[] }));

vi.mock("../src/extensions/subagents/runner.ts", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		async executeRun(options: RunProcessOptions) {
			fake.calls.push(options);
			options.run.status = "done";
			options.run.finalText = `ok ${options.run.name}`;
			options.run.startedAt = Date.now();
			options.run.endedAt = Date.now();
			options.onChange();
		},
	};
});

import subagentsExtension from "../src/extensions/subagents/index.ts";

function matches(pattern: string, model: string, level?: string): boolean {
	const parsed = parseModelPattern(pattern);
	if (!parsed) throw new Error(`bad pattern ${pattern}`);
	return matchesModelPattern(parsed, model, level);
}

describe("model pattern grammar", () => {
	it("matches provider/id at any level, including none", () => {
		expect(matches("gateway/example-medium", "gateway/example-medium")).toBe(true);
		expect(matches("gateway/example-medium", "gateway/example-medium", "max")).toBe(true);
		expect(matches("gateway/example-medium", "gateway/example-medium-2", "max")).toBe(false);
		expect(matches("gateway/example-medium", "anthropic/example-medium")).toBe(false);
	});

	it("matches exact levels and level lists", () => {
		expect(matches("gateway/example-medium:max", "gateway/example-medium", "max")).toBe(true);
		expect(matches("gateway/example-medium:max", "gateway/example-medium", "high")).toBe(false);
		expect(matches("gateway/example-medium:max", "gateway/example-medium")).toBe(false);
		expect(matches("anthropic/claude-opus-5-5:high|xhigh", "anthropic/claude-opus-5-5", "xhigh")).toBe(true);
		expect(matches("anthropic/claude-opus-5-5:high|xhigh", "anthropic/claude-opus-5-5", "medium")).toBe(false);
		expect(matches("anthropic/claude-opus-5-5:high|xhigh", "anthropic/claude-opus-5-5")).toBe(false);
	});

	it("supports * globs inside provider and id", () => {
		expect(matches("gateway/*", "gateway/example-medium", "max")).toBe(true);
		expect(matches("gateway/*", "anthropic/claude-sonnet-5")).toBe(false);
		expect(matches("anthropic/claude-opus-*:high|xhigh", "anthropic/claude-opus-5-5", "high")).toBe(true);
		expect(matches("anthropic/claude-opus-*:high|xhigh", "anthropic/claude-sonnet-5", "high")).toBe(false);
		expect(matches("*/example-medium:max", "gateway/example-medium", "max")).toBe(true);
		// Regex metacharacters in the pattern are literal.
		expect(matches("gateway/example-medium.max", "gateway/example-mediumxmax")).toBe(false);
	});

	it("compares provider/id case-insensitively and the level exactly", () => {
		expect(matches("Gateway/EXAMPLE-MEDIUM:max", "gateway/example-medium", "max")).toBe(true);
		expect(matches("gateway/example-medium:MAX", "gateway/example-medium:MAX")).toBe(true); // not a level: part of the id
		expect(matches("gateway/example-medium:MAX", "gateway/example-medium", "max")).toBe(false);
	});

	it("treats a non-level colon suffix as part of the id and a slash-less pattern as any provider", () => {
		expect(matches("amazon-bedrock/anthropic.claude-v2:1", "amazon-bedrock/anthropic.claude-v2:1")).toBe(true);
		expect(matches("example-medium:max", "gateway/example-medium", "max")).toBe(true);
		expect(matches("example-medium", "other/example-medium")).toBe(true);
		expect(parseModelPattern("   ")).toBeUndefined();
	});

	it("empty allowlist allows everything", () => {
		expect(isModelAllowed({ allow: [] }, "anthropic/claude-example-large", "max")).toBe(true);
	});
});

describe("policy resolution", () => {
	const settings = {
		models: { default: "gateway/example-medium:max", allow: ["gateway/*", "anthropic/claude-sonnet-5:medium"] },
	};

	it("reads settings when env is absent", () => {
		expect(resolveSubagentModelPolicy(settings, {})).toEqual({
			default: "gateway/example-medium:max",
			allow: ["gateway/*", "anthropic/claude-sonnet-5:medium"],
		});
		expect(resolveSubagentModelPolicy({}, {})).toEqual({ default: undefined, allow: [] });
		expect(resolveSubagentModelPolicy(undefined, {})).toEqual({ default: undefined, allow: [] });
	});

	it("env wins per key and splits the allow list on commas", () => {
		expect(
			resolveSubagentModelPolicy(settings, {
				PHI_SUBAGENT_MODEL_DEFAULT: "anthropic/claude-sonnet-5:medium",
				PHI_SUBAGENT_MODEL_ALLOW: " anthropic/claude-sonnet-5:medium , ,gateway/example-medium:max",
			}),
		).toEqual({
			default: "anthropic/claude-sonnet-5:medium",
			allow: ["anthropic/claude-sonnet-5:medium", "gateway/example-medium:max"],
		});
		expect(resolveSubagentModelPolicy(settings, { PHI_SUBAGENT_MODEL_ALLOW: "gateway/example-medium:max" })).toEqual({
			default: "gateway/example-medium:max",
			allow: ["gateway/example-medium:max"],
		});
	});

	it("treats an empty env string as unset for that key", () => {
		expect(
			resolveSubagentModelPolicy(settings, { PHI_SUBAGENT_MODEL_DEFAULT: "", PHI_SUBAGENT_MODEL_ALLOW: "  " }),
		).toEqual({ default: "gateway/example-medium:max", allow: ["gateway/*", "anthropic/claude-sonnet-5:medium"] });
		expect(resolveSubagentModelPolicy({}, { PHI_SUBAGENT_MODEL_DEFAULT: "", PHI_SUBAGENT_MODEL_ALLOW: "" })).toEqual({
			default: undefined,
			allow: [],
		});
	});

	it("describes the policy only when one is set and exports it to children", () => {
		expect(describeModelPolicy({ allow: [] })).toBeUndefined();
		expect(
			describeModelPolicy({ default: "gateway/example-medium:max", allow: ["gateway/example-medium:max"] }),
		).toBe(
			"Subagent models are pinned: allowed gateway/example-medium:max; default gateway/example-medium:max. Tasks with any other model are refused.",
		);
		expect(describeModelPolicy({ default: "gateway/example-medium:max", allow: [] })).toBe(
			"Subagent models are pinned: default gateway/example-medium:max.",
		);
		expect(modelPolicyEnv({ allow: [] })).toEqual({});
		expect(modelPolicyEnv({ default: "gateway/example-medium:max", allow: ["a/b", "c/*"] })).toEqual({
			PHI_SUBAGENT_MODEL_DEFAULT: "gateway/example-medium:max",
			PHI_SUBAGENT_MODEL_ALLOW: "a/b,c/*",
		});
	});

	it("refusal names every offending task, the allowed patterns and the default", () => {
		const text = checkModelPolicy({ allow: ["gateway/example-medium:max"] }, [
			{ name: "ok", model: "gateway/example-medium", thinkingLevel: "max", source: "task" },
			{ name: "big", model: "anthropic/claude-example-large", thinkingLevel: "high", source: "inherited" },
		]);
		expect(text).toContain("nothing was launched");
		expect(text).toContain("big → anthropic/claude-example-large:high (inherited from this session)");
		expect(text).not.toContain("ok →");
		expect(text).toContain("Allowed: gateway/example-medium:max. Default: none.");
		expect(text).toContain("configure subagents.models.default / PHI_SUBAGENT_MODEL_DEFAULT");
		expect(checkModelPolicy({ allow: [] }, [{ name: "x", model: "a/b" }])).toBeUndefined();
		expect(checkModelPolicy({ allow: ["a/*"] }, [{ name: "x" }])).toContain("x → (none) (no model resolved)");
	});
});

const MODELS = [
	{ provider: "gateway", id: "example-medium", name: "EXAMPLE-MEDIUM", contextWindow: 400_000, reasoning: true },
	{ provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5", contextWindow: 1_000_000, reasoning: true },
	{ provider: "anthropic", id: "claude-opus-5-5", name: "Opus 5.5", contextWindow: 1_000_000, reasoning: true },
	{
		provider: "anthropic",
		id: "claude-example-large",
		name: "Example Large",
		contextWindow: 1_000_000,
		reasoning: true,
	},
];

const MODELS_PARENT = { provider: "anthropic", id: "claude-example-large", level: "high" };

interface ToolUnderTest {
	description: string;
	prepareLoadout?: (loadout: unknown) => ToolLoadoutChanges | undefined;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<{ content: { text: string }[] }>;
}

describe("subagent tool with a model policy", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-model-policy-"));
		agentDir = path.join(root, "agent");
		cwd = path.join(root, "project");
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.mkdirSync(path.join(cwd, CONFIG_DIR_NAME), { recursive: true });
		vi.stubEnv("PI_SUBAGENT_ID", "");
		vi.stubEnv("PHI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PHI_SUBAGENT_MODEL_DEFAULT", "");
		vi.stubEnv("PHI_SUBAGENT_MODEL_ALLOW", "");
		fake.calls.length = 0;
		initTheme("dark");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	});

	function writeGlobalSettings(settings: unknown): void {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
	}

	function writeProjectSettings(settings: unknown): void {
		fs.writeFileSync(path.join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify(settings));
	}

	function setup(parent: { provider: string; id: string; level?: string } | undefined = MODELS_PARENT) {
		let tool: ToolUnderTest | undefined;
		const listeners = new Map<string, (_event: unknown, ctx?: unknown) => void>();
		const parentModel = parent ? MODELS.find((m) => m.provider === parent.provider && m.id === parent.id) : undefined;
		const ctx = {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: { theme, onTerminalInput: () => () => {}, getEditorText: () => "", setWidget() {}, setStatus() {} },
			model: parentModel,
			thinkingLevel: parent?.level,
			modelRegistry: { getAvailable: () => MODELS },
			sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
		};
		const pi = {
			registerTool: (definition: ToolUnderTest) => {
				tool = definition;
			},
			registerMessageRenderer() {},
			registerEntryRenderer() {},
			registerCommand() {},
			on: (event: string, callback: (_event: unknown, ctx?: unknown) => void) => {
				listeners.set(event, callback);
			},
			emitSubagentSpawn: async () => ({}),
			sendMessage() {},
			appendEntry() {},
		} as unknown as ExtensionAPI;
		subagentsExtension(pi);
		if (!tool) throw new Error("subagent tool did not register");
		const registered = tool;
		return {
			tool: registered,
			execute: (params: Record<string, unknown>) =>
				registered.execute("call-1", { background: false, ...params }, undefined, undefined, ctx),
			shutdown: () => listeners.get("session_shutdown")?.({}),
		};
	}

	it("without a policy, behaviour is unchanged: inherit the parent and no description line", async () => {
		const { tool, execute, shutdown } = setup();
		try {
			expect(tool.prepareLoadout?.({})).toBeUndefined();
			await execute({ task: "t", name: "solo" });
			expect(fake.calls.map((c) => c.modelArg)).toEqual(["anthropic/claude-example-large:high"]);
			expect(fake.calls[0].env?.PHI_SUBAGENT_MODEL_ALLOW).toBeUndefined();
		} finally {
			shutdown();
		}
	});

	it("injects the default into single, parallel and chain tasks that name no model", async () => {
		writeGlobalSettings({
			subagents: { models: { default: "gateway/example-medium:max", allow: ["gateway/example-medium:max"] } },
		});
		const { execute, shutdown } = setup();
		try {
			await execute({ task: "t", name: "single" });
			await execute({
				tasks: [
					{ task: "a", name: "p1" },
					{ task: "b", name: "p2" },
				],
			});
			await execute({
				chain: [
					{ task: "a", name: "c1" },
					{ task: "{previous}", name: "c2" },
				],
			});
			expect(fake.calls.map((c) => [c.run.name, c.modelArg, c.run.model, c.run.thinkingLevel])).toEqual([
				["single", "gateway/example-medium:max", "gateway/example-medium", "max"],
				["p1", "gateway/example-medium:max", "gateway/example-medium", "max"],
				["p2", "gateway/example-medium:max", "gateway/example-medium", "max"],
				["c1", "gateway/example-medium:max", "gateway/example-medium", "max"],
				["c2", "gateway/example-medium:max", "gateway/example-medium", "max"],
			]);
			// Children are bound by the same resolved policy.
			expect(fake.calls[0].env).toMatchObject({
				PHI_SUBAGENT_MODEL_DEFAULT: "gateway/example-medium:max",
				PHI_SUBAGENT_MODEL_ALLOW: "gateway/example-medium:max",
			});
		} finally {
			shutdown();
		}
	});

	it("refuses the whole parallel call when one task is outside the allowlist, launching nothing", async () => {
		vi.stubEnv("PHI_SUBAGENT_MODEL_ALLOW", "gateway/example-medium:max,anthropic/claude-sonnet-5:medium");
		vi.stubEnv("PHI_SUBAGENT_MODEL_DEFAULT", "gateway/example-medium:max");
		const { execute, shutdown } = setup();
		try {
			const call = execute({
				tasks: [
					{ task: "a", name: "fine" },
					{ task: "b", name: "reviewer", model: "anthropic/claude-opus-5-5:high" },
					{ task: "c", name: "sonnet", model: "anthropic/claude-sonnet-5:medium" },
				],
			});
			await expect(call).rejects.toThrow(
				"Subagent call refused by the subagent model policy; nothing was launched. Not allowed: reviewer → anthropic/claude-opus-5-5:high (task model). Allowed: gateway/example-medium:max, anthropic/claude-sonnet-5:medium. Default: gateway/example-medium:max.",
			);
			expect(fake.calls).toHaveLength(0);
		} finally {
			shutdown();
		}
	});

	it("refuses a chain whose later step is disallowed before the first step runs", async () => {
		writeGlobalSettings({ subagents: { models: { allow: ["gateway/*"] } } });
		const { execute, shutdown } = setup();
		try {
			await expect(
				execute({
					chain: [
						{ task: "a", name: "c1", model: "gateway/example-medium:max" },
						{ task: "b", name: "c2", model: "anthropic/claude-sonnet-5:medium" },
					],
				}),
			).rejects.toThrow("c2 → anthropic/claude-sonnet-5:medium (task model)");
			expect(fake.calls).toHaveLength(0);
		} finally {
			shutdown();
		}
	});

	it("refuses an inherited parent model with no default and says how to fix it", async () => {
		writeGlobalSettings({ subagents: { models: { allow: ["gateway/example-medium:max"] } } });
		const { execute, shutdown } = setup();
		try {
			await expect(execute({ task: "t", name: "solo" })).rejects.toThrow(
				/solo → anthropic\/claude-example-large:high \(inherited from this session\).*Default: none\. No default is configured/,
			);
			expect(fake.calls).toHaveLength(0);
		} finally {
			shutdown();
		}
	});

	it("allows an inherited parent model that matches the allowlist", async () => {
		writeGlobalSettings({ subagents: { models: { allow: ["anthropic/claude-example-large"] } } });
		const { execute, shutdown } = setup();
		try {
			await execute({ task: "t", name: "solo" });
			expect(fake.calls.map((c) => c.modelArg)).toEqual(["anthropic/claude-example-large:high"]);
		} finally {
			shutdown();
		}
	});

	it("canonicalizes a bare id through the model registry before matching", async () => {
		writeGlobalSettings({ subagents: { models: { allow: ["gateway/example-medium:max"] } } });
		const { execute, shutdown } = setup();
		try {
			await execute({ task: "t", name: "bare", model: "EXAMPLE-MEDIUM:max" });
			expect(fake.calls.map((c) => c.modelArg)).toEqual(["gateway/example-medium:max"]);
			await expect(execute({ task: "t", name: "bare-high", model: "example-medium:high" })).rejects.toThrow(
				"bare-high → gateway/example-medium:high (task model)",
			);
			expect(fake.calls).toHaveLength(1);
		} finally {
			shutdown();
		}
	});

	it("gives the agent definition's model precedence over the default, and the task model over both", async () => {
		fs.writeFileSync(
			path.join(agentDir, "agents", "sonnet-worker.md"),
			"---\nname: sonnet-worker\ndescription: Sonnet worker\nmodel: anthropic/claude-sonnet-5:medium\n---\nYou work.\n",
		);
		writeGlobalSettings({
			subagents: {
				models: {
					default: "gateway/example-medium:max",
					allow: ["gateway/example-medium:max", "anthropic/claude-sonnet-5"],
				},
			},
		});
		const { execute, shutdown } = setup();
		try {
			await execute({
				tasks: [
					{ task: "a", name: "by-agent", agent: "sonnet-worker" },
					{ task: "b", name: "by-task", agent: "sonnet-worker", model: "gateway/example-medium:max" },
					{ task: "c", name: "by-default" },
				],
			});
			expect(fake.calls.map((c) => [c.run.name, c.modelArg])).toEqual([
				["by-agent", "anthropic/claude-sonnet-5:medium"],
				["by-task", "gateway/example-medium:max"],
				["by-default", "gateway/example-medium:max"],
			]);
		} finally {
			shutdown();
		}
	});

	it("refuses an agent definition's model outside the allowlist", async () => {
		fs.writeFileSync(
			path.join(agentDir, "agents", "opus-worker.md"),
			"---\nname: opus-worker\ndescription: Opus worker\nmodel: anthropic/claude-opus-5-5:xhigh\n---\nYou work.\n",
		);
		writeGlobalSettings({
			subagents: { models: { default: "gateway/example-medium:max", allow: ["gateway/example-medium:max"] } },
		});
		const { execute, shutdown } = setup();
		try {
			await expect(execute({ task: "a", agent: "opus-worker" })).rejects.toThrow(
				"opus-worker → anthropic/claude-opus-5-5:xhigh (agent definition)",
			);
			expect(fake.calls).toHaveLength(0);
		} finally {
			shutdown();
		}
	});

	it("merges project settings over global ones and lets env override both", async () => {
		writeGlobalSettings({ subagents: { models: { default: "anthropic/claude-sonnet-5:medium" } } });
		writeProjectSettings({ subagents: { models: { allow: ["anthropic/claude-sonnet-5:medium"] } } });
		const { execute, shutdown } = setup();
		try {
			await execute({ task: "t", name: "merged" });
			expect(fake.calls.map((c) => c.modelArg)).toEqual(["anthropic/claude-sonnet-5:medium"]);
			vi.stubEnv("PHI_SUBAGENT_MODEL_ALLOW", "gateway/*");
			vi.stubEnv("PHI_SUBAGENT_MODEL_DEFAULT", "gateway/example-medium:max");
			await execute({ task: "t", name: "env" });
			expect(fake.calls.map((c) => c.modelArg)).toEqual([
				"anthropic/claude-sonnet-5:medium",
				"gateway/example-medium:max",
			]);
		} finally {
			shutdown();
		}
	});

	it("reports an unknown pinned default clearly", async () => {
		writeGlobalSettings({ subagents: { models: { default: "nope/missing:max" } } });
		const { execute, shutdown } = setup();
		try {
			const result = await execute({ task: "t", name: "x" });
			expect(result.content[0].text).toContain('Unknown model "nope/missing:max" (the pinned subagent default');
			expect(fake.calls).toHaveLength(0);
		} finally {
			shutdown();
		}
	});

	it("adds the policy line to the tool description only when a policy is set", () => {
		vi.stubEnv("PHI_SUBAGENT_MODEL_ALLOW", "gateway/example-medium:max,anthropic/claude-sonnet-5:medium");
		vi.stubEnv("PHI_SUBAGENT_MODEL_DEFAULT", "gateway/example-medium:max");
		const { tool, shutdown } = setup();
		try {
			const changes = tool.prepareLoadout?.({});
			const description = changes?.descriptions?.subagent;
			expect(description?.startsWith(tool.description)).toBe(true);
			expect(
				description?.endsWith(
					"Subagent models are pinned: allowed gateway/example-medium:max, anthropic/claude-sonnet-5:medium; default gateway/example-medium:max. Tasks with any other model are refused.",
				),
			).toBe(true);
		} finally {
			shutdown();
		}
	});
});
