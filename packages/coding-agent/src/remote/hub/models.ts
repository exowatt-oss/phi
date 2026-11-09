/**
 * The hub's own view of the models phi can use on this machine: answers `models.list` without a
 * `sessionId` (the app's new-thread screen) and validates `session.spawn`'s model. Built exactly
 * like a session's registry (auth.json, models.json, enabled model bundles) but without network
 * refreshes or extensions, so extension-registered providers only appear inside sessions.
 */

import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { enabledModelBundlePaths } from "../../extensions/hub/model-bundles.ts";
import type { ModelInfo, ModelsPayload } from "../protocol.ts";

export interface ModelCatalog {
	/** Available models with the user's defaults. */
	list(): Promise<ModelsPayload>;
	/** Whether `provider/modelId` (or `modelId` under any provider) is an available model. */
	has(provider: string | undefined, modelId: string | undefined): Promise<boolean>;
}

const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CACHE_MS = 60_000;

export class PhiModelCatalog implements ModelCatalog {
	private runtime: { at: number; value: Promise<ModelRuntime> } | undefined;
	private readonly agentDir: string;
	private readonly home: string;

	constructor(home: string, agentDir = getAgentDir()) {
		this.home = home;
		this.agentDir = agentDir;
	}

	private getRuntime(): Promise<ModelRuntime> {
		const now = Date.now();
		if (!this.runtime || now - this.runtime.at > CACHE_MS) {
			const agentDir = this.agentDir;
			const value = ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
				modelLayerPathsResolver: () => enabledModelBundlePaths(agentDir),
				allowModelNetwork: false,
			});
			value.catch(() => {
				if (this.runtime?.value === value) this.runtime = undefined;
			});
			this.runtime = { at: now, value };
		}
		return this.runtime.value;
	}

	async list(): Promise<ModelsPayload> {
		const runtime = await this.getRuntime();
		const available = [...(await runtime.getAvailable())].sort(
			(a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
		);
		const models: ModelInfo[] = available.map((m) => ({
			provider: m.provider,
			id: m.id,
			name: m.name || m.id,
			reasoning: Boolean(m.reasoning),
		}));
		let defaultProvider: string | undefined;
		let defaultModel: string | undefined;
		let thinkingLevel: string | undefined;
		try {
			const settings = SettingsManager.create(this.home, this.agentDir, { projectTrusted: false });
			defaultProvider = settings.getDefaultProvider();
			defaultModel = settings.getDefaultModel();
			thinkingLevel = settings.getDefaultThinkingLevel();
		} catch {
			// settings unreadable: no defaults
		}
		const current =
			defaultProvider && defaultModel
				? available.find((m) => m.provider === defaultProvider && m.id === defaultModel)
				: undefined;
		const thinkingLevels = current
			? (getSupportedThinkingLevels(current) as string[])
			: ALL_THINKING_LEVELS.slice(0, 5);
		return {
			models,
			...(current ? { current: { provider: current.provider, id: current.id } } : {}),
			...(thinkingLevel ? { thinkingLevel: current && !current.reasoning ? "off" : thinkingLevel } : {}),
			thinkingLevels,
		};
	}

	async has(provider: string | undefined, modelId: string | undefined): Promise<boolean> {
		const runtime = await this.getRuntime();
		const available = await runtime.getAvailable();
		if (provider && modelId) return available.some((m) => m.provider === provider && m.id === modelId);
		if (modelId) return available.some((m) => m.id === modelId || `${m.provider}/${m.id}` === modelId);
		if (provider) return available.some((m) => m.provider === provider);
		return true;
	}
}
