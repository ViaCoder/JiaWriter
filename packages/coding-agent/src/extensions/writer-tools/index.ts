/**
 * Built-in JiaWriter extension: the read-only writing checks style_check, word_count and
 * readability_check. Each reads a text file or inline text and returns a report in the
 * JW_LANG language; none of them changes the text.
 */

// Parameter schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Readability check.
import { DEFAULT_SENTENCE_LIMIT, formatReadability, readabilityCheck } from "../../writer/readability.ts";
// AI-style check.
import { formatStyleReport, styleCheck, styleClean } from "../../writer/style/check.ts";
// The default threshold for the schema description.
import { DEFAULT_NEGATION_THRESHOLD } from "../../writer/style/patterns.ts";
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

/** Extension factory. */
export default function writerToolsExtension(pi: ExtensionAPI): void {
	// style_check.
	pi.registerTool({
		// Name the model calls.
		name: "style_check",
		// Name shown in the interface.
		label: "Style check",
		// Full description sent to the model.
		description:
			"Find AI-style writing in a draft, with line and column: contrast frames, stock phrases, negative assertions, list and bold overuse",
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
		description: "Count a draft as writers do, whole or per section, against a target",
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
		description: "Find rare Chinese characters and long sentences, and rate English readability",
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
