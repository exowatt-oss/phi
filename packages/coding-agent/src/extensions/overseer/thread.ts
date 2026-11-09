/**
 * Thread side of the overseer: a session started with `PHI_OVERSEER_SESSION_ID` learns who its
 * overseer is (a short system-prompt section) and can report back with `report_to_overseer`,
 * delivered by agent mail to the member whose session id is the overseer's.
 *
 * The receiving side of agent mail accepts only senders that are live members, so the report goes
 * out under this session's own member when agent mail runs here, else under a short-lived member
 * started just for the send (same session id, name and cwd), closed right after.
 */

import { basename, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import {
	AgentMailMember,
	listMailRecords,
	liveMailMembers,
	MAX_MESSAGE_BYTES,
	type MailRecord,
} from "../agent-mail/transport.ts";
import { oneLine } from "./format.ts";
import { ThreadBannerWidget } from "./tui.ts";
import type { OverseerDeps } from "./types.ts";

export const REPORT_KINDS = ["question", "blocker", "progress", "done"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const MAX_REPORT_CHARS = 8192;
export const THREAD_SECTION = "overseer_thread";

export interface ThreadInfo {
	overseerSessionId: string;
	overseerName?: string;
	thread?: string;
	subagentDefault?: string;
	subagentAllow?: string;
}

/** The overseer link of this process, from its environment; undefined when it is not a thread. */
export function threadInfoFromEnv(env: NodeJS.ProcessEnv): ThreadInfo | undefined {
	const overseerSessionId = env.PHI_OVERSEER_SESSION_ID?.trim();
	if (!overseerSessionId) return undefined;
	const value = (key: string) => {
		const text = env[key]?.trim();
		return text ? text : undefined;
	};
	return {
		overseerSessionId,
		overseerName: value("PHI_OVERSEER_NAME"),
		thread: value("PHI_OVERSEER_THREAD"),
		subagentDefault: value("PHI_SUBAGENT_MODEL_DEFAULT"),
		subagentAllow: value("PHI_SUBAGENT_MODEL_ALLOW"),
	};
}

/** The system-prompt section a thread gets (body only; the section tag wraps it). */
export function threadPromptBlock(info: ThreadInfo, fallbackName: string): string {
	const thread = oneLine(info.thread ?? fallbackName, 80);
	const overseer = oneLine(info.overseerName ?? "overseer", 80);
	const lines = [
		`You are thread "${thread}" of overseer "${overseer}" (session ${info.overseerSessionId.slice(0, 8)}): another phi session that started you and coordinates several threads for the user.`,
		'Messages headed "[overseer …]" come from that overseer acting for the user: follow them as you would the user\'s.',
		'Use report_to_overseer for a question (kind "question"), a blocker ("blocker"), notable progress ("progress") and when you finish ("done"). Keep reports short and concrete.',
		"Do not stop to wait for an answer unless you are truly blocked: make a reasonable choice, report it, and keep going.",
		"Your final reply when you go idle also reaches the overseer, so end each piece of work with a clear status.",
	];
	if (info.subagentDefault || info.subagentAllow) {
		const parts: string[] = [];
		if (info.subagentDefault)
			parts.push(`subagent tasks that name no model run on ${oneLine(info.subagentDefault, 120)}`);
		if (info.subagentAllow) parts.push(`only these subagent models are allowed: ${oneLine(info.subagentAllow, 400)}`);
		lines.push(`Subagent model policy (set by the overseer): ${parts.join("; ")}.`);
	}
	return lines.join("\n");
}

export interface ReportReceipt {
	status: "delivered" | "not reachable";
	text: string;
	/** The overseer's agent-mail id, when found. */
	to?: string;
	state?: "busy" | "idle";
}

export interface ReportOptions {
	agentDir: string;
	overseerSessionId: string;
	overseerName?: string;
	ownSessionId: string;
	threadName: string;
	cwd: string;
	kind: ReportKind;
	message: string;
	/** Agent-mail members this process runs (default: the transport's registry). */
	members?: () => AgentMailMember[];
	/** Member used for a one-off send when this session has none (tests inject one). */
	createMember?: (options: ConstructorParameters<typeof AgentMailMember>[0]) => AgentMailMember;
}

const NOT_REACHABLE_TAIL = "your final reply will reach it when you go idle.";

/** `[thread <name> · <kind>] <message>`. */
export function frameReport(threadName: string, kind: ReportKind, message: string): string {
	return `[thread ${oneLine(threadName, 80)} · ${kind}] ${message}`;
}

/** The overseer's agent-mail record: the member whose session id is the overseer's (oldest first). */
export function findOverseerMember(records: readonly MailRecord[], overseerSessionId: string): MailRecord | undefined {
	return records
		.filter((record) => record.sessionId === overseerSessionId)
		.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))[0];
}

/** Deliver a report to the overseer over agent mail. Never throws for delivery failures. */
export async function deliverReport(options: ReportOptions): Promise<ReportReceipt> {
	const framed = frameReport(options.threadName, options.kind, options.message);
	if (Buffer.byteLength(framed) > MAX_MESSAGE_BYTES) {
		throw new Error(`Report too long: at most ${MAX_MESSAGE_BYTES} bytes of UTF-8. Shorten it.`);
	}
	const label = options.overseerName ? `overseer "${oneLine(options.overseerName, 80)}"` : "the overseer";
	const notReachable = (reason: string): ReportReceipt => ({
		status: "not reachable",
		text: `Overseer not reachable (${reason}); ${NOT_REACHABLE_TAIL}`,
	});
	let target: MailRecord | undefined;
	try {
		target = findOverseerMember(listMailRecords(join(options.agentDir, "mail")), options.overseerSessionId);
	} catch (error) {
		return notReachable(`agent mail unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!target) return notReachable(`${label} is not a live agent-mail member`);

	const own = (options.members ?? liveMailMembers)().find(
		(member) => member.record?.sessionId === options.ownSessionId,
	);
	let sender = own;
	let temporary: AgentMailMember | undefined;
	try {
		if (!sender) {
			const create = options.createMember ?? ((init) => new AgentMailMember(init));
			temporary = create({
				agentDir: options.agentDir,
				sessionId: options.ownSessionId,
				name: options.threadName,
				cwd: options.cwd,
				onMessage: () => {},
			});
			await temporary.start();
			sender = temporary;
		}
		// The marker makes the overseer's reply hint name this thread (overseer send), not this
		// member's agent-mail id: a temporary member is gone by the time the overseer answers.
		const threadName = options.threadName.trim().slice(0, 256);
		const receipt = await sender.send(
			target.id,
			framed,
			threadName ? { thread: { name: threadName, kind: options.kind } } : {},
		);
		if (receipt.status === "delivered") {
			return {
				status: "delivered",
				to: target.id,
				state: receipt.state,
				text: `Delivered to ${label} (${receipt.state === "busy" ? "busy: it sees the report after its current step" : "idle: the report starts its turn"}). Keep working unless you are blocked; its answer arrives as a message headed [overseer …].`,
			};
		}
		return { ...notReachable(receipt.text.split("\n").at(-1) ?? receipt.status), to: target.id };
	} catch (error) {
		return notReachable(error instanceof Error ? error.message : String(error));
	} finally {
		await temporary?.close();
	}
}

/**
 * Thread side: system-prompt section, `report_to_overseer`, and (in phi's own TUI with
 * `PI_TUI_MODE=1`) a one-line "overseen by" banner below the editor.
 */
export function registerThreadSide(
	pi: ExtensionAPI,
	info: ThreadInfo,
	deps: Pick<OverseerDeps, "agentDir"> & Partial<Pick<OverseerDeps, "env" | "now">>,
): void {
	const banner = new ThreadBannerWidget(info, deps.env ?? process.env, deps.now ?? (() => Date.now()), () =>
		pi.getSessionName(),
	);
	pi.on("session_start", (_event, ctx) => {
		try {
			banner.attach(ctx);
		} catch {
			// The banner is cosmetic; it never breaks the session.
		}
	});
	pi.on("message_start", (event) => {
		banner.observe(event.message);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const fallback = pi.getSessionName() ?? basename(ctx.cwd);
		const block = threadPromptBlock(info, fallback);
		// A handler that replaced the whole prompt earlier wins over sections: append to its text.
		if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
			return { systemPrompt: `${event.systemPrompt}\n\n<${THREAD_SECTION}>\n${block}\n</${THREAD_SECTION}>` };
		}
		event.systemPromptOptions.sections[THREAD_SECTION] = block;
		return undefined;
	});

	pi.registerTool({
		name: "report_to_overseer",
		label: "Report to Overseer",
		description:
			"Send a short report to the overseer session that started this thread: a question, a blocker, notable progress, or that the work is done. Delivered into the overseer's session over local agent mail; returns a receipt (delivered / not reachable). Does not wait for an answer.",
		promptSnippet: "Report a question, blocker, progress or completion to your overseer",
		promptGuidelines: [
			"Use report_to_overseer when you need a decision, are blocked, reach a milestone, or finish. Then keep working unless blocked; answers arrive as [overseer …] messages.",
		],
		parameters: Type.Object({
			message: Type.String({ maxLength: MAX_REPORT_CHARS, description: "The report, at most 8192 characters." }),
			kind: StringEnum(REPORT_KINDS, {
				description: 'What it is: "question", "blocker", "progress" or "done".',
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const message = params.message.trim();
			if (!message) throw new Error("message is required.");
			if (message.length > MAX_REPORT_CHARS)
				throw new Error(`message is longer than ${MAX_REPORT_CHARS} characters.`);
			const receipt = await deliverReport({
				agentDir: deps.agentDir(),
				overseerSessionId: info.overseerSessionId,
				overseerName: info.overseerName,
				ownSessionId: ctx.sessionManager.getSessionId(),
				threadName: info.thread ?? pi.getSessionName() ?? basename(ctx.cwd),
				cwd: ctx.cwd,
				kind: params.kind,
				message,
			});
			return { content: [{ type: "text", text: receipt.text }], details: receipt };
		},
		renderCall(args, theme) {
			const kind = typeof args.kind === "string" ? args.kind : "report";
			const preview = typeof args.message === "string" ? oneLine(args.message, 80) : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("report_to_overseer "))}${theme.fg("accent", kind)} ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},
	});
}
