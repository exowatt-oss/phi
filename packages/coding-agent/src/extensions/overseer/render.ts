/**
 * TUI rendering for the overseer: the tool call line, its result (first line collapsed, full text
 * expanded), the batched `overseer_event` message and the `/threads` board entry. Compact and
 * muted, like agent mail's messages.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import type { CustomMessage } from "../../core/messages.ts";
import type { CustomEntry } from "../../core/session-manager.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { oneLine } from "./format.ts";
import type { OverseerEventDetails } from "./types.ts";

interface CallArgs {
	action?: string;
	name?: string;
	target?: string;
	prompt?: string;
	message?: string;
	model?: string;
	backend?: string;
	all?: boolean;
}

export function renderOverseerCall(args: CallArgs, theme: Theme): Text {
	const title = theme.fg("toolTitle", theme.bold("overseer "));
	const action = theme.fg("accent", args.action ?? "?");
	const subject = args.name ?? args.target ?? (args.all ? "all" : "");
	const extras = [args.model, args.backend && args.backend !== "auto" ? args.backend : undefined]
		.filter(Boolean)
		.join(" · ");
	let text = `${title}${action}${subject ? ` ${theme.fg("text", oneLine(subject, 40))}` : ""}${extras ? theme.fg("muted", `  ${extras}`) : ""}`;
	const preview = args.prompt ?? args.message;
	if (preview) text += `\n  ${theme.fg("dim", oneLine(preview, 96))}`;
	return new Text(text, 0, 0);
}

export function renderOverseerResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Text {
	const first = result.content[0];
	const text = first?.type === "text" ? first.text : "";
	if (options.expanded) return new Text(theme.fg("muted", text), 0, 0);
	const lines = text.split("\n");
	const more = lines.length > 1 ? theme.fg("dim", `  (+${lines.length - 1} lines, ctrl+o)`) : "";
	return new Text(`${theme.fg(options.isPartial ? "dim" : "muted", oneLine(lines[0], 160))}${more}`, 0, 0);
}

export function renderOverseerEvent(
	message: CustomMessage<OverseerEventDetails>,
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Text {
	const content = typeof message.content === "string" ? message.content : "[overseer update]";
	if (options.expanded) return new Text(theme.fg("muted", content), options.outputPad, 0);
	const events = message.details?.events ?? [];
	const lines = [content.split("\n")[0]];
	for (const event of events) {
		if (event.kind === "heartbeat") continue;
		lines.push(`  ${event.thread} · ${event.kind}${event.summary ? ` · ${oneLine(event.summary, 100)}` : ""}`);
		if (event.kind === "idle" && event.text) lines.push(`    ${oneLine(event.text, 110)}`);
	}
	return new Text(theme.fg("muted", lines.join("\n")), options.outputPad, 0);
}

export function renderBoardEntry(
	entry: CustomEntry<{ text?: string }>,
	options: { expanded: boolean; outputPad?: number },
	theme: Theme,
): Text {
	const text = entry.data?.text ?? "(no threads)";
	return new Text(theme.fg("muted", text), options.outputPad ?? 0, 0);
}
