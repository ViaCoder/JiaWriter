/**
 * Built-in JiaWriter extension: the read-only writing checks style_check, word_count and
 * readability_check. Each reads a text file or inline text and returns a report in the
 * JW_LANG language; none of them changes the text.
 */

// The drafts an automatic check reads.
import { existsSync, readFileSync } from "node:fs";
// One request to the session's model, for the semantic review.
import { type Api, completeSimple, type Model } from "@earendil-works/pi-ai/compat";
// Parameter schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// Upstream path resolution (cwd, ~).
import { resolveToCwd } from "../../core/tools/path-utils.ts";
// Which files are drafts.
import { isDraftPath } from "../../writer/docs/auto.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// The semantic review line.
import { STYLE_REVIEW } from "../../writer/prompts/manuals.ts";
// Readability check.
import { DEFAULT_SENTENCE_LIMIT, formatReadability, readabilityCheck } from "../../writer/readability.ts";
// AI-style check.
import { formatStyleReport, inferRegister, styleCheck, styleClean } from "../../writer/style/check.ts";
// The default threshold for the schema description.
import { DEFAULT_NEGATION_THRESHOLD } from "../../writer/style/patterns.ts";
// The semantic review by a separate request.
import { formatReview, reviewDraft, reviewEnabled } from "../../writer/style/review.ts";
// Shared input loading.
import { loadToolText } from "../../writer/tool-input.ts";
// Length check.
import { DEFAULT_TOLERANCE, formatWordCount, wordCount } from "../../writer/word-count.ts";

/** Schema fields shared by the three tools. */
const INPUT_FIELDS = {
	// File input.
	path: Type.Optional(Type.String({ description: "Text file" })),
	// Inline input.
	text: Type.Optional(Type.String({ description: "Text, when there is no file" })),
};

/** Hints shared by the three tools: they only read. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Automatic rounds of revision after one message of the user, so a draft that cannot be cleaned does not loop. */
export const MAX_ROUNDS = 2;

/** The automatic check of a draft: the rules for its register, then the semantic review only a reader can do. */
export function draftCheck(text: string): { clean: boolean; text: string } {
	// A report is checked against official-document habits too.
	const register = inferRegister(text);
	const report = styleCheck(text, {
		register,
		packs: register === "report" ? ["core-zh", "core-en", "gongwen-zh"] : undefined,
	});
	return { clean: styleClean(report), text: `${formatStyleReport(report)}\n${STYLE_REVIEW}` };
}

/** How one request reaches a model: completeSimple, or a stand-in in tests. */
export type Complete = typeof completeSimple;

/** A way to ask the session's model one question with its own credentials; undefined without a model or with JW_REVIEW=off. */
export function modelAsker(
	ctx: ExtensionContext,
	complete: Complete = completeSimple,
): ((instructions: string, text: string) => Promise<string>) | undefined {
	const model = ctx.model;
	if (!model || !reviewEnabled()) return undefined;
	return async (instructions, text) => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		// The same address and keys the conversation uses.
		const target: Model<Api> = { ...model, baseUrl: auth.baseUrl ?? model.baseUrl };
		const reply = await complete(
			target,
			{ systemPrompt: instructions, messages: [{ role: "user", content: text, timestamp: Date.now() }] },
			{ apiKey: auth.apiKey, headers: auth.headers },
		);
		if (reply.stopReason === "error") throw new Error(reply.errorMessage ?? "review failed");
		return reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
	};
}

/** Extension factory; `complete` reaches the model for the semantic review (tests pass a stand-in). */
export default function writerToolsExtension(pi: ExtensionAPI, complete: Complete = completeSimple): void {
	// Drafts written since the user's last message, and the automatic rounds they have had.
	const written = new Set<string>();
	let rounds = 0;
	// A new message from the user starts again.
	pi.on("input", () => {
		written.clear();
		rounds = 0;
	});
	// After each write or edit of a draft, the program checks it: the model never has to remember to.
	pi.on("tool_result", (event, ctx) => {
		if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const path = (event.input as { path?: unknown }).path;
		const file = typeof path === "string" ? resolveToCwd(path, ctx.cwd) : "";
		if (!file || !isDraftPath(file, ctx.cwd) || !existsSync(file)) return;
		written.add(file);
		return { content: [...event.content, { type: "text", text: draftCheck(readFileSync(file, "utf-8")).text }] };
	});
	// When a reply ends, each draft it wrote gets the rules and one separate semantic review; while either finds
	// something, the program asks for another round, at most MAX_ROUNDS.
	pi.on("agent_end", async (_event, ctx) => {
		if (rounds >= MAX_ROUNDS || written.size === 0) return;
		const ask = modelAsker(ctx, complete);
		const open: string[] = [];
		for (const file of written) {
			if (!existsSync(file)) continue;
			const text = readFileSync(file, "utf-8");
			const check = draftCheck(text);
			const issues = ask ? await reviewDraft(text, ask) : undefined;
			if (check.clean && !issues?.length) continue;
			const review = issues?.length
				? `\n${t("style.reviewFound", { count: issues.length })}\n${formatReview(issues)}`
				: "";
			open.push(`${file}\n${check.text}${review}`);
		}
		if (open.length === 0) return;
		rounds++;
		const reports = `${t("style.materials")}\n\n${open.join("\n\n")}`;
		pi.sendMessage(
			{
				customType: "jiawriter-style-round",
				content: `${t("style.round", { round: rounds, max: MAX_ROUNDS })}\n\n${reports}`,
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	// style_check.
	pi.registerTool({
		// Name the model calls.
		name: "style_check",
		// Name shown in the interface.
		label: "Style check",
		// Full description sent to the model.
		description:
			"Finds AI-style writing in a draft, with line and column: contrast frames, stock phrases, negative assertions, list and bold overuse",
		// Argument schema.
		parameters: Type.Object({
			// path or text.
			...INPUT_FIELDS,
			// Pattern packs.
			packs: Type.Optional(
				Type.Array(Type.String(), { description: "core-zh, core-en, gongwen-zh; default the first two" }),
			),
			// Density limit.
			negation_threshold: Type.Optional(
				Type.Number({
					// Full description sent to the model.
					description: `Negative assertions allowed per 10 sentences; default ${DEFAULT_NEGATION_THRESHOLD}`,
				}),
			),
		}),
		// Read-only hints for permission extensions.
		annotations: READ_ONLY,
		// Run the check.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Text to check.
			const text = await loadToolText(params, ctx.cwd);
			// Run the check.
			const report = styleCheck(text, { packs: params.packs, negationThreshold: params.negation_threshold });
			// Text report plus the structured one.
			// The rules see words; the review line asks for what only a reader sees.
			return {
				content: [{ type: "text", text: `${formatStyleReport(report)}\n${STYLE_REVIEW}` }],
				details: { clean: styleClean(report), report },
			};
		},
	});
	// word_count.
	pi.registerTool({
		// Name the model calls.
		name: "word_count",
		// Name shown in the interface.
		label: "Word count",
		// Full description sent to the model.
		description: "Counts a draft as writers do, whole or per section, against a target",
		// Argument schema.
		parameters: Type.Object({
			// path or text.
			...INPUT_FIELDS,
			// Per-section counts.
			by_section: Type.Optional(Type.Boolean({ description: "Per section" })),
			// Target length.
			target: Type.Optional(Type.Number({ description: "Target length" })),
			// Allowed deviation.
			tolerance: Type.Optional(
				Type.Number({ description: `Allowed deviation as a fraction; default ${DEFAULT_TOLERANCE}` }),
			),
		}),
		// Read-only hints for permission extensions.
		annotations: READ_ONLY,
		// Run the check.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Text to count.
			const text = await loadToolText(params, ctx.cwd);
			// Count it.
			const report = wordCount(text, {
				bySection: params.by_section,
				// Target length.
				target: params.target,
				// Allowed deviation.
				tolerance: params.tolerance,
			});
			// Text report plus the structured one.
			return { content: [{ type: "text", text: formatWordCount(report) }], details: report };
		},
	});
	// readability_check.
	pi.registerTool({
		// Name the model calls.
		name: "readability_check",
		// Name shown in the interface.
		label: "Readability check",
		// Full description sent to the model.
		description: "Finds rare Chinese characters and long sentences, and rates English readability",
		// Argument schema.
		parameters: Type.Object({
			// path or text.
			...INPUT_FIELDS,
			// Sentence length limit.
			max_sentence_chars: Type.Optional(
				Type.Number({ description: `Longest Chinese sentence in characters; default ${DEFAULT_SENTENCE_LIMIT}` }),
			),
		}),
		// Read-only hints for permission extensions.
		annotations: READ_ONLY,
		// Run the check.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Text to check.
			const text = await loadToolText(params, ctx.cwd);
			// Run the check.
			const report = readabilityCheck(text, params.max_sentence_chars);
			// Text report plus the structured one.
			return { content: [{ type: "text", text: formatReadability(report) }], details: report };
		},
	});
}
