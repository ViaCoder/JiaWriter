/**
 * JiaWriter text for the upstream sections of system-prompt.ts (preamble, docs).
 * The rules themselves live in writer/prompts: see stages.ts for what reaches the model and when.
 */

// Shared JW_LANG rule.
import { resolveLang } from "./i18n/index.ts";

/** Opening sentence (the untagged preamble). */
export const WRITER_PREAMBLE =
	"You are JiaWriter, a general-purpose agent. Use the instructions below and the tools available to you to assist the user.";

/** Rule for the language of replies to the user (JW_LANG, Chinese by default). */
export function writerLanguageRule(lang: string | undefined): string {
	// English when the interface language is English (same rule as the tool output).
	// Everything on screen: GLM wrote its notes between tool calls in English once the rules were (2026-11-08).
	if (resolveLang(lang) === "en") return "Write all text the user sees in English, notes between tool calls included";
	// Chinese otherwise (the default).
	return "Write all text the user sees in Simplified Chinese, notes between tool calls included";
}

/** Replaces upstream's "Be concise in your responses": chat stays short, documents keep their length. */
export const WRITER_CHAT_RULE = "Keep chat replies short; the brief decides a document's length";

/** Documentation pointers (the docs section). */
export function writerDocsSection(readmePath: string, docsPath: string): string {
	// One line: the model reads further only when the user asks about JiaWriter itself.
	return `When the user asks about JiaWriter itself, read ${readmePath} and the files in ${docsPath}`;
}
