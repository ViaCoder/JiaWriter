/**
 * JiaWriter model configuration from environment variables.
 * Pure functions only: reading and checking JW_* values, building URLs,
 * clamping the output budget and writing the Chinese setup hint.
 */

// The check of PROMPT_ADD.
import { promptAddProblem } from "./prompt-add.ts";
// Token estimate shared with compaction.
import { estimateTextTokens } from "./token-estimate.ts";

/** Provider name under which the JW_* model is registered. */
export const JW_PROVIDER = "jw";
/** Context window used when JW_CTX is not set. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Output limit used when JW_OUT is not set. */
export const DEFAULT_MAX_OUTPUT = 128_000;
/** Tokens kept free between input and output so a request never overflows. */
export const OUTPUT_SAFETY_MARGIN = 1_024;
/** Smallest output budget ever requested, even when the input is very large. */
export const MIN_OUTPUT_TOKENS = 256;

/** Reasoning levels a user can choose with JW_EFFORT; "off" turns reasoning off. */
export const WRITER_REASONING_CHOICES = ["off", "low", "medium", "high", "xhigh", "max"] as const;
/** One JW_EFFORT value. */
export type WriterReasoning = (typeof WRITER_REASONING_CHOICES)[number];
/** Level used when JW_EFFORT is not set (the same default pi uses). */
export const DEFAULT_REASONING: WriterReasoning = "medium";

/** The three APIs JiaWriter can talk to. */
export type WriterApi = "anthropic-messages" | "openai-responses" | "openai-completions";
/** All supported API names, in the order the detector tries them. */
export const WRITER_APIS: readonly WriterApi[] = ["anthropic-messages", "openai-responses", "openai-completions"];

/** Checked model settings taken from the environment. */
export interface WriterEnvConfig {
	/** Base URL with any trailing slash and trailing /v1 removed. */
	root: string;
	/** Model name sent to the API. */
	model: string;
	/** API chosen by JW_API, or undefined to detect it. */
	api?: WriterApi;
	/** Context window in tokens. */
	contextWindow: number;
	/** Maximum output tokens. */
	maxTokens: number;
	/** Requested reasoning level; the nearest supported level is used when this one is not available. */
	reasoning: WriterReasoning;
}

/** Result of reading the JW_* variables. */
export interface WriterEnvReadResult {
	/** True when any JW_* model variable is set (the user chose this configuration path). */
	present: boolean;
	/** Required variables that are missing. */
	missing: string[];
	/** Variables that are set but invalid, with a Chinese reason each. */
	errors: string[];
	/** The checked configuration, only when missing and errors are both empty. */
	config?: WriterEnvConfig;
}

/** Required variables, in the order they are reported. */
const REQUIRED_VARS = ["JW_URL", "JW_KEY", "JW_MODEL"] as const;
/** Every variable that marks the JW_* configuration as present. */
const MODEL_VARS = ["JW_URL", "JW_KEY", "JW_MODEL", "JW_API", "JW_CTX", "JW_OUT"] as const;

/** Return the trimmed value of a variable, or undefined when it is unset or blank. */
function readVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
	// Missing variables read as undefined.
	const raw = env[name];
	// Blank values count as unset.
	const value = raw?.trim();
	// Hand back a non-empty value or undefined.
	return value ? value : undefined;
}

/** Parse a positive integer variable; push a Chinese error when it is not one. */
function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, errors: string[]): number {
	// Unset means "use the default".
	const raw = readVar(env, name);
	// Nothing set: default value.
	if (raw === undefined) return fallback;
	// Accept plain digits only (no units, no signs, no decimals).
	if (!/^\d+$/.test(raw)) {
		// Explain what is expected.
		errors.push(`${name} 必须是正整数（单位 token），当前值：${raw}`);
		// Keep going with the default so all problems are reported at once.
		return fallback;
	}
	// Convert the digits to a number.
	const value = Number.parseInt(raw, 10);
	// Zero is not a usable size.
	if (value <= 0) {
		// Explain the rule.
		errors.push(`${name} 必须大于 0，当前值：${raw}`);
		// Default again.
		return fallback;
	}
	// A valid size.
	return value;
}

/** Remove trailing slashes and one trailing /v1 so every API can append its own path. */
export function normalizeBaseUrl(url: string): string {
	// Drop whitespace around the value.
	let root = url.trim();
	// Remove every trailing slash.
	root = root.replace(/\/+$/, "");
	// Remove a single trailing /v1 (any case).
	root = root.replace(/\/v1$/i, "");
	// Removing /v1 may expose another trailing slash.
	return root.replace(/\/+$/, "");
}

/** Base URL to register for an API: Anthropic SDKs add /v1 themselves, OpenAI SDKs expect it. */
export function providerBaseUrl(root: string, api: WriterApi): string {
	// Anthropic: https://host -> SDK calls https://host/v1/messages.
	if (api === "anthropic-messages") return root;
	// OpenAI Responses and Chat: https://host/v1 -> SDK calls /responses or /chat/completions.
	return `${root}/v1`;
}

/** Read and check the JW_* model variables. */
export function readWriterEnv(env: NodeJS.ProcessEnv): WriterEnvReadResult {
	// The configuration path is in use when any model variable is set.
	const present = MODEL_VARS.some((name) => readVar(env, name) !== undefined);
	// Collect missing required variables.
	const missing = present ? REQUIRED_VARS.filter((name) => readVar(env, name) === undefined) : [];
	// Collect invalid values.
	const errors: string[] = [];
	// Nothing set at all: the user configures models another way (models.json or /login).
	if (!present) return { present, missing: [], errors };
	// The URL, when set, must be an http(s) address.
	const url = readVar(env, "JW_URL");
	// Check the URL format.
	if (url !== undefined && !/^https?:\/\/[^\s/]+/i.test(url)) {
		// Explain the expected form.
		errors.push(`JW_URL 必须是 http:// 或 https:// 开头的地址，当前值：${url}`);
	}
	// The API name, when set, must be one of the three supported values.
	const apiRaw = readVar(env, "JW_API");
	// Accept only known names.
	const api =
		apiRaw !== undefined && (WRITER_APIS as readonly string[]).includes(apiRaw) ? (apiRaw as WriterApi) : undefined;
	// Report an unknown API name.
	if (apiRaw !== undefined && api === undefined) {
		// List the valid choices.
		errors.push(`JW_API 只能是 ${WRITER_APIS.join(" / ")}，当前值：${apiRaw}（不设置则自动检测）`);
	}
	// Context window and output limit, with defaults.
	const contextWindow = readPositiveInt(env, "JW_CTX", DEFAULT_CONTEXT_WINDOW, errors);
	// Output limit.
	const maxTokens = readPositiveInt(env, "JW_OUT", DEFAULT_MAX_OUTPUT, errors);
	// The interface language, when set, must be zh or en.
	const lang = readVar(env, "JW_LANG");
	// Report other values.
	if (lang !== undefined && lang !== "zh" && lang !== "en") errors.push(`JW_LANG 只能是 zh 或 en，当前值：${lang}`);
	// The old name stopped working on 2026-11-05: silently ignoring it would change the user's level.
	if (readVar(env, "JW_REASONING") !== undefined) errors.push("JW_REASONING 已改名为 JW_EFFORT，请改用新名字。");
	// Reasoning level, when set, must be one of the choices.
	const reasoningRaw = readVar(env, "JW_EFFORT");
	// Default, a known level, or undefined for an unknown value.
	const reasoning =
		reasoningRaw === undefined
			? DEFAULT_REASONING
			: (WRITER_REASONING_CHOICES as readonly string[]).includes(reasoningRaw)
				? (reasoningRaw as WriterReasoning)
				: undefined;
	// Report an unknown level.
	if (reasoning === undefined)
		errors.push(`JW_EFFORT 只能是 ${WRITER_REASONING_CHOICES.join(" / ")}，当前值：${reasoningRaw}`);
	// The persona addition must be readable: a silent start without it would look like a model change.
	const promptAdd = promptAddProblem(env);
	if (promptAdd) errors.push(promptAdd);
	// Any problem: no configuration.
	if (missing.length > 0 || errors.length > 0) return { present, missing, errors };
	// Everything checked: build the configuration (url and model are set here).
	return {
		present,
		missing,
		errors,
		config: {
			root: normalizeBaseUrl(url as string),
			model: readVar(env, "JW_MODEL") as string,
			api,
			contextWindow,
			maxTokens,
			// Checked above: defined whenever there are no errors.
			reasoning: reasoning as WriterReasoning,
		},
	};
}

/** Rough token count of a request payload: CJK characters 1 each, other characters 4 per token. */
export function estimatePayloadTokens(payload: unknown): number {
	// Serialize once; undefined becomes an empty string.
	return estimateTextTokens(JSON.stringify(payload) ?? "");
}

/** Output budget that fits next to the input: min(maxTokens, context - input - margin), at least MIN_OUTPUT_TOKENS. */
export function clampMaxTokens(
	maxTokens: number,
	contextWindow: number,
	inputTokens: number,
	margin = OUTPUT_SAFETY_MARGIN,
): number {
	// Space left in the context window after the input and the margin.
	const available = contextWindow - inputTokens - margin;
	// Never ask for more than configured, never more than fits.
	const budget = Math.min(maxTokens, available);
	// Keep a small floor; the provider reports a clear error if even that does not fit.
	return Math.max(MIN_OUTPUT_TOKENS, Math.floor(budget));
}

/** Smallest thinking budget Anthropic accepts. */
const MIN_THINKING_BUDGET = 1024;

/** Payload field that carries the output limit for each API. */
const OUTPUT_FIELDS: Record<WriterApi, string[]> = {
	// Anthropic Messages.
	"anthropic-messages": ["max_tokens"],
	// OpenAI Responses.
	"openai-responses": ["max_output_tokens"],
	// OpenAI Chat Completions uses one of two names depending on the server.
	"openai-completions": ["max_completion_tokens", "max_tokens"],
};

/** Return a payload whose output limit is clamped, or undefined when nothing changes. */
export function applyOutputClamp(payload: unknown, api: WriterApi, contextWindow: number, maxTokens: number): unknown {
	// Only plain objects carry the fields we adjust.
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	// Work on a shallow copy so the original payload is left alone.
	const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
	// The input part is everything except the output limit itself.
	const inputTokens = estimatePayloadTokens(next);
	// The budget that fits.
	const budget = clampMaxTokens(maxTokens, contextWindow, inputTokens);
	// Track whether any field was changed.
	let changed = false;
	// Adjust each output field this API uses.
	for (const field of OUTPUT_FIELDS[api]) {
		// Current requested value, if the field is present.
		const current = next[field];
		// Only lower numeric values that exceed the budget.
		if (typeof current === "number" && current > budget) {
			// Lower it to the budget.
			next[field] = budget;
			// Remember the change.
			changed = true;
		}
	}
	// Anthropic refuses a thinking budget that does not leave room for the answer, and the upstream budget
	// was sized from the model's limit, before this clamp.
	const thinking = next.thinking as { type?: string; budget_tokens?: unknown } | undefined;
	if (api === "anthropic-messages" && thinking?.type === "enabled" && typeof thinking.budget_tokens === "number") {
		// The output limit this request ends up with.
		const output = typeof next.max_tokens === "number" ? next.max_tokens : budget;
		if (thinking.budget_tokens >= output) {
			// Half for thinking, half for the answer; too little to think with means no thinking.
			const half = Math.floor(output / 2);
			if (half >= MIN_THINKING_BUDGET) next.thinking = { ...thinking, budget_tokens: half };
			else delete next.thinking;
			changed = true;
		}
	}
	// undefined tells the hook runner to keep the original payload.
	return changed ? next : undefined;
}

/** Chinese setup hint with copy-ready commands for the current platform. */
export function formatSetupHint(missing: string[], errors: string[], platform: NodeJS.Platform): string {
	// Lines of the message.
	const lines: string[] = [];
	// Headline.
	lines.push("JiaWriter 需要通过环境变量配置模型。");
	// Missing variables, if any.
	if (missing.length > 0) lines.push(`缺少：${missing.join("、")}`);
	// Invalid values, one per line.
	for (const error of errors) lines.push(`格式错误：${error}`);
	// Example values; the key stays a placeholder.
	const examples: [string, string][] = [
		["JW_URL", "https://api.example.com"],
		["JW_KEY", "<你的 API key>"],
		["JW_MODEL", "<模型名>"],
	];
	// Show commands only for the variables that need attention, or all required ones.
	const wanted = missing.length > 0 ? examples.filter(([name]) => missing.includes(name)) : examples;
	// Blank line before the commands.
	lines.push("");
	// Windows: PowerShell for the current window and setx for later windows, plus cmd.
	if (platform === "win32") {
		// PowerShell, current window.
		lines.push("PowerShell（当前窗口有效）：");
		// One assignment per variable.
		for (const [name, value] of wanted) lines.push(`  $env:${name}="${value}"`);
		// PowerShell or cmd, persistent.
		lines.push("长期有效（需新开终端）：");
		// One setx per variable.
		for (const [name, value] of wanted) lines.push(`  setx ${name} "${value}"`);
		// Classic cmd.
		lines.push("cmd（当前窗口有效）：");
		// One set per variable.
		for (const [name, value] of wanted) lines.push(`  set ${name}=${value}`);
	} else {
		// bash and zsh on Linux and macOS.
		lines.push("Linux / macOS（bash、zsh）：");
		// One export per variable, quoted.
		for (const [name, value] of wanted) lines.push(`  export ${name}="${value}"`);
		// How to keep the values.
		lines.push("长期有效：把上面几行写进 ~/.bashrc 或 ~/.zshrc。fish 用 set -gx 变量名 值。");
	}
	// Optional variables.
	lines.push(
		"可选：JW_API（不设置则自动检测）、JW_CTX、JW_OUT（默认都是 128000）、JW_EFFORT（off / low / medium / high / xhigh / max，默认 medium，不支持时自动改用最接近的档位）、JW_LANG（zh / en）。",
	);
	// Join into one message.
	return lines.join("\n");
}
