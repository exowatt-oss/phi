import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { runCheck } from "./check.ts";
import { registerLoopControlTool } from "./control-tool.ts";
import { LoopDashboard } from "./dashboard.ts";
import { LoopEngine, type LoopToken } from "./engine.ts";
import { runEvaluator } from "./evaluator.ts";
import { interpretLoopRequest } from "./interpret.ts";
import { DEFAULT_LOOP_CONFIG, formatResolvedConfig, parseLoopCommand } from "./parser.ts";
import { buildContinuationPrompt, buildInitialLoopPrompt } from "./prompt.ts";
import { renderAuditEntry, renderIterationEntry } from "./render.ts";
import { captureRepoSnapshot } from "./repository-state.ts";
import { LoopStore } from "./store.ts";
import {
	LOOP_AUDIT_ENTRY,
	LOOP_ITERATION_ENTRY,
	type LoopControlCall,
	type LoopIterationRecord,
	type LoopStateSnapshot,
} from "./types.ts";
import { addUsage, emptyUsageTotals, usageFromAssistantMessage } from "./usage.ts";
import { openLoopViewer } from "./viewer.ts";

export const LOOP_DISPATCH_MESSAGE = "phi.loop.dispatch.v1";

export default function loopExtension(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let engine: LoopEngine | undefined;
	let dashboard: LoopDashboard | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controls: LoopControlCall[] = [];
	let usage = emptyUsageTotals();
	let activity: string | undefined;
	let lastMessages: any[] = [];
	let _beforeRepo: Awaited<ReturnType<typeof captureRepoSnapshot>>;
	let lastRecord: LoopIterationRecord | undefined;
	let sessionGeneration = 0;
	let disposal = { generation: 0, disposed: true, controller: new AbortController() };
	const tokenFor = (s: LoopStateSnapshot): LoopToken => ({
		loopId: s.loopId,
		iterationId: s.iterationId,
		revision: s.revision,
	});
	const live = (generation: number, token?: LoopToken) => {
		if (disposal.disposed || disposal.generation !== generation) return false;
		if (!token) return true;
		const s = engine?.getState();
		return !!s && s.loopId === token.loopId && s.revision === token.revision && s.iterationId === token.iterationId;
	};
	const invalidateSession = () => {
		disposal.disposed = true;
		disposal.controller.abort();
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const records = () => {
		const r = new LoopStore({
			append: () => undefined,
			entries: () => ctx?.sessionManager.getEntries() ?? [],
		}).reconstruct();
		return r.iterations;
	};
	const update = (snapshot = engine?.getState()) => {
		if (!disposal.disposed) dashboard?.update(snapshot, { records: records(), activity });
	};
	const storeFor = (c: ExtensionContext) =>
		new LoopStore({
			append: (customType, data) => pi.appendEntry(customType, data),
			entries: () =>
				c.sessionManager.getEntries().map((e: any) => ({ type: e.type, customType: e.customType, data: e.data })),
		});
	const dispatch = (snapshot: LoopStateSnapshot, initial = false, generation = disposal.generation) => {
		if (!ctx || !live(generation, tokenFor(snapshot))) return;
		const text = initial
			? buildInitialLoopPrompt(snapshot.config, snapshot)
			: buildContinuationPrompt({
					config: snapshot.config,
					snapshot,
					lastRecord,
					remaining: {
						iterations: snapshot.config.maxIterations - snapshot.iterationIndex + 1,
						wallTimeMs: Math.max(0, snapshot.config.timeoutMs - (Date.now() - Date.parse(snapshot.startedAt))),
						budgetUsd:
							snapshot.config.budgetUsd === undefined
								? undefined
								: Math.max(
										0,
										snapshot.config.budgetUsd -
											snapshot.cumulative.costUsd -
											snapshot.cumulative.evaluatorCostUsd,
									),
					},
				});
		pi.sendMessage(
			{ customType: LOOP_DISPATCH_MESSAGE, content: text, display: false },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};
	const finishDecision = async (token: LoopToken, generation: number) => {
		if (!engine || !live(generation, token)) return;
		const result = await engine.decide(token);
		// decide() advances the state (a continue moves to the next iteration and bumps the
		// revision), so liveness must be checked against the snapshot it returned, not the
		// pre-decision token. Checking the old token silently dropped every dispatch after
		// iteration 1 and left the loop parked in "dispatching" until some unrelated message
		// happened to start a turn.
		if (!result.applied || !result.snapshot || !live(generation, tokenFor(result.snapshot))) return;
		update(result.snapshot);
		if (result.decision?.kind === "continue") {
			if (result.snapshot.phase === "pacing") {
				const captured = {
					...result.snapshot,
					revision: result.snapshot.revision,
					iterationId: result.snapshot.iterationId,
				};
				timer = setTimeout(
					() =>
						void engine
							?.paceElapsed({
								loopId: captured.loopId,
								iterationId: captured.iterationId,
								revision: captured.revision,
							})
							.then((r) => {
								if (r.applied && r.snapshot) dispatch(r.snapshot);
							}),
					result.snapshot.config.everyMs,
				);
			} else if (result.snapshot.phase === "dispatching") dispatch(result.snapshot, false, generation);
		}
	};
	const settle = async () => {
		const generation = disposal.generation;
		const signal = disposal.controller.signal;
		const sessionCtx = ctx;
		if (!engine || !sessionCtx || !live(generation)) return;
		const s = engine.getState();
		if (!s || s.phase !== "running" || !s.iterationId) return;
		const token: LoopToken = { loopId: s.loopId, iterationId: s.iterationId, revision: s.revision };
		const last = lastMessages.at(-1);
		const interrupted = last?.role === "assistant" && last.stopReason === "aborted";
		if (interrupted) {
			await engine.requestPause("user_paused");
			if (!live(generation, token)) return;
		}
		const settled = await engine.recordSettlement(token, {
			usage,
			controlCalls: controls.splice(0),
			interrupted,
			agentError: last?.stopReason === "error" ? "agent error" : undefined,
		});
		if (!settled.applied || !settled.snapshot) return;
		const settledToken = tokenFor(settled.snapshot);
		if (!live(generation, settledToken)) return;
		let phase = settled.snapshot.phase;
		if (phase === "verifying_check") {
			const outcome = await runCheck({
				command: settled.snapshot.config.checkCommand!,
				cwd: settled.snapshot.config.cwd,
				timeoutMs: settled.snapshot.config.checkTimeoutMs,
				maxOutputBytes: 65536,
				signal,
			});
			const checked = await engine.applyCheck(settledToken, outcome);
			if (!checked.applied || !checked.snapshot) return;
			const checkedToken = tokenFor(checked.snapshot);
			if (!live(generation, checkedToken)) return;
			phase = checked.snapshot.phase;
		}
		if (phase === "evaluating_condition") {
			const evaluationToken = tokenFor(engine.getState()!);
			if (!live(generation, evaluationToken)) return;
			const outcome = sessionCtx.sideQuestion
				? await runEvaluator({
						input: {
							task: settled.snapshot.config.task,
							condition: settled.snapshot.config.untilCondition!,
							iterationIndex: settled.snapshot.iterationIndex,
							iterationSummary: controls.at(-1)?.summary,
							remainingLimits: {
								iterationsLeft: settled.snapshot.config.maxIterations - settled.snapshot.iterationIndex,
								wallTimeLeftMs: 0,
								budgetLeftUsd:
									settled.snapshot.config.budgetUsd === undefined
										? undefined
										: Math.max(
												0,
												settled.snapshot.config.budgetUsd -
													settled.snapshot.cumulative.costUsd -
													settled.snapshot.cumulative.evaluatorCostUsd,
											),
							},
						},
						sideQuestion: sessionCtx.sideQuestion,
						model: settled.snapshot.config.evaluatorModel,
						confidenceThreshold: settled.snapshot.config.evaluatorConfidence,
						signal,
					})
				: {
						model: "unknown",
						usage: emptyUsageTotals(),
						costUsd: 0,
						error: "sideQuestion unavailable; evaluator fail closed",
					};
			if (!live(generation, evaluationToken)) return;
			const evaluated = await engine.applyEvaluator(evaluationToken, outcome);
			if (!evaluated.applied || !evaluated.snapshot) return;
			const evaluatedToken = tokenFor(evaluated.snapshot);
			if (!live(generation, evaluatedToken)) return;
			await finishDecision(evaluatedToken, generation);
		} else if (live(generation, settledToken)) {
			await finishDecision(settledToken, generation);
		}
	};
	const active = () => {
		const s = engine?.getState();
		return s && s.phase === "running" && s.iterationId ? { loopId: s.loopId, iterationId: s.iterationId } : undefined;
	};
	registerLoopControlTool(pi, { isIterationActive: active, record: (call) => controls.push(call) });
	pi.on("session_start", (_event, c) => {
		invalidateSession();
		sessionGeneration += 1;
		disposal = { generation: sessionGeneration, disposed: false, controller: new AbortController() };
		ctx = c;
		dashboard = new LoopDashboard(c.ui);
		engine = LoopEngine.rehydrate(storeFor(c), {
			now: Date.now,
			newId: (kind) => `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			onTransition: update,
		});
		update();
	});
	pi.on("agent_start", () => {
		const s = engine?.getState();
		if (s?.phase === "dispatching")
			void engine
				?.markRunning({ loopId: s.loopId, iterationId: s.iterationId, revision: s.revision })
				.then((r) => r.applied && update(r.snapshot));
	});
	pi.on("message_end", (event) => {
		lastMessages.push(event.message);
		if (engine?.getState()?.phase === "running" && (event.message as any).role === "assistant")
			usage = addUsage(usage, usageFromAssistantMessage(event.message as any));
	});
	pi.on("tool_execution_start", (event) => {
		if (engine?.getState()?.phase === "running") {
			activity = event.toolName;
			usage = addUsage(usage, { toolCalls: 1 });
			update();
		}
	});
	pi.on("tool_execution_end", (event) => {
		if (engine?.getState()?.phase === "running" && event.isError) {
			usage = addUsage(usage, { toolErrors: 1 });
		}
	});
	pi.on("session_compact", () => {
		if (engine?.getState()?.phase === "running") usage = addUsage(usage, { compactions: 1 });
	});
	pi.on("agent_settled", () => void settle().catch(() => undefined));
	const interrupt = () => {
		invalidateSession();
		void engine?.markInterrupted().catch(() => undefined);
	};
	pi.on("session_shutdown", interrupt);
	pi.on("session_before_switch", interrupt);
	pi.on("session_before_fork", interrupt);
	pi.registerEntryRenderer(LOOP_ITERATION_ENTRY, (entry, options, theme) =>
		renderIterationEntry(entry.data as LoopIterationRecord, options, theme),
	);
	pi.registerEntryRenderer(LOOP_AUDIT_ENTRY, (entry, options, theme) =>
		renderAuditEntry(entry.data as any, options, theme),
	);
	pi.registerCommand("loop", {
		description: "Run a bounded autonomous coding loop",
		handler: async (args, commandCtx) => {
			const parsed = parseLoopCommand(args, DEFAULT_LOOP_CONFIG);
			if (parsed.kind === "error") return commandCtx.ui.notify(parsed.message, "error");
			if (parsed.kind === "dashboard") {
				if (commandCtx.mode === "tui")
					await openLoopViewer({
						ui: commandCtx.ui,
						getSnapshot: () => engine?.getState(),
						getRecords: records,
						onPause: () => void engine?.requestPause("user_paused"),
						onResume: () => undefined,
						onStop: () => void engine?.requestStop(),
						onVerify: () => undefined,
						onPin: () => undefined,
					});
				else
					commandCtx.ui.notify(
						engine?.getState() ? `${engine.getState()!.phase} ${engine.getState()!.iterationIndex}` : "No loop",
						"info",
					);
				return;
			}
			if (parsed.kind === "status")
				return commandCtx.ui.notify(
					engine?.getState()
						? `${engine.getState()!.phase} ${engine.getState()!.iterationIndex}/${engine.getState()!.config.maxIterations}`
						: "No loop",
					"info",
				);
			if (parsed.kind === "stop") {
				await engine?.requestStop();
				update();
				return;
			}
			if (parsed.kind === "pause") {
				await engine?.requestPause("user_paused");
				update();
				return;
			}
			if (parsed.kind === "resume") {
				const s = engine?.getState();
				// A loop parked in "dispatching" with an idle agent lost its dispatch message;
				// re-send it so /loop resume recovers the loop instead of reporting nothing.
				if (s?.phase === "dispatching" && commandCtx.isIdle()) {
					commandCtx.ui.notify(`Re-dispatching iteration ${s.iterationIndex}`, "info");
					dispatch(s);
					return;
				}
				if (!s || s.phase !== "paused") return commandCtx.ui.notify("No paused loop", "error");
				if (
					(!commandCtx.hasUI || s.config.cwd !== commandCtx.cwd) &&
					!(
						commandCtx.hasUI &&
						(await commandCtx.ui.confirm("Resume loop despite drift?", "The loop cwd or session state changed."))
					)
				)
					return commandCtx.ui.notify("Resume refused: explicit confirmation required", "error");
				const r = await engine!.resume({ loopId: s.loopId, iterationId: s.iterationId, revision: s.revision });
				if (r.applied && r.snapshot) dispatch(r.snapshot);
				return;
			}
			if (parsed.kind === "verify")
				return commandCtx.ui.notify(
					"Verification is only available when a check or condition is configured.",
					"info",
				);
			if (parsed.kind !== "start") return;
			if (commandCtx.mode === "print" || commandCtx.mode === "json") {
				console.error(JSON.stringify({ error: "loop requires interactive or rpc mode in v1" }));
				return;
			}
			if (engine?.getState() && engine.getState()!.phase !== "terminal")
				return commandCtx.ui.notify("A loop is already active or paused.", "error");
			const freeform = !args.split(/\s+/).some((token) => token.startsWith("--"));
			let config = { ...parsed.config, cwd: process.cwd(), startedAt: new Date().toISOString() };
			let interpretationRationale: string | undefined;
			if (freeform && commandCtx.sideQuestion) {
				const interpreted = await interpretLoopRequest({ raw: args, sideQuestion: commandCtx.sideQuestion });
				if (!("error" in interpreted)) {
					config = {
						...config,
						task: interpreted.task,
						everyMs: interpreted.everyMs ?? config.everyMs,
						maxIterations: interpreted.maxIterations ?? config.maxIterations,
						timeoutMs: interpreted.timeoutMs ?? config.timeoutMs,
						untilCondition: interpreted.untilCondition ?? config.untilCondition,
						checkCommand: interpreted.checkCommand ?? config.checkCommand,
					};
					interpretationRationale = interpreted.rationale;
				}
			}
			const started = await engine!.start(config, { sessionId: commandCtx.sessionManager.getSessionId() });
			if (!started.applied || !started.snapshot)
				return commandCtx.ui.notify(started.reason ?? "Unable to start loop", "error");
			commandCtx.ui.notify(
				`${formatResolvedConfig(config)}${interpretationRationale ? `\n\nLLM interpretation rationale: ${interpretationRationale}` : ""}`,
				"info",
			);
			_beforeRepo = await captureRepoSnapshot(config.cwd);
			usage = emptyUsageTotals();
			lastMessages = [];
			controls = [];
			dispatch(started.snapshot, true);
		},
	});
}
