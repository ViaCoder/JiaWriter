/**
 * The read-only /jw page: each JiaWriter variable with its value in effect and where it comes from
 * (environment, detection, cache, /lang, default), keys only as set or unset, URLs without credentials,
 * and copy-ready commands for this platform with the key as a placeholder.
 */

// URL credential redaction shared with the upstream bug report.
import { redactUrl } from "../core/bug-report.ts";
// Defaults of the model variables.
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT, DEFAULT_REASONING } from "./env-config.ts";
// Messages and the language source.
import { currentLang, savedLang, t, type WriterLang } from "./i18n/index.ts";
// The permission mode.
import { parsePermissionMode, permissionMode, savedPermissionMode } from "./permission.ts";
// The persona addition, shown by path and size.
import { promptAddPath, promptAddText } from "./prompt-add.ts";
// Search defaults.
import { DEFAULT_ANYSEARCH_URL, DEFAULT_DEEPSEEK_URL, DEFAULT_FIRECRAWL_URL } from "./websearch/core.ts";
// Main-model state after startup.
import type { WriterModelState } from "./writer-model.ts";

/** One row of the page. */
export interface ConfigRow {
	// Variable name.
	name: string;
	// Value in effect (never a key).
	value: string;
	// Where the value comes from.
	source: string;
}

/** A variable's trimmed value, or undefined when unset or blank. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	// Blank counts as unset.
	const v = env[name]?.trim();
	return v ? v : undefined;
}

/** Rows of the model group. */
export function modelRows(env: NodeJS.ProcessEnv, state: WriterModelState, lang?: WriterLang): ConfigRow[] {
	// Source labels.
	const src = (k: "env" | "default" | "detect" | "cache" | "manual") => t(`jw.src.${k}`, {}, lang);
	const fromEnv = (name: string, fallback: string) => {
		const v = readEnv(env, name);
		return { name, value: v ?? fallback, source: v ? src("env") : src("default") };
	};
	// The API: from JW_API, detection or the detection cache.
	const ready = state.kind === "ready" ? state : undefined;
	const api = ready
		? {
				name: "JW_API",
				value: ready.api,
				source: ready.source === "env" ? src("manual") : ready.source === "cache" ? src("cache") : src("detect"),
			}
		: {
				name: "JW_API",
				value: readEnv(env, "JW_API") ?? "-",
				source: readEnv(env, "JW_API") ? src("manual") : src("detect"),
			};
	// Reasoning: the level asked for and what the endpoint supports.
	const reasoning = fromEnv("JW_EFFORT", DEFAULT_REASONING);
	if (ready) reasoning.value += t("jw.reasoningLevels", { levels: ready.reasoning.levels.join("/") || "-" }, lang);
	// All model rows.
	return [
		{
			name: "JW_URL",
			value: readEnv(env, "JW_URL") ? redactUrl(readEnv(env, "JW_URL") ?? "") : t("jw.unset", {}, lang),
			source: src(readEnv(env, "JW_URL") ? "env" : "default"),
		},
		{
			name: "JW_KEY",
			value: t(readEnv(env, "JW_KEY") ? "jw.set" : "jw.unset", {}, lang),
			source: src(readEnv(env, "JW_KEY") ? "env" : "default"),
		},
		fromEnv("JW_MODEL", t("jw.unset", {}, lang)),
		api,
		fromEnv("JW_CTX", String(DEFAULT_CONTEXT_WINDOW)),
		fromEnv("JW_OUT", String(DEFAULT_MAX_OUTPUT)),
		reasoning,
	];
}

/** Rows of the interface and search group. */
export function otherRows(env: NodeJS.ProcessEnv, lang?: WriterLang): ConfigRow[] {
	// Language: environment, /lang, or the default.
	const langSource = readEnv(env, "JW_LANG") ? "jw.src.env" : savedLang() ? "jw.src.lang" : "jw.src.default";
	const src = (name: string) => t(readEnv(env, name) ? "jw.src.env" : "jw.src.default", {}, lang);
	return [
		{ name: "JW_LANG", value: currentLang(), source: t(langSource, {}, lang) },
		// How much new tools ask: environment, /jw permission, or the default.
		{
			name: "JW_PERMISSION",
			value: permissionMode(env),
			source: t(
				parsePermissionMode(env.JW_PERMISSION)
					? "jw.src.env"
					: savedPermissionMode()
						? "jw.src.permission"
						: "jw.src.default",
				{},
				lang,
			),
		},
		{ name: "JW_ENGINES", value: readEnv(env, "JW_ENGINES") ?? "bing,google", source: src("JW_ENGINES") },
		{ name: "JW_SEARCH_PAGES", value: readEnv(env, "JW_SEARCH_PAGES") ?? "3", source: src("JW_SEARCH_PAGES") },
		{
			name: "JW_SEARCH_URL",
			value: redactUrl(readEnv(env, "JW_SEARCH_URL") ?? DEFAULT_ANYSEARCH_URL),
			source: src("JW_SEARCH_URL"),
		},
		{
			name: "ANYSEARCH_KEY",
			value: t(readEnv(env, "ANYSEARCH_KEY") ? "jw.set" : "jw.anonymous", {}, lang),
			source: src("ANYSEARCH_KEY"),
		},
		{
			name: "JW_DEEPSEEK_URL",
			value: redactUrl(readEnv(env, "JW_DEEPSEEK_URL") ?? DEFAULT_DEEPSEEK_URL),
			source: src("JW_DEEPSEEK_URL"),
		},
		{
			name: "DEEPSEEK_KEY",
			value: t(readEnv(env, "DEEPSEEK_KEY") ? "jw.set" : "jw.unset", {}, lang),
			source: src("DEEPSEEK_KEY"),
		},
		{
			name: "JW_FIRECRAWL_URL",
			value: redactUrl(readEnv(env, "JW_FIRECRAWL_URL") ?? DEFAULT_FIRECRAWL_URL),
			source: src("JW_FIRECRAWL_URL"),
		},
		{
			name: "FIRECRAWL_KEY",
			value: t(readEnv(env, "FIRECRAWL_KEY") ? "jw.set" : "jw.unset", {}, lang),
			source: src("FIRECRAWL_KEY"),
		},
		{ name: "JW_SF", value: readEnv(env, "JW_SF") ?? t("jw.sfAuto", {}, lang), source: src("JW_SF") },
		{
			name: "PROMPT_ADD",
			// The path and size only: the text is the user's own.
			value: promptAddPath(env)
				? t("jw.promptAdd", { path: promptAddPath(env) ?? "", chars: promptAddText(env).length }, lang)
				: t("jw.unset", {}, lang),
			source: src("PROMPT_ADD"),
		},
	];
}

/** Copy-ready commands for this platform with the current values; the key is a placeholder. */
export function setupCommands(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, lang?: WriterLang): string[] {
	// Required variables with their current value or an example.
	const pairs: [string, string][] = [
		["JW_URL", readEnv(env, "JW_URL") ? redactUrl(readEnv(env, "JW_URL") ?? "") : "https://api.example.com"],
		["JW_KEY", t("jw.keyPlaceholder", {}, lang)],
		["JW_MODEL", readEnv(env, "JW_MODEL") ?? t("jw.modelPlaceholder", {}, lang)],
	];
	// PowerShell on Windows, POSIX shells elsewhere.
	return platform === "win32"
		? pairs.map(([n, v]) => `$env:${n}="${v}"`)
		: pairs.map(([n, v]) => `export ${n}="${v}"`);
}

/** Column width of text (CJK characters take two columns). */
function width(s: string): number {
	// Wide ranges count twice.
	return [...s].reduce((w, c) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
}

/** The page as lines: groups of aligned rows, then the commands and the close hint. */
export function formatWaConfig(
	env: NodeJS.ProcessEnv,
	state: WriterModelState,
	platform: NodeJS.Platform,
	lang?: WriterLang,
): string[] {
	// Aligned rows of a group.
	const block = (rows: ConfigRow[]) => {
		const nameW = Math.max(...rows.map((r) => r.name.length));
		const valueW = Math.max(...rows.map((r) => width(r.value)));
		return rows.map(
			(r) => `  ${r.name.padEnd(nameW)}  ${r.value}${" ".repeat(valueW - width(r.value))}  ${r.source}`,
		);
	};
	// The configuration problem, when there is one.
	const problem =
		state.kind === "error" ? [t("jw.problem", {}, lang), ...state.message.split("\n").map((l) => `  ${l}`), ""] : [];
	return [
		t("jw.title", {}, lang),
		"",
		...problem,
		t("jw.groupModel", {}, lang),
		...block(modelRows(env, state, lang)),
		"",
		t("jw.groupOther", {}, lang),
		...block(otherRows(env, lang)),
		"",
		t(platform === "win32" ? "jw.groupSetupWin" : "jw.groupSetup", {}, lang),
		...setupCommands(env, platform, lang).map((l) => `  ${l}`),
		"",
		t("jw.close", {}, lang),
	];
}
