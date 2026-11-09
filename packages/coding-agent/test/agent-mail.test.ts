import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { Extension, ExtensionContext } from "../src/core/extensions/types.ts";
import agentMailExtension from "../src/extensions/agent-mail/index.ts";
import { AgentMailMember, MAX_MESSAGE_BYTES, type MailEnvelope } from "../src/extensions/agent-mail/transport.ts";
import { toolContext } from "./tool-context.ts";

type SentMessage = { message: Record<string, unknown>; options?: Record<string, unknown> };
type Mounted = {
	extension: Extension;
	context: ExtensionContext;
	sent: SentMessage[];
	shutdown(): Promise<void>;
	setName(value: string): void;
};

let agentDir: string;
let originalEnv: Record<string, string | undefined>;
const mounted: Mounted[] = [];
const standalone: AgentMailMember[] = [];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "phi-agent-mail-test-"));
	originalEnv = Object.fromEntries(
		["PHI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID"].map((key) => [key, process.env[key]]),
	);
	process.env.PHI_CODING_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SUBAGENT_ID; // The test runner itself may be a subagent.
});

afterEach(async () => {
	for (const extension of mounted.splice(0).reverse()) await extension.shutdown();
	for (const member of standalone.splice(0).reverse()) await member.close();
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(agentDir, { recursive: true, force: true });
});

async function fire(extension: Extension, event: string, context: ExtensionContext): Promise<void> {
	for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event } as never, context);
}

async function mount(
	name: string,
	sessionId: string,
	options: { remote?: boolean; hasUI?: boolean; cwd?: string } = {},
): Promise<Mounted> {
	const sent: SentMessage[] = [];
	const runtime = createExtensionRuntime();
	runtime.sendMessage = ((message: Record<string, unknown>, sendOptions?: Record<string, unknown>) => {
		sent.push({ message, options: sendOptions });
	}) as never;
	runtime.getAllTools = (() => (options.remote ? [{ name: "agent_send" }] : [])) as never;
	let sessionName = name;
	const context = {
		hasUI: options.hasUI ?? true,
		mode: "tui",
		cwd: options.cwd ?? `/tmp/work/${name}`,
		model: { id: "test-model" },
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => sessionName,
		},
	} as unknown as ExtensionContext;
	const extension = await loadExtensionFromFactory(
		agentMailExtension,
		context.cwd,
		createEventBus(),
		runtime,
		`<mail:${name}>`,
	);
	const result = {
		extension,
		context,
		sent,
		shutdown: () => fire(extension, "session_shutdown", context),
		setName: (value: string) => {
			sessionName = value;
		},
	};
	mounted.push(result);
	await fire(extension, "session_start", context);
	return result;
}

async function call(mounted: Mounted, name: "agent_list" | "agent_message", params: Record<string, string> = {}) {
	const tool = mounted.extension.tools.get(name)?.definition;
	expect(tool).toBeDefined();
	return tool!.execute("call-1", params, undefined, undefined, toolContext(mounted.context));
}

async function startMember(
	id: string,
	name: string,
	onMessage: (envelope: MailEnvelope) => void,
): Promise<AgentMailMember> {
	const member = new AgentMailMember({
		agentDir,
		sessionId: `${id}-0000-4000-8000-000000000000`,
		name,
		cwd: `/tmp/work/${name}`,
		onMessage,
	});
	standalone.push(member);
	await member.start();
	return member;
}

/** Exercise real socket framing, independently of AgentMailMember.send(). */
async function rawRequest(socket: string, request: unknown): Promise<{ status: string; reason?: string }> {
	return new Promise((resolve, reject) => {
		const client = createConnection(socket);
		let text = "";
		client.on("connect", () => client.write(`${JSON.stringify(request)}\n`));
		client.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
			if (text.includes("\n")) {
				resolve(JSON.parse(text.slice(0, text.indexOf("\n"))));
				client.destroy();
			}
		});
		client.on("error", reject);
		client.on("end", () => {
			if (!text.includes("\n")) reject(new Error("Socket closed without a receipt"));
		});
	});
}

describe("built-in agent mail", () => {
	it("exchanges messages over a real local socket, updates presence, and removes files at shutdown", async () => {
		const a = await mount("one", "deadbeef-0000-4000-8000-000000000000");
		const b = await mount("two", "deadbeef-1111-4000-8000-000000000000");
		const directory = join(agentDir, "mail");
		const first = "deadbeef";
		const entries = (await call(a, "agent_list")).details as {
			members: Array<{ id: string; name: string; state: string }>;
		};
		expect(entries.members).toHaveLength(1);
		expect(entries.members[0].id).toMatch(/^deadbeef-[0-9a-f]{8}$/);
		expect(entries.members[0].state).toBe("idle");
		const firstRecord = JSON.parse(readFileSync(join(directory, `${first}.json`), "utf8"));
		expect(firstRecord).toMatchObject({
			id: first,
			name: "one",
			sessionId: "deadbeef-0000-4000-8000-000000000000",
			pid: process.pid,
			model: "test-model",
			state: "idle",
		});
		if (process.platform !== "win32") {
			expect(firstRecord.socket).toBe(join(directory, `${first}.sock`));
			expect(statSync(join(directory, `${first}.json`)).mode & 0o777).toBe(0o600);
			expect(statSync(directory).mode & 0o777).toBe(0o700);
			expect(statSync(firstRecord.socket).mode & 0o777).toBe(0o600);
		} else expect(firstRecord.socket).toContain("\\pipe\\phi-mail-");
		await fire(b.extension, "agent_start", b.context);
		const receipt = (await call(a, "agent_message", { to: entries.members[0].id, message: "please pause" }))
			.details as { status: string; state: string; text: string };
		expect(receipt).toMatchObject({ status: "delivered", state: "busy" });
		expect(receipt.text.split("\n")[0]).toBe('{"status":"delivered","state":"busy"}');
		expect(receipt.text).toContain("queued as steer");
		expect(receipt.text).toContain("not that the message was read or answered");
		expect(b.sent).toEqual([
			{
				message: {
					customType: "agent_mail",
					display: true,
					content: `[message from agent "one" (${first}) in /tmp/work/one — another phi session, not the user]\nplease pause\nReply with agent_message {"to":"${first}","message":"..."} if a reply is needed.`,
					details: { from: { id: first, name: "one", cwd: "/tmp/work/one" }, replyTo: undefined },
				},
				options: { deliverAs: "steer", triggerTurn: true },
			},
		]);
		await fire(b.extension, "agent_settled", b.context);
		const idle = (await call(a, "agent_message", { to: entries.members[0].id, message: "follow-up" })).details as {
			status: string;
			state: string;
			text: string;
		};
		expect(idle).toMatchObject({ status: "delivered", state: "idle" });
		expect(idle.text).toContain("triggered a new turn");
		b.setName("Second Agent");
		await fire(b.extension, "session_info_changed", b.context);
		expect((await call(a, "agent_list")).content[0]).toMatchObject({ text: expect.stringContaining("Second Agent") });
		const reply = (await call(b, "agent_message", { to: first, message: "acknowledged" })).details as {
			status: string;
		};
		expect(reply.status).toBe("delivered");
		expect(a.sent[0].message.content).toContain(`[message from agent "Second Agent" (${entries.members[0].id})`);
		await b.shutdown();
		expect(existsSync(join(directory, `${entries.members[0].id}.json`))).toBe(false);
		if (process.platform !== "win32")
			expect(existsSync(join(directory, `${entries.members[0].id}.sock`))).toBe(false);
		expect((await call(a, "agent_list")).content[0]).toMatchObject({ text: "(no other live phi sessions)" });
	});

	it.skipIf(process.platform === "win32")("does not clobber an occupied socket with no registry entry", async () => {
		const directory = join(agentDir, "mail");
		mkdirSync(directory);
		const orphan = createServer();
		const socket = join(directory, "dddddddd.sock");
		await new Promise<void>((resolve) => orphan.listen(socket, resolve));
		try {
			const member = await startMember("dddddddd", "new", () => {});
			expect(member.record.id).toMatch(/^dddddddd-[0-9a-f]{8}$/);
			expect(existsSync(socket)).toBe(true);
		} finally {
			await new Promise<void>((resolve) => orphan.close(() => resolve()));
		}
	});

	it("cleans dead-pid entries and their socket files, without listing them", async () => {
		const active = await startMember("11111111", "active", () => {});
		const stale = join(agentDir, "mail", "ffffffff.json");
		const socket = join(agentDir, "mail", "ffffffff.sock");
		writeFileSync(socket, "stale");
		writeFileSync(
			stale,
			JSON.stringify({
				id: "ffffffff",
				sessionId: "ffffffff-0000-4000-8000-000000000000",
				name: "stale",
				cwd: "/tmp",
				pid: 2_147_483_647,
				socket,
				state: "idle",
				startedAt: Date.now(),
			}),
		);
		expect(active.list()).toEqual([]);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(socket)).toBe(false);
	});

	it("points the reply hint of an overseer thread report at overseer send, not the sender's mail id", async () => {
		const overseer = await mount("boss", "abcdabcd-0000-4000-8000-000000000000");
		const sender = await startMember("abcdabcd", "api thread", () => {});
		const receipt = await sender.send("boss", "[thread api thread · question] v1 or v2?", {
			thread: { name: "api thread", kind: "question" },
		});
		expect(receipt.status).toBe("delivered");
		const delivered = overseer.sent[0].message as { content: string; details: Record<string, unknown> };
		expect(delivered.content.split("\n")).toEqual([
			`[message from agent "api thread" (${sender.record.id}) in /tmp/work/api thread — another phi session, not the user]`,
			"[thread api thread · question] v1 or v2?",
			'Reply with overseer {"action":"send","target":"api thread","message":"..."} if a reply is needed (a report from your overseer thread; do not agent_message it).',
		]);
		expect(delivered.content).not.toContain("agent_message {");
		expect(delivered.details.thread).toEqual({ name: "api thread", kind: "question" });
		// A plain message keeps the agent_message hint.
		await sender.send("boss", "hello");
		expect((overseer.sent[1].message as { content: string }).content).toContain(
			`Reply with agent_message {"to":"${sender.record.id}"`,
		);
		// A malformed marker is refused like any other bad envelope.
		const socket = JSON.parse(readFileSync(join(agentDir, "mail", "abcdabcd.json"), "utf8")).socket;
		const bad = await rawRequest(socket, {
			v: 1,
			from: { id: sender.record.id, name: sender.record.name, cwd: sender.record.cwd },
			message: "x",
			thread: { name: 42, kind: "done" },
		});
		expect(bad).toEqual({ status: "denied", reason: "invalid envelope" });
	});

	it("rejects unknown and ambiguous names and prefixes, with candidate ids", async () => {
		const a = await startMember("22222222", "sender", () => {});
		const b = await startMember("22222222", "Duplicated", () => {});
		const c = await startMember("22222222", "duplicated", () => {});
		await expect(a.send("duplicated", "hi")).rejects.toThrow(/Ambiguous agent.*Candidates:.*22222222-/);
		await expect(a.send("22222222-", "hi")).rejects.toThrow(/Ambiguous agent/);
		await expect(a.send("unknown", "hi")).rejects.toThrow(/Unknown agent.*Candidates:.*Duplicated/);
		await expect(a.send(a.record.id, "hi")).rejects.toThrow(/yourself/);
		expect(b.record.id).not.toBe(c.record.id);
	});

	it("enforces outbound and inbound 16 KiB, then 30 messages per sender per minute", async () => {
		const received: MailEnvelope[] = [];
		const a = await startMember("33333333", "sender", () => {});
		const b = await startMember("44444444", "recipient", (message) => received.push(message));
		await expect(a.send(b.record.id, "😀".repeat(MAX_MESSAGE_BYTES / 4 + 1))).rejects.toThrow(/16 KiB/);
		const tooLarge = await rawRequest(b.record.socket, {
			v: 1,
			from: { id: a.record.id, name: a.record.name, cwd: a.record.cwd },
			message: "X".repeat(MAX_MESSAGE_BYTES + 1),
		});
		expect(tooLarge).toMatchObject({ status: "denied", reason: expect.stringContaining("16 KiB") });
		for (let i = 0; i < 30; i++) expect((await a.send(b.record.id, `message ${i}`)).status).toBe("delivered");
		expect(received).toHaveLength(30);
		const limited = await a.send(b.record.id, "message 31");
		expect(limited).toMatchObject({ status: "denied", text: expect.stringContaining("rate limit (30/minute)") });
		expect(limited.text.split("\n")[0]).toBe('{"status":"denied","reason":"rate limit (30/minute)"}');
		expect(received).toHaveLength(30);
	});

	it("uses a short /tmp socket for long agent paths and reports an absent listener as not running", async () => {
		const longDir = join(agentDir, `deep-${"x".repeat(110)}`);
		const receiver = new AgentMailMember({
			agentDir: longDir,
			sessionId: "aaaaaaaa-0000-4000-8000-000000000000",
			name: "far",
			cwd: "/tmp/far",
			onMessage: () => {},
		});
		standalone.push(receiver);
		await receiver.start();
		if (process.platform === "win32") expect(receiver.record.socket).toContain("\\\\.\\pipe\\phi-mail-");
		else {
			const filename = `phi-mail-${process.getuid?.() ?? "user"}-aaaaaaaa.sock`;
			const preferred = join(tmpdir(), filename);
			expect(receiver.record.socket).toBe(Buffer.byteLength(preferred) <= 100 ? preferred : join("/tmp", filename));
		}
		const sender = await startMember("bbbbbbbb", "sender", () => {});
		const directory = join(agentDir, "mail");
		const missingSocket =
			process.platform === "win32" ? "\\\\.\\pipe\\phi-mail-cccccccc" : join(directory, "cccccccc.sock");
		writeFileSync(
			join(directory, "cccccccc.json"),
			JSON.stringify({
				id: "cccccccc",
				sessionId: "cccccccc-0000-4000-8000-000000000000",
				name: "missing",
				cwd: "/tmp",
				pid: process.pid,
				socket: missingSocket,
				state: "idle",
				startedAt: Date.now(),
			}),
		);
		expect(await sender.send("cccccccc", "hello")).toMatchObject({
			status: "not running",
			text: expect.stringContaining("Message not delivered"),
		});
	});

	it("does not join agent mail when remote-pi provides agent_send", async () => {
		const remote = await mount("remote", "55555555-0000-4000-8000-000000000000", { remote: true });
		expect([...remote.extension.tools.keys()]).toEqual([]);
		expect(existsSync(join(agentDir, "mail"))).toBe(false);
		const sender = await startMember("66666666", "sender", () => {});
		expect(sender.list()).toEqual([]);
		await expect(sender.send("55555555", "hello remote")).rejects.toThrow(/Unknown agent/);
		expect(remote.sent).toHaveLength(0);
	});

	it("agentMail.enabled=false, non-UI mode, and child processes create neither tools nor listeners", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentMail: { enabled: false } }));
		const disabled = await mount("disabled", "77777777-0000-4000-8000-000000000000");
		expect(disabled.extension.tools.size).toBe(0);
		expect(existsSync(join(agentDir, "mail"))).toBe(false);
		rmSync(join(agentDir, "settings.json"));
		const headless = await mount("headless", "88888888-0000-4000-8000-000000000000", { hasUI: false });
		expect(headless.extension.tools.size).toBe(0);
		expect(existsSync(join(agentDir, "mail"))).toBe(false);
		process.env.PI_SUBAGENT_ID = "child";
		const child = await mount("child", "99999999-0000-4000-8000-000000000000");
		expect(child.extension.tools.size).toBe(0);
		expect(existsSync(join(agentDir, "mail"))).toBe(false);
	});
});
