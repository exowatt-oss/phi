/**
 * phi remote slash commands: the list (`commands.list`), its version, how `/name args` from the phone
 * is routed, and the transcript of an expanded skill. Pure functions, the bridge against a fake link,
 * and a real AgentSession with the built-in `remote` extension on a fake hub socket.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSkillBlock } from "../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/types.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import type { SlashCommandInfo } from "../src/core/slash-commands.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { COMPACT_ERROR_WINDOW_MS, SessionBridge } from "../src/extensions/remote/bridge.ts";
import {
	buildCommandList,
	commandDescription,
	commandsVersion,
	MAX_COMMANDS,
	REMOTE_BUILTINS,
	resolveSlash,
} from "../src/extensions/remote/commands.ts";
import remoteExtension, { resetRemoteState } from "../src/extensions/remote/index.ts";
import type { LinkLike } from "../src/extensions/remote/link.ts";
import { promptLine, typedUserText, userItem } from "../src/extensions/remote/transcript.ts";
import type { SessionToHub, TranscriptItem } from "../src/remote/protocol.ts";
import { createHarness, type Harness } from "./test-harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

type Frame = any;

const source = createSyntheticSourceInfo("<test>", { source: "test" });
const cmd = (
	name: string,
	kind: SlashCommandInfo["source"],
	extra: Partial<SlashCommandInfo> = {},
): SlashCommandInfo => ({
	name,
	source: kind,
	sourceInfo: source,
	...extra,
});

const SLASH: SlashCommandInfo[] = [
	cmd("skill:use-subs", "skill", { description: "Mixed subagent swarm" }),
	cmd("review", "prompt", { description: "Review a diff", argumentHint: "<path>" }),
	cmd("mcp", "extension", { description: "MCP servers" }),
	cmd("remote", "extension", { description: "phi remote: pair a phone" }),
	cmd("settings", "extension", { description: "shadowed by the TUI built-in" }),
	cmd("model", "prompt", { description: "shadowed too" }),
	cmd("skill:checkin", "skill", { description: "Status check-in" }),
	cmd("loop", "extension", { description: "Loop" }),
	cmd("Zeta", "prompt"),
	cmd("alpha", "prompt"),
	cmd("bad name", "extension"),
];

describe("command list", () => {
	it("lists the remote built-ins first, then extensions, skills and prompts, each alphabetical", () => {
		const list = buildCommandList(SLASH, { skillCommands: true });
		expect(list.map((command) => `${command.source}:${command.name}`)).toEqual([
			"builtin:compact",
			"builtin:model",
			"builtin:name",
			"builtin:new",
			"builtin:thinking",
			"extension:loop",
			"extension:mcp",
			"skill:skill:checkin",
			"skill:skill:use-subs",
			"prompt:alpha",
			"prompt:review",
			"prompt:Zeta",
		]);
		expect(list.find((command) => command.name === "review")).toEqual({
			name: "review",
			description: "Review a diff",
			source: "prompt",
			argumentHint: "<path>",
		});
		expect(list.find((command) => command.name === "compact")).toMatchObject({ argumentHint: "[instructions]" });
		// Only the built-ins the bridge can run without a terminal.
		expect(REMOTE_BUILTINS.map((command) => command.name).sort()).toEqual([
			"compact",
			"model",
			"name",
			"new",
			"thinking",
		]);
		expect(list.some((command) => command.name === "clear" || command.name === "settings")).toBe(false);
	});

	it("follows the enableSkillCommands setting, dedupes names and caps descriptions and length", () => {
		expect(buildCommandList(SLASH, { skillCommands: false }).some((command) => command.source === "skill")).toBe(
			false,
		);
		const dupes = buildCommandList(
			[cmd("deploy", "prompt", { description: "template" }), cmd("deploy", "extension", { description: "command" })],
			{ skillCommands: true },
		);
		expect(dupes.filter((command) => command.name === "deploy")).toEqual([
			{ name: "deploy", description: "command", source: "extension" },
		]);
		// `remote:1` / `remote:2` when two extensions register `/remote`: neither is listed.
		expect(
			buildCommandList([cmd("remote:1", "extension"), cmd("remote:2", "extension")], { skillCommands: true }).some(
				(command) => command.name.startsWith("remote"),
			),
		).toBe(false);
		const long = commandDescription(`first line\n\n   second\tline ${"x".repeat(400)}`);
		expect(long).toHaveLength(160);
		expect(long?.startsWith("first line second line x")).toBe(true);
		expect(long?.endsWith("…")).toBe(true);
		expect(commandDescription("  \n ")).toBeUndefined();

		const many = Array.from({ length: 700 }, (_, index) => cmd(`p${String(index).padStart(3, "0")}`, "prompt"));
		const capped = buildCommandList(many, { skillCommands: true });
		expect(capped).toHaveLength(MAX_COMMANDS);
		expect(capped.slice(0, 5).every((command) => command.source === "builtin")).toBe(true);
		expect(capped.at(-1)?.name).toBe("p494");
	});

	it("versions the list: equal lists, equal versions; any change, a new one", () => {
		const list = buildCommandList(SLASH, { skillCommands: true });
		const version = commandsVersion(list);
		expect(commandsVersion(buildCommandList([...SLASH].reverse(), { skillCommands: true }))).toBe(version);
		expect(
			commandsVersion(buildCommandList([...SLASH, cmd("skill:new-one", "skill")], { skillCommands: true })),
		).not.toBe(version);
		const described = SLASH.map((command) =>
			command.name === "mcp" ? { ...command, description: "MCP servers and tools" } : command,
		);
		expect(commandsVersion(buildCommandList(described, { skillCommands: true }))).not.toBe(version);
		expect(commandsVersion(buildCommandList(SLASH, { skillCommands: false }))).not.toBe(version);
	});
});

describe("slash routing", () => {
	const route = (text: string, skillCommands = true, slash = SLASH) => resolveSlash(text, slash, { skillCommands });

	it("runs the remote built-ins, with /clear as an alias of /new", () => {
		expect(route("hello")).toBeUndefined();
		expect(route("  /new  ")).toEqual({ kind: "builtin", name: "new", args: "" });
		expect(route("/clear")).toEqual({ kind: "builtin", name: "new", args: "" });
		expect(route("/compact keep the API notes")).toEqual({
			kind: "builtin",
			name: "compact",
			args: "keep the API notes",
		});
		expect(route("/name  remote smoke ")).toEqual({ kind: "builtin", name: "name", args: "remote smoke" });
		expect(route("/model anthropic/claude-haiku-4-5")).toMatchObject({ kind: "builtin", name: "model" });
		expect(route("/thinking high")).toEqual({ kind: "builtin", name: "thinking", args: "high" });
		// An extension command named `clear` wins over the alias, as it would in the terminal.
		expect(route("/clear all", true, [cmd("clear", "extension")])).toEqual({
			kind: "dispatch",
			text: "/clear all",
			extensionCommand: true,
		});
	});

	it("refuses TUI-only built-ins and /remote instead of sending them to the model", () => {
		for (const name of ["settings", "tree", "resume", "export", "fast", "quit", "btw", "reload", "remote"]) {
			expect(route(`/${name} x`)).toEqual({ kind: "refused", name });
		}
	});

	it("dispatches extension commands, skills, templates and unknown names with expansion", () => {
		expect(route("/mcp list")).toEqual({ kind: "dispatch", text: "/mcp list", extensionCommand: true });
		expect(route("/review src/app.ts")).toEqual({
			kind: "dispatch",
			text: "/review src/app.ts",
			extensionCommand: false,
		});
		expect(route("/skill:use-subs build X")).toEqual({
			kind: "dispatch",
			text: "/skill:use-subs build X",
			extensionCommand: false,
		});
		// The phone types the skill name alone: it becomes `/skill:<name>`, arguments untouched.
		expect(route("/use-subs build X\nand Y")).toEqual({
			kind: "dispatch",
			text: "/skill:use-subs build X\nand Y",
			extensionCommand: false,
		});
		expect(route("/checkin")).toMatchObject({ text: "/skill:checkin" });
		// ...but not with skill commands off, and never for unknown names.
		expect(route("/use-subs build X", false)).toMatchObject({ text: "/use-subs build X" });
		expect(route("/nonsense here")).toEqual({ kind: "dispatch", text: "/nonsense here", extensionCommand: false });
		expect(route("/")).toEqual({ kind: "dispatch", text: "/", extensionCommand: false });
		// A prompt template of the same name as a skill keeps its name.
		expect(route("/checkin now", true, [cmd("checkin", "prompt"), cmd("skill:checkin", "skill")])).toMatchObject({
			text: "/checkin now",
		});
	});
});

describe("transcript of an expanded skill", () => {
	// Exactly what AgentSession._expandSkillCommand produces.
	const block = (name: string, args: string) =>
		`<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n# ${name}\n\nBody.\n</skill>${args ? `\n\n${args}` : ""}`;

	it("shows what the user typed, like the TUI's collapsed skill block", () => {
		expect(typedUserText(block("use-subs", "build X"))).toBe("/skill:use-subs build X");
		expect(typedUserText(block("checkin", ""))).toBe("/skill:checkin");
		// Same reading as the TUI's parser.
		const parsed = parseSkillBlock(block("use-subs", "build X\nthen Y"));
		expect(typedUserText(block("use-subs", "build X\nthen Y"))).toBe(`/skill:${parsed?.name} ${parsed?.userMessage}`);
		expect(typedUserText("<skill>not a block")).toBe("<skill>not a block");
		expect(typedUserText("plain")).toBe("plain");
		expect(userItem({ content: [{ type: "text", text: block("checkin", "hi") }], timestamp: 7 })).toEqual({
			id: "u:7",
			ts: 7,
			kind: "user",
			text: "/skill:checkin hi",
		});
		expect(promptLine(block("checkin", "how is it going"))).toBe("/skill:checkin how is it going");
	});
});

// ---------------------------------------------------------------------------------------------
// Bridge against a fake link
// ---------------------------------------------------------------------------------------------

function fakeLink(): LinkLike & { sent: Frame[] } {
	const sent: Frame[] = [];
	return {
		connected: true,
		sent,
		send(frame: SessionToHub) {
			sent.push(JSON.parse(JSON.stringify(frame)));
		},
	};
}

const reasoningModel = {
	provider: "anthropic",
	id: "claude-haiku-4-5",
	name: "Haiku",
	reasoning: true,
	thinkingLevelMap: {},
};
const plainModel = { provider: "faux", id: "faux-1", name: "Faux", reasoning: false };

function makeBridge(
	options: { idle?: boolean; model?: unknown; commandContext?: Partial<ExtensionCommandContext>; compact?: any } = {},
) {
	const link = fakeLink();
	let slash = [...SLASH];
	const pi = {
		sendUserMessage: vi.fn(),
		setModel: vi.fn(async () => true),
		setThinkingLevel: vi.fn(),
		getThinkingLevel: () => "off" as const,
		getSessionName: () => undefined,
		setSessionName: vi.fn(),
		getCommands: () => slash,
		getSettings: () => ({ enableSkillCommands: true }),
	} as unknown as Pick<
		ExtensionAPI,
		| "sendUserMessage"
		| "setModel"
		| "setThinkingLevel"
		| "getThinkingLevel"
		| "getSessionName"
		| "setSessionName"
		| "getCommands"
		| "getSettings"
	>;
	const ctx = {
		mode: "rpc",
		cwd: "/tmp/project",
		model: "model" in options ? options.model : plainModel,
		scopedModels: [],
		sessionManager: {
			getSessionId: () => "session-1",
			getLeafId: () => null,
			getBranch: () => [],
			getEntries: () => [],
			getEntry: () => undefined,
		},
		isIdle: () => options.idle ?? true,
		abort: vi.fn(),
		shutdown: vi.fn(),
		compact: vi.fn(options.compact ?? (() => {})),
		getContextUsage: () => undefined,
		modelRegistry: { getAvailable: () => [plainModel, reasoningModel], find: () => undefined },
	} as unknown as ExtensionContext;
	const newSession = vi.fn(async () => ({ cancelled: false }));
	const commandContext = { newSession, ...options.commandContext } as unknown as ExtensionCommandContext;
	const withCommandContext = vi.fn(<T>(fn: (c: ExtensionCommandContext) => Promise<T>) => fn(commandContext));
	const bridge = new SessionBridge({
		pi,
		ctx,
		link,
		host: "box",
		withCommandContext: withCommandContext as unknown as <T>(
			fn: (c: ExtensionCommandContext) => Promise<T>,
		) => Promise<T>,
	});
	const setSlash = (next: SlashCommandInfo[]) => {
		slash = next;
	};
	return { bridge, link, pi: pi as any, ctx: ctx as any, newSession, withCommandContext, setSlash };
}

async function request(bridge: SessionBridge, link: ReturnType<typeof fakeLink>, op: string, args: unknown = {}) {
	const id = `q${Math.random()}`;
	bridge.onFrame({ t: "req", id, op, args } as never);
	await vi.waitFor(() => {
		if (!link.sent.some((frame) => frame.t === "reply" && frame.re === id)) throw new Error("no reply yet");
	});
	return link.sent.find((frame) => frame.t === "reply" && frame.re === id);
}

const prompt = (bridge: SessionBridge, link: ReturnType<typeof fakeLink>, text: string, extra = {}) =>
	request(bridge, link, "prompt", { text, mode: "auto", ...extra });

describe("session bridge: slash commands", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("answers `commands` and versions the list in the summary", async () => {
		const { bridge, link, setSlash } = makeBridge();
		bridge.onConnected();
		const register = link.sent.find((frame) => frame.t === "register");
		const list = buildCommandList(SLASH, { skillCommands: true });
		expect(register.session.commandsVersion).toBe(commandsVersion(list));
		expect(await request(bridge, link, "commands")).toEqual({
			t: "reply",
			re: expect.any(String),
			ok: true,
			data: { commands: list },
		});
		// A newly registered command changes the version in the next summary.
		setSlash([...SLASH, cmd("deploy", "extension")]);
		expect(bridge.summary().commandsVersion).not.toBe(register.session.commandsVersion);
		// Unknown ops stay bad_request (what an older phi answers to `commands`).
		expect(await request(bridge, link, "teleport")).toMatchObject({ ok: false, error: { code: "bad_request" } });
	});

	it("runs /name, /model and /thinking itself", async () => {
		const { bridge, link, pi } = makeBridge({ model: reasoningModel });
		expect(await prompt(bridge, link, "/name remote smoke")).toMatchObject({ ok: true });
		expect(pi.setSessionName).toHaveBeenCalledWith("remote smoke");
		expect(await prompt(bridge, link, "/name")).toMatchObject({
			ok: false,
			error: { code: "bad_request", message: "Usage: /name <name>" },
		});
		expect(await prompt(bridge, link, "/model faux/faux-1")).toMatchObject({ ok: true });
		expect(pi.setModel).toHaveBeenCalledWith(plainModel);
		expect(await prompt(bridge, link, "/model nope/nothing")).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect(await prompt(bridge, link, "/thinking HIGH")).toMatchObject({ ok: true });
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(await prompt(bridge, link, "/thinking sideways")).toMatchObject({
			ok: false,
			error: { code: "bad_request", message: expect.stringContaining("Usage: /thinking <level> (off, minimal") },
		});
		expect(
			await prompt(bridge, link, "/name x", { images: [{ mimeType: "image/png", data: "AAAA" }] }),
		).toMatchObject({ ok: false, error: { code: "bad_request" } });
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("starts a new session through a command context, for /new and /clear", async () => {
		const { bridge, link, newSession, withCommandContext } = makeBridge();
		expect(await prompt(bridge, link, "/new")).toMatchObject({ ok: true });
		expect(await prompt(bridge, link, "/clear")).toMatchObject({ ok: true });
		expect(withCommandContext).toHaveBeenCalledTimes(2);
		expect(newSession).toHaveBeenCalledTimes(2);
		expect(await prompt(bridge, link, "/new please")).toMatchObject({
			ok: false,
			error: { code: "bad_request", message: "Usage: /new (no arguments)" },
		});
		newSession.mockResolvedValueOnce({ cancelled: true });
		expect(await prompt(bridge, link, "/new")).toMatchObject({
			ok: false,
			error: { code: "bad_request", message: "/new was cancelled by an extension" },
		});
		const failing = makeBridge({
			commandContext: { newSession: async () => Promise.reject(new Error("disk full")) } as never,
		});
		expect(await prompt(failing.bridge, failing.link, "/new")).toMatchObject({
			ok: false,
			error: { code: "internal", message: "disk full" },
		});
	});

	it("compacts when idle, reports quick failures and refuses while working", async () => {
		const ok = makeBridge({ compact: (options: any) => options.onComplete({}) });
		expect(await prompt(ok.bridge, ok.link, "/compact keep the API notes")).toMatchObject({ ok: true });
		expect(ok.ctx.compact).toHaveBeenCalledWith(
			expect.objectContaining({ customInstructions: "keep the API notes" }),
		);

		const empty = makeBridge({
			compact: (options: any) => options.onError(new Error("Nothing to compact (session too small)")),
		});
		expect(await prompt(empty.bridge, empty.link, "/compact")).toMatchObject({
			ok: false,
			error: { code: "bad_request", message: "compaction failed: Nothing to compact (session too small)" },
		});
		expect(empty.ctx.compact.mock.calls[0][0]).not.toHaveProperty("customInstructions");

		// Still running after the window: acknowledged.
		vi.useFakeTimers();
		const slow = makeBridge();
		const id = "slow";
		slow.bridge.onFrame({ t: "req", id, op: "prompt", args: { text: "/compact" } } as never);
		await vi.advanceTimersByTimeAsync(COMPACT_ERROR_WINDOW_MS + 10);
		expect(slow.link.sent.find((frame) => frame.re === id)).toMatchObject({ ok: true });
		vi.useRealTimers();

		const busy = makeBridge({ idle: false });
		expect(await prompt(busy.bridge, busy.link, "/compact")).toMatchObject({
			ok: false,
			error: { code: "bad_request", message: "the session is working; send /compact when it is idle" },
		});
		expect(busy.ctx.compact).not.toHaveBeenCalled();
	});

	it("dispatches skills, templates and extension commands with expansion, refuses TUI-only built-ins", async () => {
		const { bridge, link, pi } = makeBridge();
		expect(await prompt(bridge, link, "/use-subs build X", { mode: "followUp" })).toMatchObject({ ok: true });
		expect(pi.sendUserMessage).toHaveBeenLastCalledWith("/skill:use-subs build X", {
			deliverAs: "followUp",
			expandPromptTemplates: true,
		});
		expect(
			await prompt(bridge, link, "/review a.ts", { images: [{ mimeType: "image/png", data: "AAAA" }] }),
		).toMatchObject({ ok: true });
		expect(pi.sendUserMessage).toHaveBeenLastCalledWith(
			[
				{ type: "text", text: "/review a.ts" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			{ deliverAs: "steer", expandPromptTemplates: true },
		);
		expect(await prompt(bridge, link, "/unknown thing")).toMatchObject({ ok: true });
		expect(pi.sendUserMessage).toHaveBeenLastCalledWith("/unknown thing", {
			deliverAs: "steer",
			expandPromptTemplates: true,
		});
		// Plain prompts are unchanged: no expansion option at all.
		expect(await prompt(bridge, link, "hello /review")).toMatchObject({ ok: true });
		expect(pi.sendUserMessage).toHaveBeenLastCalledWith("hello /review", { deliverAs: "steer" });

		const calls = pi.sendUserMessage.mock.calls.length;
		expect(await prompt(bridge, link, "/settings")).toMatchObject({
			ok: false,
			error: {
				code: "bad_request",
				message: "/settings needs the phi terminal; it is not available from phi remote",
			},
		});
		expect(await prompt(bridge, link, "/remote off")).toMatchObject({ ok: false, error: { code: "bad_request" } });
		expect(pi.sendUserMessage.mock.calls.length).toBe(calls);
	});

	it("runs extension commands without a model, but nothing that reaches the model", async () => {
		const { bridge, link, pi } = makeBridge({ model: undefined });
		expect(await prompt(bridge, link, "/mcp list")).toMatchObject({ ok: true });
		expect(pi.sendUserMessage).toHaveBeenLastCalledWith("/mcp list", {
			deliverAs: "steer",
			expandPromptTemplates: true,
		});
		expect(await prompt(bridge, link, "/use-subs go")).toMatchObject({
			ok: false,
			error: { message: "no model selected in this session" },
		});
	});
});

// ---------------------------------------------------------------------------------------------
// A real session with the remote extension, on a fake hub socket
// ---------------------------------------------------------------------------------------------

class FakeHub {
	readonly frames: Frame[] = [];
	private socket: Socket | undefined;
	private server!: Server;
	private nextId = 0;
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	async listen(): Promise<void> {
		this.server = createServer((socket) => {
			this.socket = socket;
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const frame = JSON.parse(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					this.frames.push(frame);
					if (frame.t === "register") socket.write(`${JSON.stringify({ t: "registered", hubId: "hub-test" })}\n`);
				}
			});
			socket.on("error", () => undefined);
		});
		await new Promise<void>((resolve) => this.server.listen(this.path, resolve));
	}

	async request(op: string, args: Record<string, unknown> = {}): Promise<Frame> {
		const id = `r${++this.nextId}`;
		await vi.waitFor(() => expect(this.socket).toBeDefined());
		this.socket?.write(`${JSON.stringify({ t: "req", id, op, args })}\n`);
		return vi.waitFor(
			() => {
				const reply = this.frames.find((frame) => frame.t === "reply" && frame.re === id);
				if (!reply) throw new Error("no reply yet");
				return reply;
			},
			{ timeout: 5000 },
		);
	}

	upserts(): TranscriptItem[] {
		return this.frames.filter((f) => f.t === "event" && f.event.type === "item.upsert").map((f) => f.event.item);
	}

	async close(): Promise<void> {
		this.socket?.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}

describe("phi remote slash commands in a real session", () => {
	let dir: string;
	let hub: FakeHub;
	let harness: Harness | undefined;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "phrc-"));
		vi.stubEnv("PI_REMOTE_DIR", dir);
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		vi.stubEnv("PHI_REMOTE", undefined);
		vi.stubEnv("PHI_REMOTE_SPAWN_ID", undefined);
		hub = new FakeHub(join(dir, "hub.sock"));
		await hub.listen();
	});

	afterEach(async () => {
		if (harness) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
			harness = undefined;
		}
		resetRemoteState();
		vi.unstubAllEnvs();
		await hub.close().catch(() => undefined);
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists, dispatches and expands like the terminal, and starts /new through the command path", async () => {
		const skillPath = join(dir, "SKILL.md");
		writeFileSync(skillPath, "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n\nSay DEMO-SKILL-LOADED.\n");
		const echoed: string[] = [];
		const extensionsResult = await createTestExtensionsResult(
			[
				{ name: "remote", factory: remoteExtension },
				{
					name: "echo",
					factory: (pi: ExtensionAPI) =>
						pi.registerCommand("echo", {
							description: "Echo the arguments",
							handler: async (args) => {
								echoed.push(args);
							},
						}),
				},
			],
			dir,
		);
		const base = createTestResourceLoader({ extensionsResult });
		const resourceLoader: ResourceLoader = {
			...base,
			getSkills: () => ({
				skills: [
					{
						name: "demo",
						description: "Demo skill",
						filePath: skillPath,
						baseDir: dir,
						sourceInfo: source,
						disableModelInvocation: false,
					},
				],
				diagnostics: [],
			}),
			getPrompts: () => ({
				prompts: [
					{
						name: "greet",
						description: "Greet someone",
						argumentHint: "<who>",
						content: "Say hello to $1 politely.",
						sourceInfo: source,
						filePath: join(dir, "greet.md"),
					},
				],
				diagnostics: [],
			}),
		};
		harness = await createHarness({ responses: ["skill reply", "template reply"], resourceLoader });
		const newSession = vi.fn(async () => ({ cancelled: false }));
		await harness.session.bindExtensions({
			mode: "rpc",
			commandContextActions: {
				waitForIdle: async () => {},
				newSession,
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			},
		});
		const register = await vi.waitFor(() => {
			const frame = hub.frames.find((f) => f.t === "register");
			if (!frame) throw new Error("not registered");
			return frame;
		});

		const listed = await hub.request("commands");
		expect(listed.ok).toBe(true);
		const names = listed.data.commands.map((c: { source: string; name: string }) => `${c.source}:${c.name}`);
		expect(names).toEqual([
			"builtin:compact",
			"builtin:model",
			"builtin:name",
			"builtin:new",
			"builtin:thinking",
			"extension:echo",
			"skill:skill:demo",
			"prompt:greet",
		]);
		expect(listed.data.commands.find((c: { name: string }) => c.name === "greet")).toEqual({
			name: "greet",
			description: "Greet someone",
			source: "prompt",
			argumentHint: "<who>",
		});
		expect(register.session.commandsVersion).toBe(commandsVersion(listed.data.commands));

		// An extension command runs, nothing reaches the model, nothing lands in the transcript.
		expect(await hub.request("prompt", { text: "/echo one two" })).toMatchObject({ ok: true });
		await vi.waitFor(() => expect(echoed).toEqual(["one two"]));
		expect(harness.faux.callCount).toBe(0);

		// A skill typed without its prefix: the model gets the expanded skill, the item reads as typed.
		expect(await hub.request("prompt", { text: "/demo do it" })).toMatchObject({ ok: true });
		await vi.waitFor(() => expect(harness?.faux.callCount).toBe(1));
		await harness.session.waitForIdle();
		const sent = JSON.stringify(harness.faux.contexts[0]);
		expect(sent).toContain("Say DEMO-SKILL-LOADED.");
		expect(sent).toContain('<skill name=\\"demo\\"');
		await vi.waitFor(() =>
			expect(hub.upserts().find((item) => item.kind === "user")).toMatchObject({ text: "/skill:demo do it" }),
		);

		// A prompt template expands; the transcript shows the expanded text, as the terminal does.
		expect(await hub.request("prompt", { text: "/greet Ada" })).toMatchObject({ ok: true });
		await vi.waitFor(() => expect(harness?.faux.callCount).toBe(2));
		await harness.session.waitForIdle();
		const snapshot = await hub.request("snapshot");
		const users = snapshot.data.items.filter((item: TranscriptItem) => item.kind === "user");
		expect(users.map((item: { text: string }) => item.text)).toEqual([
			"/skill:demo do it",
			"Say hello to Ada politely.",
		]);
		// Live and snapshot agree on the skill item.
		const liveSkill = hub.upserts().find((item) => item.id === users[0].id);
		expect(liveSkill).toEqual(users[0]);

		// The built-ins.
		expect(await hub.request("prompt", { text: "/name remote smoke" })).toMatchObject({ ok: true });
		expect(harness.sessionManager.getSessionName()).toBe("remote smoke");
		await vi.waitFor(() =>
			expect(hub.frames.some((f) => f.t === "upsert" && f.session.name === "remote smoke")).toBe(true),
		);
		expect(await hub.request("prompt", { text: "/new" })).toMatchObject({ ok: true });
		expect(newSession).toHaveBeenCalledTimes(1);
		expect(await hub.request("prompt", { text: "/remote off" })).toMatchObject({
			ok: false,
			error: { code: "bad_request" },
		});
		expect(harness.faux.callCount).toBe(2);
	});
});
