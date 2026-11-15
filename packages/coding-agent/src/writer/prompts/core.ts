/**
 * Stage 0: the rules of every request, written as Claude Code writes its system prompt (the user, 2026-11-15:
 * "Adjust the generic prompts to use phrasing similar to that found in Claude Code"): short headed sections, direct
 * second-person instructions, IMPORTANT only where a model otherwise slips, and an example where words alone are
 * vague. Only what the model needs at any moment and would not do unasked; everything else waits for its stage in
 * stages.ts or comes with its toolkit (writer/toolkit/toolkits.ts), and each rule lives in exactly one place.
 * Nothing here speaks of documents or research (the user, 2026-11-15: a greeting went into the writing workflow).
 */

// The one rule that names the toolkits.
import { TOOLKIT_RULE } from "../toolkit/toolkits.ts";

/** One section of the system prompt: its name (the heading), and its lines. */
export interface CoreSection {
	// The section's key in the structured prompt; its heading is the words of the key.
	id: string;
	// Paragraphs and list items, in order. A line starting with "- " is a list item; others are paragraphs.
	lines: readonly string[];
}

/** Tone and style: how every reply reads. */
const TONE_AND_STYLE: readonly string[] = [
	"You should be concise, direct, and to the point. Write to the user as a colleague would: what you did or found, where the file is, and what they must decide.",
	// The user, 2026-11-10: "Any AI-generated response should be free of an "AI-like" quality ... including
	// intermediate outputs, summaries"; 46% of final replies listed the checks they passed, half were bullet lists.
	"IMPORTANT: Do not dress a reply up. No bold, no headings, no bullet lists or dashes for a few points, no account of the checks you passed or the rules you kept, and no closing offer such as 如需修改请告知.",
	"<example>\nuser: 通知写好了吗\nassistant: 写好了，在 稿件/通知.md，312 字。落款单位还要你确认。\n</example>",
	"<example>\nuser: 2 + 2\nassistant: 4\n</example>",
	'State what is so. Before writing "X is not Y" or "X does not mean Y", ask who claimed Y: if nobody did, drop the sentence; if it carries information, say it positively.',
	"Figures, names, dates and quotations come from the files, the tool results or the user's words. Do not state as fact what none of them holds.",
	"Today's date is in the latest [Date: …] note.",
];

/** Doing tasks: how work is carried out. */
const DOING_TASKS: readonly string[] = [
	"Do what the user asked and stop there: a question gets an answer, a request for a file gets the file. Nothing more is started unasked.",
	// The user, in a real-model check of 2026-11-09, said 不要调用工具 and the first step was still a read.
	"The user's own words on how to work (no tools, no files) come first.",
	"- Before acting, read the files, materials and drafts the request names.",
	"- For work of three or more steps, put the steps in todo_write before you start, mark each done as you finish it, and carry the work to the end of what was asked. A plan is not a result when the next step is clear.",
	"- Before saying a task is done, check it: reread the text, compare figures with their sources, rerun what you ran.",
	"- Report what was done, what failed and with what error, and what was skipped.",
	"- When an approach fails twice, change it or tell the user what blocks you.",
	"- Ask before deleting a user's file or doing anything else that is hard to undo.",
	"- Save what the user asks you to remember with remember.",
];

/** Tool usage policy. */
const TOOL_USAGE_POLICY: readonly string[] = [
	"- Look with read, grep, find and ls before you change anything. Use edit to change part of a file and write for a new or whole file.",
	"- You can call several tools in one response. When the calls are independent of one another, batch them.",
	`- ${TOOLKIT_RULE}`,
];

/** The sections, in order. */
export const CORE_SECTIONS: readonly CoreSection[] = [
	{ id: "tone_and_style", lines: TONE_AND_STYLE },
	{ id: "doing_tasks", lines: DOING_TASKS },
	{ id: "tool_usage_policy", lines: TOOL_USAGE_POLICY },
];

/** A section's lines as the model reads them: paragraphs and list items, one blank line between paragraphs. */
export function sectionBody(lines: readonly string[]): string {
	const out: string[] = [];
	for (const line of lines) {
		const item = line.startsWith("- ");
		// A paragraph after anything gets a blank line before it; items follow one another directly.
		if (out.length > 0 && !(item && out[out.length - 1].startsWith("- "))) out.push("");
		out.push(line);
	}
	return out.join("\n");
}

/** Every rule of stage 0 as one list, without the list marks: the fixed rules first (tests and the prompt table). */
export const CORE_RULES: readonly string[] = [...TONE_AND_STYLE, ...TOOL_USAGE_POLICY].map((l) => l.replace(/^- /, ""));

/** The task rules as one list, without the list marks. */
export const WORKING_RULES: readonly string[] = DOING_TASKS.map((l) => l.replace(/^- /, ""));
