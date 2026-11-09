import {
	type Api,
	getOpenAIResponsesFastServiceTier,
	type Model,
	type ServiceTier,
	supportsFastMode,
} from "@earendil-works/pi-ai";

const CODEX_FAST_MODELS = /^(?:gpt-6-(?:astra|sol|luna)|gpt-6\.1-sol|gpt-5\.[56](?:-sol)?)(?:-\d{4}-\d{2}-\d{2})?$/;

/** Documented model support; account, workspace, and rollout eligibility remains provider-owned. */
export function getSupportedServiceTiers(model: Model<Api> | undefined): readonly ServiceTier[] {
	if (!model) return ["default"];
	if (model.api === "anthropic-messages") {
		return supportsFastMode(model) ? ["default", "fast"] : ["default"];
	}
	if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
		return CODEX_FAST_MODELS.test(model.id) ? ["default", "fast"] : ["default"];
	}
	// GPT-6 Astra on Amazon Bedrock: `fast` is sent as `service_tier: "ultrafast"`, and the
	// explicit `ultrafast` tier is the same request.
	const fastTier = getOpenAIResponsesFastServiceTier(model)?.tier;
	if (fastTier === "ultrafast") return ["default", "fast", "ultrafast"];
	if (fastTier) return ["default", "fast"];
	return ["default"];
}
