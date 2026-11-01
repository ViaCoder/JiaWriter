/**
 * Built-in WriterAgent extension: the read-only writing checks style_check, word_count and
 * readability_check. Each reads a text file or inline text and returns a report in the
 * WA_LANG language; none of them changes the text.
 */

// Parameter schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Readability check.
import { DEFAULT_SENTENCE_LIMIT, formatReadability, readabilityCheck } from "../../writer/readability.ts";
// AI-style check.
import { formatStyleReport, styleCheck, styleClean } from "../../writer/style/check.ts";
// Pack names for the schema description.
import { DEFAULT_NEGATION_THRESHOLD, STYLE_PACKS } from "../../writer/style/patterns.ts";
// Shared input loading.
import { loadToolText } from "../../writer/tool-input.ts";
// Length check.
import { DEFAULT_TOLERANCE, formatWordCount, wordCount } from "../../writer/word-count.ts";

/** Schema fields shared by the three tools. */
const INPUT_FIELDS = {
	// File input.
	path: Type.Optional(
		Type.String({ description: "Text file to check (.md, .txt), relative to the working directory" }),
	),
	// Inline input.
	text: Type.Optional(Type.String({ description: "Text to check when there is no file; ignored when path is given" })),
};

/** Hints shared by the three tools: they only read. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Extension factory. */
export default function writerToolsExtension(pi: ExtensionAPI): void {
	// style_check.
	pi.registerTool({
		// Name the model calls.
		name: "style_check",
		// Name shown in the interface.
		label: "Style check",
		// Full description sent to the model.
		description: `Check a draft for AI-style writing and report each finding with its line and column. Pattern packs: ${Object.keys(STYLE_PACKS).join(", ")} (default core-zh and core-en). It lists contrast frames such as 不是……而是 and "not just X but Y", stock phrases, the density of negative assertions per 10 sentences, and list and bold usage. Code, URLs and direct quotations are skipped. The text stays as it is.`,
		// One line in the tools section of the system prompt.
		promptSnippet:
			"Check a draft for AI-style writing: contrast frames, stock phrases, negative assertions, list and bold overuse",
		// Rules added to the rules section while the tool is active.
		promptGuidelines: [
			"Run style_check on every finished draft, rewrite only the flagged passages with edit, and run style_check again until it passes",
			"Rewrite each flagged passage as a plain, direct statement of what something is or does, and fill it with concrete content",
			'Add packs: ["core-zh", "gongwen-zh"] for official documents (公文) and reports for government readers',
		],
		// Argument schema.
		parameters: Type.Object({
			// path or text.
			...INPUT_FIELDS,
			// Pattern packs.
			packs: Type.Optional(
				Type.Array(Type.String(), { description: "Pattern packs to apply; default core-zh and core-en" }),
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
			return {
				content: [{ type: "text", text: formatStyleReport(report) }],
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
		description:
			"Count a draft the way writers do: Chinese characters plus English words plus numbers, punctuation listed separately. Optionally counts each section (Markdown headings, 一、 and （一） headings) and compares the total with a target length.",
		// One line in the tools section of the system prompt.
		promptSnippet:
			"Count Chinese characters and English words of a draft, per section, and compare with a target length",
		// Rules added to the rules section while the tool is active.
		promptGuidelines: [
			"Use word_count with the target from the brief before delivering a draft, and lengthen or shorten the sections it reports",
		],
		// Argument schema.
		parameters: Type.Object({
			// path or text.
			...INPUT_FIELDS,
			// Per-section counts.
			by_section: Type.Optional(Type.Boolean({ description: "Also count each section" })),
			// Target length.
			target: Type.Optional(Type.Number({ description: "Target length in characters" })),
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
		description: `Find Chinese characters outside the 3,500 common characters of 通用规范汉字表 (level 1), Chinese sentences longer than a limit (default ${DEFAULT_SENTENCE_LIMIT} characters), and the Flesch reading ease of English text. Code, URLs and direct quotations are skipped. The text stays as it is.`,
		// One line in the tools section of the system prompt.
		promptSnippet: "Find rare Chinese characters and overlong sentences in a draft, and rate English readability",
		// Rules added to the rules section while the tool is active.
		promptGuidelines: [
			"Run readability_check on finished drafts; replace the rare characters it lists with common ones and split the long sentences, keeping names and quotations as they are",
		],
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
