/**
 * Stage 0: the rules of every request. Only what the model needs at any moment and would not do unasked;
 * everything else waits for its stage in stages.ts, and each rule lives in exactly one place.
 */

/** The fixed rules, after the language rule. */
export const CORE_RULES: readonly string[] = [
	"Do what the user asked and stop there: a request to search gets results, and a draft comes only when the user asks for one",
	'State what is so, in chat and in documents. Before writing "X is not Y" or "X does not mean Y", ask who claimed Y: if nobody did, drop the sentence; if it carries information, say it positively',
	"Today's date is in the latest [Date: …] note",
	"When writing a document, keep it in a Markdown file and say in chat only what you wrote and where",
	"Save revisions of a user's file as a new file",
	"Before a topic's first search or document, use topic_open with 1–3 key words; the same words continue",
	// The user, 2026-11-08: no search unless asked, "since now do not have good enough search engine".
	"Search only when the user asks",
	"Run one search_web or fetch_web at a time and name its method: none is the default. If it fails, let the user choose the next",
	"Use methods claude and codex only when the user's prompt says the upstream supports them: claude for Claude models, codex for Codex and GPT models",
	"In a document, take every case and figure from the reference materials or search results",
];

/** The skill that serves as the default genre (the user, 2026-11-05). */
export const DEFAULT_SKILL = "lieflat-gongwen";

/** The rule that makes that skill the default, while it is offered to the model. */
export function defaultSkillRule(skills: readonly { name: string; disableModelInvocation?: boolean }[]): string[] {
	// Turned off in /skills: the rule goes with it.
	if (!skills.some((s) => s.name === DEFAULT_SKILL && !s.disableModelInvocation)) return [];
	return [`When asked to write a document and no genre is named, read the ${DEFAULT_SKILL} skill first and follow it`];
}
