/**
 * Built-in JiaWriter extension: a structured question to the user (the plan's general-capability line, 2026-11-08).
 * The model offers two to four choices; the user picks one with the arrow keys or types an answer of their own.
 * With nobody to answer, the tool says so at once, so the model goes on with the usual choice and names it.
 */

// Schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";

/** Fewest and most choices a question offers. */
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 4;

/** The choices as shown: trimmed, without repeats, at most MAX_CHOICES, then the line for an answer of one's own. */
export function choiceLines(choices: readonly string[], other: string): string[] {
	const kept = [...new Set(choices.map((c) => c.trim()).filter(Boolean))].slice(0, MAX_CHOICES);
	return [...kept, other];
}

/** Register the tool. */
export default function writerAskExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask",
		description:
			"Asks the user one question with two to four choices; the user picks one or types their own answer.\n\nUsage:\n" +
			" - Only for a decision that is the user's and that the request, the files and the usual practice cannot settle\n" +
			" - Put the recommended choice first\n" +
			" - When nobody can answer, go on with the usual choice and name it in the reply",
		parameters: Type.Object({
			question: Type.String(),
			choices: Type.Array(Type.String(), { description: "Two to four short choices" }),
		}),
		// One question at a time.
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const answer = (text: string) => ({ content: [{ type: "text" as const, text }], details: { answer: text } });
			if (!ctx.hasUI) return answer(t("ask.noUser"));
			const other = t("ask.other");
			const lines = choiceLines(params.choices ?? [], other);
			if (lines.length - 1 < MIN_CHOICES) return answer(t("ask.fewChoices"));
			const picked = await ctx.ui.select(params.question, lines);
			if (picked === undefined) return answer(t("ask.cancelled"));
			if (picked !== other) return answer(t("ask.answer", { answer: picked }));
			const typed = (await ctx.ui.input(params.question))?.trim();
			return answer(typed ? t("ask.answer", { answer: typed }) : t("ask.cancelled"));
		},
	});
}
