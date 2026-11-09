/** Immutable, credential-blind models.json snapshot. */

import { readFile } from "node:fs/promises";
import { ProviderCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import {
	ModelCostSchema,
	ModelInputLimitsSchema,
	ModelInputModalitySchema,
	ModelPromptCacheSchema,
	ThinkingLevelMapSchema,
} from "@earendil-works/pi-ai/providers/model-schema";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";

// Keep the value permissive at the file boundary so an invalid soft ceiling can
// be dropped per-model without rejecting the rest of models.json. The composer
// validates that the value is a non-negative safe integer before it reaches Model.
const ModelCompactionSchema = Type.Object(
	{
		softCeilingTokens: Type.Optional(
			Type.Unknown({
				description:
					"Caps the context window this model's compaction thresholds use, in tokens; overrides the compaction.softCeilingTokens setting. A non-negative integer; 0 uses the raw window. Invalid values are ignored.",
			}),
		),
	},
	{ description: "Per-model compaction settings." },
);

const SamplingParamsSchema = Type.Record(Type.String(), Type.Unknown());
const SamplingParamsByThinkingLevelSchema = Type.Object(
	{
		off: Type.Optional(SamplingParamsSchema),
		minimal: Type.Optional(SamplingParamsSchema),
		low: Type.Optional(SamplingParamsSchema),
		medium: Type.Optional(SamplingParamsSchema),
		high: Type.Optional(SamplingParamsSchema),
		xhigh: Type.Optional(SamplingParamsSchema),
		max: Type.Optional(SamplingParamsSchema),
	},
	{ description: "samplingParams per thinking level, merged over samplingParams." },
);

const SamplingParamsFieldSchema = Type.Record(Type.String(), Type.Unknown(), {
	description: "Fields merged into every request body. Applies only to OpenAI-compatible APIs.",
});
const HeadersSchema = Type.Record(Type.String(), Type.String(), {
	description: "Request headers. Values resolve like apiKey.",
});

/** Model fields shared by models entries and modelOverrides entries. Defaults apply only to models entries. */
const ModelFieldDescriptions = {
	name: "Display name, also matched by --model patterns.",
	reasoning: "Whether the model supports thinking.",
	contextWindow: "Context window in tokens.",
	maxTokens: "Maximum output tokens.",
} as const;

const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Model ID sent to the API." }),
	name: Type.Optional(Type.String({ minLength: 1, description: ModelFieldDescriptions.name })),
	api: Type.Optional(Type.String({ minLength: 1, description: "Overrides the provider api." })),
	baseUrl: Type.Optional(Type.String({ minLength: 1, description: "Overrides the provider baseUrl." })),
	reasoning: Type.Optional(Type.Boolean({ default: false, description: ModelFieldDescriptions.reasoning })),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(ModelInputModalitySchema, { default: ["text"] })),
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	cost: Type.Optional(ModelCostSchema),
	compaction: Type.Optional(ModelCompactionSchema),
	promptCache: Type.Optional(ModelPromptCacheSchema),
	contextWindow: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, default: 128000, description: ModelFieldDescriptions.contextWindow }),
	),
	maxTokens: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, default: 16384, description: ModelFieldDescriptions.maxTokens }),
	),
	samplingParams: Type.Optional(SamplingParamsFieldSchema),
	samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
});

const ModelOverrideSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1, description: ModelFieldDescriptions.name })),
	/** phi: a model override may move a model to another API (e.g. a gateway alias onto openai-responses). */
	api: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean({ description: ModelFieldDescriptions.reasoning })),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(ModelInputModalitySchema)),
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	cost: Type.Optional(Type.Partial(ModelCostSchema)),
	promptCache: Type.Optional(ModelPromptCacheSchema),
	contextWindow: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.contextWindow }),
	),
	/** phi: per-model compaction ceiling. */
	compaction: Type.Optional(ModelCompactionSchema),
	maxTokens: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.maxTokens })),
	samplingParams: Type.Optional(SamplingParamsFieldSchema),
	samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
});

const ProviderConfigSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1, description: "Display name." })),
	baseUrl: Type.Optional(
		Type.String({ minLength: 1, description: "API base URL. Also applies to the provider's built-in models." }),
	),
	apiKey: Type.Optional(
		Type.String({
			minLength: 1,
			description: 'Literal key, "$NAME" environment interpolation, or "!command" output.',
		}),
	),
	api: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				'API for the provider\'s models, such as "openai-completions", "openai-responses", "anthropic-messages", or "google-generative-ai".',
		}),
	),
	oauth: Type.Optional(Type.Literal("radius", { description: "OAuth login flow. Requires baseUrl." })),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(
		Type.Boolean({ default: false, description: "Whether to send the resolved API key as Authorization: Bearer." }),
	),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ModelsConfigProperties = {
	providers: Type.Record(Type.String(), ProviderConfigSchema),
};

export const ModelsConfigSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	...ModelsConfigProperties,
});

/** Entry schemas rendered into docs/models-configuration.md. */
export const ModelsJsonSchemas = {
	provider: ProviderConfigSchema,
	model: ModelDefinitionSchema,
	modelOverride: ModelOverrideSchema,
};

const validateModelsConfig = Compile(ModelsConfigSchema);

export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/**
 * Merge one provider config over another, with `over` taking precedence. Scalar
 * fields from `over` replace `base`; `models` arrays concatenate with a later
 * definition of the same `id` replacing the earlier one; `modelOverrides` merge
 * by key. This is the per-provider half of the layered merge below.
 */
function mergeProviderConfig(base: ModelsJsonProvider, over: ModelsJsonProvider): ModelsJsonProvider {
	const merged: ModelsJsonProvider = { ...base, ...over };

	if (base.models || over.models) {
		const byId = new Map<string, ModelsJsonModel>();
		for (const model of [...(base.models ?? []), ...(over.models ?? [])]) byId.set(model.id, model);
		merged.models = [...byId.values()];
	}
	if (base.modelOverrides || over.modelOverrides) {
		merged.modelOverrides = { ...base.modelOverrides, ...over.modelOverrides };
	}
	if (base.headers || over.headers) {
		merged.headers = { ...base.headers, ...over.headers };
	}
	return merged;
}

/**
 * Merge a lower-precedence provider map with a higher-precedence one. A provider
 * present in both is merged field-by-field with the higher layer winning; a
 * provider present in only one is carried through unchanged.
 */
function mergeProviderMaps(
	lower: ReadonlyMap<string, ModelsJsonProvider>,
	higher: ReadonlyMap<string, ModelsJsonProvider>,
): Map<string, ModelsJsonProvider> {
	const merged = new Map<string, ModelsJsonProvider>(lower);
	for (const [providerId, provider] of higher) {
		const existing = merged.get(providerId);
		merged.set(providerId, existing ? mergeProviderConfig(existing, provider) : provider);
	}
	return merged;
}

/** One immutable load of models.json. */
export class ModelConfig {
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	private readonly error: string | undefined;

	private constructor(providers: ReadonlyMap<string, ModelsJsonProvider>, error?: string) {
		this.providers = providers;
		this.error = error;
	}

	static async load(modelsJsonPath: string | undefined): Promise<ModelConfig> {
		if (!modelsJsonPath) return new ModelConfig(new Map());
		const { providers, error } = await ModelConfig.loadProviderMap(modelsJsonPath);
		return new ModelConfig(providers, error);
	}

	/**
	 * Load and merge several models.json sources into one config. Sources are
	 * ordered lowest precedence first, highest last: a provider or field defined
	 * in a later source wins over an earlier one. phi uses this to layer enabled
	 * hub model bundles beneath the user's own `~/.pi/agent/models.json`, which is
	 * therefore always the final — highest precedence — source. The merge is
	 * deterministic in the order given, so multiple bundles compose predictably.
	 */
	static async loadLayered(modelsJsonPaths: readonly (string | undefined)[]): Promise<ModelConfig> {
		const paths = modelsJsonPaths.filter((path): path is string => Boolean(path));
		if (paths.length === 0) return new ModelConfig(new Map());
		if (paths.length === 1) return ModelConfig.load(paths[0]);

		let merged = new Map<string, ModelsJsonProvider>();
		const errors: string[] = [];
		for (const path of paths) {
			const { providers, error } = await ModelConfig.loadProviderMap(path);
			if (error) errors.push(error);
			merged = mergeProviderMaps(merged, providers);
		}
		return new ModelConfig(merged, errors.length > 0 ? errors.join("\n\n") : undefined);
	}

	private static async loadProviderMap(
		modelsJsonPath: string,
	): Promise<{ providers: Map<string, ModelsJsonProvider>; error?: string }> {
		const path = normalizePath(modelsJsonPath);
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: new Map() };
			return {
				providers: new Map(),
				error: `Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(stripBom(content)));
		} catch (error) {
			return {
				providers: new Map(),
				error: `Failed to parse models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			};
		}

		if (!validateModelsConfig.Check(parsed)) {
			const errors =
				validateModelsConfig
					.Errors(parsed)
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					.join("\n") || "Unknown schema error";
			return { providers: new Map(), error: `Invalid models.json schema:\n${errors}\n\nFile: ${path}` };
		}

		const providers = new Map<string, ModelsJsonProvider>();
		for (const [providerId, provider] of Object.entries(parsed.providers)) {
			providers.set(providerId, deepFreeze(structuredClone(provider)));
		}
		return { providers };
	}

	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return this.providers.get(providerId);
	}

	getProviderIds(): readonly string[] {
		return [...this.providers.keys()];
	}

	getError(): string | undefined {
		return this.error;
	}
}
