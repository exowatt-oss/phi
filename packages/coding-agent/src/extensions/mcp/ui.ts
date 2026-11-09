import {
	type Component,
	Container,
	type Focusable,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolMode } from "./config.ts";
import type { ServerConnectionStatus } from "./runtime.ts";

export type McpDisplayStatus = ServerConnectionStatus | "disabled" | "invalid";

export interface McpToolView {
	name: string;
	description: string;
	loaded: boolean;
}

export interface McpServerView {
	name: string;
	enabled: boolean;
	status: McpDisplayStatus;
	transport: "http" | "stdio" | "unknown";
	toolMode: ToolMode;
	/** Tools a lazy server lists in `eagerTools`; absent or 0 means none. */
	eagerToolCount?: number;
	injectInstructions: boolean;
	toolCount: number;
	loadedToolCount: number;
	identity?: string;
	protocolVersion?: string;
	error?: string;
	tools: readonly McpToolView[];
}

export interface McpManagerController {
	readonly configPath: string;
	getServers(): readonly McpServerView[];
	reconnect(serverName: string): Promise<void>;
	setEnabled(serverName: string, enabled: boolean): Promise<void>;
	subscribe(listener: () => void): () => void;
}

type Screen =
	| { kind: "servers" }
	| { kind: "server"; serverName: string }
	| { kind: "tools"; serverName: string }
	| { kind: "tool"; serverName: string; toolName: string };

type Action = "view-tools" | "reconnect" | "enable" | "disable" | "back";
type Operation = "Reconnecting" | "Enabling" | "Disabling";

const MAX_SERVER_NAME = 120;
const MAX_TOOL_NAME = 240;
const MAX_DESCRIPTION = 480;
const MAX_IDENTITY = 200;
const MAX_PROTOCOL = 100;
const MAX_ERROR = 360;
const MAX_PATH = 240;
const MAX_TOOLS = 1_000;

function truncateText(value: string, max: number): string {
	if (value.length <= max) return value;
	if (max <= 1) return "…".slice(0, max);
	return `${value.slice(0, max - 1)}…`;
}

/** Remove terminal controls before any remote-controlled value reaches a component. */
function sanitize(value: string | undefined, max: number, multiline = false): string {
	if (value === undefined) return "";
	let output = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code === 10 && multiline) {
			output += character;
		} else if (code < 32 || code === 127 || (code >= 128 && code <= 159)) {
		} else {
			output += character;
		}
	}
	if (!multiline) output = output.replace(/\s+/gu, " ").trim();
	else output = output.replace(/\n{3,}/gu, "\n\n").trim();
	return truncateText(output, max);
}

function safeLine(value: string | undefined, max: number, fallback: string): string {
	const sanitized = sanitize(value, max);
	return sanitized || fallback;
}

function normalizeStatus(status: McpDisplayStatus): McpDisplayStatus {
	if (
		status === "idle" ||
		status === "cached" ||
		status === "connecting" ||
		status === "ready" ||
		status === "failed" ||
		status === "closed" ||
		status === "disabled" ||
		status === "invalid"
	)
		return status;
	return "invalid";
}

function normalizeServers(servers: readonly McpServerView[]): McpServerView[] {
	return servers.map((server) => {
		const tools = server.tools.slice(0, MAX_TOOLS).map((tool) => ({
			name: safeLine(tool.name, MAX_TOOL_NAME, "(unnamed tool)"),
			description: sanitize(tool.description, MAX_DESCRIPTION, true),
			loaded: tool.loaded === true,
		}));
		const toolCount = Number.isFinite(server.toolCount)
			? Math.max(0, Math.min(MAX_TOOLS, Math.floor(server.toolCount)))
			: tools.length;
		const loadedToolCount = Number.isFinite(server.loadedToolCount)
			? Math.max(0, Math.min(toolCount, Math.floor(server.loadedToolCount)))
			: tools.filter((tool) => tool.loaded).length;
		const normalizedStatus = normalizeStatus(server.status);
		const status = !server.enabled && normalizedStatus !== "invalid" ? "disabled" : normalizedStatus;
		return {
			name: safeLine(server.name, MAX_SERVER_NAME, "(unnamed server)"),
			enabled: server.enabled === true,
			status,
			transport:
				server.transport === "http" || server.transport === "stdio" || server.transport === "unknown"
					? server.transport
					: "unknown",
			toolMode: server.toolMode === "eager" ? "eager" : "lazy",
			eagerToolCount:
				server.toolMode !== "eager" && Number.isFinite(server.eagerToolCount)
					? Math.max(0, Math.floor(server.eagerToolCount ?? 0))
					: 0,
			injectInstructions: server.injectInstructions === true,
			toolCount,
			loadedToolCount,
			identity: server.identity === undefined ? undefined : safeLine(server.identity, MAX_IDENTITY, "unknown"),
			protocolVersion:
				server.protocolVersion === undefined
					? undefined
					: safeLine(server.protocolVersion, MAX_PROTOCOL, "unknown"),
			error: server.error === undefined ? undefined : safeLine(server.error, MAX_ERROR, "unknown issue"),
			tools,
		};
	});
}

function statusPresentation(status: McpDisplayStatus): {
	glyph: string;
	label: string;
	color: "success" | "warning" | "error" | "accent" | "muted" | "dim";
} {
	switch (status) {
		case "ready":
			return { glyph: "✓", label: "ready", color: "success" };
		case "cached":
			return { glyph: "◌", label: "cached", color: "accent" };
		case "connecting":
			return { glyph: "…", label: "connecting", color: "warning" };
		case "failed":
			return { glyph: "×", label: "failed", color: "error" };
		case "disabled":
			return { glyph: "—", label: "disabled", color: "muted" };
		case "invalid":
			return { glyph: "!", label: "invalid", color: "error" };
		case "closed":
			return { glyph: "·", label: "closed", color: "dim" };
		case "idle":
			return { glyph: "·", label: "idle", color: "dim" };
	}
}

function toolModeLabel(server: McpServerView): string {
	const eager = server.eagerToolCount ?? 0;
	return eager > 0 ? `${server.toolMode} + ${eager} eager` : server.toolMode;
}

function selectTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	for (const child of body) container.addChild(child);
	if (footer) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
	}
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return container;
}

function keyLabel(
	keybindings: KeybindingsManager,
	keybinding:
		| "tui.select.up"
		| "tui.select.down"
		| "tui.select.pageUp"
		| "tui.select.pageDown"
		| "tui.select.confirm"
		| "tui.select.cancel",
): string {
	const keys = keybindings.getKeys(keybinding);
	return keys.length > 0 ? keys.join("/") : keybinding.replace("tui.select.", "");
}

function selectionFooter(keybindings: KeybindingsManager, confirm: string, cancel: string): string {
	return `${keyLabel(keybindings, "tui.select.up")} / ${keyLabel(keybindings, "tui.select.down")} navigate · ${keyLabel(keybindings, "tui.select.confirm")} ${confirm} · ${keyLabel(keybindings, "tui.select.cancel")} ${cancel}`;
}

function line(theme: Theme, label: string, value: string): Text {
	return new Text(`${theme.fg("muted", `${label}:`)} ${value}`, 1, 0);
}

class McpManagerView implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly controller: McpManagerController;
	private readonly notify: ExtensionCommandContext["ui"]["notify"];
	private readonly done: () => void;
	private servers: McpServerView[];
	private screen: Screen = { kind: "servers" };
	private content: Container;
	private list: SelectList | undefined;
	private listItems: SelectItem[] = [];
	private selectedIndex = 0;
	private selectedServerName: string | undefined;
	private selectedAction: Action = "view-tools";
	private selectedToolName: string | undefined;
	private input: Input | undefined;
	private inputTarget: Focusable | undefined;
	private toolQuery = "";
	private operation: Operation | undefined;
	private unsubscribe: (() => void) | undefined;
	private closed = false;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		controller: McpManagerController,
		notify: ExtensionCommandContext["ui"]["notify"],
		done: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.controller = controller;
		this.notify = notify;
		this.done = done;
		this.servers = normalizeServers(controller.getServers());
		this.unsubscribe = controller.subscribe(() => this.refresh());
		this.content = new Container();
		this.rebuildContent();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.inputTarget) this.inputTarget.focused = value;
	}

	dispose(): void {
		this.close(false);
	}

	private refresh(): void {
		if (this.closed) return;
		const currentServer = this.currentServer();
		this.servers = normalizeServers(this.controller.getServers());
		if (currentServer && !this.servers.some((server) => server.name === currentServer.name)) {
			this.screen = { kind: "servers" };
			this.selectedServerName = undefined;
		}
		this.rebuildContent();
		this.tui.requestRender();
	}

	private currentServer(): McpServerView | undefined {
		const screen = this.screen;
		if (screen.kind === "servers") return undefined;
		return this.servers.find((server) => server.name === screen.serverName);
	}

	private setScreen(screen: Screen): void {
		if (this.inputTarget) this.inputTarget.focused = false;
		this.screen = screen;
		this.operation = undefined;
		this.rebuildContent();
		this.tui.requestRender();
	}

	private close(complete: boolean): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.inputTarget) this.inputTarget.focused = false;
		if (complete) this.done();
	}

	private rebuildContent(): void {
		this.list = undefined;
		this.listItems = [];
		this.input = undefined;
		this.inputTarget = undefined;
		if (this.screen.kind === "servers") this.buildServerList();
		else if (this.screen.kind === "server") this.buildServerDetail();
		else if (this.screen.kind === "tools") this.buildToolList();
		else this.buildToolDetail();
	}

	private buildServerList(): void {
		this.selectedIndex = this.selectedServerName
			? Math.max(
					0,
					this.servers.findIndex((server) => server.name === this.selectedServerName),
				)
			: Math.min(this.selectedIndex, Math.max(0, this.servers.length - 1));
		this.listItems = this.servers.map((server) => {
			const status = statusPresentation(server.status);
			return {
				value: server.name,
				label: `${status.glyph} ${server.name} · ${status.label}`,
				description: `${server.toolCount} tools · ${server.loadedToolCount} loaded · ${toolModeLabel(server)}`,
			};
		});
		this.list = new SelectList(
			this.listItems,
			Math.min(12, Math.max(1, this.listItems.length)),
			selectTheme(this.theme),
			{
				minPrimaryColumnWidth: 28,
				maxPrimaryColumnWidth: 64,
			},
		);
		this.list.setSelectedIndex(this.selectedIndex);
		this.content = this.buildServerListFrame();
	}

	private buildServerListFrame(): Container {
		const connected = this.servers.filter((server) => server.status === "ready").length;
		const totalTools = this.servers.reduce((sum, server) => sum + server.toolCount, 0);
		const loadedTools = this.servers.reduce((sum, server) => sum + server.loadedToolCount, 0);
		const body: Component[] = [
			line(this.theme, "config", safeLine(this.controller.configPath, MAX_PATH, "(unknown)")),
			line(
				this.theme,
				"summary",
				`${connected}/${this.servers.length} connected · ${totalTools} tools · ${loadedTools} loaded`,
			),
			new Spacer(1),
		];
		if (this.servers.length === 0) {
			body.push(
				new Text(this.theme.fg("muted", "No servers configured."), 1, 0),
				new Text(this.theme.fg("dim", "Edit mcp.json to add a server."), 1, 0),
				new Text(this.theme.fg("dim", `${keyLabel(this.keybindings, "tui.select.cancel")} close`), 1, 0),
			);
			return frame(this.theme, "MCP servers", body);
		}
		body.push(this.list as SelectList);
		return frame(this.theme, "MCP servers", body, selectionFooter(this.keybindings, "details", "close"));
	}

	private actionsFor(server: McpServerView): { value: Action; label: string; description?: string }[] {
		if (server.status === "invalid") {
			return server.enabled
				? [
						{ value: "disable", label: "Disable", description: "Keep this invalid entry out of the session" },
						{ value: "back", label: "Back" },
					]
				: [{ value: "back", label: "Back" }];
		}
		if (!server.enabled || server.status === "disabled") {
			return [
				{ value: "enable", label: "Enable", description: "Persist enablement outside mcp.json" },
				{ value: "back", label: "Back" },
			];
		}
		return [
			{ value: "view-tools", label: "View tools", description: "Browse names, load state, and descriptions" },
			{ value: "reconnect", label: "Reconnect", description: "Close and reconnect this server" },
			{ value: "disable", label: "Disable", description: "Persist enablement outside mcp.json" },
			{ value: "back", label: "Back" },
		];
	}

	private buildServerDetail(): void {
		const server = this.currentServer();
		if (!server) {
			this.setScreen({ kind: "servers" });
			return;
		}
		const actions = this.actionsFor(server);
		const items: SelectItem[] = actions.map((action) => ({
			value: action.value,
			label: action.label,
			description: action.description,
		}));
		this.listItems = items;
		this.selectedIndex = Math.max(
			0,
			actions.findIndex((action) => action.value === this.selectedAction),
		);
		if (this.selectedIndex < 0) this.selectedIndex = 0;
		this.list = new SelectList(items, Math.min(8, Math.max(1, items.length)), selectTheme(this.theme));
		this.list.setSelectedIndex(this.selectedIndex);
		this.content = this.buildServerDetailFrame(server);
	}

	private buildServerDetailFrame(server: McpServerView): Container {
		const status = statusPresentation(server.status);
		const body: Component[] = [
			line(this.theme, "status", this.theme.fg(status.color, `${status.glyph} ${status.label}`)),
			line(this.theme, "enabled", server.enabled ? "yes" : "no"),
			line(this.theme, "transport", server.transport),
			line(this.theme, "tool mode", toolModeLabel(server)),
			line(this.theme, "instructions", server.injectInstructions ? "yes" : "no"),
			line(this.theme, "identity", safeLine(server.identity, MAX_IDENTITY, "unknown")),
			line(this.theme, "protocol", safeLine(server.protocolVersion, MAX_PROTOCOL, "unknown")),
			line(this.theme, "tools", `${server.toolCount} total · ${server.loadedToolCount} loaded`),
		];
		if (server.error) body.push(line(this.theme, "issue", safeLine(server.error, MAX_ERROR, "unknown issue")));
		body.push(new Spacer(1));
		if (this.operation) {
			body.push(new Text(this.theme.fg("warning", `${this.operation}…`), 1, 0));
			return frame(this.theme, `MCP server: ${server.name}`, body, "Working… input is temporarily disabled");
		}
		body.push(this.list as SelectList);
		return frame(this.theme, `MCP server: ${server.name}`, body, selectionFooter(this.keybindings, "select", "back"));
	}

	private filteredTools(server: McpServerView): McpToolView[] {
		const query = this.toolQuery.trim().toLowerCase();
		if (!query) return [...server.tools];
		return server.tools.filter(
			(tool) => tool.name.toLowerCase().includes(query) || tool.description.toLowerCase().includes(query),
		);
	}

	private buildToolList(): void {
		const server = this.currentServer();
		if (!server) {
			this.setScreen({ kind: "servers" });
			return;
		}
		const tools = this.filteredTools(server);
		this.listItems = tools.map((tool) => ({
			value: tool.name,
			label: tool.name,
			description: `${tool.loaded ? "loaded" : "not loaded"} · ${tool.description || "no description"}`,
		}));
		this.selectedIndex = this.selectedToolName
			? Math.max(
					0,
					tools.findIndex((tool) => tool.name === this.selectedToolName),
				)
			: Math.min(this.selectedIndex, Math.max(0, tools.length - 1));
		if (this.selectedIndex < 0) this.selectedIndex = 0;
		this.list =
			tools.length > 0
				? new SelectList(this.listItems, Math.min(12, tools.length), selectTheme(this.theme), {
						minPrimaryColumnWidth: 24,
						maxPrimaryColumnWidth: 64,
					})
				: undefined;
		this.list?.setSelectedIndex(this.selectedIndex);
		this.input = new Input();
		this.input.setValue(this.toolQuery);
		this.inputTarget = this.input;
		this.input.focused = this._focused;
		this.content = this.buildToolListFrame(server, tools);
	}

	private buildToolListFrame(server: McpServerView, tools: McpToolView[]): Container {
		const body: Component[] = [
			new Text(this.theme.fg("muted", "Search tools by name or description"), 1, 0),
			this.input as Input,
			new Spacer(1),
		];
		if (server.toolCount === 0 || server.tools.length === 0) {
			body.push(new Text(this.theme.fg("muted", "No tools available for this server."), 1, 0));
		} else if (tools.length === 0) {
			body.push(new Text(this.theme.fg("muted", "No tools match this search."), 1, 0));
		} else {
			body.push(this.list as SelectList);
		}
		return frame(this.theme, `Tools: ${server.name}`, body, selectionFooter(this.keybindings, "details", "back"));
	}

	private buildToolDetail(): void {
		if (this.screen.kind !== "tool") return;
		const { toolName } = this.screen;
		const server = this.currentServer();
		const tool = server?.tools.find((candidate) => candidate.name === toolName);
		if (!server || !tool) {
			if (server) this.setScreen({ kind: "tools", serverName: server.name });
			else this.setScreen({ kind: "servers" });
			return;
		}
		const body: Component[] = [
			line(this.theme, "name", tool.name),
			line(this.theme, "load state", tool.loaded ? "loaded" : "not loaded"),
			new Spacer(1),
			new Text(this.theme.fg("muted", "Description"), 1, 0),
			new Text(tool.description || "No description.", 1, 0),
		];
		this.content = frame(
			this.theme,
			`Tool: ${server.name}`,
			body,
			`${keyLabel(this.keybindings, "tui.select.cancel")} back`,
		);
	}

	private moveSelection(delta: number): void {
		if (!this.list || this.listItems.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.listItems.length - 1, this.selectedIndex + delta));
		this.list.setSelectedIndex(this.selectedIndex);
		this.tui.requestRender();
	}

	private selectedValue(): string | undefined {
		return this.listItems[this.selectedIndex]?.value;
	}

	private activateSelection(): void {
		if (this.screen.kind === "servers") {
			const serverName = this.selectedValue();
			if (!serverName) return;
			this.selectedServerName = serverName;
			this.selectedToolName = undefined;
			this.setScreen({ kind: "server", serverName });
			return;
		}
		if (this.screen.kind === "server") {
			const action = this.selectedValue() as Action | undefined;
			if (!action) return;
			this.selectedAction = action;
			if (action === "back") {
				this.setScreen({ kind: "servers" });
				return;
			}
			if (action === "view-tools") {
				this.toolQuery = "";
				this.selectedToolName = undefined;
				this.setScreen({ kind: "tools", serverName: this.screen.serverName });
				return;
			}
			void this.runAction(action);
			return;
		}
		if (this.screen.kind === "tools") {
			const toolName = this.selectedValue();
			if (!toolName) return;
			this.selectedToolName = toolName;
			this.setScreen({ kind: "tool", serverName: this.screen.serverName, toolName });
		}
	}

	private async runAction(action: "reconnect" | "enable" | "disable"): Promise<void> {
		const server = this.currentServer();
		if (!server || this.operation) return;
		this.operation = action === "reconnect" ? "Reconnecting" : action === "enable" ? "Enabling" : "Disabling";
		this.rebuildContent();
		this.tui.requestRender();
		try {
			if (action === "reconnect") await this.controller.reconnect(server.name);
			else await this.controller.setEnabled(server.name, action === "enable");
			const verb = action === "reconnect" ? "reconnected" : action === "enable" ? "enabled" : "disabled";
			this.notify(`MCP server ${server.name} ${verb}.`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.notify(
				`MCP server ${server.name} ${action} failed: ${safeLine(message, MAX_ERROR, "unknown issue")}`,
				"error",
			);
		} finally {
			this.operation = undefined;
			this.refresh();
		}
	}

	handleInput(data: string): void {
		if (this.closed || this.operation) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.screen.kind === "servers") this.close(true);
			else if (this.screen.kind === "server") this.setScreen({ kind: "servers" });
			else if (this.screen.kind === "tools") this.setScreen({ kind: "server", serverName: this.screen.serverName });
			else this.setScreen({ kind: "tools", serverName: this.screen.serverName });
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-Math.max(1, Math.floor(this.listItems.length / 2)));
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(Math.max(1, Math.floor(this.listItems.length / 2)));
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.activateSelection();
			return;
		}
		if (this.screen.kind === "tools" && this.input) {
			const before = this.input.getValue();
			this.input.handleInput(data);
			const after = this.input.getValue();
			if (before !== after) {
				this.toolQuery = sanitize(after, MAX_TOOL_NAME);
				this.selectedIndex = 0;
				this.selectedToolName = undefined;
				this.rebuildContent();
				this.tui.requestRender();
			}
		}
	}

	render(width: number): string[] {
		return this.content
			.render(width)
			.map((renderedLine) =>
				visibleWidth(renderedLine) > width ? truncateToWidth(renderedLine, width, "") : renderedLine,
			);
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

export async function showMcpManager(ctx: ExtensionCommandContext, controller: McpManagerController): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		let view: McpManagerView;
		view = new McpManagerView(tui, theme, keybindings, controller, ctx.ui.notify, () => {
			view.dispose();
			done();
		});
		return view;
	});
}
