/**
 * Presentation for the ls tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `ls.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { LsToolDetails } from "../ls.ts";
import { getTextOutput, renderToolPath, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

function formatLsCall(args: { path?: string; limit?: number } | undefined, theme: Theme, cwd: string): string {
	const limit = args?.limit;
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "." });
	let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${pathDisplay}`;
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}
function formatLsResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: LsToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	const entryLimit = result.details?.entryLimitReached;
	const truncation = result.details?.truncation;

	// Minimal display: one muted summary line, no payload. Errors and expanded views keep content.
	if (options.display === "minimal" && !options.expanded && !isError) {
		if (!output) return "";
		const lines = output.split("\n");
		// A single line is a status message such as "(empty directory)": show it as is.
		if (lines.length === 1) return `\n${theme.fg("muted", `⎿ ${lines[0]}`)}`;
		// Entry rows only: execute() appends blank lines plus a bracketed notice when limits were hit.
		const entryCount = lines.filter((line) => line.trim() !== "" && !line.startsWith("[")).length;
		const truncated = entryLimit || truncation?.truncated;
		return `\n${theme.fg("muted", `⎿ ${entryCount} entr${entryCount === 1 ? "y" : "ies"}${truncated ? " · truncated" : ""} (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : (options.collapsedLines ?? 20);
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	if (entryLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (entryLimit) warnings.push(`${entryLimit} entries limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const lsRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatLsCall(args as any, theme, context.cwd));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatLsResult(result as any, options, theme, context.showImages, context.isError));
		return text;
	},
};
