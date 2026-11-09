import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { toRpcModelInfo } from "../src/modes/rpc/rpc-types.ts";

// `get_available_models` used to return raw Model objects, leaving every host to
// derive the supported thinking levels from `thinkingLevelMap` — whose semantics
// are asymmetric (an absent key means supported for off..high but unsupported for
// xhigh/max, an explicit null means unsupported). A host that did not reimplement
// them offered levels the provider rejects.

describe("toRpcModelInfo", () => {
	it("keeps the model fields and adds the resolved thinking levels", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const info = toRpcModelInfo(model);

		expect(info.provider).toBe("anthropic");
		expect(info.id).toBe("claude-sonnet-4-5");
		expect(info.contextWindow).toBe(model.contextWindow);
		expect(info.thinkingLevels).toContain("off");
		expect(info.thinkingLevels).toContain("high");
	});

	it("omits a level the model maps to null", () => {
		// claude-fable-5 cannot be asked not to think (`thinkingLevelMap.off` is null)
		// and rejects every effort above "low", so a host that offered the full range
		// would be offering two kinds of level the provider 400s on.
		const model = getModel("anthropic", "claude-fable-5")!;

		const levels = toRpcModelInfo(model).thinkingLevels;

		expect(levels).not.toContain("off");
		expect(levels).not.toContain("max");
		expect(levels).toEqual(["minimal", "low"]);
	});

	it("reports only off for a non-reasoning model", () => {
		const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, reasoning: false };

		expect(toRpcModelInfo(model).thinkingLevels).toEqual(["off"]);
	});

	it("omits xhigh and max unless the model maps them", () => {
		// An unmapped xhigh/max means unsupported, unlike the lower levels.
		const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, thinkingLevelMap: undefined };

		const levels = toRpcModelInfo(model).thinkingLevels;

		expect(levels).not.toContain("xhigh");
		expect(levels).not.toContain("max");
		expect(levels).toEqual(["off", "minimal", "low", "medium", "high"]);
	});
});
