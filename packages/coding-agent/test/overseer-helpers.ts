/**
 * Test doubles for the overseer extension: a fake hub control client, a fake command runner, a
 * fake model registry, and a mount helper that loads the extension with injected dependencies.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { Extension, ExtensionContext } from "../src/core/extensions/types.ts";
import { createOverseerExtension } from "../src/extensions/overseer/index.ts";
import type { ModelLookup } from "../src/extensions/overseer/model.ts";
import type { CtlClientLike, OverseerDeps, Runner, RunOptions, RunResult } from "../src/extensions/overseer/types.ts";
import { HubControlError } from "../src/remote/hub/control.ts";
import type { HubControlOp } from "../src/remote/hub/frames.ts";
import type { SessionSummary } from "../src/remote/protocol.ts";
import { toolContext } from "./tool-context.ts";

export function summary(partial: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
	return {
		name: partial.sessionId.slice(0, 8),
		cwd: "/tmp/work",
		host: "test",
		pid: 4242,
		kind: "interactive",
		status: "idle",
		startedAt: 1_000,
		lastActivityAt: 1_000,
		...partial,
	};
}

type Handler = (op: HubControlOp & Record<string, unknown>) => unknown;

/** In-memory hub: answers `sessions.list` from `sessions`, records every op, custom handlers win. */
export class FakeHub {
	sessions: SessionSummary[] = [];
	calls: Array<HubControlOp & Record<string, unknown>> = [];
	handlers: Record<string, Handler> = {};
	connects = 0;
	closed = 0;
	down = false;

	connect = async (): Promise<CtlClientLike> => {
		this.connects++;
		if (this.down) throw new Error("connect ENOENT hub.sock");
		return {
			request: async <T>(op: HubControlOp): Promise<T> => {
				const frame = op as HubControlOp & Record<string, unknown>;
				this.calls.push(frame);
				const handler = this.handlers[op.op];
				if (handler) return (await handler(frame)) as T;
				if (op.op === "sessions.list") return { sessions: this.sessions.map((s) => ({ ...s })) } as T;
				if (op.op === "session.snapshot") {
					const live = this.sessions.find((s) => s.sessionId === frame.sessionId);
					if (!live) throw new HubControlError("not_found", `no live session ${String(frame.sessionId)}`);
					return { items: [], hasMore: false, state: { status: live.status }, summary: live } as T;
				}
				return {} as T;
			},
			close: () => {
				this.closed++;
			},
		};
	};

	ops(name: string): Array<HubControlOp & Record<string, unknown>> {
		return this.calls.filter((call) => call.op === name);
	}
}

export interface RunCall {
	command: string;
	args: string[];
	options?: RunOptions;
}

/** Runner that records calls and answers from a list of matchers (first match wins). */
export function fakeRunner(
	answers: Array<{ match: (call: RunCall) => boolean; result: Partial<RunResult> }> = [],
): Runner & { calls: RunCall[] } {
	const calls: RunCall[] = [];
	const run = (async (command: string, args: string[], options?: RunOptions): Promise<RunResult> => {
		const call = { command, args, options };
		calls.push(call);
		const answer = answers.find((entry) => entry.match(call));
		return { code: 0, stdout: "", stderr: "", ...(answer?.result ?? {}) };
	}) as Runner & { calls: RunCall[] };
	run.calls = calls;
	return run;
}

export function fakeModels(refs: string[]): ModelLookup {
	const models = refs.map((ref) => {
		const slash = ref.indexOf("/");
		return { provider: ref.slice(0, slash), id: ref.slice(slash + 1), name: ref } as unknown as Model<Api>;
	});
	return {
		find: (provider, modelId) => models.find((model) => model.provider === provider && model.id === modelId),
		getAll: () => models,
	};
}

export interface Mounted {
	extension: Extension;
	ctx: ExtensionContext;
	sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	entries: Array<{ type: string; data: unknown }>;
	statuses: Array<string | undefined>;
	notifications: string[];
	/** Every `ui.setWidget` call, in order. */
	widgets: Array<{ key: string; content: unknown; options?: Record<string, unknown> }>;
	call(params: Record<string, unknown>): Promise<{ text: string; details: unknown }>;
	fire(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
}

export async function mountOverseer(options: {
	deps: Partial<OverseerDeps>;
	sessionId?: string;
	cwd?: string;
	sessionName?: string;
	models?: string[];
	model?: { provider: string; id: string };
	thinking?: string;
	hasUI?: boolean;
	mode?: string;
}): Promise<Mounted> {
	const sent: Mounted["sent"] = [];
	const entries: Mounted["entries"] = [];
	const statuses: Mounted["statuses"] = [];
	const notifications: string[] = [];
	const widgets: Mounted["widgets"] = [];
	const runtime = createExtensionRuntime();
	runtime.sendMessage = ((message: Record<string, unknown>, sendOptions?: Record<string, unknown>) => {
		sent.push({ message, options: sendOptions });
	}) as never;
	runtime.appendEntry = ((type: string, data: unknown) => {
		entries.push({ type, data });
	}) as never;
	runtime.getSessionName = (() => options.sessionName) as never;
	runtime.getThinkingLevel = (() => options.thinking ?? "medium") as never;
	const cwd = options.cwd ?? "/tmp";
	const registry = fakeModels(options.models ?? ["gateway/example-medium", "anthropic/claude-opus-5-5"]);
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		cwd,
		model: options.model ?? { provider: "anthropic", id: "claude-opus-5-5" },
		modelRegistry: registry,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => options.sessionId ?? "0190aaaa-0000-7000-8000-00000000beef",
			getSessionName: () => options.sessionName,
		},
		ui: {
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			notify: (text: string) => notifications.push(text),
			setWidget: (key: string, content: unknown, widgetOptions?: Record<string, unknown>) =>
				widgets.push({ key, content, options: widgetOptions }),
		},
	} as unknown as ExtensionContext;
	const extension = await loadExtensionFromFactory(
		createOverseerExtension(options.deps),
		cwd,
		createEventBus(),
		runtime,
		"<overseer>",
	);
	const fire = async (event: string, payload: Record<string, unknown> = {}) => {
		const results: unknown[] = [];
		for (const handler of extension.handlers.get(event) ?? []) {
			results.push(await handler({ type: event, ...payload } as never, ctx));
		}
		return results;
	};
	const call = async (params: Record<string, unknown>) => {
		const tool = extension.tools.get("overseer")?.definition;
		if (!tool) throw new Error("overseer tool not registered");
		const result = await tool.execute("call-1", params as never, undefined, undefined, toolContext(ctx));
		const first = result.content[0];
		return { text: first?.type === "text" ? first.text : "", details: result.details };
	};
	return { extension, ctx, sent, entries, statuses, notifications, widgets, call, fire };
}

/** Deps that never touch the real machine. */
export function testDeps(hub: FakeHub, agentDir: string, overrides: Partial<OverseerDeps> = {}): Partial<OverseerDeps> {
	let clock = 1_000_000;
	return {
		connect: hub.connect,
		startHub: async () => "failed",
		run: fakeRunner(),
		now: () => clock,
		sleep: async (ms: number) => {
			clock += ms;
		},
		env: { PATH: "" },
		agentDir: () => agentDir,
		newSessionId: () => "0190bbbb-1111-7000-8000-000000000001",
		invocation: () => ({ command: "/opt/phi/bin/phi", args: [] }),
		which: () => undefined,
		pidAlive: () => false,
		hubLog: () => "/tmp/hub.log",
		...overrides,
	};
}
