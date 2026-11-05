/**
 * JiaWriter startup: turn the JW_* variables into the "jw" provider.
 * Called once from main.ts; the result is read by the built-in writer-env
 * extension (provider registration, output clamp, reasoning fallback) and by
 * sdk.ts (default model and thinking level).
 */

// Join the agent directory and the cache file name.
import { join } from "node:path";
// Probing and the detection cache.
import {
	buildProbe,
	type DetectResult,
	detectApi,
	detectCacheKey,
	detectReasoning,
	loadDetectCache,
	probeEndpoint,
	type ReasoningSupport,
	saveDetectCache,
} from "./api-detect.ts";
// Variable parsing, URLs and the setup hint.
import {
	formatSetupHint,
	JW_PROVIDER,
	providerBaseUrl,
	readWriterEnv,
	type WriterApi,
	type WriterReasoning,
} from "./env-config.ts";

/** Where the API type came from. */
export type ApiSource = "env" | "cache" | "detect";

/** pi thinking level map: a level name per supported level, null for unsupported ones. */
export type WriterThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
>;

/** Provider settings handed to pi.registerProvider(). */
export interface WriterProviderConfig {
	// Display name.
	name: string;
	// Endpoint base for this API.
	baseUrl: string;
	// Environment reference: the key is read at request time and never stored.
	apiKey: string;
	// Wire API.
	api: WriterApi;
	// One chat model.
	models: {
		type: "chat";
		id: string;
		name: string;
		reasoning: boolean;
		thinkingLevelMap?: WriterThinkingLevelMap;
		compat?: { forceAdaptiveThinking?: boolean };
		input: "text"[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
	}[];
}

/** A ready configuration. */
export interface WriterModelReady {
	kind: "ready";
	// Base URL without /v1 (used to rebuild the provider after a reasoning fallback).
	root: string;
	api: WriterApi;
	source: ApiSource;
	model: string;
	contextWindow: number;
	maxTokens: number;
	// Reasoning support of the endpoint.
	reasoning: ReasoningSupport;
	// Level asked for with JW_EFFORT.
	thinkingLevel: WriterReasoning;
	// Detection cache file and key (for the runtime reasoning fallback).
	cachePath: string;
	cacheKey: string;
	// Settings for registerProvider.
	provider: WriterProviderConfig;
}

/** Outcome of the startup step. */
export type WriterModelState =
	// No JW_* variable set: the user configures models another way.
	| { kind: "none" }
	// Variables checked but detection skipped (for --help).
	| { kind: "skipped" }
	// Ready to register.
	| WriterModelReady
	// Invalid configuration or failed detection; message is Chinese and safe to print.
	| { kind: "error"; message: string };

/** Options for setupWriterModel. */
export interface SetupWriterModelOptions {
	// Environment to read (process.env in production).
	env: NodeJS.ProcessEnv;
	// Agent directory holding api-detect.json.
	agentDir: string;
	// Platform for the setup hint.
	platform: NodeJS.Platform;
	// False skips probing (used for --help, which must not touch the network).
	probe: boolean;
	// fetch implementation (tests pass a mock).
	fetchFn: typeof fetch;
}

/** No reasoning. */
const NO_REASONING: ReasoningSupport = { mode: "none", levels: [] };

/** State shared with the extension and sdk.ts. */
let current: WriterModelState = { kind: "none" };

/** Read the last startup result. */
export function getWriterModel(): WriterModelState {
	// Return the stored state.
	return current;
}

/** Replace the stored state (main.ts after setup; the extension after a fallback; tests reset it). */
export function setWriterModel(state: WriterModelState): void {
	// Store the new state.
	current = state;
}

/** File that caches detected API types and reasoning support. */
export function detectCachePath(agentDir: string): string {
	// <agent dir>/api-detect.json
	return join(agentDir, "api-detect.json");
}

/** pi thinking level map for a reasoning support: unsupported levels are null, so pi picks the nearest supported one. */
export function writerThinkingLevelMap(support: ReasoningSupport): WriterThinkingLevelMap {
	// "minimal" is not offered (the choices run from low to max).
	const map: WriterThinkingLevelMap = { minimal: null };
	// Each offered level.
	for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
		// Supported in effort mode: send the level name itself.
		if (support.mode === "effort") map[level] = support.levels.includes(level) ? level : null;
		// Budget mode: pi computes budgets for low..high; xhigh and max are unavailable.
		else if (support.mode === "budget") map[level] = support.levels.includes(level) ? undefined : null;
		// No reasoning: everything above off is unavailable.
		else map[level] = null;
	}
	// Remove undefined entries so pi uses its built-in budgets for them.
	for (const key of Object.keys(map) as (keyof WriterThinkingLevelMap)[]) if (map[key] === undefined) delete map[key];
	// Done.
	return map;
}

/** Reasoning support without one level (no level left means no reasoning). */
export function dropReasoningLevel(support: ReasoningSupport, level: string): ReasoningSupport {
	// Keep the other levels.
	const levels = support.levels.filter((l) => l !== level);
	// Empty: reasoning off.
	return levels.length > 0 ? { mode: support.mode, levels } : NO_REASONING;
}

/** Build the provider registration for a ready configuration. */
export function buildProviderConfig(
	root: string,
	api: WriterApi,
	model: string,
	contextWindow: number,
	maxTokens: number,
	reasoning: ReasoningSupport = NO_REASONING,
): WriterProviderConfig {
	// True when any reasoning level works.
	const hasReasoning = reasoning.mode !== "none" && reasoning.levels.length > 0;
	// One chat model with the configured limits.
	return {
		// Shown in model lists.
		name: "JiaWriter",
		// Endpoint base depends on the API.
		baseUrl: providerBaseUrl(root, api),
		// Read JW_KEY when each request is made.
		apiKey: "$JW_KEY",
		// Wire API.
		api,
		// The single model.
		models: [
			{
				// Chat model.
				type: "chat",
				// Model name as the API expects it.
				id: model,
				// Same for display.
				name: model,
				// Reasoning parameters are sent only when the endpoint accepts them.
				reasoning: hasReasoning,
				// Supported levels; pi falls back to the nearest one.
				...(hasReasoning ? { thinkingLevelMap: writerThinkingLevelMap(reasoning) } : {}),
				// Anthropic effort levels need adaptive thinking.
				...(api === "anthropic-messages" && reasoning.mode === "effort"
					? { compat: { forceAdaptiveThinking: true } }
					: {}),
				// Text input only; image support is unknown.
				input: ["text"],
				// Cost tracking is not configured.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// From JW_CTX.
				contextWindow,
				// From JW_OUT.
				maxTokens,
			},
		],
	};
}

/** Chinese explanation of a failed detection (status codes only, no bodies, no key). */
export function formatDetectFailure(result: Extract<DetectResult, { ok: false }>): string {
	// One line per probe: API name and status (0 means no response).
	const statuses = result.outcomes
		.map((o) => `${o.api}：${o.status === 0 ? "无响应" : `HTTP ${o.status}`}`)
		.join("；");
	// Wrong key.
	if (result.reason === "auth") return `JW_KEY 无效或没有权限（${statuses}）。请检查 JW_KEY 和 JW_URL。`;
	// Nothing matched.
	return `无法自动识别 JW_URL 的 API 类型（${statuses}）。请检查 JW_URL 和 JW_MODEL，或用 JW_API 手动指定：anthropic-messages / openai-responses / openai-completions。`;
}

/** Read JW_*, decide the API type and reasoning support, prepare the provider; stores and returns the state. */
export async function setupWriterModel(options: SetupWriterModelOptions): Promise<WriterModelState> {
	// Check the variables.
	const read = readWriterEnv(options.env);
	// Not configured this way: nothing to do.
	if (!read.present) return remember({ kind: "none" });
	// Missing or invalid values: explain how to set them.
	if (!read.config)
		return remember({ kind: "error", message: formatSetupHint(read.missing, read.errors, options.platform) });
	// Checked configuration.
	const { root, model, contextWindow, maxTokens, reasoning: requested } = read.config;
	// Cache file and key for this URL and model.
	const cachePath = detectCachePath(options.agentDir);
	// Key without the API key.
	const cacheKey = detectCacheKey(root, model);
	// The key, used only for the probes.
	const key = options.env.JW_KEY?.trim() ?? "";
	// Shared fields of every ready state.
	const base = { root, model, contextWindow, maxTokens, thinkingLevel: requested, cachePath, cacheKey };
	// Previous detection, if any.
	const cached = loadDetectCache(cachePath, cacheKey);
	// API type: JW_API, then cache, then probing.
	let api: WriterApi;
	// Where it came from.
	let source: ApiSource;
	// Response of the matching probe, used as the baseline for reasoning probes.
	let baseline: { status: number; body: string } | undefined;
	// 1. An explicit JW_API wins and needs no network.
	if (read.config.api) {
		// Use it.
		api = read.config.api;
		// From the environment.
		source = "env";
	} else if (cached) {
		// 2. A previous detection.
		api = cached.api;
		// From the cache.
		source = "cache";
	} else {
		// --help: do not probe.
		if (!options.probe) return remember({ kind: "skipped" });
		// 3. Probe the endpoints.
		const result = await detectApi(root, key, model, options.fetchFn);
		// Failure: explain with status codes.
		if (!result.ok) return remember({ kind: "error", message: formatDetectFailure(result) });
		// Detected.
		api = result.api;
		// From probing.
		source = "detect";
		// The last outcome is the match: reuse it as the baseline.
		baseline = result.outcomes[result.outcomes.length - 1];
	}
	// Reasoning support: off needs nothing; otherwise cache, then probes.
	let reasoning: ReasoningSupport = NO_REASONING;
	// Only when reasoning is wanted.
	if (requested !== "off") {
		// Known from an earlier start for the same API.
		if (cached?.api === api && cached.reasoning) reasoning = cached.reasoning;
		// Probe when allowed.
		else if (options.probe) {
			// Baseline: the matching detection probe, or one plain probe now.
			const plain = baseline ?? (await probeEndpoint(options.fetchFn, buildProbe(root, api, key, model)));
			// Probe each level.
			const found = await detectReasoning(root, api, key, model, options.fetchFn, plain);
			// A key problem at this point is reported like a failed detection.
			if (found === "auth")
				return remember({
					kind: "error",
					message: "JW_KEY 无效或没有权限（检测推理档位时被拒绝）。请检查 JW_KEY 和 JW_URL。",
				});
			// Use the result.
			reasoning = found;
		}
	}
	// Remember API and reasoning for the next start (only when something was probed or detected).
	if (source === "detect" || (requested !== "off" && !(cached?.api === api && cached.reasoning) && options.probe)) {
		// Keep the reasoning result only when it was probed.
		saveDetectCache(cachePath, cacheKey, api, new Date(), requested !== "off" ? reasoning : cached?.reasoning);
	}
	// Ready.
	return remember({
		kind: "ready",
		api,
		source,
		reasoning,
		...base,
		provider: buildProviderConfig(root, api, model, contextWindow, maxTokens, reasoning),
	});
}

/** Store a state and return it. */
function remember(state: WriterModelState): WriterModelState {
	// Shared with the extension and sdk.ts.
	current = state;
	// Hand it back to the caller.
	return state;
}

/** Provider, model and initial thinking level for startup model selection, when JW_* is ready. */
export function getWriterDefaultModel():
	| { provider: string; modelId: string; thinkingLevel: WriterReasoning }
	| undefined {
	// Only a ready configuration selects a model; pi clamps the level to the nearest supported one.
	return current.kind === "ready"
		? { provider: JW_PROVIDER, modelId: current.model, thinkingLevel: current.thinkingLevel }
		: undefined;
}
