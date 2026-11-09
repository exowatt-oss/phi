import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("ExtensionContext sideQuestion", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("returns the faux-provider answer and usage without mutating the transcript", async () => {
		let answer: string | undefined;
		let usage: unknown;
		let idleTimeoutMs: number | undefined;
		const harness = await createHarness({
			settings: { streamIdleTimeoutMs: 4321 },
			extensionFactories: [
				(pi) => {
					pi.registerCommand("ask", {
						description: "Ask a side question",
						handler: async (_args, ctx) => {
							const response = await ctx.sideQuestion?.({ messages: [] });
							answer = response?.answer;
							usage = response?.usage;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(_context, options) => {
				idleTimeoutMs = options?.idleTimeoutMs;
				return fauxAssistantMessage("side answer");
			},
		]);
		const before = harness.session.messages.length;

		await harness.session.prompt("/ask");

		expect(answer).toBe("side answer");
		expect(usage).toBeDefined();
		expect(idleTimeoutMs).toBe(4321);
		expect(harness.session.messages).toHaveLength(before);
	});

	it("rejects unknown and malformed model references clearly", async () => {
		const errors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("ask", {
						description: "Ask a side question",
						handler: async (_args, ctx) => {
							for (const model of ["nope/nope", "nomodel"]) {
								try {
									await ctx.sideQuestion?.({ messages: [], model });
								} catch (error) {
									errors.push(error instanceof Error ? error.message : String(error));
								}
							}
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/ask");

		expect(errors).toEqual([
			"Unknown side-question model: nope/nope",
			"Invalid side-question model reference: nomodel",
		]);
	});

	it("rejects an already-aborted request", async () => {
		let errorMessage: string | undefined;
		const controller = new AbortController();
		controller.abort();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("ask", {
						description: "Ask a side question",
						handler: async (_args, ctx) => {
							try {
								await ctx.sideQuestion?.({ messages: [], signal: controller.signal });
							} catch (error) {
								errorMessage = error instanceof Error ? error.message : String(error);
							}
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not answer")]);

		await harness.session.prompt("/ask");

		expect(errorMessage).toMatch(/abort/i);
	});
});
