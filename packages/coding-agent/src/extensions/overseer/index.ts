/**
 * Built-in `overseer` extension: one phi session (the overseer) starts other full phi sessions
 * (threads) with pinned models and manages them through the phi remote hub's local control wire.
 *
 * Manager side (every top-level session): the `overseer` tool (spawn / list / read / send / abort /
 * model / close / resume / adopt / watch), a monitor that polls the hub while threads exist and
 * wakes the overseer with batched `overseer_event` messages, a per-session registry under
 * `<agentDir>/overseer/`, a footer status, and `/threads`. Nothing connects to the hub until the
 * tool is used or a restored registry has threads. In phi's own TUI with `PI_TUI_MODE=1`, a live
 * threads board above the editor (`tui.ts`).
 *
 * Thread side (sessions started with `PHI_OVERSEER_SESSION_ID`): a system-prompt section naming
 * the overseer and the `report_to_overseer` tool; with `PI_TUI_MODE=1` in the TUI, a one-line
 * "overseen by" banner below the editor.
 *
 * Off in subagent children (`PI_SUBAGENT_ID`) and with `PHI_OVERSEER=0`.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { ControlClient } from "../../remote/hub/control.ts";
import { resolvePhiInvocation } from "../../remote/hub/spawn.ts";
import { hubLogPath, hubSocketPath } from "../../remote/paths.ts";
import { ensureHub } from "../remote/control.ts";
import { defaultRunner, whichOnPath } from "./backends.ts";
import { OverseerManager } from "./manager.ts";
import { renderBoardEntry, renderOverseerEvent } from "./render.ts";
import { registerThreadSide, threadInfoFromEnv } from "./thread.ts";
import { registerOverseerTool } from "./tool.ts";
import { OVERSEER_BOARD_ENTRY, OVERSEER_EVENT_TYPE, type OverseerDeps, type OverseerEventDetails } from "./types.ts";

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): OverseerDeps {
	return {
		connect: () => ControlClient.connect(hubSocketPath()),
		startHub: () => ensureHub(),
		run: defaultRunner,
		now: () => Date.now(),
		sleep: (ms) =>
			new Promise((resolve) => {
				setTimeout(resolve, ms).unref?.();
			}),
		env,
		agentDir: () => getAgentDir(),
		newSessionId: () => uuidv7(),
		invocation: () => resolvePhiInvocation(),
		which: (command) => whichOnPath(command, env.PATH ?? ""),
		pidAlive,
		hubLog: () => hubLogPath(),
	};
}

export function overseerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !env.PI_SUBAGENT_ID && env.PHI_OVERSEER !== "0";
}

/** The extension factory with injectable dependencies (tests). */
export function createOverseerExtension(overrides: Partial<OverseerDeps> = {}): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		const deps: OverseerDeps = { ...defaultDeps(overrides.env ?? process.env), ...overrides };
		if (!overseerEnabled(deps.env)) return;

		const thread = threadInfoFromEnv(deps.env);
		if (thread) registerThreadSide(pi, thread, deps);

		const manager = new OverseerManager(pi, deps);
		registerOverseerTool(pi, manager);

		pi.on("session_start", (_event, ctx) => {
			try {
				manager.start(ctx);
			} catch {
				// The overseer is advisory; a bad registry file never breaks the session.
			}
		});
		pi.on("session_shutdown", () => manager.shutdown());

		pi.registerCommand("threads", {
			description: "Show this overseer's threads (the overseer tool's board)",
			acceptsArgs: false,
			handler: async (_args, ctx) => {
				manager.attach(ctx);
				await manager.showBoard(ctx);
			},
		});

		pi.registerMessageRenderer<OverseerEventDetails>(OVERSEER_EVENT_TYPE, (message, options, theme) =>
			renderOverseerEvent(message, options, theme),
		);
		pi.registerEntryRenderer<{ text?: string }>(OVERSEER_BOARD_ENTRY, (entry, options, theme) =>
			renderBoardEntry(entry, options, theme),
		);
	};
}

export default createOverseerExtension();
