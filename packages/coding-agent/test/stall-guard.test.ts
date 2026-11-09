import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { Extension } from "../src/core/extensions/types.ts";
import stallGuardExtension, {
	detectStall,
	STALL_NUDGE_MESSAGE_TYPE,
	STALL_RESUME_NOTE_MESSAGE_TYPE,
	STALL_WARNING_MESSAGE_TYPE,
} from "../src/extensions/stall-guard/index.ts";

/**
 * v4 is calibrated against ten days of sessions: reports and handoffs are
 * structurally safe, while empty output, telegraphic self-talk, and short
 * commitments/bare promises/status lines trigger a quiet capped continuation.
 */

type Handler = (event: unknown, ctx: unknown) => unknown;
type Handlers = Map<string, Handler[]>;
type SentMessage = {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
};

type TestContext = {
	ui: { setStatus: (key: string, text: string | undefined) => void };
	sessionManager: { getBranch: () => never[] };
};

function assistant(text: string, extra: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		content: text.length > 0 ? [{ type: "text", text }] : [],
		stopReason: "stop",
		usage: { reasoning: 0 },
		...extra,
	} as never;
}

function assistantWithBlocks(content: unknown[], extra: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		content,
		stopReason: "stop",
		usage: { reasoning: 0 },
		...extra,
	} as never;
}

function assistantStop(text: string, reasoning: number | undefined, toolCallIncluded = false) {
	const content: unknown[] = [{ type: "text", text }];
	if (toolCallIncluded) content.push({ type: "toolCall", id: "c1", name: "bash", arguments: {} });
	return {
		role: "assistant",
		content,
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 1000,
			output: 32,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 363_707,
			...(reasoning === undefined ? {} : { reasoning }),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as never;
}

function toolCall(name: string, argumentsValue: unknown) {
	return { type: "toolCall", id: `${name}-1`, name, arguments: argumentsValue };
}

function toolResult(details?: unknown) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: details === undefined ? "bash" : "subagent",
			content: [],
			isError: false,
			...(details === undefined ? {} : { details }),
		},
	} as never;
}

function contextFor(branch: never[], statuses: Array<{ key: string; text: string | undefined }>): TestContext {
	return {
		ui: { setStatus: (key, text) => statuses.push({ key, text }) },
		sessionManager: { getBranch: () => branch },
	};
}

async function loadGuard() {
	const runtime = createExtensionRuntime();
	const sent: SentMessage[] = [];
	runtime.sendMessage = ((message: Record<string, unknown>, options: Record<string, unknown> | undefined) => {
		sent.push({ message, options });
	}) as never;
	const extension = await loadExtensionFromFactory(
		stallGuardExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"<inline:stall-guard>",
	);
	return { extension, sent };
}

async function invoke(extension: Extension, name: string, event: unknown, context: TestContext): Promise<void> {
	for (const handler of (extension.handlers as Handlers).get(name) ?? []) await handler(event, context);
}

describe("stall guard v4 detection", () => {
	it.each([
		"Need maybe mobile screenshot… Then close… Need maybe inspect… let's.",
		"Need maybe inspect screenshot. Then close. Need maybe check browser console. Let's.",
		"Fine. Need cleanup. Then final with COMPLETE and verification output. But before final, check the rollout. Need maybe user says mtd only. Need ensure all work finished. Cleanup now.",
		"Continuing.",
		"I'm at the final shipping stage now.",
		"You have 65388 tokens left",
	])("marks the calibrated stall %j as stalled", (text) => {
		expect(detectStall(assistant(text))).toMatchObject({ stalled: true });
	});

	it("marks an empty text-only stop as stalled", () => {
		expect(detectStall(assistant(""))).toMatchObject({
			stalled: true,
			reason: expect.stringContaining("empty stop"),
		});
	});

	it("treats a session_notes call as an ordinary tool call", () => {
		expect(
			detectStall(
				assistantWithBlocks([toolCall("session_notes", { epic: "ex-123" }), { type: "text", text: "Continuing." }]),
			),
		).toEqual({ stalled: false, reason: "stop included a tool call" });
	});

	it("does not nudge an empty stop containing an ordinary tool call", () => {
		expect(detectStall(assistantWithBlocks([toolCall("bash", {})]))).toEqual({
			stalled: false,
			reason: "stop included a tool call",
		});
	});

	it.each(["complete", "pause"])("does not stall a terminal loop_control action: %s", (action) => {
		expect(detectStall(assistantWithBlocks([toolCall("loop_control", JSON.stringify({ action }))]))).toMatchObject({
			stalled: false,
		});
	});

	it("lets loop_control own continuation for every action", () => {
		expect(detectStall(assistantWithBlocks([toolCall("loop_control", { action: "continue" })]))).toEqual({
			stalled: false,
			reason: "loop_control owns continuation",
		});
	});

	it("ignores any ordinary tool call before reading text", () => {
		expect(
			detectStall(assistantWithBlocks([toolCall("bash", {}), { type: "text", text: "Continuing." }])),
		).toMatchObject({
			stalled: false,
		});
	});

	it("does not use reasoning token counts as a verdict gate", () => {
		expect(
			detectStall(assistant("I'm at the final shipping stage now.", { usage: { reasoning: 128 } })),
		).toMatchObject({
			stalled: true,
		});
	});

	it.each([
		"Shipped: PR #42 merged, CI green.\n\n- deploy ran\n- smoke passed\n\nNext steps: none.",
		"Pipeline: parse → validate → emit. Done.",
		"I'll leave the flag off by default; the PR is merged and deployed.",
		"Want me to finish that?",
		"Blocked: I need your Okta admin to approve the grant before I can continue.",
		"Wave C is running in the background; Wave D goes next once it reports.",
		"One paragraph of prose is here.\n\nA second paragraph gives the outcome.\n\nA third paragraph records the follow-up.",
		"Done. All 42 tests pass.",
		"Shipped. PR #42 merged. CI green.",
		"Done. Tests pass. Pushed.",
		"Run `npm test` to verify. Open the PR link above. Done.",
		"I'm going to stop here — everything is shipped.",
		"Continuing from the last session, the deploy finished and all checks pass.",
		"Now the deploy is live. Next, run the smoke test. Done.",
	])("does not stall the legitimate final text %j", (text) => {
		expect(detectStall(assistant(text))).toMatchObject({ stalled: false });
	});

	it("still catches a deliberative telegraphic wall without completion claims", () => {
		expect(detectStall(assistant("Need to check the logs. Then rerun. Maybe the cache."))).toMatchObject({
			stalled: true,
		});
	});

	it("does not let a COMPLETE or BLOCKED word shield change the form decision", () => {
		expect(
			detectStall(
				assistant(
					"Fine. Need cleanup. Then final with COMPLETE and verification output. But before final, check the rollout. Need maybe user says mtd only. Need ensure all work finished. Cleanup now.",
				),
			),
		).toMatchObject({ stalled: true });
	});
});

describe("historical stall guard detector regressions", () => {
	it.each([
		"Local implementation and validation are complete. I’m at the final shipping stage now: commit, PR/merge, deployment, and production verification.",
		"Continuing. All 451 backend tests are green. I’m moving directly through manifest.",
		"T-002 is accepted and closed. T-003 is now implementing the typed registry.",
		"T-002 connectivity history is accepted and fully green. The next controller slice is direct commander and router/site commitment recording.\n\nT-010 remains blocked only on honest browser evidence.",
		"T-002 and the full UI workstream are complete. UI PR #369 is merged and its main-built immutable image is published.\n\nWork continues now on T-003 historical interval readers and controller-side report generation.",
		"I found the current Agentwatch layout issue. The pasted temp image expired, but the live slide reproduces it. I’ve started a responsive fix and will validate it at desktop, tablet, mobile, 320px, and short landscape sizes before shipping.",
		"On it. I’ve reproduced the narrow-screen failure, implemented the adaptive layout, and I’m validating the rendered breakpoints now. Next is regression suite → merge → deploy → live verification. I’ll ping you once the production URL is confirmed working.",
		"You’re right — I paused again when I should have kept executing. The fix is now implemented, validated, committed, and pushed. I’m opening and merging the PR next, then I’ll stay on the deployment until production is verified.",
	])("restores the historical short commitment stall %j", (text) => {
		expect(detectStall(assistantStop(text, 0))).toMatchObject({ stalled: true });
	});

	it("still catches the dialect-4 wall and BLOCKED-prefixed leaked reasoning", () => {
		expect(
			detectStall(
				assistantStop(
					"Oops we need not end final; but here system provided tool screenshot? Actually after tool output was enormous image attachment from prior? We are still in analysis but maybe no. Need proceed.\n\nNeed request re-review because pushed. Copilot comments fixed. Reply to comments. Could POST replies. Then re-request review. We can do one re-review. We need ensure PR head updated and checks rerun maybe CodeQL. Reply. Use gh api. Do.",
					0,
				),
			),
		).toMatchObject({ stalled: true });
		expect(
			detectStall(
				assistantStop(
					"BLOCKED: exact user must act. But no! Need keep going, user says. We need tool call now. We have no issue; continue. We should not talk. First fix progress count CSS and maybe logo.",
					0,
				),
			),
		).toMatchObject({ stalled: true });
		expect(
			detectStall(
				assistantStop(
					'BLOCKED: Need continue tools, not final. Wait this is in final accidentally? I responded final with "BLOCKED"? We need actually continue in next assistant turn? We need continue without final. Good.',
					0,
				),
			),
		).toMatchObject({ stalled: true });
	});

	it("flags hallucinated status lines regardless of reasoning tokens", () => {
		for (const [text, reasoning] of [
			["You have 65388 tokens left", 0],
			["You have 62531 tokens left.", 0],
			["You have 8022 weighted tokens left", 181],
			["You've got 8017 weighted tokens left", 0],
			["You have 3586 weighted tokens left\n", 53],
		] as const) {
			expect(detectStall(assistantStop(text, reasoning))).toMatchObject({ stalled: true });
		}
		expect(
			detectStall(assistantStop("You have 65388 tokens left in the gateway budget, so a full re-run fits.", 400)),
		).toMatchObject({ stalled: false });
	});

	it("does not shield handoffs, terminal answers, or questions", () => {
		for (const text of [
			"BLOCKED: we need your Okta admin to approve the SSO grant before I can log in.",
			"BLOCKED: I need the Grafana admin key from you to continue.",
			"COMPLETE — all 34 tests green, feed verified.",
			"The fix is ready. Do you want me to also update the runbook?",
			"I can take the riskier path or the safe one — which option do you prefer?",
			"Done. Shipped the fix as 0.83.0-exo.5 and verified the feed.",
			"Wrapped up.",
			"Done — I'm going to stop here.",
		]) {
			expect(detectStall(assistantStop(text, 0)), text).toMatchObject({ stalled: false });
		}
	});

	it("reasoning tokens neither shield nor trigger the short commitment", () => {
		// The reasoning gate was deliberately removed: 12% of healthy GPT tool
		// turns and 62% of healthy Anthropic tool turns report zero reasoning.
		for (const reasoning of [0, 250, undefined]) {
			expect(detectStall(assistantStop("I’m now implementing the registry.", reasoning))).toMatchObject({
				stalled: true,
			});
		}
	});

	it("keeps a short commitment with a real tool call out of the verdict", () => {
		expect(detectStall(assistantStop("I’m now implementing the registry.", 0, true))).toMatchObject({
			stalled: false,
		});
	});

	it("keeps an ordinary budget sentence out of the verdict", () => {
		expect(
			detectStall(assistantStop("You have 65388 tokens left in the gateway budget, so a full re-run fits.", 400)),
		).toMatchObject({ stalled: false });
	});
});

describe("stall guard v4 handler", () => {
	beforeEach(() => {
		vi.stubEnv("PI_SUBAGENT_ID", undefined);
		vi.stubEnv("PI_STALL_GUARD", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("sends at most three ephemeral hidden nudges, then one dim warning", async () => {
		const { extension, sent } = await loadGuard();
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const branch = [toolResult()];
		const context = contextFor(branch, statuses);
		const event = { type: "agent_end", messages: [assistant("Continuing.")] };

		for (let i = 0; i < 5; i++) await invoke(extension, "agent_end", event, context);

		const nudges = sent.filter(({ message }) => message.customType === STALL_NUDGE_MESSAGE_TYPE);
		expect(nudges).toHaveLength(3);
		expect(sent.filter(({ message }) => message.customType === STALL_WARNING_MESSAGE_TYPE)).toHaveLength(1);
		expect(nudges[0]).toMatchObject({
			message: { display: false, ephemeral: true, customType: STALL_NUDGE_MESSAGE_TYPE },
			options: { triggerTurn: true },
		});
		expect(nudges[0]?.message.content).toContain("Automatic reminder 1/3");
		expect(nudges[0]?.message.content).not.toMatch(/COMPLETE|BLOCKED|verification/i);
		expect(sent.at(-1)).toMatchObject({
			message: {
				customType: STALL_WARNING_MESSAGE_TYPE,
				display: true,
				ephemeral: true,
				content: "stall guard: 3 continuations this prompt — stopping; give it a concrete next command",
			},
		});
	});

	it("resets the cap at a real user input and clears the footer", async () => {
		const { extension, sent } = await loadGuard();
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const context = contextFor([toolResult()], statuses);
		const event = { type: "agent_end", messages: [assistant("Continuing.")] };
		for (let i = 0; i < 4; i++) await invoke(extension, "agent_end", event, context);
		const beforeReset = sent.filter(({ message }) => message.customType === STALL_NUDGE_MESSAGE_TYPE).length;
		expect(beforeReset).toBe(3);

		await invoke(extension, "input", { type: "input", text: "continue", source: "interactive" }, context);
		await invoke(extension, "agent_end", event, context);
		expect(sent.filter(({ message }) => message.customType === STALL_NUDGE_MESSAGE_TYPE)).toHaveLength(4);
		expect(statuses.at(-1)).toEqual({ key: "stall-guard", text: "↻ stall guard: continued 1/3" });
	});

	it("resets the counter when a stall is suppressed by background work", async () => {
		const { extension, sent } = await loadGuard();
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const branch = [toolResult()];
		const context = contextFor(branch, statuses);
		const event = { type: "agent_end", messages: [assistant("Continuing.")] };

		await invoke(extension, "agent_end", event, context);
		expect(sent).toHaveLength(1);
		expect(statuses.at(-1)).toEqual({ key: "stall-guard", text: "↻ stall guard: continued 1/3" });

		branch[0] = toolResult({ background: true, runs: [{ runId: "run-1", name: "worker" }] });
		await invoke(extension, "agent_end", event, context);
		expect(sent).toHaveLength(1);
		expect(statuses.at(-1)).toEqual({
			key: "stall-guard",
			text: "⏸ turn ended without tool calls · 1 background agents running",
		});

		branch[0] = toolResult();
		await invoke(extension, "agent_end", event, context);
		expect(sent).toHaveLength(2);
		expect(sent.at(-1)).toMatchObject({ message: { customType: STALL_NUDGE_MESSAGE_TYPE } });
		expect(statuses.at(-1)).toEqual({ key: "stall-guard", text: "↻ stall guard: continued 1/3" });
	});

	it("resets the counter when no tool has ever run", async () => {
		const { extension, sent } = await loadGuard();
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const branch: never[] = [];
		const context = contextFor(branch, statuses);
		await invoke(extension, "agent_end", { type: "agent_end", messages: [assistant("Continuing.")] }, context);
		expect(sent).toHaveLength(0);
		expect(statuses.at(-1)).toEqual({
			key: "stall-guard",
			text: "⏸ turn ended without tool calls · 0 background agents running",
		});

		branch.push(toolResult());
		await invoke(extension, "agent_end", { type: "agent_end", messages: [assistant("Continuing.")] }, context);
		expect(sent).toHaveLength(1);
	});

	it("sends an ephemeral hidden resume note and footer status", async () => {
		const { extension, sent } = await loadGuard();
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const branch = [toolResult(), { type: "message", message: assistant("Continuing.") } as never];
		const context = contextFor(branch, statuses);
		await invoke(extension, "session_start", { type: "session_start", reason: "resume" }, context);

		expect(sent).toMatchObject([
			{
				message: { customType: STALL_RESUME_NOTE_MESSAGE_TYPE, display: false, ephemeral: true },
			},
		]);
		expect(statuses.at(-1)).toEqual({
			key: "stall-guard",
			text: "stall guard: last turn ended mid-work with nothing running — your next prompt resumes it",
		});
	});
});
