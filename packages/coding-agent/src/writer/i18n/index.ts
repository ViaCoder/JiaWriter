/**
 * WriterAgent i18n layer for tool output: Chinese by default, English with WA_LANG=en.
 */

// English table.
import { en } from "./en.ts";
// Chinese table and the key type.
import { type MessageKey, zh } from "./zh.ts";

/** Supported output languages. */
export type WriterLang = "zh" | "en";

/** Language from a WA_LANG value: English for "en" or "en-…", Chinese otherwise. */
export function resolveLang(value: string | undefined): WriterLang {
	// Normalized value ("" when unset).
	const v = (value ?? "").trim().toLowerCase();
	// English only when asked for.
	return v === "en" || v.startsWith("en-") || v.startsWith("en_") ? "en" : "zh";
}

/** Message for key in lang, with each {name} replaced by vars[name]. */
export function t(key: MessageKey, vars: Readonly<Record<string, string | number>> = {}, lang?: WriterLang): string {
	// Table of the requested language (WA_LANG when not given).
	const table = (lang ?? resolveLang(process.env.WA_LANG)) === "en" ? en : zh;
	// Fill the placeholders; unknown names stay visible.
	return table[key].replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
