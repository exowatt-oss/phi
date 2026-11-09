import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getSupportedServiceTiers } from "../src/core/service-tier.ts";

function model(api: Api, provider: string, id: string): Model<Api> {
	return {
		api,
		provider,
		id,
		name: id,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("service tier discovery", () => {
	it.each(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.6", "gpt-5.5"])(
		"advertises Fast for documented Codex model %s",
		(id) => {
			expect(getSupportedServiceTiers(model("openai-codex-responses", "openai-codex", id))).toEqual([
				"default",
				"fast",
			]);
		},
	);
	it.each(["gpt-5.1-codex", "gpt-6.1-astra", "gpt-6.1-luna", "unknown", "gpt-6-astra-ultrafast"])(
		"does not advertise Fast for undocumented Codex model %s",
		(id) => {
			expect(getSupportedServiceTiers(model("openai-codex-responses", "openai-codex", id))).toEqual(["default"]);
		},
	);
	it.each(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"])(
		"advertises Fast for first-party Anthropic model %s",
		(id) => {
			expect(getSupportedServiceTiers(model("anthropic-messages", "anthropic", id))).toEqual(["default", "fast"]);
		},
	);
	it.each(["claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-opus-4-7"])(
		"does not advertise Fast for unsupported Anthropic model %s",
		(id) => {
			expect(getSupportedServiceTiers(model("anthropic-messages", "anthropic", id))).toEqual(["default"]);
		},
	);
	it("does not infer premium tiers from a compatible API on another provider", () => {
		expect(getSupportedServiceTiers(model("anthropic-messages", "gateway", "claude-opus-5-5"))).toEqual(["default"]);
		expect(getSupportedServiceTiers(model("openai-completions", "github-copilot", "gpt-6-sol"))).toEqual(["default"]);
		expect(getSupportedServiceTiers(model("openai-responses", "gateway", "example-large"))).toEqual(["default"]);
		expect(getSupportedServiceTiers(undefined)).toEqual(["default"]);
	});
	it("honors explicit Anthropic gateway compatibility", () => {
		const proxy = model("anthropic-messages", "gateway", "claude-opus-5-5");
		proxy.compat = { supportsFastMode: true };
		expect(getSupportedServiceTiers(proxy)).toEqual(["default", "fast"]);
	});
	it("accepts dated versions of supported models without admitting adjacent classes", () => {
		expect(
			getSupportedServiceTiers(model("openai-codex-responses", "openai-codex", "gpt-6.1-sol-2026-09-30")),
		).toEqual(["default", "fast"]);
		expect(getSupportedServiceTiers(model("anthropic-messages", "anthropic", "claude-opus-5-5-20260930"))).toEqual([
			"default",
			"fast",
		]);
		expect(
			getSupportedServiceTiers(model("openai-codex-responses", "openai-codex", "gpt-6.1-astra-2026-09-30")),
		).toEqual(["default"]);
	});
	it("advertises Fast (sent as ultrafast) for GPT-6 Astra and GPT-6.1 Sol on Amazon Bedrock's OpenAI endpoints", () => {
		for (const [baseUrl, id] of [
			["https://bedrock-mantle.us-east-1.api.aws/openai/v1", "openai.gpt-6-astra"],
			["https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", "us.openai.gpt-6-astra"],
			["https://bedrock-mantle.us-east-1.api.aws/openai/v1", "openai.gpt-6.1-sol"],
		] as const) {
			const bedrock = model("openai-responses", "bedrock-astra", id);
			bedrock.baseUrl = baseUrl;
			expect(getSupportedServiceTiers(bedrock)).toEqual(["default", "fast", "ultrafast"]);
		}
		for (const id of ["openai.gpt-6-sol"]) {
			const bedrockModel = model("openai-responses", "bedrock-mantle", id);
			bedrockModel.baseUrl = "https://bedrock-mantle.us-east-1.api.aws/openai/v1";
			expect(getSupportedServiceTiers(bedrockModel)).toEqual(["default"]);
		}
		const elsewhere = model("openai-responses", "proxy", "openai.gpt-6-astra");
		expect(getSupportedServiceTiers(elsewhere)).toEqual(["default"]);
	});
	it("honors an explicit OpenAI Responses fast wire tier", () => {
		const custom = model("openai-responses", "proxy", "anything");
		custom.compat = { fastServiceTier: "ultrafast", fastServiceTierCostMultiplier: 6 };
		expect(getSupportedServiceTiers(custom)).toEqual(["default", "fast", "ultrafast"]);
		custom.compat = { fastServiceTier: "priority" };
		expect(getSupportedServiceTiers(custom)).toEqual(["default", "fast"]);
	});
});
