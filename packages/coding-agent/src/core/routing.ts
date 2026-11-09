import {
	type Api,
	type AssistantMessage,
	calculateCost,
	type Model,
	type RoutingInfo,
	type Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

export type ModelLookup = (providerId: string, modelId: string) => Model<Api> | undefined;

type AutoRoutedMessage = Pick<AssistantMessage, "provider" | "model" | "routing"> & {
	provider: "gateway";
	model: "auto";
	routing: RoutingInfo;
};

/** Gate helper — the only predicate for gateway-routed messages. */
export function isAutoRouted(
	message: Pick<AssistantMessage, "provider" | "model" | "routing">,
): message is AutoRoutedMessage {
	return message.provider === "gateway" && message.model === "auto" && message.routing !== undefined;
}

function usageTokenCount(usage: Usage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function costChanged(
	before: Usage["cost"],
	after: Usage["cost"],
	beforeCostUsd: number | undefined,
	afterCostUsd: number | undefined,
	beforeCostSource: RoutingInfo["costSource"],
	afterCostSource: RoutingInfo["costSource"],
): boolean {
	return (
		before.input !== after.input ||
		before.output !== after.output ||
		before.cacheRead !== after.cacheRead ||
		before.cacheWrite !== after.cacheWrite ||
		before.total !== after.total ||
		beforeCostUsd !== afterCostUsd ||
		beforeCostSource !== afterCostSource
	);
}

/**
 * Re-price a routed assistant message with the served model's actual price or
 * the gateway's reported charge. The message and its usage are mutated in place.
 */
export function applyRoutedCost(message: AssistantMessage, findModel: ModelLookup): boolean {
	if (!isAutoRouted(message)) return false;
	if ((message.stopReason === "error" || message.stopReason === "aborted") && usageTokenCount(message.usage) === 0) {
		return false;
	}

	const routing = message.routing;
	const beforeCost = { ...message.usage.cost };
	const beforeCostUsd = routing.costUsd;
	const beforeCostSource = routing.costSource;

	if (routing.costSource === "gateway" && routing.costUsd !== undefined) {
		const currentTotal = message.usage.cost.total;
		if (currentTotal === 0) {
			message.usage.cost.input = 0;
			message.usage.cost.cacheRead = 0;
			message.usage.cost.cacheWrite = 0;
			message.usage.cost.output = routing.costUsd;
		} else {
			const scale = routing.costUsd / currentTotal;
			message.usage.cost.input *= scale;
			message.usage.cost.output *= scale;
			message.usage.cost.cacheRead *= scale;
			message.usage.cost.cacheWrite *= scale;
		}
		message.usage.cost.total = routing.costUsd;
		return costChanged(
			beforeCost,
			message.usage.cost,
			beforeCostUsd,
			routing.costUsd,
			beforeCostSource,
			routing.costSource,
		);
	}

	const servedModel = findModel("gateway", routing.servedModel);
	if (!servedModel) {
		return false;
	}

	calculateCost(servedModel, message.usage);
	routing.costUsd = message.usage.cost.total;
	routing.costSource = "estimate";
	return costChanged(
		beforeCost,
		message.usage.cost,
		beforeCostUsd,
		routing.costUsd,
		beforeCostSource,
		routing.costSource,
	);
}

export interface RoutingBucket {
	servedModel: string;
	count: number;
	costUsd: number;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface RoutingBreakdown {
	requests: number;
	totalCostUsd: number;
	buckets: RoutingBucket[];
	counterfactuals: { model: string; costUsd: number; savedUsd: number; available: boolean }[];
	unpriced: number;
}

function cloneUsage(usage: Usage): Usage {
	return { ...usage, cost: { ...usage.cost } };
}

/** Summarize costs and token usage for routed assistant messages in a session. */
export function getRoutingBreakdown(
	entries: SessionEntry[],
	findModel: ModelLookup,
	comparisonModels: readonly string[] = [],
): RoutingBreakdown {
	const bucketsByModel = new Map<string, RoutingBucket>();
	const routedUsages: Usage[] = [];
	let requests = 0;
	let totalCostUsd = 0;
	let unpriced = 0;

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		if (!isAutoRouted(message) || message.stopReason === "error") continue;

		requests++;
		routedUsages.push(message.usage);
		const costUsd = message.routing.costUsd ?? message.usage.cost.total;
		if (message.routing.costUsd === undefined) unpriced++;
		totalCostUsd += costUsd;

		let bucket = bucketsByModel.get(message.routing.servedModel);
		if (!bucket) {
			bucket = {
				servedModel: message.routing.servedModel,
				count: 0,
				costUsd: 0,
				tokens: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			};
			bucketsByModel.set(message.routing.servedModel, bucket);
		}
		bucket.count++;
		bucket.costUsd += costUsd;
		bucket.input += message.usage.input;
		bucket.output += message.usage.output;
		bucket.cacheRead += message.usage.cacheRead;
		bucket.cacheWrite += message.usage.cacheWrite;
		bucket.tokens += usageTokenCount(message.usage);
	}

	const buckets = [...bucketsByModel.values()].sort(
		(a, b) => b.costUsd - a.costUsd || b.count - a.count || a.servedModel.localeCompare(b.servedModel),
	);
	const counterfactuals = comparisonModels.map((model) => {
		const catalogModel = findModel("gateway", model);
		if (!catalogModel) return { model, costUsd: 0, savedUsd: 0, available: false };

		let costUsd = 0;
		for (const usage of routedUsages) {
			costUsd += calculateCost(catalogModel, cloneUsage(usage)).total;
		}
		return { model, costUsd, savedUsd: costUsd - totalCostUsd, available: true };
	});

	return { requests, totalCostUsd, buckets, counterfactuals, unpriced };
}

/** Format a routing decision and its optional metadata as a plain-text trailer. */
export function formatRoutingTrailer(routing: RoutingInfo): string {
	const metadata = [routing.tier, routing.intent, routing.confidence?.toFixed(2)].filter(
		(part): part is string => part !== undefined,
	);
	const cost =
		routing.costUsd === undefined
			? ""
			: ` · ${routing.costSource === "estimate" ? "~" : ""}${formatUsd(routing.costUsd)}`;
	return `${routing.requestedModel} routed to ${routing.servedModel}${metadata.length > 0 ? ` (${metadata.join(" · ")})` : ""}${cost}`;
}

/** Format a USD amount without scientific notation. */
export function formatUsd(usd: number): string {
	if (usd === 0) return "$0";
	const sign = usd < 0 ? "-" : "";
	const absolute = Math.abs(usd);
	if (absolute < 0.01) {
		const fixed = absolute.toFixed(5).replace(/0+$/u, "").replace(/\.$/u, "");
		return `$${sign}${fixed || "0"}`;
	}
	return `$${sign}${absolute.toFixed(3)}`;
}
