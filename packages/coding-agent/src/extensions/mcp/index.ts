import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import { type CachedCatalog, CatalogCache } from "./cache.ts";
import { connectServer, type McpClient } from "./client.ts";
import {
	type BridgeConfig,
	effectiveToolMode,
	loadBridgeConfig,
	resolveConfigPath,
	type ServerEntry,
	type ServerManifestEntry,
} from "./config.ts";
import { elicitForm } from "./elicitation.ts";
import { writeEnablement } from "./enablement.ts";
import { FINDER_TOOL_NAME, finderToolDefinition, registerToolFinder } from "./finder.ts";
import { errorMessage } from "./json.ts";
import { createMcpOAuthHostIntegration } from "./oauth/command-host.ts";
import type { McpOAuthHostIntegration } from "./oauth/host.ts";
import { McpError, type McpServerIdentity, type McpToolInfo } from "./protocol.ts";
import {
	type FinderCatalogEntry,
	type McpFinderRuntime,
	type McpServerRuntime,
	type ServerConnectionStatus,
	safeMcpError,
} from "./runtime.ts";
import { buildServerTools, type RegisteredTool, ToolNameRegistry } from "./tools.ts";
import { type McpDisplayStatus, type McpManagerController, type McpServerView, showMcpManager } from "./ui.ts";

type Reporter = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => void;

const MCP_STATUS_KEY = "mcp";
const MCP_LOADED_TOOL_ENTRY = "mcp_tool_loaded";
const DEFAULT_INSTRUCTIONS_WAIT_MS = 3_000;
const MAX_TIMER_MS = 2_147_483_647;

type PersistedLoadedTool = {
	serverName: string;
	toolName: string;
};

export interface McpProbeResult {
	name: string;
	status: "ready" | "failed";
	toolCount: number;
	error: string | null;
}

class ServerState implements McpServerRuntime {
	readonly serverName: string;
	readonly entry: ServerEntry;
	private readonly owner: McpManager;
	status: ServerConnectionStatus = "idle";
	catalog: McpToolInfo[] = [];
	identity: McpServerIdentity | undefined;
	error: string | undefined;
	client: McpClient | undefined;
	connectPromise: Promise<McpClient> | undefined;
	controller: AbortController | undefined;
	operation = 0;

	constructor(entry: ServerEntry, owner: McpManager) {
		this.entry = entry;
		this.owner = owner;
		this.serverName = entry.name;
	}

	ensureConnection(signal?: AbortSignal): Promise<McpClient> {
		return this.owner.ensureState(this, signal);
	}

	refreshCatalog(): Promise<void> {
		return this.owner.refreshState(this);
	}

	isToolLoaded(mcpName: string): boolean {
		return this.owner.isToolLoaded(this.serverName, mcpName);
	}

	markToolLoaded(mcpName: string): void {
		this.owner.markToolLoaded(this.serverName, mcpName, effectiveToolMode(this.entry, mcpName));
	}
}

export class McpManager implements McpFinderRuntime {
	private readonly states = new Map<string, ServerState>();
	private readonly registered = new Map<ServerState, RegisteredTool[]>();
	private readonly refreshes = new Map<ServerState, Promise<void>>();
	private readonly owned = new Set<string>();
	private readonly names = new ToolNameRegistry();
	private cache: CatalogCache | undefined;
	private epoch = 0;
	private closing = false;
	private finderRegistered = false;
	private reportContext: ExtensionContext | undefined;
	private report: Reporter = () => undefined;
	private announcedReadyEpoch = -1;
	private readonly pi: ExtensionAPI | undefined;
	private readonly listeners = new Set<() => void>();
	private oauthHost: McpOAuthHostIntegration | undefined;
	private manifest: readonly ServerManifestEntry[] = [];
	private currentConfigPath = "";
	private currentAgentDir = "";
	private currentConfigPresent = false;
	private currentDefaults: BridgeConfig["defaults"] | undefined;
	private projectOverrides = new Set<string>();
	private readonly loadedTools = new Set<string>();
	/** `eagerTools` names already reported as absent from a live catalogue this session. */
	private readonly warnedEagerTools = new Set<string>();
	private enablementChange: Promise<void> = Promise.resolve();

	constructor(pi: ExtensionAPI | undefined, agentDir: string) {
		this.pi = pi;
		this.currentAgentDir = agentDir;
	}

	get configPath(): string {
		return this.currentConfigPath;
	}

	getController(): McpManagerController {
		const manager = this;
		return {
			get configPath() {
				return manager.currentConfigPath;
			},
			getServers: () => manager.getServerViews(),
			reconnect: (serverName) => manager.reconnect(serverName),
			setEnabled: (serverName, enabled) => manager.setEnabled(serverName, enabled),
			subscribe: (listener) => manager.subscribe(listener),
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getServerViews(): readonly McpServerView[] {
		const active = new Map([...this.states.values()].map((state) => [state.serverName, state]));
		const activeTools = new Set(this.pi?.getActiveTools() ?? []);
		return this.manifest.map((manifest) => {
			const state = active.get(manifest.name);
			const tools = state?.catalog ?? [];
			const registered = state ? (this.registered.get(state) ?? []) : [];
			const loadedNames = new Set(
				registered.filter((tool) => activeTools.has(tool.name)).map((tool) => tool.mcpName),
			);
			const status: McpDisplayStatus = manifest.error
				? "invalid"
				: !manifest.enabled
					? "disabled"
					: (state?.status ?? "idle");
			return {
				name: manifest.name,
				enabled: manifest.enabled,
				status,
				transport: manifest.transport,
				toolMode: manifest.toolMode,
				eagerToolCount: manifest.eagerTools.length,
				injectInstructions: manifest.injectInstructions,
				toolCount: tools.length,
				loadedToolCount: loadedNames.size,
				identity: state?.identity?.serverName,
				protocolVersion: state?.identity?.protocolVersion,
				// state.error was sanitized when it was set; re-running it would blank every OAuth reason.
				error: manifest.error ?? state?.error,
				tools: tools.map((tool) => ({
					name: tool.name,
					description: tool.description ?? "",
					loaded: loadedNames.has(tool.name),
				})),
			};
		});
	}

	get currentEpoch(): number {
		return this.epoch;
	}

	/** Connect a bounded, isolated set of entries without creating an agent session. */
	async probe(entries: readonly ServerEntry[], timeoutMs?: number): Promise<McpProbeResult[]> {
		await this.stop();
		this.epoch++;
		this.closing = false;
		for (const entry of entries) this.states.set(entry.name, new ServerState(entry, this));
		const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
		try {
			return await Promise.all(
				[...this.states.values()].map(async (state): Promise<McpProbeResult> => {
					try {
						const client = await state.ensureConnection(signal);
						return { name: state.serverName, status: "ready", toolCount: client.tools.length, error: null };
					} catch (error) {
						return {
							name: state.serverName,
							status: "failed",
							toolCount: 0,
							error: safeMcpError(error, state.entry.config),
						};
					}
				}),
			);
		} finally {
			await this.stop();
		}
	}

	getServers(): readonly McpServerRuntime[] {
		return [...this.states.values()];
	}

	getCatalogEntries(): readonly FinderCatalogEntry[] {
		const entries: FinderCatalogEntry[] = [];
		for (const state of this.states.values()) {
			for (const tool of this.registered.get(state) ?? []) entries.push(tool);
		}
		return entries;
	}

	/**
	 * Server names only. This text lands in the finder's tool description, which is part of the
	 * cached prompt prefix: live tool counts or connection states change mid-run ("113 tools" →
	 * "116") and would invalidate the prompt cache on every provider.
	 */
	describeInventory(): string {
		const names = [...this.states.values()].map((state) => state.serverName);
		return names.length > 0 ? names.join(", ") : "nothing";
	}

	async reconnect(serverName: string): Promise<void> {
		const manifest = this.findManifest(serverName);
		if (!manifest) throw new Error(`No configured MCP server named "${serverName}".`);
		if (manifest.error) throw new Error(`MCP server "${manifest.name}" is invalid: ${manifest.error}`);
		if (!manifest.enabled) throw new Error(`MCP server "${manifest.name}" is disabled.`);
		const state = this.states.get(manifest.name);
		if (!state) throw new Error(`MCP server "${manifest.name}" is not active.`);
		await this.refreshState(state);
	}

	setEnabled(serverName: string, enabled: boolean): Promise<void> {
		const operation = this.enablementChange.then(async () => {
			const manifest = this.findManifest(serverName);
			if (!manifest) throw new Error(`No configured MCP server named "${serverName}".`);
			if (!this.currentAgentDir || !this.currentConfigPath) throw new Error("MCP configuration is not loaded.");
			const context = this.reportContext;
			if (!context) throw new Error("MCP session is not active.");
			const project = { cwd: context.cwd, trusted: context.isProjectTrusted() };
			// A project may add an overlay after session start. Do not write a global
			// sidecar choice that a newly added project selection already overrides.
			const current = await loadBridgeConfig(this.currentAgentDir, project);
			if (this.projectOverrides.has(manifest.name) || current.projectOverrides.includes(manifest.name)) {
				throw new Error(
					`MCP server "${manifest.name}" is selected by the project .pi/mcp.json; edit that file instead.`,
				);
			}
			await writeEnablement(
				this.currentAgentDir,
				this.currentConfigPath,
				manifest.name,
				manifest.fingerprint,
				enabled,
			);
			const config = await loadBridgeConfig(this.currentAgentDir, project);
			await this.beginSession(config, context);
			const updated = this.findManifest(manifest.name);
			if (enabled && (!updated?.enabled || updated.error)) {
				throw new Error(updated?.error ?? `MCP server "${manifest.name}" could not be enabled.`);
			}
		});
		this.enablementChange = operation.catch(() => undefined);
		return operation;
	}

	private findManifest(serverName: string): ServerManifestEntry | undefined {
		return this.manifest.find((entry) => entry.name.toLowerCase() === serverName.toLowerCase());
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A view subscriber must never interfere with the MCP runtime.
			}
		}
	}

	async beginSession(config: BridgeConfig, ctx: ExtensionContext): Promise<void> {
		await this.stop();
		this.epoch++;
		this.currentConfigPath = config.path;
		this.currentConfigPresent = config.present;
		this.oauthHost = createMcpOAuthHostIntegration();
		this.currentDefaults = config.defaults;
		this.projectOverrides = new Set(config.projectOverrides);
		this.manifest = config.manifest;
		this.emit();
		this.closing = false;
		this.reportContext = ctx;
		this.restoreLoadedTools(ctx);
		this.report = report;
		this.announcedReadyEpoch = -1;
		this.warnedEagerTools.clear();
		this.cache = undefined;
		this.states.clear();
		this.registered.clear();

		for (const entry of config.servers) this.states.set(entry.name, new ServerState(entry, this));
		this.emit();
		this.names.setServerNames([...this.states.keys()]);
		if (this.states.size === 0) return;

		// Register before touching the network or waiting on the cache. The finder
		// exists while every background handshake is still in flight.
		if (!this.finderRegistered && this.pi) {
			registerToolFinder(this.pi, this);
			this.finderRegistered = true;
		}
		this.owned.add(FINDER_TOOL_NAME);
		this.reconcile();

		const cache = await CatalogCache.open(this.currentAgentDir);
		if (!this.isLive(this.epoch)) return;
		this.cache = cache;
		for (const state of this.states.values()) {
			const cached = cache.get(state.serverName, state.entry.fingerprint);
			if (!cached) continue;
			state.catalog = cached.tools;
			state.identity = cached.identity;
			state.status = "cached";
		}
		this.reconcile();

		for (const state of this.states.values()) {
			// Every connection starts in parallel. The explicit rejection handler is
			// important: background failures must not become unhandled rejections.
			void state.ensureConnection().catch((error: unknown) => {
				if (this.isCurrentState(state)) this.noteFailure(state, error);
			});
		}
	}

	async stop(): Promise<void> {
		this.reportContext?.ui.setStatus(MCP_STATUS_KEY, undefined);
		this.closing = true;
		this.epoch++;
		const states = [...this.states.values()];
		this.states.clear();
		this.registered.clear();
		for (const state of states) {
			state.status = "closed";
			state.operation++;
			state.controller?.abort();
			// Closing stdio children can take seconds, and OAuth recovery may not
			// settle on abort. Neither may hold up a session switch. The connection
			// continuation closes a client even if it arrives after this stop.
			void (async () => {
				await state.connectPromise?.catch(() => undefined);
				await state.client?.close().catch(() => undefined);
				state.client = undefined;
				state.connectPromise = undefined;
			})().catch(() => undefined);
		}
		const cache = this.cache;
		if (cache) await cache.flush().catch(() => undefined);
		this.cache = undefined;
		this.reportContext = undefined;
		this.report = () => undefined;
		this.oauthHost = undefined;
		this.manifest = [];
		this.currentDefaults = undefined;
		this.reconcile();
		this.emit();
	}

	async ensureServer(serverName: string): Promise<McpServerRuntime> {
		const state = [...this.states.values()].find(
			(entry) => entry.serverName.toLowerCase() === serverName.toLowerCase(),
		);
		if (!state) throw new Error(`No bridged server named "${serverName}".`);
		await state.ensureConnection();
		return state;
	}

	ensureState(state: ServerState, signal?: AbortSignal): Promise<McpClient> {
		if (!this.isCurrentState(state))
			return Promise.reject(new McpError(`MCP server ${state.serverName} is not active.`));
		if (state.client) return awaitSignal(Promise.resolve(state.client), signal);
		const promise = state.connectPromise ?? this.startConnection(state);
		return awaitSignal(promise, signal);
	}

	refreshState(state: ServerState): Promise<void> {
		if (!this.isCurrentState(state)) return Promise.resolve();
		const existing = this.refreshes.get(state);
		if (existing) return existing;
		const refresh = this.doRefresh(state);
		this.refreshes.set(state, refresh);
		void refresh.then(
			() => this.clearRefresh(state, refresh),
			() => this.clearRefresh(state, refresh),
		);
		return refresh;
	}

	private async doRefresh(state: ServerState): Promise<void> {
		if (!this.isCurrentState(state)) return;
		const pending = state.connectPromise;
		if (pending) {
			await pending.catch(() => undefined);
			this.clearConnectionPromise(state, pending);
		}
		if (!this.isCurrentState(state)) return;
		const oldClient = state.client;
		state.client = undefined;
		state.catalog = [];
		state.status = "idle";
		state.error = undefined;
		state.operation++;
		this.reconcile();
		const cache = this.cache;
		if (cache) await cache.remove(state.serverName).catch(() => undefined);
		if (oldClient) await oldClient.close().catch(() => undefined);
		await this.startConnection(state);
	}

	private clearRefresh(state: ServerState, refresh: Promise<void>): void {
		if (this.refreshes.get(state) === refresh) this.refreshes.delete(state);
	}

	async awaitInstructions(): Promise<void> {
		const waits = [...this.states.values()]
			// A cached identity with no instructions is still authoritative: the
			// server returned no instructions when that catalog was recorded. Only
			// wait when no cached/live identity exists at all.
			// Lazy servers' instructions arrive with their first loaded tools,
			// so the first turn never waits on their handshakes, unless the server
			// lists `eagerTools`: those put its instructions in the first prompt.
			.filter(
				(state) =>
					state.entry.injectInstructions &&
					(state.entry.toolMode !== "lazy" || state.entry.eagerTools.length > 0) &&
					!state.identity,
			)
			.map((state) => state.ensureConnection().catch(() => undefined));
		if (waits.length === 0) return;
		const configured = process.env.PHI_MCP_INSTRUCTIONS_WAIT_MS;
		const parsed = configured === undefined || configured.trim() === "" ? NaN : Number(configured);
		const deadlineMs =
			Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_TIMER_MS ? parsed : DEFAULT_INSTRUCTIONS_WAIT_MS;
		if (deadlineMs === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.all(waits),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, deadlineMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	buildInstructionsBlock(): string | undefined {
		const sections: string[] = [];
		for (const state of this.states.values()) {
			// A lazy server's instructions first arrive with the finder result that
			// loads one of its tools, then join the system prompt from the next turn
			// so pruning or compaction of that result cannot lose them. A lazy server
			// whose `eagerTools` are already in the tool list has no finder result to
			// carry them, so its instructions are in the prompt from the first turn.
			if (!state.entry.injectInstructions) continue;
			const preloaded =
				state.entry.toolMode === "lazy"
					? (this.registered.get(state) ?? []).filter((tool) => tool.toolMode === "eager")
					: [];
			if (
				state.entry.toolMode === "lazy" &&
				preloaded.length === 0 &&
				!state.catalog.some((tool) => this.isToolLoaded(state.serverName, tool.name))
			)
				continue;
			const instructions = state.identity?.instructions?.trim();
			if (!instructions) continue;
			// Worded to stay true as more tools load, so the prompt prefix stays stable.
			const heading =
				preloaded.length > 0
					? `### ${state.serverName}\n\n_Already in your tool list: ${preloaded.map((tool) => `\`${tool.name}\``).join(", ")}. Call \`${FINDER_TOOL_NAME}\` to load its other tools._`
					: `### ${state.serverName}`;
			sections.push(`${heading}\n\n${instructions}`);
		}
		if (sections.length === 0) return undefined;
		return [
			"## MCP server instructions",
			"",
			"These servers are bridged into this session; their tools are named `mcp_<server>_<tool>`.",
			"",
			sections.join("\n\n"),
		].join("\n");
	}

	formatStatus(configPath: string, defaults: BridgeConfig["defaults"] | undefined): string {
		const lines = [`config: ${this.currentConfigPresent ? configPath : "not found"}`];
		const effectiveDefaults = this.currentDefaults ?? defaults;
		if (effectiveDefaults)
			lines.push(
				`defaults: toolMode ${effectiveDefaults.toolMode}, injectInstructions ${effectiveDefaults.injectInstructions}`,
			);
		if (this.manifest.length === 0) {
			lines.push("no MCP servers configured");
			return lines.join("\n");
		}
		const active = new Set(this.pi?.getActiveTools() ?? []);
		for (const manifest of this.manifest) {
			const state = this.states.get(manifest.name);
			if (manifest.error) {
				lines.push(`✗ ${manifest.name} — invalid — 0 tools — ${toolModeLabel(manifest)}, 0/0 loaded`);
				lines.push(`    error: ${manifest.error}`);
				continue;
			}
			if (!manifest.enabled || !state) {
				lines.push(`– ${manifest.name} — disabled — 0 tools — ${toolModeLabel(manifest)}, 0/0 loaded`);
				continue;
			}
			const tools = this.registered.get(state) ?? [];
			const loaded = `${tools.filter((tool) => active.has(tool.name)).length}/${tools.length} loaded`;
			const identity = state.identity;
			lines.push(
				`${state.status === "ready" || state.status === "cached" ? "✓" : "✗"} ${state.serverName} — ${state.status} — ${tools.length} tools — ${toolModeLabel(state.entry)}, ${loaded}${
					identity
						? ` — ${identity.serverName ?? "unknown"} ${identity.serverVersion ?? ""} (MCP ${identity.protocolVersion})`
						: ""
				}`,
			);
			if (!state.entry.injectInstructions && identity?.instructions)
				lines.push("    instructions withheld (injectInstructions: false)");
			if (state.error) lines.push(`    error: ${state.error}`);
			const listed = tools.filter((tool) => active.has(tool.name));
			lines.push(listed.length > 0 ? `    ${listed.map((tool) => tool.name).join(", ")}` : "    (none loaded yet)");
		}
		return lines.join("\n");
	}

	private startConnection(state: ServerState): Promise<McpClient> {
		if (!this.isCurrentState(state))
			return Promise.reject(new McpError(`MCP server ${state.serverName} is not active.`));
		if (state.client) return Promise.resolve(state.client);
		if (state.connectPromise) return state.connectPromise;

		const epoch = this.epoch;
		const operation = ++state.operation;
		const controller = new AbortController();
		state.controller = controller;
		state.status = "connecting";
		state.error = undefined;
		this.emit();
		const promise = connectServer(state.serverName, state.entry.config, controller.signal, {
			// OAuth and elicitation both have to be visible to the human.
			notice: (message, level) => this.report(this.reportContext as ExtensionContext, message, level),
			elicit: async (params) => {
				const context = this.reportContext;
				return elicitForm(
					params,
					context
						? {
								hasUI: context.hasUI,
								select: (title, options) => context.ui.select(title, options),
								input: (title, placeholder) => context.ui.input(title, placeholder),
								notify: (message, type) => context.ui.notify(message, type),
							}
						: undefined,
				);
			},
			oauthHost: this.oauthHost,
		})
			.then(async (client) => {
				if (!this.isCurrent(state, epoch, operation)) {
					await client.close().catch(() => undefined);
					throw new McpError(`MCP server ${state.serverName} connection was superseded.`);
				}
				state.client = client;
				state.identity = client.identity;
				state.catalog = client.tools;
				state.status = "ready";
				state.error = undefined;
				this.reconcile();
				const cache = this.cache;
				if (cache) {
					const record: CachedCatalog = {
						serverName: state.serverName,
						fingerprint: state.entry.fingerprint,
						timestamp: Date.now(),
						identity: client.identity,
						tools: client.tools,
					};
					void cache.put(record).catch(() => undefined);
				}
				return client;
			})
			.catch((error: unknown) => {
				if (this.isCurrent(state, epoch, operation)) {
					state.status = "failed";
					state.error = safeMcpError(error, state.entry.config);
					this.reconcile();
				}
				throw error;
			});
		state.connectPromise = promise;
		// Attach a terminal observer without changing the promise callers await.
		void promise.then(
			() => this.clearConnectionPromise(state, promise),
			() => this.clearConnectionPromise(state, promise),
		);
		return promise;
	}

	private clearConnectionPromise(state: ServerState, promise: Promise<McpClient>): void {
		if (state.connectPromise === promise) {
			state.connectPromise = undefined;
			state.controller = undefined;
		}
	}

	private noteFailure(state: ServerState, error: unknown): void {
		state.error = safeMcpError(error, state.entry.config);
		this.emit();
		this.report(
			this.reportContext as ExtensionContext,
			`mcp: ${state.serverName} unavailable — ${state.error}`,
			"warning",
		);
	}

	private reconcile(): void {
		try {
			const pi = this.pi;
			if (!pi) {
				this.emit();
				return;
			}
			const definitions: ToolDefinition<any, any, any>[] = [];
			// The finder's description lists the unloaded inventory, so it is refreshed
			// with the catalogue, in the same batch.
			if (this.finderRegistered && this.states.size > 0) definitions.push(finderToolDefinition(pi, this));
			const usedNames = new Set(
				pi
					.getAllTools()
					.map((tool) => tool.name)
					.filter((name) => !this.owned.has(name)),
			);
			usedNames.add(FINDER_TOOL_NAME);
			for (const state of this.states.values()) {
				const tools = buildServerTools(state, state.catalog, usedNames, this.names, definitions);
				this.registered.set(state, tools);
				for (const tool of tools) this.owned.add(tool.name);
				this.warnUnknownEagerTools(state);
			}
			// One registry refresh for the whole catalogue; see buildServerTools.
			pi.registerTools(definitions);
			this.applyToolModes();
			this.updateConnectionStatus();
			this.emit();
		} catch (error) {
			// A stale extension runtime can reject registrations during teardown. It
			// must not turn a late background handshake into an unhandled rejection.
			if (!this.closing) console.error(`mcp: could not register catalogue — ${errorMessage(error)}`);
		}
	}

	/** Only a live catalogue is authoritative; a cached one may predate a server upgrade. */
	private warnUnknownEagerTools(state: ServerState): void {
		if (state.status !== "ready" || state.entry.eagerTools.length === 0) return;
		const known = new Set(state.catalog.map((tool) => tool.name));
		const unknown = state.entry.eagerTools.filter(
			(name) => !known.has(name) && !this.warnedEagerTools.has(this.toolKey(state.serverName, name)),
		);
		if (unknown.length === 0) return;
		for (const name of unknown) this.warnedEagerTools.add(this.toolKey(state.serverName, name));
		this.report(
			this.reportContext as ExtensionContext,
			`mcp: ${state.serverName} "eagerTools" names unknown tool(s): ${unknown.join(", ")}`,
			"warning",
		);
	}

	private updateConnectionStatus(): void {
		const ctx = this.reportContext;
		if (!ctx || this.states.size === 0 || this.closing) return;

		const states = [...this.states.values()];
		const total = states.length;
		const connected = states.filter((state) => state.status === "ready").length;
		const failed = states.filter((state) => state.status === "failed").length;
		const pending = total - connected - failed;

		if (pending > 0) {
			const unavailable = failed > 0 ? ` · ${failed} unavailable` : "";
			ctx.ui.setStatus(MCP_STATUS_KEY, `MCP ${connected}/${total} connected${unavailable} · connecting…`);
			return;
		}

		if (this.announcedReadyEpoch === this.epoch) return;
		this.announcedReadyEpoch = this.epoch;
		const tools = states
			.filter((state) => state.status === "ready")
			.reduce((sum, state) => sum + state.catalog.length, 0);
		const serverLabel = total === 1 ? "server" : "servers";
		const toolLabel = tools === 1 ? "tool" : "tools";

		if (failed === 0) {
			ctx.ui.setStatus(MCP_STATUS_KEY, `✓ MCP ${connected}/${total} connected`);
			this.report(ctx, `✓ MCP connected — ${connected} ${serverLabel}, ${tools} ${toolLabel} ready`, "info");
			return;
		}

		ctx.ui.setStatus(MCP_STATUS_KEY, `⚠ MCP ${connected}/${total} connected · ${failed} unavailable`);
		if (connected === 0) {
			this.report(ctx, `MCP unavailable — all ${total} ${serverLabel} failed; run /mcp for details`, "warning");
			return;
		}
		this.report(
			ctx,
			`MCP ready — ${connected}/${total} ${serverLabel} connected, ${failed} unavailable, ${tools} ${toolLabel} ready; run /mcp for details`,
			"warning",
		);
	}

	private restoreLoadedTools(ctx: ExtensionContext): void {
		this.loadedTools.clear();
		const branch = ctx.sessionManager.getBranch?.() ?? [];
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== MCP_LOADED_TOOL_ENTRY) continue;
			const data = entry.data;
			if (!data || typeof data !== "object") continue;
			const persisted = data as Partial<PersistedLoadedTool>;
			if (typeof persisted.serverName !== "string" || typeof persisted.toolName !== "string") continue;
			this.loadedTools.add(this.toolKey(persisted.serverName, persisted.toolName));
		}
	}

	markToolLoaded(entryOrServerName: FinderCatalogEntry | string, toolName?: string, toolMode = "lazy"): void {
		const serverName = typeof entryOrServerName === "string" ? entryOrServerName : entryOrServerName.serverName;
		const mcpName = typeof entryOrServerName === "string" ? toolName : entryOrServerName.mcpName;
		const mode = typeof entryOrServerName === "string" ? toolMode : entryOrServerName.toolMode;
		if (!mcpName || mode !== "lazy") return;
		const key = this.toolKey(serverName, mcpName);
		if (!this.loadedTools.has(key)) {
			this.loadedTools.add(key);
			try {
				this.pi?.appendEntry(MCP_LOADED_TOOL_ENTRY, {
					serverName,
					toolName: mcpName,
				} satisfies PersistedLoadedTool);
			} catch {
				// Persistence is best effort; a stale extension context must not block the MCP call.
			}
		}
		const projected = [...this.registered.values()]
			.flat()
			.find((tool) => tool.serverName === serverName && tool.mcpName === mcpName);
		if (projected && this.pi) {
			const active = this.pi.getActiveTools();
			if (!active.includes(projected.name)) this.pi.setActiveTools([...active, projected.name]);
		}
	}

	isToolLoaded(serverName: string, toolName: string): boolean {
		return this.loadedTools.has(this.toolKey(serverName, toolName));
	}

	/** Rebuild lazy-tool enablement from the current session-manager branch. */
	syncLoadedTools(ctx: ExtensionContext): void {
		this.restoreLoadedTools(ctx);
		this.applyToolModes();
	}

	private toolKey(serverName: string, toolName: string): string {
		return `${serverName}\u0000${toolName}`;
	}

	private applyToolModes(): void {
		const pi = this.pi;
		if (!pi) return;
		const eager = new Set<string>();
		if (this.finderRegistered && this.states.size > 0) eager.add(FINDER_TOOL_NAME);
		for (const state of this.states.values()) {
			for (const tool of this.registered.get(state) ?? []) {
				if (tool.toolMode === "eager" || this.loadedTools.has(this.toolKey(tool.serverName, tool.mcpName))) {
					eager.add(tool.name);
				}
			}
		}
		const withhold = new Set([...this.owned].filter((name) => !eager.has(name)));
		const active = pi.getActiveTools();
		const next = active.filter((name) => !withhold.has(name));
		for (const name of eager) {
			if (!next.includes(name)) next.push(name);
		}
		if (next.length !== active.length || next.some((name, index) => name !== active[index])) pi.setActiveTools(next);
	}

	private isLive(epoch: number): boolean {
		return !this.closing && this.epoch === epoch;
	}

	private isCurrentState(state: ServerState): boolean {
		return this.isLive(this.epoch) && this.states.get(state.serverName) === state;
	}

	private isCurrent(state: ServerState, epoch: number, operation: number): boolean {
		return this.isLive(epoch) && this.states.get(state.serverName) === state && state.operation === operation;
	}
}

export default function mcpExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const manager = new McpManager(pi, agentDir);
	let configPath = resolveConfigPath(agentDir);
	let configDefaults: BridgeConfig["defaults"] | undefined;
	let firstAgentStartEpoch = -1;
	const controller = manager.getController();

	pi.on("session_start", async (_event, ctx) => {
		firstAgentStartEpoch = -1;
		let config: BridgeConfig;
		try {
			config = await loadBridgeConfig(agentDir, { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
		} catch (error) {
			report(ctx, `mcp: ${errorMessage(error)}`, "error");
			await manager.stop();
			return;
		}
		configPath = config.path;
		configDefaults = config.defaults;
		for (const warning of config.warnings) report(ctx, `mcp: ${warning}`, "warning");
		if (config.present && config.manifest.length > 0) {
			if (config.servers.length > 0) {
				const serverLabel = config.servers.length === 1 ? "server" : "servers";
				report(ctx, `mcp: connecting ${config.servers.length} ${serverLabel} in the background`, "info");
			}
		}
		await manager.beginSession(config, ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		manager.syncLoadedTools(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (firstAgentStartEpoch !== manager.currentEpoch) {
			firstAgentStartEpoch = manager.currentEpoch;
			await manager.awaitInstructions();
		}
		const instructions = manager.buildInstructionsBlock();
		if (!instructions) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
	});

	pi.on("session_shutdown", async () => {
		await manager.stop();
	});

	pi.registerCommand("mcp", {
		description: "Manage native MCP servers",
		getArgumentCompletions: (prefix) => completeMcpCommand(prefix, manager.getServerViews()),
		handler: async (args, ctx) => {
			const tokens = splitCommandArgs(args);
			if (tokens.length === 0) {
				if (ctx.mode === "tui") {
					await showMcpManager(ctx, controller);
					return;
				}
				ctx.ui.notify(manager.formatStatus(configPath, configDefaults), "info");
				return;
			}

			const [rawVerb, target, ...extra] = tokens;
			const verb = rawVerb?.toLowerCase();
			if (verb === "status" && !target) {
				ctx.ui.notify(manager.formatStatus(configPath, configDefaults), "info");
				return;
			}
			if (verb !== "reconnect" && verb !== "enable" && verb !== "disable") {
				ctx.ui.notify(MCP_USAGE, "warning");
				return;
			}
			if (extra.length > 0 || target === "status") {
				ctx.ui.notify(MCP_USAGE, "warning");
				return;
			}

			const views = manager.getServerViews();
			const targetName = target ?? "all";
			const targets = targetName.toLowerCase() === "all" ? views.map((server) => server.name) : [targetName];
			if (targets.length === 0) {
				ctx.ui.notify("No MCP servers are configured.", "warning");
				return;
			}
			const failures: string[] = [];
			let succeeded = 0;
			for (const name of targets) {
				try {
					if (verb === "reconnect") await controller.reconnect(name);
					else await controller.setEnabled(name, verb === "enable");
					succeeded++;
				} catch (error) {
					failures.push(`${name}: ${safeMcpError(error)}`);
				}
			}
			const action = verb === "reconnect" ? "reconnected" : verb === "enable" ? "enabled" : "disabled";
			const messages: string[] = [];
			if (succeeded > 0) messages.push(`MCP ${action} ${succeeded} server${succeeded === 1 ? "" : "s"}.`);
			if (failures.length > 0) messages.push(`MCP ${verb} failed:\n${failures.join("\n")}`);
			ctx.ui.notify(messages.join("\n") || `MCP ${verb} made no changes.`, failures.length > 0 ? "warning" : "info");
		},
	});
}

const MCP_USAGE = [
	"Usage: /mcp [status | reconnect [server|all] | enable [server|all] | disable [server|all]]",
	"Omit the target to apply an action to all configured servers.",
].join("\n");

function toolModeLabel(entry: Pick<ServerEntry, "toolMode" | "eagerTools">): string {
	return entry.eagerTools.length > 0 ? `${entry.toolMode} + ${entry.eagerTools.length} eager` : entry.toolMode;
}

function splitCommandArgs(args: string): string[] {
	return args
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((token) => (token.toLowerCase() === "all" ? "all" : token));
}

function completeMcpCommand(prefix: string, servers: readonly McpServerView[]) {
	const normalized = prefix.trimStart();
	const trailingSpace = /\s$/.test(prefix);
	const tokens = normalized.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
		const current = tokens[0] ?? "";
		return ["status", "reconnect", "enable", "disable"]
			.filter((value) => value.startsWith(current))
			.map((value) => ({ value, label: value }));
	}
	const verb = tokens[0];
	if (verb !== "reconnect" && verb !== "enable" && verb !== "disable") return null;
	const current = trailingSpace ? "" : (tokens[1] ?? "");
	return ["all", ...servers.map((server) => server.name)]
		.filter((value, index, values) => values.indexOf(value) === index)
		.filter((value) => value.toLowerCase().startsWith(current.toLowerCase()))
		.map((value) => ({ value: `${verb} ${value}`, label: value }));
}

function awaitSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new McpError("MCP request was cancelled."));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new McpError("MCP request was cancelled."));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** notify is harmless without a UI; stderr avoids corrupting print-mode stdout. */
function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	if (level !== "info") console.error(message);
}

export const __testing = {
	CatalogCache,
	awaitSignal,
};
