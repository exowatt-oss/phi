// Exowatt fork test: models.json layering used by the `models` hub bundle kind.
// Enabled model bundles are loaded beneath the user's own ~/.pi/agent/models.json
// with a deterministic, order-stable merge; the local file always wins. This is
// the runtime half of first-class safe models.json sharing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "phi-models-layer-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeModels(name: string, body: unknown): string {
	const path = join(root, name);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(body));
	return path;
}

describe("ModelConfig.loadLayered", () => {
	it("layers bundle sources beneath the local models.json, which wins", async () => {
		const bundle = writeModels("bundle.json", {
			providers: {
				gateway: {
					name: "Gateway (bundle)",
					baseUrl: "https://bundle.example.com",
					apiKey: "$BUNDLE_KEY",
					models: [{ id: "shared", name: "Shared (bundle)" }, { id: "bundle-only" }],
				},
			},
		});
		const local = writeModels("local.json", {
			providers: {
				gateway: {
					// Local overrides the bundle's name and key; baseUrl falls through.
					name: "Gateway (local)",
					apiKey: "$LOCAL_KEY",
					models: [{ id: "shared", name: "Shared (local)" }, { id: "local-only" }],
				},
			},
		});

		// Local is passed last => highest precedence.
		const config = await ModelConfig.loadLayered([bundle, local]);
		const gateway = config.getProvider("gateway");
		expect(gateway?.name).toBe("Gateway (local)");
		expect(gateway?.apiKey).toBe("$LOCAL_KEY");
		// A field only the bundle set survives.
		expect(gateway?.baseUrl).toBe("https://bundle.example.com");
		// Models merge by id: local wins on the shared id, both uniques survive.
		const models = new Map(gateway?.models?.map((model) => [model.id, model.name]));
		expect(models.get("shared")).toBe("Shared (local)");
		expect(models.has("bundle-only")).toBe(true);
		expect(models.has("local-only")).toBe(true);
	});

	it("keeps providers that appear in only one layer", async () => {
		const bundle = writeModels("bundle.json", { providers: { onlybundle: { baseUrl: "https://b" } } });
		const local = writeModels("local.json", { providers: { onlylocal: { baseUrl: "https://l" } } });
		const config = await ModelConfig.loadLayered([bundle, local]);
		expect([...config.getProviderIds()].sort()).toEqual(["onlybundle", "onlylocal"]);
	});

	it("is deterministic across multiple bundle layers in the order given", async () => {
		const first = writeModels("first.json", { providers: { g: { name: "first", baseUrl: "https://first" } } });
		const second = writeModels("second.json", { providers: { g: { name: "second" } } });
		const local = writeModels("local.json", { providers: { g: { apiKey: "$K" } } });
		const config = await ModelConfig.loadLayered([first, second, local]);
		const g = config.getProvider("g");
		// Later bundle wins over earlier bundle; local adds its own field.
		expect(g?.name).toBe("second");
		expect(g?.baseUrl).toBe("https://first");
		expect(g?.apiKey).toBe("$K");
	});

	it("treats a missing source as empty and surfaces a real parse error", async () => {
		const good = writeModels("good.json", { providers: { g: { baseUrl: "https://g" } } });
		const missing = join(root, "does-not-exist.json");
		const ok = await ModelConfig.loadLayered([missing, good]);
		expect(ok.getError()).toBeUndefined();
		expect(ok.getProviderIds()).toEqual(["g"]);

		const broken = writeModels("broken.json", "not json" as unknown);
		writeFileSync(broken, "{ not json");
		const withError = await ModelConfig.loadLayered([broken, good]);
		expect(withError.getError()).toContain("Failed to parse models.json");
		// A broken lower layer must not drop the good higher layer.
		expect(withError.getProviderIds()).toEqual(["g"]);
	});

	it("delegates to load() for a single source", async () => {
		const local = writeModels("local.json", { providers: { g: { apiKey: "$K" } } });
		const layered = await ModelConfig.loadLayered([undefined, local]);
		expect(layered.getProvider("g")?.apiKey).toBe("$K");
		expect((await ModelConfig.loadLayered([])).getProviderIds()).toEqual([]);
	});
});

// The openai-completions compat block is schema-validated, and a key missing from
// the schema fails the whole file rather than just that field: one undocumented
// flag and the user loses every custom provider. `sendReasoningEffortOff` is
// documented in docs/models.md and docs/custom-provider.md, so it has to parse.
describe("models.json compat schema", () => {
	it("accepts compat.sendReasoningEffortOff on a custom model", async () => {
		const local = writeModels("local.json", {
			providers: {
				gateway: {
					baseUrl: "https://gateway.example.com",
					apiKey: "$K",
					models: [
						{
							id: "thinker",
							reasoning: true,
							thinkingLevelMap: { off: "none", low: "low", high: "high" },
							compat: { supportsReasoningEffort: true, sendReasoningEffortOff: true },
						},
					],
				},
			},
		});

		const config = await ModelConfig.load(local);

		expect(config.getError()).toBeUndefined();
		const model = config.getProvider("gateway")?.models?.[0];
		expect(model?.compat).toMatchObject({ sendReasoningEffortOff: true });
	});

	it("does not reject an unknown compat key, which is why the flag worked unschema'd", async () => {
		// Recorded deliberately: the compat schema does not set additionalProperties,
		// so an unlisted key parses fine. Adding `sendReasoningEffortOff` above makes
		// it part of the validated type rather than unblocking it — nothing was broken
		// at runtime before, and this test is what says so.
		const local = writeModels("typo.json", {
			providers: {
				gateway: {
					baseUrl: "https://gateway.example.com",
					models: [{ id: "thinker", compat: { sendReasoningEffortOf: true } }],
				},
			},
		});

		expect((await ModelConfig.load(local)).getError()).toBeUndefined();
	});
});
