import type { Component, TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type McpManagerController,
	type McpServerView,
	type McpToolView,
	showMcpManager,
} from "../src/extensions/mcp/ui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

class FakeController implements McpManagerController {
	readonly configPath = "/tmp/phi/mcp.json";
	servers: McpServerView[];
	readonly reconnect = vi.fn<(serverName: string) => Promise<void>>().mockResolvedValue(undefined);
	readonly setEnabled = vi.fn<(serverName: string, enabled: boolean) => Promise<void>>().mockResolvedValue(undefined);
	private readonly listeners = new Set<() => void>();

	constructor(servers: McpServerView[]) {
		this.servers = servers;
	}

	getServers(): readonly McpServerView[] {
		return this.servers;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	publish(): void {
		for (const listener of this.listeners) listener();
	}
}

type Harness = {
	controller: FakeController;
	component: Component;
	completion: Promise<void>;
	notify: ReturnType<typeof vi.fn>;
	tui: { requestRender: ReturnType<typeof vi.fn> };
};

const baseTool = (overrides: Partial<McpToolView> = {}): McpToolView => ({
	name: "ping",
	description: "Ping the server",
	loaded: true,
	...overrides,
});

const baseServer = (overrides: Partial<McpServerView> = {}): McpServerView => ({
	name: "demo",
	enabled: true,
	status: "ready",
	transport: "http",
	toolMode: "lazy",
	injectInstructions: true,
	toolCount: 1,
	loadedToolCount: 1,
	identity: "Demo server",
	protocolVersion: "2025-06-18",
	tools: [baseTool()],
	...overrides,
});

async function openManager(servers: McpServerView[], keybindings = new KeybindingsManager({})): Promise<Harness> {
	const controller = new FakeController(servers);
	const notify = vi.fn();
	const tui = { requestRender: vi.fn() };
	let resolveCompletion!: () => void;
	const completion = new Promise<void>((resolve) => {
		resolveCompletion = resolve;
	});
	let component: Component | undefined;
	const custom = vi.fn(async (factory: Parameters<NonNullable<ExtensionCommandContext["ui"]["custom"]>>[0]) => {
		component = await factory(tui as unknown as TUI, theme, keybindings, () => resolveCompletion());
		await completion;
	});
	const ctx = {
		ui: { custom, notify },
	} as unknown as ExtensionCommandContext;
	void showMcpManager(ctx, controller);
	await vi.waitFor(() => expect(component).toBeDefined());
	return { controller, component: component as Component, completion, notify, tui };
}

function input(component: Component, data: string): void {
	component.handleInput?.(data);
}

function screen(component: Component, width = 100): string {
	return stripTerminalSequences(component.render(width).join("\n"));
}

async function closeManager(harness: Harness): Promise<void> {
	for (let index = 0; index < 4; index++) input(harness.component, "\x1b");
	await harness.completion;
}

afterEach(() => vi.restoreAllMocks());

describe("MCP manager TUI", () => {
	it("renders every connection state with glyph and plain-text status, safely", async () => {
		const harness = await openManager([
			baseServer({ name: "ready", status: "ready" }),
			baseServer({ name: "cached", status: "cached" }),
			baseServer({ name: "connecting", status: "connecting" }),
			baseServer({ name: "failed", status: "failed", error: "offline" }),
			baseServer({ name: "disabled", enabled: false, status: "disabled" }),
			baseServer({ name: "invalid", status: "invalid", error: "bad config" }),
			baseServer({ name: "unsafe\u001b[31m\u0085name", status: "idle" }),
		]);
		const rendered = screen(harness.component, 52);
		expect(rendered).toContain("✓ ready");
		expect(rendered).toContain("◌ cached");
		expect(rendered).toContain("… connecting");
		expect(rendered).toContain("× failed");
		expect(rendered).toContain("— disabled");
		expect(rendered).toContain("! invalid");
		expect(rendered).not.toContain("\u001b");
		for (const line of harness.component.render(52)) expect(visibleWidth(line)).toBeLessThanOrEqual(52);
		await closeManager(harness);
	});

	it("labels a lazy server's eagerTools count in the list and detail views", async () => {
		const harness = await openManager([
			baseServer({ name: "copper", eagerToolCount: 4 }),
			baseServer({ name: "plain", toolMode: "eager", eagerToolCount: 3 }),
		]);
		const rendered = screen(harness.component, 120);
		expect(rendered).toContain("lazy + 4 eager");
		expect(rendered).not.toContain("eager + 3 eager");
		input(harness.component, "\r");
		expect(screen(harness.component, 120)).toContain("tool mode: lazy + 4 eager");
		await closeManager(harness);
	});

	it("opens server detail, invokes actions, and reports async failures", async () => {
		const reconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const harness = await openManager([baseServer()]);
		harness.controller.reconnect.mockImplementation(reconnect);
		input(harness.component, "\r");
		expect(screen(harness.component)).toContain("View tools");
		input(harness.component, "\x1b");
		expect(screen(harness.component)).toContain("MCP servers");
		input(harness.component, "\r");
		input(harness.component, "\x1b[B");
		input(harness.component, "\r");
		await vi.waitFor(() => expect(reconnect).toHaveBeenCalledWith("demo"));
		expect(harness.notify).toHaveBeenCalledWith("MCP server demo reconnected.", "info");

		harness.controller.reconnect.mockRejectedValueOnce(new Error("offline\u001b[31m"));
		await vi.waitFor(() => expect(screen(harness.component)).toContain("MCP server: demo"));
		input(harness.component, "\r");
		input(harness.component, "\r");
		await vi.waitFor(() =>
			expect(harness.notify).toHaveBeenCalledWith("MCP server demo reconnect failed: offline[31m", "error"),
		);
		await closeManager(harness);
	});

	it("refreshes live state through the subscription and uses configured selection keys", async () => {
		const keybindings = new KeybindingsManager({
			"tui.select.confirm": "ctrl+m",
			"tui.select.cancel": "ctrl+n",
			"tui.select.down": "ctrl+j",
			"tui.select.up": "ctrl+k",
		});
		const harness = await openManager([baseServer({ status: "connecting" })], keybindings);
		expect(screen(harness.component)).toContain("demo · connecting");
		harness.controller.servers = [baseServer({ status: "ready", loadedToolCount: 1 })];
		harness.controller.publish();
		expect(screen(harness.component)).toContain("✓ demo · ready");
		expect(harness.tui.requestRender).toHaveBeenCalled();
		input(harness.component, "\x0e");
		await harness.completion;
	});

	it("browses tools, shows load state and description, and follows escape hierarchy", async () => {
		const tools = [
			baseTool({ name: "alpha_tool", description: "First tool", loaded: true }),
			baseTool({ name: "beta_tool", description: "Second tool", loaded: false }),
		];
		const harness = await openManager([baseServer({ tools, toolCount: 2, loadedToolCount: 1 })]);
		input(harness.component, "\r");
		input(harness.component, "\r");
		let rendered = screen(harness.component);
		expect(rendered).toContain("alpha_tool");
		expect(rendered).toContain("loaded");
		expect(rendered).toContain("not loaded");
		input(harness.component, "beta");
		rendered = screen(harness.component);
		expect(rendered).not.toContain("alpha_tool");
		expect(rendered).toContain("beta_tool");
		for (let index = 0; index < 4; index++) input(harness.component, "\x7f");
		input(harness.component, "\x1b[B");
		input(harness.component, "\r");
		rendered = screen(harness.component);
		expect(rendered).toContain("name: beta_tool");
		expect(rendered).toContain("load state: not loaded");
		expect(rendered).toContain("Second tool");
		input(harness.component, "\x1b");
		expect(screen(harness.component)).toContain("Tools: demo");
		input(harness.component, "\x1b");
		expect(screen(harness.component)).toContain("MCP server: demo");
		input(harness.component, "\x1b");
		expect(screen(harness.component)).toContain("MCP servers");
		input(harness.component, "\x1b");
		await harness.completion;
	});

	it("shows an explicit empty state for servers with no tools", async () => {
		const harness = await openManager([baseServer({ tools: [], toolCount: 0, loadedToolCount: 0 })]);
		input(harness.component, "\r");
		input(harness.component, "\r");
		expect(screen(harness.component)).toContain("No tools available for this server.");
		await closeManager(harness);
	});

	it("shows the no-server state with its safe config path", async () => {
		const harness = await openManager([]);
		const rendered = screen(harness.component);
		expect(rendered).toContain("No servers configured.");
		expect(rendered).toContain("/tmp/phi/mcp.json");
		expect(rendered).toContain("escape/ctrl+c close");
		await closeManager(harness);
	});
});
