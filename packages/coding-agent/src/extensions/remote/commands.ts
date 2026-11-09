/**
 * phi remote slash commands, session side: the list the phone autocompletes (`commands.list`) and
 * how a `/name args` prompt from the phone is routed.
 *
 * The routing follows the phi TUI: built-ins first, then extension commands, then skills
 * (`/skill:<name>`) and prompt templates expand, and an unknown `/foo` reaches the model as text.
 * Two differences, both for a phone without a terminal: built-ins that need the TUI (settings,
 * selectors, export to a local path, ...) are refused instead of being sent to the model as text, and
 * `/<skill>` without the `skill:` prefix runs that skill when nothing else has the name.
 */

import { BUILTIN_SLASH_COMMANDS, type SlashCommandInfo } from "../../core/slash-commands.ts";
import type { CommandInfo, CommandSource } from "../../remote/protocol.ts";

/** Most entries `commands.list` returns. */
export const MAX_COMMANDS = 500;
/** Longest description, on one line. */
export const MAX_DESCRIPTION = 160;

export type RemoteBuiltin = "new" | "compact" | "name" | "model" | "thinking";

/** The TUI built-ins the bridge runs itself, without a terminal. */
export const REMOTE_BUILTINS: readonly (CommandInfo & { name: RemoteBuiltin })[] = [
	{ name: "new", description: "Start a new session", source: "builtin" },
	{
		name: "compact",
		description: "Compact the session context",
		source: "builtin",
		argumentHint: "[instructions]",
	},
	{ name: "name", description: "Set the session display name", source: "builtin", argumentHint: "<name>" },
	{
		name: "model",
		description: "Switch this session's model",
		source: "builtin",
		argumentHint: "<provider/model>",
	},
	{ name: "thinking", description: "Set the thinking level", source: "builtin", argumentHint: "<level>" },
];

const REMOTE_BUILTIN_NAMES = new Set<string>(REMOTE_BUILTINS.map((command) => command.name));

/** Accepted from the phone, never listed (the TUI has no `/clear`). */
const ALIASES: Readonly<Record<string, RemoteBuiltin>> = { clear: "new" };

/** Every TUI built-in. The TUI runs these before any extension command or template of the same name. */
const TUI_BUILTINS = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

/** phi remote's own `/remote` (pairing, `/remote off`): meaningless from the phone. */
const OWN_COMMAND = "remote";

const SOURCE_ORDER: Readonly<Record<CommandSource, number>> = { builtin: 0, extension: 1, skill: 2, prompt: 3 };

/** `name` without the `:<n>` suffix phi adds when two extensions register the same command. */
function baseName(name: string): string {
	return name.replace(/:\d+$/, "");
}

/** One line, at most `MAX_DESCRIPTION` chars; undefined when empty. */
export function commandDescription(text: unknown): string | undefined {
	if (typeof text !== "string") return undefined;
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length > MAX_DESCRIPTION ? `${line.slice(0, MAX_DESCRIPTION - 1)}…` : line;
}

export interface CommandListOptions {
	/** The `enableSkillCommands` setting: off, the TUI offers no `/skill:` commands. */
	skillCommands: boolean;
}

/**
 * What the phone may type after the slash: the remote built-ins, then extension commands, skills and
 * prompt templates (`pi.getCommands()`), each group alphabetical, names unique, at most 500.
 * Extension commands and templates the TUI shadows with a built-in of the same name are left out, as
 * is phi remote's own `/remote`.
 */
export function buildCommandList(slash: readonly SlashCommandInfo[], options: CommandListOptions): CommandInfo[] {
	const candidates: CommandInfo[] = [...REMOTE_BUILTINS];
	for (const command of slash) {
		if (!command || typeof command.name !== "string") continue;
		const name = command.name.trim();
		if (!name || /\s/.test(name)) continue;
		const source = command.source;
		if (source === "skill") {
			if (!options.skillCommands) continue;
		} else if (source === "extension" || source === "prompt") {
			const base = baseName(name);
			if (TUI_BUILTINS.has(base) || base === OWN_COMMAND) continue;
		} else {
			continue;
		}
		const description = commandDescription(command.description);
		const argumentHint = commandDescription(command.argumentHint);
		candidates.push({
			name,
			...(description ? { description } : {}),
			source,
			...(argumentHint ? { argumentHint } : {}),
		});
	}
	// Stable: within a group the order of first appearance decides which duplicate stays, which is
	// the order the session resolves names in.
	candidates.sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);
	const seen = new Set<string>();
	const unique = candidates.filter((command) => {
		if (seen.has(command.name)) return false;
		seen.add(command.name);
		return true;
	});
	unique.sort(
		(a, b) =>
			SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
			compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
			compareText(a.name, b.name),
	);
	return unique.slice(0, MAX_COMMANDS);
}

/** Code-unit order: the same on every host, unlike locale collation. */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Opaque version of a command list: changes whenever any listed field does. */
export function commandsVersion(commands: readonly CommandInfo[]): string {
	let hash = 0x811c9dc5;
	const feed = (text: string) => {
		for (let index = 0; index < text.length; index++) {
			hash ^= text.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193);
		}
		hash ^= 0x1f; // field separator
		hash = Math.imul(hash, 0x01000193);
	};
	for (const command of commands) {
		feed(command.source);
		feed(command.name);
		feed(command.argumentHint ?? "");
		feed(command.description ?? "");
	}
	return `${commands.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

export type SlashRoute =
	/** A built-in the bridge runs itself. */
	| { kind: "builtin"; name: RemoteBuiltin; args: string }
	/** A TUI built-in that needs a terminal, or phi remote's own `/remote`. */
	| { kind: "refused"; name: string }
	/**
	 * Through `sendUserMessage(text, { expandPromptTemplates: true })`: an extension command runs,
	 * a skill or prompt template expands, anything else reaches the model as text.
	 */
	| { kind: "dispatch"; text: string; extensionCommand: boolean };

/**
 * Route a prompt from the phone; undefined when it is not a slash command. Names are split from the
 * arguments at the first space, as the session does.
 */
export function resolveSlash(
	text: string,
	slash: readonly SlashCommandInfo[],
	options: CommandListOptions,
): SlashRoute | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const space = trimmed.indexOf(" ");
	const name = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
	const rest = trimmed.slice(1 + name.length);
	if (!name) return { kind: "dispatch", text: trimmed, extensionCommand: false };
	if (REMOTE_BUILTIN_NAMES.has(name)) return { kind: "builtin", name: name as RemoteBuiltin, args: rest.trim() };
	if (TUI_BUILTINS.has(name) || name === OWN_COMMAND) return { kind: "refused", name };
	if (slash.some((command) => command?.source === "extension" && command.name === name)) {
		return { kind: "dispatch", text: trimmed, extensionCommand: true };
	}
	if (slash.some((command) => command?.source === "prompt" && command.name === name)) {
		return { kind: "dispatch", text: trimmed, extensionCommand: false };
	}
	const alias = ALIASES[name];
	if (alias) return { kind: "builtin", name: alias, args: rest.trim() };
	if (
		options.skillCommands &&
		!name.startsWith("skill:") &&
		slash.some((command) => command?.source === "skill" && command.name === `skill:${name}`)
	) {
		return { kind: "dispatch", text: `/skill:${name}${rest}`, extensionCommand: false };
	}
	return { kind: "dispatch", text: trimmed, extensionCommand: false };
}
