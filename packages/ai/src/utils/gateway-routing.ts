import type { Api, Model, RoutingInfo } from "../types.ts";

function getHeader(headers: Record<string, string>, name: string): string | undefined {
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected) return value;
	}
	return undefined;
}

function getNonEmptyHeader(headers: Record<string, string>, name: string): string | undefined {
	const value = getHeader(headers, name)?.trim();
	return value ? value : undefined;
}

export function extractGatewayRouting(model: Model<Api>, headers: Record<string, string>): RoutingInfo | undefined {
	if (model.provider !== "gateway" || model.id !== "auto") return undefined;

	const servedModel = getNonEmptyHeader(headers, "x-litellm-model-group");
	if (!servedModel) return undefined;

	const routing: RoutingInfo = {
		requestedModel: model.id,
		servedModel,
	};

	const upstreamModel = getNonEmptyHeader(headers, "x-litellm-model-name");
	if (upstreamModel) routing.upstreamModel = upstreamModel;

	const callId = getNonEmptyHeader(headers, "x-litellm-call-id");
	if (callId) routing.callId = callId;

	const responseCost = getNonEmptyHeader(headers, "x-litellm-response-cost");
	if (responseCost) {
		const costUsd = Number(responseCost);
		if (Number.isFinite(costUsd) && costUsd > 0) {
			routing.costUsd = costUsd;
			routing.costSource = "gateway";
		}
	}

	const tier = getNonEmptyHeader(headers, "x-auto-tier");
	if (tier) routing.tier = tier;

	const intent = getNonEmptyHeader(headers, "x-auto-intent");
	if (intent) routing.intent = intent;

	const confidenceHeader = getNonEmptyHeader(headers, "x-auto-confidence");
	if (confidenceHeader) {
		const confidence = Number(confidenceHeader);
		if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
			routing.confidence = confidence;
		}
	}

	return routing;
}
