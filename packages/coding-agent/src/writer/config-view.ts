/**
 * The read-only /wa page: each WriterAgent variable with its value in effect and where it comes from
 * (environment, detection, cache, /lang, default), keys only as set or unset, URLs without credentials,
 * and copy-ready commands for this platform with the key as a placeholder.
 */

// URL credential redaction shared with the upstream bug report.
import { redactUrl } from "../core/bug-report.ts";
// Defaults of the model variables.
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT, DEFAULT_REASONING } from "./env-config.ts";
// Messages and the language source.
import { currentLang, savedLang, t, type WriterLang } from "./i18n/index.ts";
// Search defaults.
import { DEFAULT_ANYSEARCH_URL } from "./websearch/core.ts";
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
	const src = (k: "env" | "default" | "detect" | "cache" | "manual") => t(`wa.src.${k}`, {}, lang);
	const fromEnv = (name: string, fallback: string) => {
		const v = readEnv(env, name);
		return { name, value: v ?? fallback, source: v ? src("env") : src("default") };
	};
	// The API: from WA_API, detection or the detection cache.
	const ready = state.kind === "ready" ? state : undefined;
	const api = ready
		? {
				name: "WA_API",
				value: ready.api,
				source: ready.source === "env" ? src("manual") : ready.source === "cache" ? src("cache") : src("detect"),
			}
		: {
				name: "WA_API",
				value: readEnv(env, "WA_API") ?? "-",
				source: readEnv(env, "WA_API") ? src("manual") : src("detect"),
			};
	// Reasoning: the level asked for and what the endpoint supports.
	const reasoning = fromEnv("WA_REASONING", DEFAULT_REASONING);
	if (ready) reasoning.value += t("wa.reasoningLevels", { levels: ready.reasoning.levels.join("/") || "-" }, lang);
	// All model rows.
	return [
		{
			name: "WA_URL",
			value: readEnv(env, "WA_URL") ? redactUrl(readEnv(env, "WA_URL") ?? "") : t("wa.unset", {}, lang),
			source: src(readEnv(env, "WA_URL") ? "env" : "default"),
		},
		{
			name: "WA_KEY",
			value: t(readEnv(env, "WA_KEY") ? "wa.set" : "wa.unset", {}, lang),
			source: src(readEnv(env, "WA_KEY") ? "env" : "default"),
		},
		fromEnv("WA_MODEL", t("wa.unset", {}, lang)),
		api,
		fromEnv("WA_CTX", String(DEFAULT_CONTEXT_WINDOW)),
		fromEnv("WA_OUT", String(DEFAULT_MAX_OUTPUT)),
		reasoning,
	];
}

/** Rows of the interface and search group. */
export function otherRows(env: NodeJS.ProcessEnv, lang?: WriterLang): ConfigRow[] {
	// Language: environment, /lang, or the default.
	const langSource = readEnv(env, "WA_LANG") ? "wa.src.env" : savedLang() ? "wa.src.lang" : "wa.src.default";
	const src = (name: string) => t(readEnv(env, name) ? "wa.src.env" : "wa.src.default", {}, lang);
	return [
		{ name: "WA_LANG", value: currentLang(), source: t(langSource, {}, lang) },
		{ name: "WA_SEARCH", value: readEnv(env, "WA_SEARCH") ?? "auto", source: src("WA_SEARCH") },
		{ name: "WA_ENGINES", value: readEnv(env, "WA_ENGINES") ?? "bing,google", source: src("WA_ENGINES") },
		{ name: "WA_SEARCH_PAGES", value: readEnv(env, "WA_SEARCH_PAGES") ?? "3", source: src("WA_SEARCH_PAGES") },
		{
			name: "WA_SEARCH_URL",
			value: redactUrl(readEnv(env, "WA_SEARCH_URL") ?? DEFAULT_ANYSEARCH_URL),
			source: src("WA_SEARCH_URL"),
		},
		{
			name: "WA_SEARCH_KEY",
			value: t(readEnv(env, "WA_SEARCH_KEY") ? "wa.set" : "wa.anonymous", {}, lang),
			source: src("WA_SEARCH_KEY"),
		},
		{ name: "WA_SF", value: readEnv(env, "WA_SF") ?? t("wa.sfAuto", {}, lang), source: src("WA_SF") },
	];
}

/** Copy-ready commands for this platform with the current values; the key is a placeholder. */
export function setupCommands(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, lang?: WriterLang): string[] {
	// Required variables with their current value or an example.
	const pairs: [string, string][] = [
		["WA_URL", readEnv(env, "WA_URL") ? redactUrl(readEnv(env, "WA_URL") ?? "") : "https://api.example.com"],
		["WA_KEY", t("wa.keyPlaceholder", {}, lang)],
		["WA_MODEL", readEnv(env, "WA_MODEL") ?? t("wa.modelPlaceholder", {}, lang)],
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
		state.kind === "error" ? [t("wa.problem", {}, lang), ...state.message.split("\n").map((l) => `  ${l}`), ""] : [];
	return [
		t("wa.title", {}, lang),
		"",
		...problem,
		t("wa.groupModel", {}, lang),
		...block(modelRows(env, state, lang)),
		"",
		t("wa.groupOther", {}, lang),
		...block(otherRows(env, lang)),
		"",
		t(platform === "win32" ? "wa.groupSetupWin" : "wa.groupSetup", {}, lang),
		...setupCommands(env, platform, lang).map((l) => `  ${l}`),
		"",
		t("wa.close", {}, lang),
	];
}
