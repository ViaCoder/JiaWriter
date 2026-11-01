/**
 * WriterAgent model configuration from environment variables.
 * Pure functions only: reading and checking WA_* values, building URLs,
 * clamping the output budget and writing the Chinese setup hint.
 */

/** Provider name under which the WA_* model is registered. */
export const WA_PROVIDER = "wa";
/** Context window used when WA_CTX is not set. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Output limit used when WA_OUT is not set. */
export const DEFAULT_MAX_OUTPUT = 128_000;
/** Tokens kept free between input and output so a request never overflows. */
export const OUTPUT_SAFETY_MARGIN = 1_024;
/** Smallest output budget ever requested, even when the input is very large. */
export const MIN_OUTPUT_TOKENS = 256;

/** Reasoning levels a user can choose with WA_REASONING; "off" turns reasoning off. */
export const WRITER_REASONING_CHOICES = ["off", "low", "medium", "high", "xhigh", "max"] as const;
/** One WA_REASONING value. */
export type WriterReasoning = (typeof WRITER_REASONING_CHOICES)[number];
/** Level used when WA_REASONING is not set (the same default pi uses). */
export const DEFAULT_REASONING: WriterReasoning = "medium";

/** The three APIs WriterAgent can talk to. */
export type WriterApi = "anthropic-messages" | "openai-responses" | "openai-completions";
/** All supported API names, in the order the detector tries them. */
export const WRITER_APIS: readonly WriterApi[] = ["anthropic-messages", "openai-responses", "openai-completions"];

/** Checked model settings taken from the environment. */
export interface WriterEnvConfig {
	/** Base URL with any trailing slash and trailing /v1 removed. */
	root: string;
	/** Model name sent to the API. */
	model: string;
	/** API chosen by WA_API, or undefined to detect it. */
	api?: WriterApi;
	/** Context window in tokens. */
	contextWindow: number;
	/** Maximum output tokens. */
	maxTokens: number;
	/** Requested reasoning level; the nearest supported level is used when this one is not available. */
	reasoning: WriterReasoning;
}

/** Result of reading the WA_* variables. */
export interface WriterEnvReadResult {
	/** True when any WA_* model variable is set (the user chose this configuration path). */
	present: boolean;
	/** Required variables that are missing. */
	missing: string[];
	/** Variables that are set but invalid, with a Chinese reason each. */
	errors: string[];
	/** The checked configuration, only when missing and errors are both empty. */
	config?: WriterEnvConfig;
}

/** Required variables, in the order they are reported. */
const REQUIRED_VARS = ["WA_URL", "WA_KEY", "WA_MODEL"] as const;
/** Every variable that marks the WA_* configuration as present. */
const MODEL_VARS = ["WA_URL", "WA_KEY", "WA_MODEL", "WA_API", "WA_CTX", "WA_OUT"] as const;

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

/** Read and check the WA_* model variables. */
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
	const url = readVar(env, "WA_URL");
	// Check the URL format.
	if (url !== undefined && !/^https?:\/\/[^\s/]+/i.test(url)) {
		// Explain the expected form.
		errors.push(`WA_URL 必须是 http:// 或 https:// 开头的地址，当前值：${url}`);
	}
	// The API name, when set, must be one of the three supported values.
	const apiRaw = readVar(env, "WA_API");
	// Accept only known names.
	const api =
		apiRaw !== undefined && (WRITER_APIS as readonly string[]).includes(apiRaw) ? (apiRaw as WriterApi) : undefined;
	// Report an unknown API name.
	if (apiRaw !== undefined && api === undefined) {
		// List the valid choices.
		errors.push(`WA_API 只能是 ${WRITER_APIS.join(" / ")}，当前值：${apiRaw}（不设置则自动检测）`);
	}
	// Context window and output limit, with defaults.
	const contextWindow = readPositiveInt(env, "WA_CTX", DEFAULT_CONTEXT_WINDOW, errors);
	// Output limit.
	const maxTokens = readPositiveInt(env, "WA_OUT", DEFAULT_MAX_OUTPUT, errors);
	// The interface language, when set, must be zh or en.
	const lang = readVar(env, "WA_LANG");
	// Report other values.
	if (lang !== undefined && lang !== "zh" && lang !== "en") errors.push(`WA_LANG 只能是 zh 或 en，当前值：${lang}`);
	// Reasoning level, when set, must be one of the choices.
	const reasoningRaw = readVar(env, "WA_REASONING");
	// Default, a known level, or undefined for an unknown value.
	const reasoning =
		reasoningRaw === undefined
			? DEFAULT_REASONING
			: (WRITER_REASONING_CHOICES as readonly string[]).includes(reasoningRaw)
				? (reasoningRaw as WriterReasoning)
				: undefined;
	// Report an unknown level.
	if (reasoning === undefined)
		errors.push(`WA_REASONING 只能是 ${WRITER_REASONING_CHOICES.join(" / ")}，当前值：${reasoningRaw}`);
	// Any problem: no configuration.
	if (missing.length > 0 || errors.length > 0) return { present, missing, errors };
	// Everything checked: build the configuration (url and model are set here).
	return {
		present,
		missing,
		errors,
		config: {
			root: normalizeBaseUrl(url as string),
			model: readVar(env, "WA_MODEL") as string,
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
	const text = JSON.stringify(payload) ?? "";
	// CJK ideographs, kana, hangul and full-width forms are about one token each.
	const cjk = text.match(/[　-鿿가-힯＀-￯]/g)?.length ?? 0;
	// The remaining characters average about four per token.
	const other = text.length - cjk;
	// Round up so the estimate errs on the large side.
	return cjk + Math.ceil(other / 4);
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
	// undefined tells the hook runner to keep the original payload.
	return changed ? next : undefined;
}

/** Chinese setup hint with copy-ready commands for the current platform. */
export function formatSetupHint(missing: string[], errors: string[], platform: NodeJS.Platform): string {
	// Lines of the message.
	const lines: string[] = [];
	// Headline.
	lines.push("WriterAgent 需要通过环境变量配置模型。");
	// Missing variables, if any.
	if (missing.length > 0) lines.push(`缺少：${missing.join("、")}`);
	// Invalid values, one per line.
	for (const error of errors) lines.push(`格式错误：${error}`);
	// Example values; the key stays a placeholder.
	const examples: [string, string][] = [
		["WA_URL", "https://api.example.com"],
		["WA_KEY", "<你的 API key>"],
		["WA_MODEL", "<模型名>"],
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
		"可选：WA_API（不设置则自动检测）、WA_CTX、WA_OUT（默认都是 128000）、WA_REASONING（off / low / medium / high / xhigh / max，默认 medium，不支持时自动改用最接近的档位）、WA_LANG（zh / en）。",
	);
	// Join into one message.
	return lines.join("\n");
}
