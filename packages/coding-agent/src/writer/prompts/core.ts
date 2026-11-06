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
	"When a document or a research topic starts, call topic_open with a short name; the same name continues it",
	"Search when the request needs it, and never when told not to",
	"Run one web_search or web_fetch at a time and name its method: none is the default. When one fails, use another or tell the user",
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
