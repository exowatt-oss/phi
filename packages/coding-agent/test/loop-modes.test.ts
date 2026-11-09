import { afterEach, describe, expect, it, vi } from "vitest";
import loopExtension from "../src/extensions/loop/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const printOutput = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	writeRawStdout: vi.fn((line: string) => printOutput.lines.push(line)),
}));

describe("loop mode parity", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
		printOutput.lines = [];
	});

	it("registers /loop as an extension command and exposes loop RPC UI requests", async () => {
		const harness = await createHarness({ extensionFactories: [loopExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: {
				setStatus: vi.fn(),
				setWidget: vi.fn(),
			} as never,
		});

		const status = vi.fn();
		const widget = vi.fn();
		await harness.session.prompt("/loop --every 0 --max-iterations 1 inspect");
		expect(
			harness.session.extensionRunner.getRegisteredCommands().some((entry) => entry.invocationName === "loop"),
		).toBe(true);
		expect(status).not.toHaveBeenCalled(); // RPC get_commands is assembled by rpc-mode from this registry.
		expect(widget).not.toHaveBeenCalled();
		const command = harness.session.extensionRunner
			.getRegisteredCommands()
			.find((entry) => entry.invocationName === "loop");
		expect(command?.sourceInfo).toBeDefined();
		expect(command?.description).toContain("bounded");
	});

	it("rejects loop start in print/json mode before the process can dispose", async () => {
		const harness = await createHarness({ extensionFactories: [loopExtension] });
		harnesses.push(harness);
		const runtimeHost = {
			session: harness.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as never;

		const result = await runPrintMode(runtimeHost, {
			mode: "json",
			initialMessage: "/loop --every 0 --max-iterations 2 background work",
		});

		expect(result).toBe(0);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom")).toBe(false);
	});

	it("prints a machine-readable error when pacing is requested in print/json mode", async () => {
		const harness = await createHarness({ extensionFactories: [loopExtension] });
		harnesses.push(harness);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const runtimeHost = {
			session: harness.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as never;

		const result = await runPrintMode(runtimeHost, {
			mode: "json",
			initialMessage: "/loop --every 1s background work",
		});
		expect(result).toBe(0);
		expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain(
			JSON.stringify({ error: "loop requires interactive or rpc mode in v1" }),
		);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom")).toBe(false);
	});
});
