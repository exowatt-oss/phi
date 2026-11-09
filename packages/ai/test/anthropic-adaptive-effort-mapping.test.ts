import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels, streamSimple } from "../src/compat.ts";
import { MODELS } from "../src/models.generated.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

/**
 * Regression cover for `400 invalid_request_error: Invalid effort level`.
 *
 * Measured against api.anthropic.com on 2026-09-12, one 1-token prompt per
 * (model, effort) pair:
 *
 * | model             | low | medium | high | xhigh | max |
 * |-------------------|-----|--------|------|-------|-----|
 * | claude-fable-5    | 200 | 400    | 400  | 400   | 400 |
 * | claude-fable-5-1  | 200 | 200    | 200  | 200   | 200 |
 * | claude-opus-5     | 200 | 200    | 200  | 200   | 200 |
 *
 * Fable 5 also answers 200 for adaptive thinking with no `output_config` at
 * all, and 400 (`"thinking.type.disabled" is not supported`) for
 * `thinking: { type: "disabled" }` — which is why its catalog entry maps
 * `off` to null.
 *
 * So a request must never carry an effort value the catalog did not explicitly
 * allow for that model, and an explicit `null` must omit `output_config.effort`
 * rather than fall back to an invented level.
 */

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;

	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) throw new Error("Expected payload to be captured before request failure");
	return capturedPayload;
}

/** Mirrors the generated catalog entry, so the mapping rule is testable on its own. */
function makeLowEffortOnlyModel(): Model<"anthropic-messages"> {
	return {
		id: "vendor--fable-5-proxy",
		name: "Vendor Proxy Fable 5",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
		thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: null, high: null, xhigh: null, max: null },
		compat: { forceAdaptiveThinking: true },
	};
}

describe("anthropic adaptive effort mapping", () => {
	it.each(["minimal", "low"] as const)("sends the mapped effort for %s", async (reasoning) => {
		const payload = await capturePayload(makeLowEffortOnlyModel(), { reasoning });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it.each(["medium", "high", "xhigh", "max"] as const)(
		"omits output_config.effort when the catalog maps %s to null",
		async (reasoning) => {
			const payload = await capturePayload(makeLowEffortOnlyModel(), { reasoning });

			// Adaptive thinking stays on; the model picks its own effort. Before this,
			// the mapper fell through to a hardcoded switch and put "medium"/"high" on
			// the wire for a model that rejects both.
			expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(payload.output_config).toBeUndefined();
		},
	);

	it("still passes a level through when the catalog leaves it unmapped", async () => {
		const model = makeLowEffortOnlyModel();
		const payload = await capturePayload(
			{ ...model, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
			{ reasoning: "medium" },
		);

		// An absent key is the catalog convention for "this model shares pi's
		// vocabulary", so the fallthrough is correct here and must not regress.
		expect(payload.output_config).toEqual({ effort: "medium" });
	});

	it("clamps an unsupported level down to a supported one instead of inventing it", () => {
		const model = makeLowEffortOnlyModel();

		expect(getSupportedThinkingLevels(model)).toEqual(["minimal", "low"]);
		for (const level of ["medium", "high", "xhigh", "max"] as const) {
			expect(clampThinkingLevel(model, level)).toBe("low");
		}
	});

	it("keeps Claude Fable 5's catalog entry inside the vocabulary the API accepts", () => {
		const fable5 = getModel("anthropic", "claude-fable-5");

		expect(fable5.thinkingLevelMap).toMatchObject({ medium: null, high: null, xhigh: null, max: null });
		expect(getSupportedThinkingLevels(fable5)).toEqual(["minimal", "low"]);
		expect(clampThinkingLevel(fable5, "max")).toBe("low");
	});

	it("leaves the Fable 5.1 refresh on the full effort vocabulary", () => {
		const fable51 = getModel("anthropic", "claude-fable-5-1");

		expect(getSupportedThinkingLevels(fable51)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("applies the correction to every provider's Fable 5 entry, and to no 5.1 entry", () => {
		const base = /claude-fable-5(?![.-]?\d)/;
		const refresh = /claude-fable-5[.-]\d/;
		let checked = 0;

		for (const models of Object.values(MODELS)) {
			for (const model of Object.values(models) as Model<any>[]) {
				const id = model.id.toLowerCase();
				if (base.test(id)) {
					checked++;
					expect(getSupportedThinkingLevels(model), model.id).toEqual(["minimal", "low"]);
				} else if (refresh.test(id)) {
					checked++;
					expect(getSupportedThinkingLevels(model), model.id).toContain("xhigh");
				}
			}
		}

		expect(checked).toBeGreaterThan(0);
	});
});
