/**
 * JiaWriter i18n layer for tool output and the interface: Chinese by default. The language is JW_LANG
 * when set, else the one chosen with /lang (<agentDir>/writer-settings.json), else Chinese.
 */

// Settings file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// Path helpers.
import { join } from "node:path";
// Agent directory.
import { getAgentDir } from "../../config.ts";
// English table.
import { en } from "./en.ts";
// Chinese table and the key type.
import { type MessageKey, zh } from "./zh.ts";

/** Supported output languages. */
export type WriterLang = "zh" | "en";

/** Language from a JW_LANG value: English for "en" or "en-…", Chinese otherwise. */
export function resolveLang(value: string | undefined): WriterLang {
	// Normalized value ("" when unset).
	const v = (value ?? "").trim().toLowerCase();
	// English only when asked for.
	return v === "en" || v.startsWith("en-") || v.startsWith("en_") ? "en" : "zh";
}

/** Settings file of the interface language. */
export function uiSettingsPath(): string {
	// Next to the other settings.
	return join(getAgentDir(), "writer-settings.json");
}

// Last read of the settings file: path and language (the interface reads the language on every render).
let cached: { path: string; lang: WriterLang | undefined } | undefined;

/** Language chosen with /lang, or undefined. */
export function savedLang(): WriterLang | undefined {
	// Read once per settings path.
	const path = uiSettingsPath();
	if (cached?.path !== path) {
		let lang: WriterLang | undefined;
		try {
			const v = (JSON.parse(readFileSync(path, "utf-8")) as { lang?: unknown }).lang;
			lang = v === "zh" || v === "en" ? v : undefined;
		} catch {
			lang = undefined;
		}
		cached = { path, lang };
	}
	return cached.lang;
}

/** The current language: JW_LANG when set, else the /lang choice, else Chinese. */
export function currentLang(): WriterLang {
	// Environment first.
	const env = (process.env.JW_LANG ?? "").trim();
	if (env !== "") return resolveLang(env);
	return savedLang() ?? "zh";
}

/** Save the /lang choice (atomic write) and use it from now on. */
export function setUiLang(lang: WriterLang): void {
	// Folder, temp file, rename.
	const path = uiSettingsPath();
	mkdirSync(join(path, ".."), { recursive: true });
	// Other settings in the file stay.
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		// First setting.
	}
	writeFileSync(`${path}.tmp`, `${JSON.stringify({ ...settings, lang }, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
	cached = { path, lang };
}

/** Message for key in lang, with each {name} replaced by vars[name]. */
export function t(key: MessageKey, vars: Readonly<Record<string, string | number>> = {}, lang?: WriterLang): string {
	// Table of the requested language (the current language when not given).
	const table = (lang ?? currentLang()) === "en" ? en : zh;
	// Fill the placeholders; unknown names stay visible.
	return table[key].replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
