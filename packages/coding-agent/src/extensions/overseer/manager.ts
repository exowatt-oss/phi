/**
 * Manager side of the overseer: the thread registry of this session, the hub connection, the
 * monitor, and one method per `overseer` tool action. Tool results are compact plain text for the
 * model plus structured `details`; failures are thrown Errors with an actionable message.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type {
	CtlSessionsData,
	CtlSnapshotData,
	CtlSpawnData,
	PromptMode,
	SessionSummary,
	TranscriptItem,
} from "../../remote/protocol.ts";
import {
	closeForcaTerminal,
	closeTmuxSession,
	createForcaTerminal,
	createTmuxSession,
	removeLaunchFiles,
	renameForcaTerminal,
	selectBackend,
	writeLaunchFiles,
} from "./backends.ts";
import { HubConnection } from "./ctl.ts";
import {
	formatAge,
	formatAllSessions,
	formatBoard,
	formatEvents,
	formatTranscript,
	oneLine,
	shortIds,
	toolActivityText,
} from "./format.ts";
import { type ModelLookup, modelLabel, resolveModelRef, validateThinking } from "./model.ts";
import { ThreadMonitor } from "./monitor.ts";
import { applySummary, backendOf, resolveTarget, ThreadRegistry } from "./registry.ts";
import { OverseerBoardWidget } from "./tui.ts";
import {
	type BackendChoice,
	DEFAULT_WATCH,
	type LaunchBackend,
	OVERSEER_BOARD_ENTRY,
	OVERSEER_EVENT_TYPE,
	type OverseerDeps,
	type OverseerEvent,
	type OverseerEventDetails,
	STATUS_KEY,
	type SubagentModels,
	type ThreadRecord,
	type WatchConfig,
} from "./types.ts";

export const REGISTER_TIMEOUT_MS = 60_000;
const REGISTER_POLL_MS = 500;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_NAME = 64;

export interface SpawnParams {
	name?: string;
	prompt?: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	backend?: BackendChoice;
	subagentModels?: SubagentModels;
	appendSystemPrompt?: string;
	watch?: Partial<WatchConfig>;
}

export interface ActionResult {
	text: string;
	details: Record<string, unknown>;
}

type Progress = (text: string) => void;

/** Thread name: 1–64 printable chars, not starting with "-", not "all". */
export function validateThreadName(value: string | undefined): string {
	const name = value?.trim() ?? "";
	if (!name) throw new Error('spawn needs "name": a short unique thread name, e.g. "api-filters".');
	if (name.length > MAX_NAME) throw new Error(`Thread name is longer than ${MAX_NAME} characters.`);
	if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(name)) throw new Error("Thread name cannot contain control characters.");
	if (name.startsWith("-")) throw new Error('Thread name cannot start with "-".');
	if (name.toLowerCase() === "all") throw new Error('"all" is reserved (watch target). Pick another thread name.');
	return name;
}

/** Absolute, existing directory; `~` and paths relative to `base` accepted. */
export function resolveCwd(input: string | undefined, base: string): string {
	let path = input?.trim() || base;
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	if (!isAbsolute(path)) path = resolve(base, path);
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		throw new Error(`cwd does not exist: ${path}`);
	}
	if (!statSync(real).isDirectory()) throw new Error(`cwd is not a directory: ${path}`);
	return real;
}

/** Normalized subagent model policy; the default model must exist. */
export function normalizeSubagentModels(
	value: SubagentModels | undefined,
	registry: ModelLookup,
): SubagentModels | undefined {
	if (!value) return undefined;
	const out: SubagentModels = {};
	if (value.default?.trim()) {
		const resolved = resolveModelRef(value.default, registry);
		out.default = modelLabel(resolved.label, resolved.thinking);
	}
	const allow = (value.allow ?? []).map((pattern) => pattern.trim()).filter(Boolean);
	for (const pattern of allow) {
		if (/[\s,]/.test(pattern))
			throw new Error(`subagentModels.allow pattern "${pattern}" cannot contain spaces or commas.`);
	}
	if (allow.length) out.allow = allow;
	return out.default || out.allow ? out : undefined;
}

/** Environment a thread gets (contract §2). */
export function threadEnv(
	overseerSessionId: string,
	overseerName: string,
	thread: string,
	subagentModels: SubagentModels | undefined,
): Record<string, string> {
	return {
		PHI_OVERSEER_SESSION_ID: overseerSessionId,
		PHI_OVERSEER_NAME: overseerName,
		PHI_OVERSEER_THREAD: thread,
		...(subagentModels?.default ? { PHI_SUBAGENT_MODEL_DEFAULT: subagentModels.default } : {}),
		...(subagentModels?.allow?.length ? { PHI_SUBAGENT_MODEL_ALLOW: subagentModels.allow.join(",") } : {}),
	};
}

/** `send` text: slash commands raw, anything else headed by who is talking. */
export function frameSend(message: string, overseerName: string, overseerSessionId: string): string {
	if (message.trimStart().startsWith("/")) return message.trimStart();
	return `[overseer ${oneLine(overseerName, 80)} (${overseerSessionId.slice(0, 8)})]\n${message}`;
}

function watchText(watch: WatchConfig): string {
	return `idle ${watch.onIdle ? "on" : "off"} · stall ${watch.stallMinutes > 0 ? `${watch.stallMinutes}m` : "off"} · heartbeat ${watch.heartbeatMinutes > 0 ? `${watch.heartbeatMinutes}m` : "off"}`;
}

function mergeWatch(base: WatchConfig, patch: Partial<WatchConfig> | undefined): WatchConfig {
	const out = { ...base };
	if (!patch) return out;
	if (typeof patch.onIdle === "boolean") out.onIdle = patch.onIdle;
	for (const key of ["stallMinutes", "heartbeatMinutes"] as const) {
		const value = patch[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
			throw new Error(`watch.${key} must be a number ≥ 0.`);
		out[key] = value;
	}
	return out;
}

export class OverseerManager {
	readonly hub: HubConnection;
	readonly monitor: ThreadMonitor;
	/** The live threads board (phi's own TUI with PI_TUI_MODE=1 only; inert elsewhere). */
	readonly boardWidget: OverseerBoardWidget;
	private registryRef: ThreadRegistry | undefined;
	private ctx: ExtensionContext | undefined;
	private readonly reserved = new Set<string>();
	private readonly pi: ExtensionAPI;
	private readonly deps: OverseerDeps;

	constructor(pi: ExtensionAPI, deps: OverseerDeps) {
		this.pi = pi;
		this.deps = deps;
		this.hub = new HubConnection(deps);
		this.boardWidget = new OverseerBoardWidget(
			{
				records: () => this.registryRef?.active() ?? [],
				live: () => this.monitor.live,
				hubDown: () => this.monitor.hubDown,
				now: deps.now,
			},
			deps.env,
		);
		this.monitor = new ThreadMonitor({
			registry: () => this.registryRef,
			hub: this.hub,
			now: deps.now,
			pidAlive: deps.pidAlive,
			wake: (events) => this.wake(events),
			status: (text) => {
				this.setStatus(text);
				this.boardWidget.refresh();
			},
		});
	}

	// ------------------------------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------------------------------

	/** session_start: load this session's registry and re-match its threads against the hub. */
	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		const registry = this.registry(ctx);
		this.boardWidget.attach(ctx);
		if (registry.active().length > 0) {
			this.monitor.sync();
			void this.monitor.poll();
			return;
		}
		// No live threads on record (none, or a lost registry file). A session with history may still
		// have threads in the hub carrying its id: one sessions.list on a short connection (never
		// starting a hub) re-adds them. A brand-new session cannot have any, so it touches nothing.
		let resumed = false;
		try {
			resumed = Boolean(ctx.sessionManager.getLeafId?.());
		} catch {
			// treat as new
		}
		if (resumed) void this.rematchOnce(registry);
	}

	/** One `sessions.list` re-match at start; best effort, silent. */
	private async rematchOnce(registry: ThreadRegistry): Promise<void> {
		let client: Awaited<ReturnType<HubConnection["open"]>> | undefined;
		try {
			client = await this.hub.open(false);
			const data = await client.request<CtlSessionsData>({ op: "sessions.list" }, 5000);
			if (this.registryRef !== registry) return;
			const added = registry.rematch(data.sessions ?? [], this.deps.now());
			if (added.length > 0) {
				this.save(registry);
				void this.monitor.poll();
			}
		} catch {
			// no hub, an old hub, or a bad file: nothing to restore
		} finally {
			client?.close();
		}
	}

	shutdown(): void {
		this.monitor.dispose();
		this.boardWidget.dispose();
		this.hub.close();
		try {
			if (this.ctx?.hasUI) this.ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// stale context
		}
		this.ctx = undefined;
	}

	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.boardWidget.attach(ctx);
	}

	registry(ctx: ExtensionContext): ThreadRegistry {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!this.registryRef || this.registryRef.overseerSessionId !== sessionId) {
			const registry = new ThreadRegistry(this.deps.agentDir(), sessionId);
			registry.load();
			this.registryRef = registry;
		}
		return this.registryRef;
	}

	overseerName(ctx: ExtensionContext): string {
		return this.pi.getSessionName() ?? (basename(ctx.cwd) || ctx.cwd);
	}

	private setStatus(text: string | undefined): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	private wake(events: OverseerEvent[]): void {
		if (events.length === 0) return;
		this.pi.sendMessage<OverseerEventDetails>(
			{ customType: OVERSEER_EVENT_TYPE, content: formatEvents(events), display: true, details: { events } },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	private save(registry: ThreadRegistry): void {
		registry.save();
		this.monitor.sync();
	}

	private async liveSessions(start = true): Promise<SessionSummary[]> {
		const data = await this.hub.read<CtlSessionsData>({ op: "sessions.list" }, { start });
		return data.sessions ?? [];
	}

	private async liveSummary(sessionId: string): Promise<SessionSummary | undefined> {
		return (await this.liveSessions()).find((summary) => summary.sessionId === sessionId);
	}

	// ------------------------------------------------------------------------------------------
	// spawn
	// ------------------------------------------------------------------------------------------

	async spawn(
		params: SpawnParams,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		progress: Progress,
	): Promise<ActionResult> {
		const registry = this.registry(ctx);
		const name = validateThreadName(params.name);
		registry.assertNameFree(name);
		// Reserved synchronously: parallel spawns of one name cannot both pass the check.
		const key = name.toLowerCase();
		if (this.reserved.has(key)) throw new Error(`A thread named "${name}" is being started already.`);
		this.reserved.add(key);
		try {
			return await this.spawnReserved(name, params, ctx, signal, progress, registry);
		} finally {
			this.reserved.delete(key);
		}
	}

	private async spawnReserved(
		name: string,
		params: SpawnParams,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		progress: Progress,
		registry: ThreadRegistry,
	): Promise<ActionResult> {
		const prompt = params.prompt ?? "";
		if (!prompt.trim()) throw new Error('spawn needs "prompt": the thread\'s first, self-contained instruction.');
		if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error("prompt is larger than 256 KiB.");
		const cwd = resolveCwd(params.cwd, ctx.cwd);

		let provider: string;
		let modelId: string;
		let thinking: string | undefined;
		if (params.model?.trim()) {
			const resolved = resolveModelRef(params.model, ctx.modelRegistry, params.thinking);
			provider = resolved.provider;
			modelId = resolved.modelId;
			thinking = resolved.thinking;
		} else {
			const current = ctx.model;
			if (!current) throw new Error('No model given and this session has none: pass "model" as "provider/id".');
			provider = current.provider;
			modelId = current.id;
			thinking = params.thinking?.trim() ? validateThinking(params.thinking) : this.pi.getThinkingLevel();
		}
		const model = `${provider}/${modelId}`;
		const subagentModels = normalizeSubagentModels(params.subagentModels, ctx.modelRegistry);
		const watch = mergeWatch(DEFAULT_WATCH, params.watch);
		const overseerId = ctx.sessionManager.getSessionId();
		const env = threadEnv(overseerId, this.overseerName(ctx), name, subagentModels);

		const choice = await selectBackend(params.backend, this.deps);
		progress(`starting ${choice.backend} thread "${name}" on ${modelLabel(model, thinking)}…`);
		// The hub must be up (and speak ctl session ops) before anything is launched.
		await this.liveSessions(true);
		const record =
			choice.backend === "headless"
				? await this.spawnHeadless({ name, cwd, prompt, provider, modelId, thinking, env, params, watch })
				: await this.spawnInTerminal(choice.backend, {
						registry,
						name,
						cwd,
						prompt,
						model,
						thinking,
						env,
						params,
						watch,
						signal,
						progress,
					});
		record.subagentModels = subagentModels;
		registry.add(record);
		this.save(registry);
		const lines = [
			`Started thread "${name}" (${record.sessionId}) · ${this.backendLabel(record)} · ${modelLabel(record.model, record.thinking)} · ${record.cwd}`,
			...(choice.note ? [`Backend: ${choice.backend} (${choice.note}).`] : []),
			...(subagentModels
				? [
						`Subagent policy: ${[subagentModels.default ? `default ${subagentModels.default}` : "", subagentModels.allow ? `allow ${subagentModels.allow.join(", ")}` : ""].filter(Boolean).join("; ")}.`,
					]
				: []),
			`Watching: ${watchText(watch)}. [overseer] updates wake you when it goes idle, errors, stalls or exits — end your turn instead of polling.`,
			`Talk to it: overseer {action:"send", target:"${name}", message}. Inspect: overseer {action:"read", target:"${name}"}.`,
		];
		return { text: lines.join("\n"), details: { action: "spawn", thread: { ...record } } };
	}

	private backendLabel(record: ThreadRecord): string {
		if (record.terminal) return `forca tab ${record.terminal}`;
		if (record.tmuxSession) return `tmux ${record.tmuxSession}`;
		return record.backend === "headless" ? `headless${record.pid ? ` pid ${record.pid}` : ""}` : record.backend;
	}

	private async spawnHeadless(input: {
		name: string;
		cwd: string;
		prompt: string;
		provider: string;
		modelId: string;
		thinking: string | undefined;
		env: Record<string, string>;
		params: SpawnParams;
		watch: WatchConfig;
	}): Promise<ThreadRecord> {
		const data = await this.hub.call<CtlSpawnData>(
			{
				op: "session.spawn",
				cwd: input.cwd,
				prompt: input.prompt,
				provider: input.provider,
				modelId: input.modelId,
				...(input.thinking ? { thinkingLevel: input.thinking } : {}),
				name: input.name,
				...(input.params.appendSystemPrompt?.trim() ? { appendSystemPrompt: input.params.appendSystemPrompt } : {}),
				env: input.env,
			},
			90_000,
		);
		return {
			name: input.name,
			sessionId: data.sessionId,
			backend: "headless",
			cwd: data.cwd || input.cwd,
			model: `${input.provider}/${input.modelId}`,
			...(input.thinking ? { thinking: input.thinking } : {}),
			...(data.pid ? { pid: data.pid } : {}),
			createdAt: this.deps.now(),
			watch: input.watch,
			state: "running",
			registered: true,
			// The hub sends the prompt right after replying: report the turn when it ends.
			awaitingReplySince: this.deps.now(),
		};
	}

	private async spawnInTerminal(
		backend: Exclude<LaunchBackend, "headless">,
		input: {
			registry: ThreadRegistry;
			name: string;
			cwd: string;
			prompt: string;
			model: string;
			thinking: string | undefined;
			env: Record<string, string>;
			params: SpawnParams;
			watch: WatchConfig;
			signal: AbortSignal | undefined;
			progress: Progress;
		},
	): Promise<ThreadRecord> {
		const agentDir = this.deps.agentDir();
		const sessionId = this.deps.newSessionId();
		const files = writeLaunchFiles(
			agentDir,
			{
				sessionId,
				name: input.name,
				cwd: input.cwd,
				invocation: this.deps.invocation(),
				model: input.model,
				thinking: input.thinking,
				env: input.env,
				hostEnv: this.deps.env,
			},
			input.prompt,
			input.params.appendSystemPrompt,
		);
		const record: ThreadRecord = {
			name: input.name,
			sessionId,
			backend,
			cwd: input.cwd,
			model: input.model,
			...(input.thinking ? { thinking: input.thinking } : {}),
			launcher: files.launcher,
			createdAt: this.deps.now(),
			watch: input.watch,
			state: "running",
			registered: false,
		};
		try {
			if (backend === "forca") {
				const created = await createForcaTerminal(this.deps.run, {
					cwd: input.cwd,
					title: input.name,
					launcher: files.launcher,
				});
				record.terminal = created.handle;
			} else {
				record.tmuxSession = await createTmuxSession(this.deps.run, {
					name: input.name,
					sessionId,
					cwd: input.cwd,
					launcher: files.launcher,
				});
			}
		} catch (error) {
			removeLaunchFiles(agentDir, sessionId);
			throw error;
		}
		// Recorded before the wait: a thread that registers late is still found by the monitor.
		input.registry.add(record);
		this.save(input.registry);
		input.progress(`thread "${input.name}" launched (${this.backendLabel(record)}); waiting for it to register…`);
		let summary: SessionSummary | undefined;
		try {
			summary = await this.waitForRegistration(record, input.signal);
		} catch (error) {
			if (/exited before registering/.test((error as Error).message)) {
				// Dead on arrival: free the name, keep the launcher for debugging.
				record.state = "closed";
				record.closedAt = this.deps.now();
				this.save(input.registry);
			}
			throw error;
		}
		if (!summary) {
			const inspect = record.terminal
				? `FORCA terminal ${record.terminal}: inspect with \`forca terminal read --terminal ${record.terminal} --screen\``
				: `tmux session ${record.tmuxSession}: inspect with \`tmux capture-pane -p -t ${record.tmuxSession}\``;
			throw new Error(
				`Thread "${input.name}" (${sessionId}) did not register with the phi remote hub within ${REGISTER_TIMEOUT_MS / 1000} s. ${inspect}. Launcher: ${files.launcher}. The record is kept: if it registers later the monitor picks it up; discard it with overseer {action:"close", target:"${input.name}"}.`,
			);
		}
		applySummary(record, summary, this.deps.now());
		if (record.terminal) {
			// Now that phi runs in the tab, pin its title to the thread name (best effort): FORCA
			// otherwise shows phi's own title or its agent status ("phi ready").
			const renamed = await renameForcaTerminal(this.deps.run, record.terminal, input.name);
			if (!renamed.ok) input.progress(`could not set the FORCA tab title: ${renamed.detail}`);
		}
		// Its first turn (the prompt) is under way or about to start: report it when it ends.
		record.awaitingReplySince = Math.max(this.deps.now(), summary.lastActivityAt);
		return record;
	}

	private async waitForRegistration(
		record: ThreadRecord,
		signal: AbortSignal | undefined,
	): Promise<SessionSummary | undefined> {
		const deadline = this.deps.now() + REGISTER_TIMEOUT_MS;
		for (let round = 0; ; round++) {
			if (signal?.aborted) throw new Error(`Aborted while waiting for thread "${record.name}" to register.`);
			try {
				const found = (await this.liveSessions(false)).find((summary) => summary.sessionId === record.sessionId);
				if (found) return found;
			} catch {
				// hub hiccup: keep waiting until the deadline
			}
			// A tmux session that is gone means phi exited before registering.
			if (record.tmuxSession && round % 4 === 3) {
				const alive = await this.deps.run("tmux", ["has-session", "-t", `=${record.tmuxSession}`], {
					timeoutMs: 5000,
				});
				if (alive.code !== 0) {
					throw new Error(
						`Thread "${record.name}" exited before registering: its tmux session ${record.tmuxSession} is gone. Run the launcher by hand to see why: sh ${record.launcher}`,
					);
				}
			}
			if (this.deps.now() >= deadline) return undefined;
			await this.deps.sleep(REGISTER_POLL_MS);
		}
	}

	// ------------------------------------------------------------------------------------------
	// list / read
	// ------------------------------------------------------------------------------------------

	async list(ctx: ExtensionContext, all: boolean): Promise<ActionResult> {
		const registry = this.registry(ctx);
		const now = this.deps.now();
		if (all) {
			const sessions = await this.liveSessions(true);
			const tracked = new Map(registry.active().map((record) => [record.sessionId, record.name]));
			return {
				text: formatAllSessions(sessions, ctx.sessionManager.getSessionId(), tracked, now),
				details: { action: "list", all: true, sessions },
			};
		}
		return this.board(ctx);
	}

	/** The board for `list` and `/threads`: a fresh `sessions.list`, without starting a hub. */
	async board(ctx: ExtensionContext): Promise<ActionResult> {
		const registry = this.registry(ctx);
		let live = new Map<string, SessionSummary>();
		let hubDown = false;
		try {
			const sessions = await this.liveSessions(false);
			live = new Map(sessions.map((summary) => [summary.sessionId, summary]));
			// Live sessions that carry this overseer's id but are missing from the registry come back.
			if (registry.rematch(sessions, this.deps.now()).length > 0) this.save(registry);
		} catch {
			hubDown = true;
		}
		const records = registry.threads.filter((record) => record.state !== "closed");
		if (records.length === 0) hubDown = false;
		const closed = registry.threads.length - records.length;
		const text =
			formatBoard(records, live, this.deps.now(), { hubDown }) +
			(closed > 0
				? `\n(${closed} closed thread${closed === 1 ? "" : "s"} not shown; resume one by name or id)`
				: "");
		return { text, details: { action: "list", threads: records.map((record) => ({ ...record })), hubDown } };
	}

	/** A registry thread, else any live hub session (read-only uses). */
	private async resolveAny(
		ctx: ExtensionContext,
		target: string,
	): Promise<{ record?: ThreadRecord; summary?: SessionSummary; sessionId: string; name: string }> {
		const registry = this.registry(ctx);
		try {
			const record = registry.resolve(target, { includeClosed: true });
			return { record, sessionId: record.sessionId, name: record.name };
		} catch (error) {
			if (!/^No thread/.test((error as Error).message)) throw error;
			const sessions = await this.liveSessions(true);
			const summary = resolveTarget(
				target,
				sessions,
				{
					name: (s) => s.name,
					id: (s) => s.sessionId,
					describe: (s) => `${oneLine(s.name, 40)} (${s.sessionId.slice(0, 8)}, ${s.kind})`,
				},
				"session",
			);
			return { summary, sessionId: summary.sessionId, name: summary.name };
		}
	}

	async read(ctx: ExtensionContext, target: string, limit = 20): Promise<ActionResult> {
		const found = await this.resolveAny(ctx, target);
		const count = Math.max(1, Math.min(200, Math.floor(limit)));
		const summary = found.summary ?? (await this.liveSummary(found.sessionId));
		let items: TranscriptItem[];
		let hasMore: boolean;
		let header: string;
		const id = found.sessionId;
		if (summary) {
			const snapshot = await this.hub.read<CtlSnapshotData>({ op: "session.snapshot", sessionId: id, limit: count });
			items = snapshot.items ?? [];
			hasMore = snapshot.hasMore === true;
			const live = snapshot.summary ?? summary;
			const activity = live.activity ? ` · ⚒ ${toolActivityText(live.activity, 80)}` : "";
			const model = live.model
				? ` · ${modelLabel(`${live.model.provider}/${live.model.id}`, live.thinkingLevel)}`
				: "";
			header = `${found.name} (${id}) · ${snapshot.state?.status ?? live.status}${model}${activity} · quiet ${formatAge(this.deps.now() - live.lastActivityAt)}${live.lastError ? ` · error: ${oneLine(live.lastError, 120)}` : ""}`;
		} else {
			const page = await this.hub.read<{ items: TranscriptItem[]; hasMore: boolean }>(
				{ op: "session.transcript", sessionId: id, limit: count },
				{ start: true },
			);
			items = page.items ?? [];
			hasMore = page.hasMore === true;
			header = `${found.name} (${id}) · not live (stored transcript)`;
		}
		return {
			text: formatTranscript(header, items, hasMore),
			details: { action: "read", sessionId: id, live: Boolean(summary), items: items.length, hasMore },
		};
	}

	// ------------------------------------------------------------------------------------------
	// send / abort / model
	// ------------------------------------------------------------------------------------------

	async send(
		ctx: ExtensionContext,
		target: string,
		message: string,
		mode: PromptMode = "auto",
	): Promise<ActionResult> {
		const registry = this.registry(ctx);
		const record = registry.resolve(target);
		if (!message.trim()) throw new Error('send needs a nonempty "message".');
		if (record.state === "exited") {
			throw new Error(
				`"${record.name}" has exited. Resume it with overseer {action:"resume", target:"${record.name}", prompt} (the prompt is delivered on resume).`,
			);
		}
		const text = frameSend(message, this.overseerName(ctx), ctx.sessionManager.getSessionId());
		await this.hub.call({ op: "session.prompt", sessionId: record.sessionId, text, mode }, 20_000);
		if (!text.startsWith("/")) {
			// Its reply arrives as an [overseer] idle update.
			record.awaitingReplySince = this.deps.now();
			this.save(registry);
		}
		return {
			text: `Sent to "${record.name}" (${mode}). ${text.startsWith("/") ? "Ran as a slash command." : "Its reply arrives as an [overseer] update when it goes idle."}`,
			details: { action: "send", sessionId: record.sessionId, mode, slash: text.startsWith("/") },
		};
	}

	async abort(ctx: ExtensionContext, target: string): Promise<ActionResult> {
		const registry = this.registry(ctx);
		const record = registry.resolve(target);
		const summary = await this.liveSummary(record.sessionId).catch(() => undefined);
		// Its next working → idle is this abort, not news (only when it is working now).
		if (summary?.status === "working") this.monitor.expectIdleOf(record.sessionId);
		if (record.awaitingReplySince !== undefined) {
			delete record.awaitingReplySince;
			this.save(registry);
		}
		await this.hub.call({ op: "session.abort", sessionId: record.sessionId });
		return {
			text: `Aborted the current turn of "${record.name}". It is idle now; send it a message to continue.`,
			details: { action: "abort", sessionId: record.sessionId },
		};
	}

	async model(ctx: ExtensionContext, target: string, model?: string, thinking?: string): Promise<ActionResult> {
		const registry = this.registry(ctx);
		const record = registry.resolve(target);
		if (!model?.trim() && !thinking?.trim())
			throw new Error('model needs "model" ("provider/id[:thinking]") and/or "thinking".');
		let level = thinking?.trim() ? validateThinking(thinking) : undefined;
		const resolved = model?.trim() ? resolveModelRef(model, ctx.modelRegistry, thinking) : undefined;
		// A turn under way (or one this overseer is waiting on) keeps the label of the model it started
		// on: the switch applies from the next turn, and the monitor may not have seen this one working.
		if (record.turnModel === undefined) {
			const live = await this.liveSummary(record.sessionId).catch(() => this.monitor.live.get(record.sessionId));
			const before = live?.model
				? modelLabel(`${live.model.provider}/${live.model.id}`, live.thinkingLevel)
				: record.model
					? modelLabel(record.model, record.thinking)
					: undefined;
			if (before && (live?.status === "working" || record.awaitingReplySince !== undefined))
				record.turnModel = before;
		}
		if (resolved) {
			await this.hub.call({
				op: "session.setModel",
				sessionId: record.sessionId,
				provider: resolved.provider,
				modelId: resolved.modelId,
			});
			record.model = resolved.label;
			level = resolved.thinking;
		}
		if (level) {
			await this.hub.call({ op: "session.setThinking", sessionId: record.sessionId, level });
			record.thinking = level;
		}
		this.save(registry);
		return {
			text: `"${record.name}" now runs ${modelLabel(record.model, record.thinking)} (applies from its next turn).`,
			details: { action: "model", sessionId: record.sessionId, model: record.model, thinking: record.thinking },
		};
	}

	// ------------------------------------------------------------------------------------------
	// close / resume / adopt / watch
	// ------------------------------------------------------------------------------------------

	async close(ctx: ExtensionContext, target: string): Promise<ActionResult> {
		const registry = this.registry(ctx);
		const record = registry.resolve(target);
		const overseerId = ctx.sessionManager.getSessionId();
		const steps: string[] = [];
		let summary: SessionSummary | undefined;
		try {
			summary = await this.liveSummary(record.sessionId);
		} catch (error) {
			steps.push(`hub: ${(error as Error).message}`);
		}
		// Only sessions that carry this overseer's id are ended. Anything else (an adopted phone,
		// terminal or other overseer's session, headless or not) is aborted if working and unwatched.
		const ours = summary ? summary.overseer?.sessionId === overseerId : !record.adopted;
		if (!ours) {
			if (summary?.status === "working") {
				this.monitor.expectIdleOf(record.sessionId);
				await this.hub.call({ op: "session.abort", sessionId: record.sessionId });
				steps.push("aborted its turn");
			}
			this.markClosed(registry, record);
			const kind = summary ? `${summary.kind} ` : "";
			return {
				text: `Stopped watching "${record.name}"${steps.length ? ` (${steps.join("; ")})` : ""}. It is a ${kind}session this overseer did not start (the user, the phone or another overseer owns it), so it was not closed.`,
				details: { action: "close", sessionId: record.sessionId, closed: false, steps },
			};
		}
		let ctlClosed = false;
		if (summary) {
			if (summary.status === "working") {
				this.monitor.expectIdleOf(record.sessionId);
				try {
					await this.hub.call({ op: "session.abort", sessionId: record.sessionId });
					steps.push("aborted its turn");
				} catch (error) {
					steps.push(`abort failed: ${(error as Error).message}`);
				}
			}
			try {
				await this.hub.call({ op: "session.close", sessionId: record.sessionId, overseer: overseerId }, 20_000);
				ctlClosed = true;
				steps.push("session closed");
			} catch (error) {
				steps.push(`ctl close refused: ${(error as Error).message}`);
			}
			// Let an interactive session finish writing before its terminal goes away.
			if (ctlClosed && (record.terminal || record.tmuxSession)) await this.waitGone(record.sessionId, 5000);
		} else {
			steps.push("session was not live");
		}
		let terminalClosed = false;
		// A tab or tmux session that could not be closed stays on the record (the user may close it).
		const leftover: { terminal?: boolean; tmuxSession?: boolean } = {};
		if (record.terminal) {
			const result = await closeForcaTerminal(this.deps.run, record.terminal);
			terminalClosed = result.ok;
			leftover.terminal = !result.ok;
			steps.push(result.ok ? `FORCA tab ${record.terminal} closed` : `FORCA tab close failed: ${result.detail}`);
		}
		if (record.tmuxSession) {
			const result = await closeTmuxSession(this.deps.run, record.tmuxSession);
			terminalClosed = terminalClosed || result.ok;
			leftover.tmuxSession = !result.ok;
			steps.push(
				result.gone
					? `tmux ${record.tmuxSession} already ended`
					: result.ok
						? `tmux ${record.tmuxSession} killed`
						: `tmux kill failed: ${result.detail}`,
			);
		}
		if (summary && !ctlClosed && !terminalClosed) {
			throw new Error(`Could not close "${record.name}": ${steps.join("; ")}.`);
		}
		this.markClosed(registry, record, leftover);
		return {
			text: `Closed "${record.name}": ${steps.join("; ")}. Resume it later with overseer {action:"resume", target:"${record.sessionId}"}.`,
			details: { action: "close", sessionId: record.sessionId, closed: true, steps },
		};
	}

	/**
	 * Mark a thread closed. Its launch files are deleted and the launcher, FORCA tab and tmux session
	 * are forgotten (they are gone, or were never this overseer's), except a tab or tmux session that
	 * `leftover` says could not be closed.
	 */
	private markClosed(
		registry: ThreadRegistry,
		record: ThreadRecord,
		leftover: { terminal?: boolean; tmuxSession?: boolean } = {},
	): void {
		record.state = "closed";
		record.closedAt = this.deps.now();
		record.lastStatus = undefined;
		delete record.turnModel;
		if (record.launcher) removeLaunchFiles(this.deps.agentDir(), record.sessionId);
		delete record.launcher;
		if (!leftover.terminal) delete record.terminal;
		if (!leftover.tmuxSession) delete record.tmuxSession;
		this.save(registry);
	}

	private async waitGone(sessionId: string, timeoutMs: number): Promise<void> {
		const deadline = this.deps.now() + timeoutMs;
		while (this.deps.now() < deadline) {
			try {
				if (!(await this.liveSessions(false)).some((summary) => summary.sessionId === sessionId)) return;
			} catch {
				return;
			}
			await this.deps.sleep(250);
		}
	}

	async resume(ctx: ExtensionContext, target: string, prompt?: string): Promise<ActionResult> {
		const registry = this.registry(ctx);
		const record = registry.resolve(target, { includeClosed: true });
		if (await this.liveSummary(record.sessionId)) {
			throw new Error(
				`"${record.name}" is live already: talk to it with overseer {action:"send", target:"${record.name}", message}.`,
			);
		}
		if (record.state === "closed") {
			const clash = registry
				.active()
				.find((other) => other !== record && other.name.toLowerCase() === record.name.toLowerCase());
			if (clash)
				throw new Error(`A live thread is named "${record.name}" already; close it before resuming this one.`);
		}
		const slash = record.model?.indexOf("/") ?? -1;
		const env = threadEnv(
			ctx.sessionManager.getSessionId(),
			this.overseerName(ctx),
			record.name,
			record.subagentModels,
		);
		const data = await this.hub.call<CtlSpawnData>(
			{
				op: "session.resume",
				sessionId: record.sessionId,
				...(prompt?.trim() ? { prompt } : {}),
				...(record.model && slash > 0
					? { provider: record.model.slice(0, slash), modelId: record.model.slice(slash + 1) }
					: {}),
				...(record.thinking ? { thinkingLevel: record.thinking } : {}),
				env,
			},
			90_000,
		);
		const previous = { sessionId: record.sessionId, terminal: record.terminal, launcher: record.launcher };
		record.sessionId = data.sessionId || record.sessionId;
		record.backend = "headless";
		// The old tab, tmux session and launcher belong to the previous process. A FORCA handle is
		// unique, so its leftover tab is closed now; a tmux name may belong to a newer thread, so it is
		// only forgotten. Nothing later (close, exit hints, labels) may act on them.
		const cleanup: string[] = [];
		if (previous.terminal) {
			const closedTab = await closeForcaTerminal(this.deps.run, previous.terminal);
			if (closedTab.ok) cleanup.push(`its old FORCA tab ${previous.terminal} was closed`);
		}
		if (previous.launcher) removeLaunchFiles(this.deps.agentDir(), previous.sessionId);
		delete record.terminal;
		delete record.tmuxSession;
		delete record.launcher;
		record.state = "running";
		record.registered = true;
		record.pid = data.pid;
		record.cwd = data.cwd || record.cwd;
		record.lastStatus = undefined;
		if (prompt?.trim()) record.awaitingReplySince = this.deps.now();
		else delete record.awaitingReplySince;
		delete record.exitedAt;
		delete record.closedAt;
		this.save(registry);
		return {
			text: `Resumed "${record.name}" (${record.sessionId}) headless${data.pid ? ` (pid ${data.pid})` : ""} in ${record.cwd}${data.cwdFallback ? " (its recorded folder is gone; fallback)" : ""}.${prompt?.trim() ? " It is working on the prompt." : " It is idle; send it a message."}${cleanup.length ? ` (${cleanup.join("; ")}.)` : ""}`,
			details: { action: "resume", thread: { ...record } },
		};
	}

	async adopt(
		ctx: ExtensionContext,
		target: string,
		watch?: Partial<WatchConfig>,
		name?: string,
	): Promise<ActionResult> {
		const registry = this.registry(ctx);
		const overseerId = ctx.sessionManager.getSessionId();
		const sessions = (await this.liveSessions(true)).filter(
			(summary) =>
				summary.sessionId !== overseerId &&
				!registry.active().some((record) => record.sessionId === summary.sessionId),
		);
		const ids = shortIds(sessions.map((summary) => summary.sessionId));
		const summary = resolveTarget(
			target,
			sessions,
			{
				name: (s) => s.name,
				id: (s) => s.sessionId,
				describe: (s) => `${oneLine(s.name, 40)} (${ids.get(s.sessionId)}, ${s.kind}, ${s.status})`,
			},
			"session",
		);
		const now = this.deps.now();
		const existing = registry.bySessionId(summary.sessionId);
		const record: ThreadRecord = existing ?? {
			name: registry.freeName(
				name?.trim() ? validateThreadName(name) : oneLine(summary.name, MAX_NAME) || summary.sessionId.slice(0, 8),
			),
			sessionId: summary.sessionId,
			backend: backendOf(summary),
			adopted: summary.overseer?.sessionId !== overseerId,
			cwd: summary.cwd,
			...(summary.tmux && summary.overseer?.sessionId === overseerId ? { tmuxSession: summary.tmux.session } : {}),
			createdAt: now,
			watch: { ...DEFAULT_WATCH },
			state: "running",
			registered: true,
		};
		if (existing) record.name = registry.freeName(record.name);
		record.state = "running";
		record.watch = mergeWatch(record.watch, watch);
		delete record.closedAt;
		applySummary(record, summary, now);
		// Old errors and stalls are not news.
		if (summary.lastError) record.notifiedError = summary.lastError;
		if (summary.status === "working") record.notifiedStallAt = summary.lastActivityAt;
		registry.add(record);
		this.save(registry);
		return {
			text: `Adopted "${record.name}" (${record.sessionId}, ${summary.kind}, ${summary.status}) · watching: ${watchText(record.watch)}.${record.adopted ? " Not started by this overseer: close only stops watching it (aborting a running turn); it is never shut down." : ""}`,
			details: { action: "adopt", thread: { ...record } },
		};
	}

	watch(ctx: ExtensionContext, target: string | undefined, patch?: Partial<WatchConfig>): ActionResult {
		const registry = this.registry(ctx);
		const key = target?.trim() || "all";
		const records = key.toLowerCase() === "all" ? registry.active() : [registry.resolve(key)];
		if (records.length === 0) throw new Error("No threads to watch.");
		for (const record of records) record.watch = mergeWatch(record.watch, patch);
		if (patch) this.save(registry);
		const lines = records.map((record) => `${record.name}: ${watchText(record.watch)}`);
		return {
			text: `${patch ? "Watch updated" : "Watch settings"}:\n${lines.join("\n")}`,
			details: { action: "watch", threads: records.map((record) => ({ name: record.name, watch: record.watch })) },
		};
	}

	/** `/threads`: the board as a transcript entry (and a notification outside the TUI). */
	async showBoard(ctx: ExtensionContext): Promise<void> {
		const { text } = await this.board(ctx);
		this.pi.appendEntry(OVERSEER_BOARD_ENTRY, { text, capturedAt: this.deps.now() });
		if (ctx.mode !== "tui" && ctx.hasUI) ctx.ui.notify(text, "info");
	}
}
