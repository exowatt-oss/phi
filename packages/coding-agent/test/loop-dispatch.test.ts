import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import loopExtension from "../src/extensions/loop/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type Entry = { type: string; customType?: string; data?: any };

const loopStates = (harness: Harness) =>
	(harness.sessionManager.getEntries() as Entry[])
		.filter((e) => e.type === "custom" && e.customType === "phi.loop.state.v1")
		.map((e) => e.data);

const dispatches = (harness: Harness) =>
	(harness.sessionManager.getEntries() as Entry[]).filter(
		(e) => e.type === "custom_message" && e.customType === "phi.loop.dispatch.v1",
	).length;

const iteration = (n: number, action: "continue" | "complete") => [
	fauxAssistantMessage([fauxToolCall("loop_control", { action, summary: `iteration ${n}` })], {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage(`done ${n}`),
];

describe("loop dispatch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("starts every iteration on its own, without an outside message", async () => {
		const harness = await createHarness({ extensionFactories: [loopExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() } as never,
		});
		harness.setResponses([...iteration(1, "continue"), ...iteration(2, "continue"), ...iteration(3, "complete")]);

		await harness.session.prompt("/loop --max 5 -- do the work");
		await vi.waitFor(
			() => {
				expect(loopStates(harness).at(-1)?.phase).toBe("terminal");
			},
			{ timeout: 10_000, interval: 20 },
		);

		expect(dispatches(harness)).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(0);
		const running = loopStates(harness).filter((s) => s.phase === "running");
		expect(running.map((s) => s.iterationIndex)).toEqual([1, 2, 3]);
	});
});
