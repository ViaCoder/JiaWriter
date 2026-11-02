/**
 * Built-in WriterAgent extension: gongwen_check, the parameter self-check of the lieflat-gongwen skill
 * (skills/writer/zh/lieflat-gongwen). It replaces the skill's `python3 scripts/check_params.py` so the check
 * runs on every platform without Python or bash. The report is Chinese, like the documents it checks.
 *
 * License: part of the lieflat-gongwen adaptation, under the PolyForm Noncommercial License 1.0.0
 * (see skills/writer/zh/lieflat-gongwen/LICENSE), not under WriterAgent's MIT license.
 */

// Parameter schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// The ported checker.
import { analyze, formatMatch, formatReport, NO_PARAM, REF } from "../../writer/gongwen/check.ts";
// Shared input loading.
import { loadToolText } from "../../writer/tool-input.ts";

/** Genres the checker knows, for the schema and errors. */
const GENRES = Object.keys(REF);

/** Extension factory. */
export default function writerGongwenExtension(pi: ExtensionAPI): void {
	// gongwen_check.
	pi.registerTool({
		// Name the model calls.
		name: "gongwen_check",
		// Name shown in the interface.
		label: "公文参数自检",
		// Full description sent to the model.
		description: `Self-check of the lieflat-gongwen skill for Chinese official documents (公文). Measures length, sentence length, heading levels (一、/（一）/1.), 一是二是, 顿号 density, mandatory/requirement/suggestion words, percentages, quotes, dashes and loose colons, and compares them with the corpus ranges of the genre: ${GENRES.join("、")}. Only ✗ hard conflicts (a wrong genre) are errors; ⚠ lines are hints. Without genre it ranks the genres by distance. The text stays as it is.`,
		// One line in the tools section of the system prompt.
		promptSnippet: "Check a 公文 draft against the corpus parameters of its genre (lieflat-gongwen self-check)",
		// Rules added to the rules section while the tool is active.
		promptGuidelines: [
			"Run gongwen_check with the genre on every 公文 draft written with the lieflat-gongwen skill, fix every ✗ hard conflict, and explain each deliberate ⚠ deviation",
		],
		// Argument schema.
		parameters: Type.Object({
			// File input.
			path: Type.Optional(
				Type.String({ description: "Draft to check (.md, .txt), relative to the working directory" }),
			),
			// Inline input.
			text: Type.Optional(
				Type.String({ description: "Text to check when there is no file; ignored when path is given" }),
			),
			// Genre.
			genre: Type.Optional(Type.String({ description: `One of ${GENRES.join(", ")}; omit to rank the genres` })),
		}),
		// Read-only hints for permission extensions.
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		// Run the check.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Text to check.
			const text = await loadToolText(params, ctx.cwd);
			// Measurements.
			const a = analyze(text);
			if (!a) throw new Error("文件为空或无法解析");
			// No genre: rank the genres.
			const genre = params.genre?.trim();
			if (!genre) return { content: [{ type: "text", text: formatMatch(a) }], details: { genre: null, fails: 0 } };
			// Statutory documents have a fixed structure and no parameter row.
			if (!REF[genre] && NO_PARAM.includes(genre)) {
				throw new Error(
					`${genre}属法定公文，没有统计参数：正文结构由制度锁定。版式要素（发文字号、主送机关、成文日期）请对照 skill 的“参考/法定公文样例/”；不传 genre 可查它是否落在公文族内。`,
				);
			}
			// Unknown genre.
			if (!REF[genre]) throw new Error(`未知文体：${genre}。可选：${GENRES.join("、")}`);
			// Full report.
			const { text: report, fails } = formatReport(a, genre);
			return { content: [{ type: "text", text: report }], details: { genre, fails } };
		},
	});
}
