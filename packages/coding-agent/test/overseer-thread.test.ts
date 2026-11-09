import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentMailMember,
	listMailRecords,
	type MailEnvelope,
	mailContent,
} from "../src/extensions/agent-mail/transport.ts";
import {
	deliverReport,
	frameReport,
	THREAD_SECTION,
	threadInfoFromEnv,
	threadPromptBlock,
} from "../src/extensions/overseer/thread.ts";
import { FakeHub, mountOverseer, testDeps } from "./overseer-helpers.ts";
import { toolContext } from "./tool-context.ts";

const OVERSEER = "0190aaaa-0000-7000-8000-00000000beef";
const THREAD = "0190bbbb-1111-7000-8000-000000000001";

let agentDir: string;
const members: AgentMailMember[] = [];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "phi-ovs-thread-"));
});

afterEach(async () => {
	for (const member of members.splice(0)) await member.close();
	rmSync(agentDir, { recursive: true, force: true });
});

async function member(sessionId: string, name: string, inbox: MailEnvelope[] = []): Promise<AgentMailMember> {
	const instance = new AgentMailMember({
		agentDir,
		sessionId,
		name,
		cwd: `/tmp/work/${name}`,
		onMessage: (envelope) => inbox.push(envelope),
	});
	await instance.start();
	members.push(instance);
	return instance;
}

describe("overseer thread prompt", () => {
	it("reads the thread env", () => {
		expect(threadInfoFromEnv({})).toBeUndefined();
		expect(threadInfoFromEnv({ PHI_OVERSEER_SESSION_ID: "  " })).toBeUndefined();
		expect(
			threadInfoFromEnv({
				PHI_OVERSEER_SESSION_ID: OVERSEER,
				PHI_OVERSEER_NAME: "boss",
				PHI_OVERSEER_THREAD: "api",
				PHI_SUBAGENT_MODEL_DEFAULT: "gateway/example-medium:max",
				PHI_SUBAGENT_MODEL_ALLOW: "",
			}),
		).toEqual({
			overseerSessionId: OVERSEER,
			overseerName: "boss",
			thread: "api",
			subagentDefault: "gateway/example-medium:max",
			subagentAllow: undefined,
		});
	});

	it("names the overseer, the reporting rules and the subagent policy", () => {
		const block = threadPromptBlock(
			{
				overseerSessionId: OVERSEER,
				overseerName: "boss",
				thread: "api",
				subagentDefault: "gateway/example-medium:max",
				subagentAllow: "gateway/*",
			},
			"fallback",
		);
		expect(block.split("\n")).toEqual([
			'You are thread "api" of overseer "boss" (session 0190aaaa): another phi session that started you and coordinates several threads for the user.',
			'Messages headed "[overseer …]" come from that overseer acting for the user: follow them as you would the user\'s.',
			'Use report_to_overseer for a question (kind "question"), a blocker ("blocker"), notable progress ("progress") and when you finish ("done"). Keep reports short and concrete.',
			"Do not stop to wait for an answer unless you are truly blocked: make a reasonable choice, report it, and keep going.",
			"Your final reply when you go idle also reaches the overseer, so end each piece of work with a clear status.",
			"Subagent model policy (set by the overseer): subagent tasks that name no model run on gateway/example-medium:max; only these subagent models are allowed: gateway/*.",
		]);
		expect(threadPromptBlock({ overseerSessionId: OVERSEER }, "work")).toContain(
			'You are thread "work" of overseer "overseer"',
		);
		expect(threadPromptBlock({ overseerSessionId: OVERSEER }, "work")).not.toContain("Subagent model policy");
	});

	it("adds a prompt section, or appends to a prompt another handler replaced", async () => {
		const m = await mountOverseer({
			deps: testDeps(new FakeHub(), agentDir, {
				env: { PHI_OVERSEER_SESSION_ID: OVERSEER, PHI_OVERSEER_THREAD: "api" },
			}),
			cwd: "/tmp",
		});
		const options = { sections: {} as Record<string, string>, forceSystemPrompt: undefined as string | undefined };
		const [result] = await m.fire("before_agent_start", { systemPromptOptions: options, systemPrompt: "BASE" });
		expect(result).toBeUndefined();
		expect(options.sections[THREAD_SECTION]).toContain('You are thread "api"');

		const forced = { sections: {} as Record<string, string>, forceSystemPrompt: "FORCED" };
		const [replaced] = (await m.fire("before_agent_start", {
			systemPromptOptions: forced,
			systemPrompt: "FORCED",
		})) as Array<{
			systemPrompt: string;
		}>;
		expect(replaced.systemPrompt.startsWith(`FORCED\n\n<${THREAD_SECTION}>\nYou are thread "api"`)).toBe(true);
		expect(replaced.systemPrompt.endsWith(`</${THREAD_SECTION}>`)).toBe(true);
		expect(forced.sections).toEqual({});
	});
});

describe("report_to_overseer delivery", () => {
	it("delivers to the overseer's member through a short-lived member of this session", async () => {
		const inbox: MailEnvelope[] = [];
		await member(OVERSEER, "boss", inbox);
		const receipt = await deliverReport({
			agentDir,
			overseerSessionId: OVERSEER,
			overseerName: "boss",
			ownSessionId: THREAD,
			threadName: "api",
			cwd: "/tmp/work/api",
			kind: "question",
			message: "Two schemas exist; use v2?",
		});
		expect(receipt).toMatchObject({ status: "delivered", state: "idle", to: "0190aaaa" });
		expect(receipt.text).toMatch(/^Delivered to overseer "boss" \(idle: the report starts its turn\)/);
		expect(inbox).toHaveLength(1);
		expect(inbox[0].message).toBe("[thread api · question] Two schemas exist; use v2?");
		expect(inbox[0].from).toMatchObject({ name: "api", cwd: "/tmp/work/api" });
		// Marked as a thread report: the overseer's hint says overseer send, not agent_message.
		expect(inbox[0].thread).toEqual({ name: "api", kind: "question" });
		expect(mailContent(inbox[0])).toMatch(
			/\nReply with overseer \{"action":"send","target":"api","message":"\.\.\."\} if a reply is needed/,
		);
		// The temporary member is gone again.
		expect(listMailRecords(join(agentDir, "mail")).map((record) => record.sessionId)).toEqual([OVERSEER]);
	});

	it("reuses this session's own agent-mail member when it runs one", async () => {
		const inbox: MailEnvelope[] = [];
		await member(OVERSEER, "boss", inbox);
		const own = await member(THREAD, "api");
		const receipt = await deliverReport({
			agentDir,
			overseerSessionId: OVERSEER,
			ownSessionId: THREAD,
			threadName: "api",
			cwd: "/tmp/work/api",
			kind: "done",
			message: "Finished: tests pass.",
		});
		expect(receipt.status).toBe("delivered");
		expect(inbox[0].from.id).toBe(own.record.id);
		expect(inbox[0].message).toBe("[thread api · done] Finished: tests pass.");
		expect(inbox[0].thread).toEqual({ name: "api", kind: "done" });
	});

	it("says the overseer is not reachable when it is not an agent-mail member", async () => {
		await member("0190cccc-0000-7000-8000-000000000000", "someone-else");
		const receipt = await deliverReport({
			agentDir,
			overseerSessionId: OVERSEER,
			overseerName: "boss",
			ownSessionId: THREAD,
			threadName: "api",
			cwd: "/tmp",
			kind: "blocker",
			message: "stuck",
		});
		expect(receipt).toEqual({
			status: "not reachable",
			text: 'Overseer not reachable (overseer "boss" is not a live agent-mail member); your final reply will reach it when you go idle.',
		});
		await expect(
			deliverReport({
				agentDir,
				overseerSessionId: OVERSEER,
				ownSessionId: THREAD,
				threadName: "api",
				cwd: "/tmp",
				kind: "progress",
				message: "é".repeat(9000),
			}),
		).rejects.toThrow(/Report too long/);
		expect(frameReport("a\nb", "progress", "x")).toBe("[thread a b · progress] x");
	});

	it("is a tool of thread sessions that returns the receipt", async () => {
		const inbox: MailEnvelope[] = [];
		await member(OVERSEER, "boss", inbox);
		const m = await mountOverseer({
			deps: testDeps(new FakeHub(), agentDir, {
				env: { PHI_OVERSEER_SESSION_ID: OVERSEER, PHI_OVERSEER_NAME: "boss", PHI_OVERSEER_THREAD: "api" },
			}),
			cwd: "/tmp/work/api",
			sessionId: THREAD,
		});
		const tool = m.extension.tools.get("report_to_overseer")!.definition;
		const result = await tool.execute(
			"call-1",
			{ message: " Need the staging URL. ", kind: "question" } as never,
			undefined,
			undefined,
			toolContext(m.ctx),
		);
		expect((result.details as { status: string }).status).toBe("delivered");
		expect(inbox[0].message).toBe("[thread api · question] Need the staging URL.");
		await expect(
			tool.execute("call-2", { message: "  ", kind: "done" } as never, undefined, undefined, toolContext(m.ctx)),
		).rejects.toThrow(/message is required/);
	});
});
