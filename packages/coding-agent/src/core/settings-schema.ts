import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { MAX_STREAM_IDLE_TIMEOUT_MS } from "@earendil-works/pi-ai/utils/stream-idle-guard";
import { type Static, type TSchemaOptions, Type } from "typebox";
import { PHI_SETTINGS_DEFAULTS, SETTINGS_DEFAULTS } from "./settings-defaults.ts";

function nonNegativeSafeInteger(options: { default?: number; description?: string } = {}) {
	return Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, ...options });
}

function timeoutSetting(options?: TSchemaOptions) {
	return Type.Union([Type.Number({ minimum: 0 }), Type.Literal("disabled")], options);
}

const CompactionModelOverrideSchema = Type.Object({
	reserveTokens: Type.Optional(nonNegativeSafeInteger()),
	keepRecentTokens: Type.Optional(nonNegativeSafeInteger()),
});

const CompactionSettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.compaction.enabled })),
	reserveTokens: Type.Optional(nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.reserveTokens })),
	keepRecentTokens: Type.Optional(
		nonNegativeSafeInteger({
			description:
				"Recent tokens retained without summarization. Unset means adaptive: max(20000, 10% of the effective context window).",
		}),
	),
	softCeilingTokens: Type.Optional(
		nonNegativeSafeInteger({
			description:
				"Caps the context window compaction thresholds use; 0 uses the raw model window. Unset falls back to PI_COMPACTION_SOFT_CEILING_TOKENS. A model's compaction.softCeilingTokens in models.json wins.",
			default: PHI_SETTINGS_DEFAULTS.compaction.softCeilingTokens,
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Summarization model as "provider/modelId[:thinkingLevel]". Default: the session model, or a Sonnet summarizer when the context-aware compaction ladder is on.',
		}),
	),
	modelOverrides: Type.Optional(
		Type.Record(Type.String(), CompactionModelOverrideSchema, {
			description: 'Per-model overrides keyed by exact "provider/modelId" strings.',
		}),
	),
});

const BranchSummarySettingsSchema = Type.Object({
	reserveTokens: Type.Optional(
		Type.Number({
			description: "Tokens reserved for the prompt and LLM response.",
			default: SETTINGS_DEFAULTS.branchSummary.reserveTokens,
		}),
	),
	skipPrompt: Type.Optional(
		Type.Boolean({
			description: 'When true, skips the "Summarize branch?" prompt and defaults to no summary.',
			default: SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		}),
	),
});

const ProviderRetrySettingsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Number({ description: "SDK or provider request timeout in milliseconds." })),
	maxRetries: Type.Optional(Type.Number({ description: "SDK or provider retry attempts." })),
	maxRetryDelayMs: Type.Optional(
		Type.Number({
			description: "Maximum server-requested delay before failing.",
			default: SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		}),
	),
});

const RetrySettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.retry.enabled })),
	maxRetries: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxRetries })),
	baseDelayMs: Type.Optional(
		Type.Number({
			description: "Exponential backoff base delay in milliseconds: 2s, 4s, 8s.",
			default: SETTINGS_DEFAULTS.retry.baseDelayMs,
		}),
	),
	maxAgentDelayMs: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxAgentDelayMs })),
	provider: Type.Optional(ProviderRetrySettingsSchema),
	maxDelayMs: Type.Optional(
		Type.Number({
			description: "Legacy retry delay setting. Use provider.maxRetryDelayMs instead.",
			deprecated: true,
		}),
	),
});

const AgentMailSettingsSchema = Type.Object({
	enabled: Type.Optional(
		Type.Boolean({
			description: "Join other local UI sessions and offer the agent_list and agent_message tools.",
			default: PHI_SETTINGS_DEFAULTS.agentMail.enabled,
		}),
	),
});

/**
 * Liveness watchdog + budgets for subagent child processes (the `subagent`
 * tool). All thresholds are minutes; see `extensions/subagents/watchdog.ts`
 * for the resolved defaults and semantics.
 */
const SubagentsSettingsSchema = Type.Object(
	{
		watchdogEnabled: Type.Optional(
			Type.Boolean({
				description: "Enable semantic liveness supervision. false disables all watchdog and default-budget kills.",
				default: true,
			}),
		),
		stallSoftMinutes: Type.Optional(
			Type.Number({
				description:
					"Minutes of parsed-event silence while awaiting model output before a run is flagged. Default: 5.",
			}),
		),
		stallHardMinutes: Type.Optional(
			Type.Number({
				description:
					"Stream hard fuse in minutes; floored by max(15, 3x streamIdleTimeoutMs), or soft-only when that guard is off. Default: 21.",
			}),
		),
		toolStallSoftMinutes: Type.Optional(
			Type.Number({
				description:
					"Parsed-event silence threshold in minutes while a tool execution is outstanding (quiet builds are legitimate). Default: 20.",
			}),
		),
		toolStallHardMinutes: Type.Optional(
			Type.Number({
				description: "Hard kill threshold in minutes while a tool execution is outstanding. Default: 60.",
			}),
		),
		maxRunMinutes: Type.Optional(
			Type.Number({
				description:
					"Default wall-clock budget per subagent run, in minutes. Soft: only idle children are killed; 0 disables. Default: 120.",
			}),
		),
		toolMaxMinutes: Type.Optional(
			Type.Number({
				description:
					"Wall-clock ceiling for a single tool call inside a subagent, in minutes, even while it streams output. Floored at toolStallHardMinutes; 0 disables. Default: 90.",
			}),
		),
		maxHardRunMinutes: Type.Optional(
			Type.Number({
				description:
					"Absolute wall-clock ceiling for a subagent run without an explicit timeoutSeconds, in minutes. Kills even a producing child; floored at maxRunMinutes; 0 disables. Default: 360.",
			}),
		),
		childIsolation: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("off")], {
				description:
					'Run each child in its own systemd-run --user --scope cgroup (Linux only) so a runaway fan-out cannot OOM the parent. "auto" uses it whenever the host can; "off" spawns children directly.',
				default: "auto",
			}),
		),
		childMemoryMax: Type.Optional(
			Type.Union([Type.String(), Type.Number()], {
				description:
					'MemoryMax for each child cgroup: bytes, "8G", "512M", or a share of host RAM like "25%". 0 or "off" removes the ceiling. Default: 30% of RAM, clamped to 2-16 GiB.',
			}),
		),
		childCpuCores: Type.Optional(
			Type.Union([Type.Number(), Type.Literal("off")], {
				description:
					'Whole CPUs each child cgroup may use (CPUQuota); also exported to the child as VITEST_MAX_THREADS and PYTEST_XDIST_AUTO_NUM_WORKERS. 0 or "off" removes it. Default: max(4, CPUs / 6).',
			}),
		),
		models: Type.Optional(
			Type.Object(
				{
					default: Type.Optional(
						Type.String({
							description:
								'Model for subagent tasks that name none (and whose agent definition names none), e.g. "example/model:high". PHI_SUBAGENT_MODEL_DEFAULT overrides it.',
						}),
					),
					allow: Type.Optional(
						Type.Array(Type.String(), {
							description:
								'Model patterns subagents may use: "provider/id", "provider/id:level", "provider/id:l1|l2", with * globs ("example/model:high"). A call with any task outside the list is refused. PHI_SUBAGENT_MODEL_ALLOW (comma-separated) overrides it.',
						}),
					),
				},
				{ description: "Pin the models the subagent tool may launch and the default for tasks that name none." },
			),
		),
	},
	{ description: "Liveness watchdog, budgets and isolation for subagent child processes." },
);

const FallbackChainSchema = Type.Array(Type.String(), {
	description:
		'Ordered "provider/modelId" refs, best model first. Rungs naming an unknown model or a provider without auth are skipped.',
});

/**
 * Model escalation for safety-classifier refusals. Client-side, so it crosses providers and works on
 * OAuth (subscription) auth, unlike Anthropic's server-side fallbacks beta.
 */
const RefusalFallbackSettingsSchema = Type.Object(
	{
		enabled: Type.Optional(
			Type.Boolean({
				description: "Escalate to the next model in chain when a safety classifier declines a turn.",
				default: PHI_SETTINGS_DEFAULTS.refusalFallback.enabled,
			}),
		),
		chain: Type.Optional(FallbackChainSchema),
		// Sticky by default: the declined content is still in the context, so returning to the head of the
		// chain on the next turn spends a guaranteed refusal per turn.
		sticky: Type.Optional(
			Type.Boolean({
				description:
					"Stay on the model that answered for the rest of the session; false restores the head of the chain after each escalated turn.",
				default: PHI_SETTINGS_DEFAULTS.refusalFallback.sticky,
			}),
		),
	},
	{ description: "Client-side model escalation for safety-classifier refusals." },
);

/** Model rerouting for provider outages, the availability sibling of the refusal fallback. */
const ErrorFallbackSettingsSchema = Type.Object(
	{
		enabled: Type.Optional(
			Type.Boolean({
				description:
					"Reroute to the next model in chain when the provider is down, unreachable, or out of quota. Defaults to false when a host UI owns model selection (RPC mode).",
				default: PHI_SETTINGS_DEFAULTS.errorFallback.enabled,
			}),
		),
		chain: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Ordered "provider/modelId" refs, best model first. Rungs naming an unknown model or a provider without auth are skipped.',
				default: [...PHI_SETTINGS_DEFAULTS.errorFallback.chain],
			}),
		),
		// Not sticky by default: sticky rerouting moved whole sessions onto another provider's billing and
		// capabilities, under the original model's label, long after the outage had passed.
		sticky: Type.Optional(
			Type.Boolean({
				description:
					"Stay on the fallback model for the rest of the session; false restores the selected model after each rerouted turn.",
				default: PHI_SETTINGS_DEFAULTS.errorFallback.sticky,
			}),
		),
	},
	{ description: "Client-side model rerouting for provider outages." },
);

const BtwSettingsSchema = Type.Object(
	{
		model: Type.Optional(
			Type.String({
				description:
					'Model for side queries, as "provider/modelId" or "provider/modelId:thinking". Default: the current session model.',
			}),
		),
		persist: Type.Optional(
			Type.Boolean({
				description: "Append completed answers to the TUI transcript as non-context entries.",
				default: PHI_SETTINGS_DEFAULTS.btw.persist,
			}),
		),
		maxHistory: Type.Optional(
			Type.Number({
				description:
					"Maximum Q&A pairs kept in the in-memory side thread; oldest pairs drop first. Clamped from 1 to 100.",
				default: PHI_SETTINGS_DEFAULTS.btw.maxHistory,
			}),
		),
	},
	{ description: "Settings for the /btw side-question command." },
);

const LoopSettingsSchema = Type.Object(
	{
		maxIterations: Type.Optional(
			Type.Number({
				description: "Iteration cap, clamped from 1 to 100.",
				default: PHI_SETTINGS_DEFAULTS.loop.maxIterations,
			}),
		),
		maxWallTimeMs: Type.Optional(
			Type.Number({
				description: "Wall-time cap in milliseconds, up to 24 hours.",
				default: PHI_SETTINGS_DEFAULTS.loop.maxWallTimeMs,
			}),
		),
		maxCostUsd: Type.Optional(Type.Number({ description: "Spend cap in USD; unset means unlimited." })),
		checkTimeoutMs: Type.Optional(
			Type.Number({
				description: "Timeout for each --check command in milliseconds.",
				default: PHI_SETTINGS_DEFAULTS.loop.checkTimeoutMs,
			}),
		),
		evaluatorModel: Type.Optional(
			Type.String({ description: "Model that judges --until conditions. Default: the session model." }),
		),
		evaluatorConfidence: Type.Optional(
			Type.Number({
				description: "Confidence the evaluator needs to stop the loop, clamped from 0.5 to 1.",
				default: PHI_SETTINGS_DEFAULTS.loop.evaluatorConfidence,
			}),
		),
		maxCheckOutputBytes: Type.Optional(
			Type.Number({
				description: "Check output kept per iteration, clamped from 1 KiB to 1 MiB.",
				default: PHI_SETTINGS_DEFAULTS.loop.maxCheckOutputBytes,
			}),
		),
	},
	{ description: "Settings for the /loop command." },
);

/**
 * Settings for the workspace-state emitter (contract v1).
 * See the workspace-state contract
 */
const SessionStateSettingsSchema = Type.Object(
	{
		classifier: Type.Optional(
			Type.Union([Type.Literal("heuristic"), Type.Literal("llm")], {
				description:
					'How the end state is classified. "llm" spends an isolated side-question call; "heuristic" inspects the final message locally and handles side-call failures.',
				default: PHI_SETTINGS_DEFAULTS.sessionState.classifier,
			}),
		),
		model: Type.Optional(
			Type.String({
				description: 'Model for the "llm" classifier, as "provider/modelId".',
				default: PHI_SETTINGS_DEFAULTS.sessionState.model,
			}),
		),
	},
	{ description: "Settings for the workspace-state emitter." },
);

const ToolDisplaySchema = Type.Union([Type.Literal("minimal"), Type.Literal("compact"), Type.Literal("full")], {
	description:
		'How much of a tool call and result is shown while collapsed. "minimal": intent line plus a one-line summary. "compact": short previews. "full": like compact, but sessions start expanded. ctrl+o always expands.',
	default: PHI_SETTINGS_DEFAULTS.toolDisplay,
});

const TerminalSettingsSchema = Type.Object({
	showImages: Type.Optional(
		Type.Boolean({
			description: "Show images when the terminal supports them.",
			default: SETTINGS_DEFAULTS.terminal.showImages,
		}),
	),
	imageWidthCells: Type.Optional(
		Type.Number({
			description: "Preferred inline image width in terminal cells.",
			default: SETTINGS_DEFAULTS.terminal.imageWidthCells,
		}),
	),
	clearOnShrink: Type.Optional(
		Type.Boolean({
			description: "Clear empty rows when content shrinks.",
			default: SETTINGS_DEFAULTS.terminal.clearOnShrink,
		}),
	),
	showTerminalProgress: Type.Optional(
		Type.Boolean({
			description: "Show OSC 9;4 terminal progress indicators.",
			default: SETTINGS_DEFAULTS.terminal.showTerminalProgress,
		}),
	),
	hyperlinks: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
	images: Type.Optional(
		Type.Union([Type.Literal("kitty"), Type.Literal("iterm2"), Type.Literal("auto"), Type.Literal(false)]),
	),
	trueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
});

const ImageSettingsSchema = Type.Object({
	autoResize: Type.Optional(
		Type.Boolean({
			description:
				"Fit images to Claude's native resolution (2576px long edge) before sending; smaller images pass through untouched.",
			default: SETTINGS_DEFAULTS.images.autoResize,
		}),
	),
	blockImages: Type.Optional(
		Type.Boolean({
			description: "When true, prevents all images from being sent to LLM providers.",
			default: SETTINGS_DEFAULTS.images.blockImages,
		}),
	),
});

function thinkingBudgetsSettings(options?: TSchemaOptions) {
	return Type.Object(
		{
			minimal: Type.Optional(Type.Number()),
			low: Type.Optional(Type.Number()),
			medium: Type.Optional(Type.Number()),
			high: Type.Optional(Type.Number()),
		},
		options,
	);
}

const ThinkingBudgetsSettingsSchema = thinkingBudgetsSettings();

const MarkdownSettingsSchema = Type.Object({
	codeBlockIndent: Type.Optional(Type.String({ default: SETTINGS_DEFAULTS.markdown.codeBlockIndent })),
	mermaid: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")], {
			default: SETTINGS_DEFAULTS.markdown.mermaid,
		}),
	),
});

const WarningSettingsSchema = Type.Object({
	anthropicExtraUsage: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.warnings.anthropicExtraUsage })),
});

function codemodeMode(options?: TSchemaOptions) {
	return Type.Union([Type.Literal("on"), Type.Literal("only")], options);
}

const CodemodeModeSchema = codemodeMode();

const CodemodeSettingsSchema = Type.Object({
	mode: Type.Optional(
		codemodeMode({
			description:
				'How codemode presents tools. "on" keeps direct tools declared and annotates tools callable from scripts; codemode lists only tools without direct exposure. "only" lists every script-callable tool in codemode and does not declare active direct tools.',
			default: SETTINGS_DEFAULTS.codemode.mode,
		}),
	),
	inlineBudget: Type.Optional(
		Type.Number({
			minimum: 0,
			description: "Estimated tokens available for inline codemode tool declarations.",
			default: SETTINGS_DEFAULTS.codemode.inlineBudget,
		}),
	),
});

const PackageSourceSchema = Type.Union(
	[
		Type.String({ description: "Load all resources from the package." }),
		Type.Object({
			source: Type.String(),
			autoload: Type.Optional(
				Type.Boolean({ description: "When false, start empty and only apply explicit resource patterns." }),
			),
			extensions: Type.Optional(Type.Array(Type.String())),
			skills: Type.Optional(Type.Array(Type.String())),
			prompts: Type.Optional(Type.Array(Type.String())),
			themes: Type.Optional(Type.Array(Type.String())),
		}),
	],
	{
		description:
			"Package source for npm or git packages. Use the string form to load all resources or the object form to filter resources.",
	},
);

const StringArraySchema = Type.Array(Type.String());
const SkillsInputSchema = Type.Union(
	[
		StringArraySchema,
		Type.Object(
			{
				enableSkillCommands: Type.Optional(Type.Boolean()),
				customDirectories: Type.Optional(StringArraySchema),
			},
			{ deprecated: true },
		),
	],
	{ description: "Local skill file paths or directories." },
);

export const SettingsSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON Schema reference." })),
		lastChangelogVersion: Type.Optional(Type.String()),
		defaultProvider: Type.Optional(Type.String()),
		defaultModel: Type.Optional(Type.String()),
		defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
		serviceTier: Type.Optional(
			Type.Union([Type.Literal("default"), Type.Literal("flex"), Type.Literal("fast"), Type.Literal("ultrafast")], {
				description:
					'Processing tier: "fast", "default", OpenAI-only "flex", or "ultrafast" (sent verbatim). "fast" also enables Anthropic fast mode on supported first-party models.',
				default: PHI_SETTINGS_DEFAULTS.serviceTier,
			}),
		),
		modelThinkingLevels: Type.Optional(
			Type.Record(Type.String(), ModelThinkingLevelSchema, {
				description: 'Per-model default thinking level overrides keyed by "provider/modelId".',
			}),
		),
		transport: Type.Optional(
			Type.Union(
				[Type.Literal("auto"), Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("websocket-cached")],
				{ default: SETTINGS_DEFAULTS.transport },
			),
		),
		sessionShareDestination: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("gist"), Type.Literal("radius")], {
				description:
					'Destination used by /share. "auto" uses Radius when authenticated and otherwise creates a GitHub gist.',
				default: SETTINGS_DEFAULTS.sessionShareDestination,
			}),
		),
		steeringMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.steeringMode,
			}),
		),
		followUpMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.followUpMode,
			}),
		),
		theme: Type.Optional(Type.String()),
		compaction: Type.Optional(CompactionSettingsSchema),
		branchSummary: Type.Optional(BranchSummarySettingsSchema),
		retry: Type.Optional(RetrySettingsSchema),
		subagents: Type.Optional(SubagentsSettingsSchema),
		agentMail: Type.Optional(AgentMailSettingsSchema),
		refusalFallback: Type.Optional(RefusalFallbackSettingsSchema),
		errorFallback: Type.Optional(ErrorFallbackSettingsSchema),
		hideThinkingBlock: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.hideThinkingBlock })),
		showCacheMissNotices: Type.Optional(
			Type.Boolean({
				description: "Show cache cost and provider recovery notices.",
				default: SETTINGS_DEFAULTS.showCacheMissNotices,
			}),
		),
		externalEditor: Type.Optional(
			Type.String({ description: "Command for Ctrl+G external editor; takes precedence over VISUAL and EDITOR." }),
		),
		shellPath: Type.Optional(
			Type.String({
				description: "Custom shell path, for example for Cygwin on Windows, with support for leading ~ expansion.",
			}),
		),
		quietStartup: Type.Optional(
			Type.Union([Type.Boolean(), Type.Literal("header")], {
				description: 'When true, hide all startup output. When "header", keep only the startup header.',
				default: SETTINGS_DEFAULTS.quietStartup,
			}),
		),
		defaultProjectTrust: Type.Optional(
			Type.Union([Type.Literal("ask"), Type.Literal("always"), Type.Literal("never")], {
				description: "Global setting only.",
				default: SETTINGS_DEFAULTS.defaultProjectTrust,
			}),
		),
		shellCommandPrefix: Type.Optional(
			Type.String({ description: "Prefix prepended to every bash command, for example to enable shell aliases." }),
		),
		npmCommand: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Command used for npm package lookup and installation, in argv form such as ["mise", "exec", "node@20", "--", "npm"].',
			}),
		),
		collapseChangelog: Type.Optional(
			Type.Boolean({
				description: "Show the condensed changelog after update; use /changelog for the full changelog.",
				default: SETTINGS_DEFAULTS.collapseChangelog,
			}),
		),
		autoUpdate: Type.Optional(
			Type.Boolean({
				description:
					"Install newer phi releases from a configured self-hosted update feed automatically, without running /upgrade. The new release takes effect when phi restarts.",
				default: SETTINGS_DEFAULTS.autoUpdate,
			}),
		),
		enableInstallTelemetry: Type.Optional(
			Type.Boolean({
				description:
					"Send an anonymous version and update ping to pi.dev after changelog-detected updates. Off in phi; PI_TELEMETRY=1 also opts in.",
				default: SETTINGS_DEFAULTS.enableInstallTelemetry,
			}),
		),
		enableAnalytics: Type.Optional(
			Type.Boolean({
				description: "Opt in to analytics data sharing.",
				default: SETTINGS_DEFAULTS.enableAnalytics,
			}),
		),
		trackingId: Type.Optional(
			Type.String({ description: "Analytics tracking identifier, generated when analytics is enabled." }),
		),
		packages: Type.Optional(
			Type.Array(PackageSourceSchema, {
				description: "npm or git package sources, as strings or objects with resource filtering.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Type.String(), { description: "Local extension file paths or directories." }),
		),
		deviceId: Type.Optional(
			Type.String({
				description: "Stable installation UUID, generated when authentication first needs it. Global only.",
			}),
		),
		skills: Type.Optional(SkillsInputSchema),
		prompts: Type.Optional(
			Type.Array(Type.String(), { description: "Local prompt template file paths or directories." }),
		),
		themes: Type.Optional(Type.Array(Type.String(), { description: "Local theme file paths or directories." })),
		enableSkillCommands: Type.Optional(
			Type.Boolean({
				description: "Register skills as /skill:name commands.",
				default: SETTINGS_DEFAULTS.enableSkillCommands,
			}),
		),
		terminal: Type.Optional(TerminalSettingsSchema),
		images: Type.Optional(ImageSettingsSchema),
		enabledModels: Type.Optional(
			Type.Array(Type.String(), {
				description: "Model patterns for cycling, in the same format as the --models CLI flag.",
			}),
		),
		defaultTools: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Initial tool selection. Plain names replace the inherited selection; +name and -name entries add or remove tools.",
			}),
		),
		doubleEscapeAction: Type.Optional(
			Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("none")], {
				description: "Action for double-escape with an empty editor.",
				default: SETTINGS_DEFAULTS.doubleEscapeAction,
			}),
		),
		treeFilterMode: Type.Optional(
			Type.Union(
				[
					Type.Literal("default"),
					Type.Literal("no-tools"),
					Type.Literal("user-only"),
					Type.Literal("labeled-only"),
					Type.Literal("all"),
				],
				{
					description: "Default filter when opening /tree.",
					default: SETTINGS_DEFAULTS.treeFilterMode,
				},
			),
		),
		thinkingBudgets: Type.Optional(
			thinkingBudgetsSettings({
				description: "Custom token budgets for thinking levels.",
			}),
		),
		editorPaddingX: Type.Optional(
			Type.Number({
				description: "Horizontal padding for the input editor.",
				default: SETTINGS_DEFAULTS.editorPaddingX,
			}),
		),
		outputPad: Type.Optional(
			Type.Union([Type.Literal(0), Type.Literal(1)], {
				description: "Horizontal padding for transcript content.",
				default: SETTINGS_DEFAULTS.outputPad,
			}),
		),
		toolOutputLines: Type.Optional(
			Type.Number({
				description:
					"Output lines shown per tool result while collapsed, clamped from 0 to 200; 0 shows only the expand hint. ctrl+o always expands.",
				default: PHI_SETTINGS_DEFAULTS.toolOutputLines,
			}),
		),
		toolDisplay: Type.Optional(ToolDisplaySchema),
		autocompleteMaxVisible: Type.Optional(
			Type.Number({
				description: "Maximum visible items in the autocomplete dropdown.",
				default: SETTINGS_DEFAULTS.autocompleteMaxVisible,
			}),
		),
		showHardwareCursor: Type.Optional(
			Type.Boolean({ description: "Show the terminal cursor while still positioning it for IME." }),
		),
		markdown: Type.Optional(MarkdownSettingsSchema),
		warnings: Type.Optional(WarningSettingsSchema),
		codemode: Type.Optional(CodemodeSettingsSchema),
		sessionDir: Type.Optional(
			Type.String({
				description: "Custom session storage directory, in the same format as the --session-dir CLI flag.",
			}),
		),
		httpProxy: Type.Optional(
			Type.String({ description: "Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients." }),
		),
		httpIdleTimeoutMs: Type.Optional(
			timeoutSetting({
				description: 'HTTP header or body idle timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		streamIdleTimeoutMs: Type.Optional(
			Type.Union([Type.Number({ minimum: 0, maximum: MAX_STREAM_IDLE_TIMEOUT_MS }), Type.Literal("disabled")], {
				description:
					'Raw model-stream inactivity timeout in milliseconds before the request is aborted and retried; 0 or "disabled" disables it.',
				default: PHI_SETTINGS_DEFAULTS.streamIdleTimeoutMs,
			}),
		),
		cacheWarming: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")], {
				description:
					'Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money.',
				default: SETTINGS_DEFAULTS.cacheWarming,
			}),
		),
		websocketConnectTimeoutMs: Type.Optional(
			timeoutSetting({
				description: 'WebSocket connect or open handshake timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		tuiMode: Type.Optional(
			Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")], {
				default: SETTINGS_DEFAULTS.tuiMode,
			}),
		),
		uiMode: Type.Optional(
			Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")], {
				description: "Legacy spelling of tuiMode written by phi 0.83 and earlier; read as a fallback.",
				deprecated: true,
			}),
		),
		fullscreenExitOutput: Type.Optional(
			Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")], {
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenExitOutput,
			}),
		),
		fullscreenScrollbar: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("hidden")], {
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenScrollbar,
			}),
		),
		fullscreenCopyOnSelect: Type.Optional(
			Type.Boolean({
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenCopyOnSelect,
			}),
		),
		fullscreenWheelScrollLines: Type.Optional(
			Type.Union([Type.Number(), Type.Literal("auto")], {
				description: "Lines scrolled per wheel event in fullscreen mode; numeric values are clamped from 1 to 100.",
				default: SETTINGS_DEFAULTS.fullscreenWheelScrollLines,
			}),
		),
		btw: Type.Optional(BtwSettingsSchema),
		loop: Type.Optional(LoopSettingsSchema),
		sessionState: Type.Optional(SessionStateSettingsSchema),
		queueMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				description: "Legacy setting migrated to steeringMode.",
				deprecated: true,
			}),
		),
		websockets: Type.Optional(
			Type.Boolean({ description: "Legacy setting migrated to transport.", deprecated: true }),
		),
	},
	{ additionalProperties: true },
);

type SettingsInput = Static<typeof SettingsSchema>;

export interface CompactionModelOverride extends Static<typeof CompactionModelOverrideSchema> {}
export interface CompactionSettings extends Static<typeof CompactionSettingsSchema> {}
export interface BranchSummarySettings extends Static<typeof BranchSummarySettingsSchema> {}
export interface ProviderRetrySettings extends Static<typeof ProviderRetrySettingsSchema> {}
export interface AgentMailSettings extends Static<typeof AgentMailSettingsSchema> {}
export interface SubagentsSettings extends Static<typeof SubagentsSettingsSchema> {}
export interface RefusalFallbackSettings extends Static<typeof RefusalFallbackSettingsSchema> {}
export interface ErrorFallbackSettings extends Static<typeof ErrorFallbackSettingsSchema> {}
export interface BtwSettings extends Static<typeof BtwSettingsSchema> {}
export interface LoopSettings extends Static<typeof LoopSettingsSchema> {}
export interface SessionStateSettings extends Static<typeof SessionStateSettingsSchema> {}
export type ToolDisplayMode = Static<typeof ToolDisplaySchema>;
export interface RetrySettings extends Omit<Static<typeof RetrySettingsSchema>, "maxDelayMs"> {}
export interface TerminalSettings extends Static<typeof TerminalSettingsSchema> {}
export interface ImageSettings extends Static<typeof ImageSettingsSchema> {}
export interface ThinkingBudgetsSettings extends Static<typeof ThinkingBudgetsSettingsSchema> {}
export type MermaidRenderingMode = NonNullable<Static<typeof MarkdownSettingsSchema>["mermaid"]>;
export interface MarkdownSettings extends Static<typeof MarkdownSettingsSchema> {}
export interface WarningSettings extends Static<typeof WarningSettingsSchema> {}
export type CodemodeMode = Static<typeof CodemodeModeSchema>;
export interface CodemodeSettings extends Static<typeof CodemodeSettingsSchema> {}
export type DefaultProjectTrust = NonNullable<SettingsInput["defaultProjectTrust"]>;
export type QuietStartup = NonNullable<SettingsInput["quietStartup"]>;
export type TransportSetting = NonNullable<SettingsInput["transport"]>;
export type SessionShareDestination = NonNullable<SettingsInput["sessionShareDestination"]>;
export type PackageSource = Static<typeof PackageSourceSchema>;
export type FullscreenExitOutput = NonNullable<SettingsInput["fullscreenExitOutput"]>;
export type TuiMode = NonNullable<SettingsInput["tuiMode"]>;
export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;
export interface Settings extends Omit<SettingsInput, "queueMode" | "retry" | "skills" | "websockets"> {
	retry?: RetrySettings;
	skills?: string[];
}
