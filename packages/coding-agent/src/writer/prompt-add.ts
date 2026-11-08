/**
 * PROMPT_ADD: a text file the user adds to the persona, for example PROMPT_ADD='~/Downloads/glm.txt'.
 * Its text joins the persona inside <system_prompt>, with no difference between the two for the model.
 */

// The file.
import { readFileSync } from "node:fs";
// Upstream path resolution: a quoted ~ reaches the program unexpanded.
import { resolveToCwd } from "../core/tools/path-utils.ts";
// Output messages.
import { t } from "./i18n/index.ts";

/** The file as read, kept so the prompt stays the same for the whole run. */
let loaded: { path: string; text: string } | undefined;

/** Absolute path of the file, when PROMPT_ADD is set. */
export function promptAddPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	// Blank counts as unset.
	const raw = env.PROMPT_ADD?.trim();
	return raw ? resolveToCwd(raw, process.cwd()) : undefined;
}

/** What is wrong with PROMPT_ADD, for the startup check; empty when it is unset or fine. */
export function promptAddProblem(env: NodeJS.ProcessEnv = process.env): string {
	// Unset is fine.
	const path = promptAddPath(env);
	if (!path) return "";
	try {
		return readFileSync(path, "utf-8").trim() ? "" : t("promptAdd.empty", { path });
	} catch {
		return t("promptAdd.unreadable", { path });
	}
}

/** The added text; empty when PROMPT_ADD is unset or its file cannot be read. */
export function promptAddText(env: NodeJS.ProcessEnv = process.env): string {
	// Unset.
	const path = promptAddPath(env);
	if (!path) return "";
	// Once per run.
	if (loaded?.path === path) return loaded.text;
	try {
		loaded = { path, text: readFileSync(path, "utf-8").trim() };
	} catch {
		// The startup check reports this; a library caller goes on without the text.
		return "";
	}
	return loaded.text;
}

/** The persona block: the persona text, then the added text, in one tag (the user, 2026-11-05, kept 2026-11-08). */
export function personaBlock(persona: string, added: string): string {
	// One line break: the two read as one text.
	return `<system_prompt>\n${added ? `${persona}\n${added}` : persona}\n</system_prompt>`;
}
