/**
 * phi remote, session side: a hidden built-in that makes this session visible and drivable from
 * the phi iPhone app through the local hub (`phi remote serve`, `~/.pi/agent/remote/hub.sock`).
 *
 * Loaded in top-level interactive and RPC sessions; never in print/JSON mode, never in nested
 * subagents, never with PHI_REMOTE=0. Without a hub it costs one `stat` every 5 s and prints
 * nothing; only `/remote` ever writes to the terminal.
 *
 * Session replacement (/new, /resume, /fork, /reload) re-runs this factory. The hub connection
 * outlives the old instance: it is parked on shutdown and adopted by the next session_start,
 * which registers the new session id on the same connection.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { hubLogPath, hubSocketPath } from "../../remote/paths.ts";
import type { DeviceInfo, PairInfo } from "../../remote/protocol.ts";
import { isSubagentFeedEvent, SUBAGENT_FEED_CHANNEL } from "../subagents/feed.ts";
import { isNestedSubagent } from "../subagents/index.ts";
import { SessionBridge } from "./bridge.ts";
import { canConnect, ctlRequest, ensureHub } from "./control.ts";
import { HubLink } from "./link.ts";
import { showDevices, showPairing } from "./ui.ts";

/** How long a parked connection waits for the replacement session before closing. */
const PARK_MS = 30_000;
/** How long a bridge action waits for its `/remote` dispatch to start. */
const ACTION_START_MS = 5_000;
/**
 * `/remote <prefix><token>` runs one action the bridge queued (a slash command from the phone that
 * needs a command context, such as `/new`). Tokens are random and single use.
 */
const ACTION_PREFIX = "--bridge-action=";

interface Parked {
	link: HubLink;
	sessionId: string | undefined;
	timer: ReturnType<typeof setTimeout>;
}

/** Process-wide: survives the extension instance being re-created on session replacement. */
const shared: { off: boolean; parked: Parked | undefined } = { off: false, parked: undefined };

/** Test hook: forget the parked connection and the `/remote off` switch. */
export function resetRemoteState(): void {
	shared.off = false;
	unpark()?.stop();
}

function unpark(): HubLink | undefined {
	const parked = shared.parked;
	if (!parked) return undefined;
	clearTimeout(parked.timer);
	shared.parked = undefined;
	return parked.link;
}

export function remoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PHI_REMOTE !== "0" && !isNestedSubagent(env);
}

/** Interactive and RPC sessions only: print/JSON runs are one-shot and have nothing to drive. */
export function remoteModeEligible(mode: ExtensionContext["mode"]): boolean {
	return mode === "tui" || mode === "rpc";
}

function shortHostname(): string {
	const name = hostname();
	return name.split(".")[0] || name;
}

function shutdownGracefully(ctx: ExtensionContext): void {
	let mode: ExtensionContext["mode"] | undefined;
	try {
		mode = ctx.mode;
		ctx.shutdown();
	} catch {
		// Stale context: the session is already going away.
	}
	// RPC mode acts on a shutdown request only between commands or after a run settles; an idle
	// headless session gets the SIGTERM it handles gracefully (dispose, then exit).
	if (mode === "rpc") setTimeout(() => process.kill(process.pid, "SIGTERM"), 1000).unref();
}

function guard(fn: () => void): void {
	try {
		fn();
	} catch {
		// Remote control is advisory; the session never sees its failures.
	}
}

export default function remoteExtension(pi: ExtensionAPI): void {
	if (!remoteEnabled()) return;

	let sessionCtx: ExtensionContext | undefined;
	let link: HubLink | undefined;
	let bridge: SessionBridge | undefined;
	const actions = new Map<string, (ctx: ExtensionCommandContext) => Promise<void>>();

	/**
	 * Run `fn` with the command context a slash command typed in the terminal gets: it is dispatched
	 * as `/remote <token>` through the session's own command path, so session control (newSession)
	 * behaves exactly as for a command from the terminal, in every mode.
	 */
	const withCommandContext = <T>(fn: (ctx: ExtensionCommandContext) => Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			// Only while `/remote` is unambiguously this extension's command: with a duplicate it is
			// renamed `remote:<n>`, and `/remote ...` would reach the model as text.
			const own = pi.getCommands().some((command) => command.source === "extension" && command.name === "remote");
			if (!own) {
				reject(new Error("the /remote command is not available in this session"));
				return;
			}
			const token = randomUUID();
			const timer = setTimeout(() => {
				if (actions.delete(token)) reject(new Error("the session did not run the command"));
			}, ACTION_START_MS);
			timer.unref();
			actions.set(token, async (ctx) => {
				clearTimeout(timer);
				try {
					resolve(await fn(ctx));
				} catch (error) {
					reject(error);
				}
			});
			pi.sendUserMessage(`/remote ${ACTION_PREFIX}${token}`, { expandPromptTemplates: true });
		});

	/** The action queued under `args`, removed so it runs once; undefined for any other `/remote` use. */
	const takeAction = (args: string): ((ctx: ExtensionCommandContext) => Promise<void>) | undefined => {
		const trimmed = args.trim();
		if (!trimmed.startsWith(ACTION_PREFIX)) return undefined;
		const token = trimmed.slice(ACTION_PREFIX.length);
		const action = actions.get(token);
		actions.delete(token);
		return action;
	};

	const activate = (ctx: ExtensionContext): void => {
		if (bridge || shared.off || !remoteModeEligible(ctx.mode)) return;
		const parked = shared.parked;
		const adopted = unpark();
		const current = adopted ?? new HubLink({ socketPath: hubSocketPath });
		const created = new SessionBridge({
			pi,
			ctx,
			link: current,
			host: shortHostname(),
			spawnId: process.env.PHI_REMOTE_SPAWN_ID || undefined,
			previousSessionId: adopted ? parked?.sessionId : undefined,
			shutdown: () => shutdownGracefully(ctx),
			withCommandContext,
		});
		link = current;
		bridge = created;
		current.setHandlers({
			onConnect: () => created.onConnected(false),
			onFrame: (frame) => created.onFrame(frame),
			onDisconnect: () => created.onDisconnected(),
			onDropped: () => created.onDropped(),
		});
		current.start();
		if (adopted?.connected) created.onConnected(true);
	};

	const deactivate = (park: boolean): void => {
		const current = link;
		const previous = bridge;
		link = undefined;
		bridge = undefined;
		previous?.dispose();
		if (!current) return;
		current.setHandlers(undefined);
		if (!park || shared.off) {
			current.stop();
			return;
		}
		unpark()?.stop();
		const timer = setTimeout(() => {
			if (shared.parked?.link === current) shared.parked = undefined;
			current.stop();
		}, PARK_MS);
		timer.unref();
		shared.parked = { link: current, sessionId: previous?.sessionIdForHandover, timer };
	};

	pi.on("session_start", (_event, ctx) =>
		guard(() => {
			sessionCtx = ctx;
			activate(ctx);
		}),
	);
	pi.on("session_shutdown", (event) => guard(() => deactivate(event.reason !== "quit")));
	pi.on("agent_start", () => guard(() => bridge?.onAgentStart()));
	pi.on("agent_settled", () => guard(() => bridge?.onAgentSettled()));
	pi.on("turn_end", () => guard(() => bridge?.reconcileSoon()));
	pi.on("message_start", (event) => guard(() => bridge?.onMessageStart(event.message)));
	pi.on("message_update", (event) => guard(() => bridge?.onMessageUpdate(event.message)));
	// Returns nothing on purpose: a message_end result would replace the message.
	pi.on("message_end", (event) => guard(() => bridge?.onMessageEnd(event.message)));
	pi.on("tool_execution_start", (event) =>
		guard(() => bridge?.onToolStart(event.toolCallId, event.toolName, event.args)),
	);
	pi.on("tool_execution_update", (event) => guard(() => bridge?.onToolUpdate(event.toolCallId, event.partialResult)));
	pi.on("tool_execution_end", (event) =>
		guard(() => bridge?.onToolEnd(event.toolCallId, event.result, event.isError)),
	);
	pi.on("model_select", () => guard(() => bridge?.onSummaryChanged()));
	pi.on("thinking_level_select", () => guard(() => bridge?.onSummaryChanged()));
	pi.on("session_info_changed", () => guard(() => bridge?.onSummaryChanged()));
	pi.on("session_compact", () => guard(() => bridge?.onTranscriptRewritten()));
	pi.on("session_tree", () => guard(() => bridge?.onTranscriptRewritten()));
	// Subagent runs of this session, served to the hub as its child threads (subagents/feed.ts).
	pi.events.on(SUBAGENT_FEED_CHANNEL, (data) =>
		guard(() => {
			if (isSubagentFeedEvent(data)) bridge?.onSubagentFeed(data);
		}),
	);

	pi.registerCommand("remote", {
		description: "phi remote: pair a phone (QR code), or `devices` / `off`",
		getArgumentCompletions: (prefix) =>
			[
				{ value: "devices", label: "devices", description: "List paired phones" },
				{ value: "off", label: "off", description: "Disconnect this session from phi remote until restart" },
			].filter((item) => item.value.startsWith(prefix.trim().toLowerCase())),
		handler: async (args, ctx) => {
			const action = takeAction(args);
			if (action) {
				await action(ctx);
				return;
			}
			if (args.trim().startsWith(ACTION_PREFIX)) return; // expired or already used: nothing to do
			try {
				await runRemoteCommand(args.trim().toLowerCase(), ctx);
			} catch (error) {
				ctx.ui.notify(`phi remote: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	const runRemoteCommand = async (sub: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (sub === "off") {
			shared.off = true;
			deactivate(false);
			unpark()?.stop();
			ctx.ui.notify("phi remote: this session is disconnected until restart (/remote reconnects it)", "info");
			return;
		}
		if (sub === "devices") {
			if (!(await canConnect())) {
				ctx.ui.notify("phi remote: the hub is not running (/remote starts it)", "warning");
				return;
			}
			const data = await ctlRequest<{ devices?: DeviceInfo[] }>({ op: "devices.list" });
			await showDevices(ctx, Array.isArray(data?.devices) ? data.devices : []);
			return;
		}
		if (sub !== "" && sub !== "pair" && sub !== "on") {
			ctx.ui.notify("Usage: /remote [devices|off]", "warning");
			return;
		}
		if (!remoteModeEligible(ctx.mode)) return;
		shared.off = false;
		activate(sessionCtx ?? ctx);
		const hub = await ensureHub(5000);
		if (hub === "failed") {
			ctx.ui.notify(`phi remote: the hub did not start (see ${hubLogPath()})`, "error");
			return;
		}
		link?.poke();
		const info = await ctlRequest<PairInfo>({ op: "pair.create" });
		if (!info || typeof info.code !== "string" || typeof info.link !== "string") {
			throw new Error("the hub returned no pairing code");
		}
		await showPairing(ctx, { ...info, urls: Array.isArray(info.urls) ? info.urls : [] });
	};
}
