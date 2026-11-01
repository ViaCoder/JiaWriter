/**
 * WriterAgent startup: turn the WA_* variables into the "wa" provider.
 * Called once from main.ts; the result is read by the built-in writer-env
 * extension (provider registration, output clamp) and by sdk.ts (default model).
 */

// Join the agent directory and the cache file name.
import { join } from "node:path";
// Probing and the detection cache.
import { type DetectResult, detectApi, detectCacheKey, loadDetectCache, saveDetectCache } from "./api-detect.ts";
// Variable parsing, URLs and the setup hint.
import { formatSetupHint, providerBaseUrl, readWriterEnv, WA_PROVIDER, type WriterApi } from "./env-config.ts";

/** Where the API type came from. */
export type ApiSource = "env" | "cache" | "detect";

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
		input: "text"[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
	}[];
}

/** Outcome of the startup step. */
export type WriterModelState =
	// No WA_* variable set: the user configures models another way.
	| { kind: "none" }
	// Variables checked but detection skipped (for --help).
	| { kind: "skipped" }
	// Ready to register.
	| {
			kind: "ready";
			api: WriterApi;
			source: ApiSource;
			model: string;
			contextWindow: number;
			maxTokens: number;
			provider: WriterProviderConfig;
	  }
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

/** State shared with the extension and sdk.ts. */
let current: WriterModelState = { kind: "none" };

/** Read the last startup result. */
export function getWriterModel(): WriterModelState {
	// Return the stored state.
	return current;
}

/** Replace the stored state (main.ts after setup; tests reset it). */
export function setWriterModel(state: WriterModelState): void {
	// Store the new state.
	current = state;
}

/** File that caches detected API types. */
export function detectCachePath(agentDir: string): string {
	// <agent dir>/api-detect.json
	return join(agentDir, "api-detect.json");
}

/** Build the provider registration for a ready configuration. */
export function buildProviderConfig(
	root: string,
	api: WriterApi,
	model: string,
	contextWindow: number,
	maxTokens: number,
): WriterProviderConfig {
	// One chat model with the configured limits.
	return {
		// Shown in model lists.
		name: "WriterAgent",
		// Endpoint base depends on the API.
		baseUrl: providerBaseUrl(root, api),
		// Read WA_KEY when each request is made.
		apiKey: "$WA_KEY",
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
				// No thinking parameters are sent (unknown whether the model supports them).
				reasoning: false,
				// Text input only; image support is unknown.
				input: ["text"],
				// Cost tracking is not configured.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// From WA_CTX.
				contextWindow,
				// From WA_OUT.
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
	if (result.reason === "auth") return `WA_KEY 无效或没有权限（${statuses}）。请检查 WA_KEY 和 WA_URL。`;
	// Nothing matched.
	return `无法自动识别 WA_URL 的 API 类型（${statuses}）。请检查 WA_URL 和 WA_MODEL，或用 WA_API 手动指定：anthropic-messages / openai-responses / openai-completions。`;
}

/** Read WA_*, decide the API type and prepare the provider; stores and returns the state. */
export async function setupWriterModel(options: SetupWriterModelOptions): Promise<WriterModelState> {
	// Check the variables.
	const read = readWriterEnv(options.env);
	// Not configured this way: nothing to do.
	if (!read.present) return remember({ kind: "none" });
	// Missing or invalid values: explain how to set them.
	if (!read.config)
		return remember({ kind: "error", message: formatSetupHint(read.missing, read.errors, options.platform) });
	// Checked configuration.
	const { root, model, contextWindow, maxTokens } = read.config;
	// 1. An explicit WA_API wins and needs no network.
	if (read.config.api) return remember(ready(root, read.config.api, "env", model, contextWindow, maxTokens));
	// --help: do not probe.
	if (!options.probe) return remember({ kind: "skipped" });
	// Cache file and key for this URL and model.
	const cachePath = detectCachePath(options.agentDir);
	// Key without the API key.
	const cacheKey = detectCacheKey(root, model);
	// 2. A previous detection.
	const cached = loadDetectCache(cachePath, cacheKey);
	// Use it without any request.
	if (cached) return remember(ready(root, cached, "cache", model, contextWindow, maxTokens));
	// 3. Probe the endpoints (the key is only used for these requests).
	const result = await detectApi(root, options.env.WA_KEY?.trim() ?? "", model, options.fetchFn);
	// Failure: explain with status codes.
	if (!result.ok) return remember({ kind: "error", message: formatDetectFailure(result) });
	// Remember the answer for the next start.
	saveDetectCache(cachePath, cacheKey, result.api);
	// Ready.
	return remember(ready(root, result.api, "detect", model, contextWindow, maxTokens));
}

/** Build a ready state. */
function ready(
	root: string,
	api: WriterApi,
	source: ApiSource,
	model: string,
	contextWindow: number,
	maxTokens: number,
): WriterModelState {
	// Everything the extension and sdk.ts need.
	return {
		kind: "ready",
		api,
		source,
		model,
		contextWindow,
		maxTokens,
		provider: buildProviderConfig(root, api, model, contextWindow, maxTokens),
	};
}

/** Store a state and return it. */
function remember(state: WriterModelState): WriterModelState {
	// Shared with the extension and sdk.ts.
	current = state;
	// Hand it back to the caller.
	return state;
}

/** Provider/model pair for startup model selection, when WA_* is ready. */
export function getWriterDefaultModel(): { provider: string; modelId: string } | undefined {
	// Only a ready configuration selects a model.
	return current.kind === "ready" ? { provider: WA_PROVIDER, modelId: current.model } : undefined;
}
