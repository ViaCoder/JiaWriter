import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS } from "@earendil-works/pi-ai/utils/retry";

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
		// JiaWriter: five tries with doubling waits (2, 4, 8, 16, 32 s, about a minute in all) instead of pi's three
		// (14 s): on 2026-11-17 the upstream's rate-limit bursts lasted one or two minutes, and runs that gave up after
		// 14 s had nothing to show, while the same requests went through a minute later.
		maxRetries: 5,
		baseDelayMs: 2000,
		maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		provider: {
			maxRetryDelayMs: 60000,
		},
	},
	// JiaWriter: the model's reasoning stays folded, as in Claude Code (ctrl+t shows it); GLM reasons in English.
	hideThinkingBlock: true,
	showCacheMissNotices: false,
	quietStartup: false,
	defaultProjectTrust: "ask",
	collapseChangelog: false,
	// JiaWriter: no version ping to pi.dev from a fork (2026-11-15).
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
