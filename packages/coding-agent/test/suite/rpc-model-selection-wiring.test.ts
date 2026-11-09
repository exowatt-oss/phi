import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./harness.ts";

// The two things RPC mode does to model selection that nothing else tests without
// a provider key: it decorates `get_available_models` with resolved thinking
// levels, and it tells the SettingsManager that a host owns the picker. Both used
// to be covered only inside a `skipIf(no anthropic key)` block, which on CI and on
// most machines means not covered at all.

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];
type RpcOutput = Record<string, unknown>;

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): RpcOutput[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RpcOutput);
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

async function startRpcMode(): Promise<{
	harness: Harness;
	hostManaged: ReturnType<typeof vi.fn>;
	lineHandler: (line: string) => void;
	cleanup: () => void;
}> {
	const listenerSnapshot = takeListenerSnapshot();
	const harness = await createHarness({
		models: [
			{ id: "faux-thinker", name: "Thinker", reasoning: true },
			{ id: "faux-plain", name: "Plain", reasoning: false },
		],
	});
	const hostManaged = vi.fn();
	vi.spyOn(harness.settingsManager, "setHostManagedModelSelection").mockImplementation((value: boolean) => {
		hostManaged(value);
	});

	void runRpcMode(createRuntimeHost(harness));
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		harness,
		hostManaged,
		lineHandler: rpcIo.lineHandler!,
		cleanup: () => {
			vi.restoreAllMocks();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		},
	};
}

async function sendCommand(
	lineHandler: (line: string) => void,
	command: RpcCommand | Record<string, unknown>,
): Promise<RpcOutput> {
	lineHandler(JSON.stringify(command));
	let response: RpcOutput | undefined;
	await vi.waitFor(() => {
		response = parseOutputLines().find(
			(line) => line.type === "response" && line.id === command.id && line.command === command.type,
		);
		expect(response).toBeDefined();
	});
	return response!;
}

describe("RPC model selection wiring", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("get_available_models reports resolved thinking levels", async () => {
		const { lineHandler, cleanup } = await startRpcMode();

		try {
			const response = await sendCommand(lineHandler, { id: "models", type: "get_available_models" });

			expect(response).toMatchObject({ success: true, command: "get_available_models" });
			const models = (response.data as { models: { id: string; thinkingLevels: string[] }[] }).models;
			const thinker = models.find((model) => model.id === "faux-thinker");
			const plain = models.find((model) => model.id === "faux-plain");

			// No thinkingLevelMap on these, which means supported through `high` but not
			// xhigh/max — the asymmetry hosts were expected to reimplement.
			expect(thinker?.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
			expect(plain?.thinkingLevels).toEqual(["off"]);
		} finally {
			cleanup();
		}
	});

	test("binding a session tells settings that the host owns the picker", async () => {
		// This is what turns errorFallback off by default in RPC mode. It runs on
		// every rebind, not just startup, because a reload or session switch brings a
		// fresh SettingsManager that has never been told.
		const { hostManaged, cleanup } = await startRpcMode();

		try {
			expect(hostManaged).toHaveBeenCalledWith(true);
		} finally {
			cleanup();
		}
	});

	test("model discovery respects configured patterns and preserves their order", async () => {
		const { harness, lineHandler, cleanup } = await startRpcMode();
		try {
			harness.settingsManager.setEnabledModels(["faux-plain", "*thinker*"]);
			const response = await sendCommand(lineHandler, { id: "scoped", type: "get_available_models" });
			expect(response).toMatchObject({ success: true });
			const models = (response.data as { models: { id: string }[] }).models;
			expect(models.map((model) => model.id)).toEqual(["faux-plain", "faux-thinker"]);
			harness.settingsManager.setEnabledModels(["faux-plain"]);
			const narrowed = await sendCommand(lineHandler, { id: "narrowed", type: "get_available_models" });
			expect((narrowed.data as { models: { id: string }[] }).models.map((model) => model.id)).toEqual([
				"faux-plain",
			]);
		} finally {
			cleanup();
		}
	});

	test("explicit all scope bypasses a curated picker", async () => {
		const { harness, lineHandler, cleanup } = await startRpcMode();
		try {
			harness.settingsManager.setEnabledModels(["faux-plain"]);
			const response = await sendCommand(lineHandler, { id: "all", type: "get_available_models", scope: "all" });
			expect((response.data as { models: { id: string }[] }).models.map((model) => model.id)).toEqual(
				expect.arrayContaining(["faux-plain", "faux-thinker"]),
			);
		} finally {
			cleanup();
		}
	});

	test("an unmatched configured scope does not expose the full catalog", async () => {
		const { harness, lineHandler, cleanup } = await startRpcMode();
		try {
			harness.settingsManager.setEnabledModels(["missing-provider/missing-model"]);
			const response = await sendCommand(lineHandler, { id: "missing", type: "get_available_models" });
			expect(response).toMatchObject({ success: true, data: { models: [] } });
		} finally {
			cleanup();
		}
	});

	test("an explicit session scope takes precedence over settings", async () => {
		const { harness, lineHandler, cleanup } = await startRpcMode();
		try {
			harness.settingsManager.setEnabledModels(["faux-plain"]);
			harness.session.setScopedModels([{ model: harness.getModel("faux-thinker")! }]);
			const response = await sendCommand(lineHandler, { id: "cli-scope", type: "get_available_models" });
			expect((response.data as { models: { id: string }[] }).models.map((model) => model.id)).toEqual([
				"faux-thinker",
			]);
		} finally {
			cleanup();
		}
	});

	test("rejects an unknown discovery scope", async () => {
		const { lineHandler, cleanup } = await startRpcMode();
		try {
			const response = await sendCommand(lineHandler, {
				id: "invalid-scope",
				type: "get_available_models",
				scope: "invalid",
			});
			expect(response).toMatchObject({ success: false, error: "Invalid scope: expected configured or all" });
		} finally {
			cleanup();
		}
	});

	test("reports tiers and rejects Fast on an unsupported model", async () => {
		const { harness, lineHandler, cleanup } = await startRpcMode();
		try {
			const models = await sendCommand(lineHandler, { id: "tiers", type: "get_available_models" });
			expect((models.data as { models: { serviceTiers: string[] }[] }).models).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "faux-plain", serviceTiers: ["default"] })]),
			);
			const response = await sendCommand(lineHandler, { id: "fast", type: "set_service_tier", tier: "fast" });
			expect(response).toMatchObject({ success: false, error: "Service tier is not supported by this model: fast" });
			expect(harness.session.serviceTier).not.toBe("fast");
		} finally {
			cleanup();
		}
	});

	test("service-tier commands update session state without changing global settings", async () => {
		const { harness, lineHandler, cleanup } = await startRpcMode();
		try {
			harness.settingsManager.setServiceTier("fast");
			const persist = vi.spyOn(harness.settingsManager, "setServiceTier");
			const response = await sendCommand(lineHandler, { id: "standard", type: "set_service_tier", tier: "default" });
			expect(response).toMatchObject({ success: true, data: { serviceTier: "default" } });
			const state = await sendCommand(lineHandler, { id: "state", type: "get_state" });
			expect(state).toMatchObject({ success: true, data: { serviceTier: "default" } });
			expect(persist).not.toHaveBeenCalled();
			expect(harness.settingsManager.getServiceTier()).toBe("fast");
		} finally {
			cleanup();
		}
	});

	test("rejects an unknown service tier without changing the session", async () => {
		const { harness, lineHandler, cleanup } = await startRpcMode();
		try {
			const previous = harness.session.serviceTier;
			const response = await sendCommand(lineHandler, { id: "bad-tier", type: "set_service_tier", tier: "turbo" });
			expect(response).toMatchObject({ success: false });
			expect(harness.session.serviceTier).toBe(previous);
		} finally {
			cleanup();
		}
	});
});
