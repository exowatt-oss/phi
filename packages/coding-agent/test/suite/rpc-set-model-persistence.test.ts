import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./harness.ts";

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
	lineHandler: (line: string) => void;
	cleanup: () => void;
}> {
	const listenerSnapshot = takeListenerSnapshot();
	const harness = await createHarness({
		models: [
			{ id: "faux-1", name: "One" },
			{ id: "faux-2", name: "Two" },
		],
		settings: {
			defaultProvider: "original-provider",
			defaultModel: "original-model",
		},
	});

	void runRpcMode(createRuntimeHost(harness));
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		harness,
		lineHandler: rpcIo.lineHandler!,
		cleanup: () => {
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

describe("RPC set_model persistence", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("persists the selected model when persist is omitted", async () => {
		const { harness, lineHandler, cleanup } = await startRpcMode();
		const targetModel = harness.getModel("faux-2")!;
		const command = {
			id: "persist-default",
			type: "set_model",
			provider: targetModel.provider,
			modelId: targetModel.id,
		} satisfies RpcCommand;

		try {
			const response = await sendCommand(lineHandler, command);

			expect(response).toMatchObject({ success: true, command: "set_model" });
			expect(harness.session.model?.id).toBe(targetModel.id);
			expect(harness.settingsManager.getDefaultProvider()).toBe(targetModel.provider);
			expect(harness.settingsManager.getDefaultModel()).toBe(targetModel.id);
		} finally {
			cleanup();
		}
	});

	test("keeps settings unchanged when persist is false", async () => {
		const { harness, lineHandler, cleanup } = await startRpcMode();
		const targetModel = harness.getModel("faux-2")!;
		const command = {
			id: "persist-false",
			type: "set_model",
			provider: targetModel.provider,
			modelId: targetModel.id,
			persist: false,
		} satisfies RpcCommand;

		try {
			const response = await sendCommand(lineHandler, command);

			expect(response).toMatchObject({ success: true, command: "set_model" });
			expect(harness.session.model?.id).toBe(targetModel.id);
			expect(harness.settingsManager.getDefaultProvider()).toBe("original-provider");
			expect(harness.settingsManager.getDefaultModel()).toBe("original-model");
		} finally {
			cleanup();
		}
	});

	test("rejects non-boolean persist values without changing model or settings", async () => {
		const { harness, lineHandler, cleanup } = await startRpcMode();
		const initialModel = harness.session.model;
		const targetModel = harness.getModel("faux-2")!;

		try {
			const response = await sendCommand(lineHandler, {
				id: "persist-invalid",
				type: "set_model",
				provider: targetModel.provider,
				modelId: targetModel.id,
				persist: "false",
			});

			expect(response).toEqual({
				id: "persist-invalid",
				type: "response",
				command: "set_model",
				success: false,
				error: "Invalid persist: expected a boolean",
			});
			expect(harness.session.model).toBe(initialModel);
			expect(harness.settingsManager.getDefaultProvider()).toBe("original-provider");
			expect(harness.settingsManager.getDefaultModel()).toBe("original-model");
		} finally {
			cleanup();
		}
	});
});
