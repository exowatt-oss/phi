import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type ClassifierModel,
	createProvider,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import jevRouter from "../examples/extensions/jev-router.ts";
import { VIRTUAL_MODEL_STATE_ENTRY, type VirtualModelStateData } from "../src/core/virtual-models.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createTool(name: string, fails = false): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name} tool`,
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => {
			if (fails) throw new Error(`${name} failed`);
			return { content: [{ type: "text", text: `${name} ok` }], details: {} };
		},
	};
}

const jevModel: ClassifierModel<string> = {
	type: "classifier",
	id: "jev-latest",
	name: "Jev",
	api: "typesafe-system-one",
	provider: "typesafe",
	baseUrl: "",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64_000,
};

describe("jev-router example", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	/** Runs the example against a faux provider and a scripted Jev complexity rating. */
	async function setup(complex: number, tools: AgentTool[]) {
		const exampleProvider = fauxProvider({
			provider: "example",
			models: ["large", "small", "medium"].map((id) => ({ id, reasoning: true })),
		});
		const typesafe = createProvider({
			id: "typesafe",
			auth: { apiKey: { name: "TypeSafe", resolve: async () => ({ auth: {} }) } },
			models: [jevModel],
			classifiers: {
				"typesafe-system-one": {
					classify: async (model) => ({
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: {
							complexity: {
								type: "choice",
								choice: complex >= 0.5 ? "complex" : "standard",
								probabilities: { standard: 1 - complex, complex },
								confidence: Math.max(complex, 1 - complex),
							},
						},
						stopReason: "stop",
						timestamp: Date.now(),
					}),
				},
			},
		});
		const harness = await createHarness({
			tools,
			extensionFactories: [
				(pi) => {
					pi.registerProvider(exampleProvider.provider);
					pi.registerProvider(typesafe);
				},
				jevRouter,
			],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await runtime.refresh({ allowNetwork: false });
		await harness.session.setModel(runtime.getModel("jev", "auto")!);

		const respond = (...messages: AssistantMessage[]) => exampleProvider.appendResponses(messages);
		const dispatched = () => harness.session.messages.flatMap((m) => (m.role === "assistant" ? [m.model] : []));
		const phases = () =>
			harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY
						? [(entry.data as VirtualModelStateData<{ phase: string }>).state.phase]
						: [],
				);
		return { harness, dispatched, respond, phases };
	}

	const call = (tool: string) => fauxAssistantMessage(fauxToolCall(tool, { path: "a.ts" }), { stopReason: "toolUse" });

	it("lets the large model make the first edit and switches to medium for the rest", async () => {
		const { harness, dispatched, respond, phases } = await setup(0.8, [createTool("read"), createTool("edit")]);

		respond(call("read"), call("edit"), fauxAssistantMessage("done"));
		await harness.session.prompt("Refactor the cache layer.");
		respond(fauxAssistantMessage("added"));
		await harness.session.prompt("Also add tests.");

		// The large model reads and edits; the same-turn follow-up goes to medium.
		expect(dispatched()).toEqual(["large", "large", "medium", "medium"]);
		expect(phases()).toEqual(["planning", "implementation"]);
		expect(harness.session.model).toMatchObject({ provider: "jev", id: "auto" });
	});

	it("plans on the small model and ignores failed edits", async () => {
		const { harness, dispatched, respond, phases } = await setup(0.2, [
			createTool("edit", true),
			createTool("write"),
		]);

		respond(call("edit"), call("write"), fauxAssistantMessage("done"));
		await harness.session.prompt("Add a verbose flag.");

		expect(dispatched()).toEqual(["small", "small", "medium"]);
		expect(phases()).toEqual(["planning", "implementation"]);
	});
});
