import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS } from "@earendil-works/pi-ai/utils/retry";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "@earendil-works/pi-ai/utils/stream-idle-guard";

/** Runtime defaults shared by settings accessors and the published JSON Schema. */
export const SETTINGS_DEFAULTS = {
	transport: "auto",
	sessionShareDestination: "auto",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	compaction: {
		enabled: true,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
	},
	branchSummary: {
		reserveTokens: 16384,
		skipPrompt: false,
	},
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		provider: {
			maxRetryDelayMs: 60000,
		},
	},
	hideThinkingBlock: false,
	showCacheMissNotices: false,
	quietStartup: false,
	defaultProjectTrust: "ask",
	collapseChangelog: false,
	// Updates are opt-in and require a configured release feed.
	autoUpdate: false,
	// Install telemetry is off unless PI_TELEMETRY=1 explicitly opts in.
	enableInstallTelemetry: false,
	enableAnalytics: false,
	enableSkillCommands: true,
	terminal: {
		showImages: true,
		imageWidthCells: 60,
		clearOnShrink: false,
		showTerminalProgress: false,
	},
	images: {
		autoResize: true,
		blockImages: false,
	},
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	markdown: {
		codeBlockIndent: "  ",
		mermaid: "streaming",
	},
	warnings: {
		anthropicExtraUsage: true,
	},
	codemode: {
		mode: "on",
		inlineBudget: 3000,
	},
	cacheWarming: "streaming",
	tuiMode: "fullscreen",
	fullscreenExitOutput: "transcript",
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	fullscreenWheelScrollLines: "auto",
} as const;

/** phi's own settings defaults, shared by the settings accessors and the published JSON Schema. */
export const PHI_SETTINGS_DEFAULTS = {
	serviceTier: "default",
	compaction: {
		softCeilingTokens: 300_000,
	},
	agentMail: {
		enabled: true,
	},
	refusalFallback: {
		enabled: true,
		sticky: true,
	},
	errorFallback: {
		enabled: false,
		// Configure fallback models explicitly in settings.json for your own provider.
		chain: [],
		sticky: false,
	},
	toolOutputLines: 5,
	toolDisplay: "minimal",
	streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	btw: {
		persist: true,
		maxHistory: 20,
	},
	loop: {
		maxIterations: 12,
		maxWallTimeMs: 7_200_000,
		checkTimeoutMs: 600_000,
		evaluatorConfidence: 0.85,
		maxCheckOutputBytes: 65_536,
	},
	sessionState: {
		classifier: "heuristic",
		model: "",
	},
} as const;
