/**
 * Built-in JiaWriter extension: the read-only writing checks style_check, word_count and
 * readability_check. Each reads a text file or inline text and returns a report in the
 * JW_LANG language; none of them changes the text.
 */

// The drafts an automatic check reads, and the materials beside them.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
// Walking from a draft up to the writing folder.
import { basename, dirname, join, relative } from "node:path";
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
// The imported references beside a draft.
import { parsedFiles } from "../../writer/docs/import.ts";
// The 公文 parameter check, run by the program at the end of a turn.
import { analyze, hardFails } from "../../writer/gongwen/check.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// The semantic review line.
import { STYLE_REVIEW } from "../../writer/prompts/manuals.ts";
// Readability check.
import {
	DEFAULT_SENTENCE_LIMIT,
	formatReadability,
	longSentences,
	rareChars,
	readabilityCheck,
} from "../../writer/readability.ts";
// AI-style check.
import { formatStyleReport, inferRegister, styleCheck, styleClean } from "../../writer/style/check.ts";
// The program's checks of a draft, as one table.
import { runDraftChecks } from "../../writer/style/draft-checks.ts";
// The default threshold for the schema description.
import { DEFAULT_NEGATION_THRESHOLD } from "../../writer/style/patterns.ts";
// The semantic review by a separate request.
import { formatReview, keepAnswerable, reviewDraft, reviewEnabled } from "../../writer/style/review.ts";
// Length as writers count it.
import { bodyBeforeReferences, countText, REFERENCES_HEADING } from "../../writer/text-stats.ts";
// Shared input loading.
import { loadToolText, setLastDraft } from "../../writer/tool-input.ts";
// The materials folders and file of a topic.
import { MATERIAL_FILE, TOPIC_DIRS } from "../../writer/topic/topic.ts";
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
	// Reports and official documents are checked against official-document habits too.
	const register = inferRegister(text);
	const report = styleCheck(text, {
		register,
		packs: register === "general" ? undefined : ["core-zh", "core-en", "gongwen-zh"],
	});
	// The program's other checks, one table (writer/style/draft-checks.ts).
	const found = runDraftChecks(text, register);
	// A clean report is one line: the full measures each time were noise the model reread after every edit.
	const styleText = styleClean(report) ? t("style.passShort") : formatStyleReport(report);
	const lines = [...found.fail, ...found.note].map((line) => `\n${line}`).join("");
	return { clean: styleClean(report) && found.fail.length === 0, text: `${styleText}${lines}` };
}

/** The folders from a draft's own up to the writing folder, where its materials may be. */
export function draftFolders(file: string, cwd: string): string[] {
	const dirs: string[] = [];
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		dirs.push(dir);
		// Stop at the writing folder, at the root, or at once for a draft outside the writing folder.
		if (relative(cwd, dir) === "" || relative(cwd, dir).startsWith("..") || dirname(dir) === dir) return dirs;
	}
}

/** Whether a draft has materials to take facts from: 素材.md, imported references, saved searches or pages, in its folder
 * or any folder above it up to the writing folder. */
export function hasMaterials(file: string, cwd: string): boolean {
	// A folder with at least one entry (dot files such as the archive index do not count).
	const filled = (dir: string) => existsSync(dir) && readdirSync(dir).some((name) => !name.startsWith("."));
	return draftFolders(file, cwd).some((dir) => {
		const material = join(dir, MATERIAL_FILE);
		if (existsSync(material) && statSync(material).size > 0) return true;
		return [join(dir, TOPIC_DIRS.refs, ".parsed"), join(dir, TOPIC_DIRS.search), join(dir, TOPIC_DIRS.web)].some(
			filled,
		);
	});
}

/** Marks of a named source in a text: a title in 《》, an address, or a report. */
const SOURCE_MARK = /《[^》\n]{2,}》|https?:\/\/|报道/;
/** Kinds of imported file that are published documents, whose title is itself a source. */
const DOCUMENT_TYPES = new Set([
	"pdf",
	"doc",
	"docx",
	"wps",
	"ofd",
	"rtf",
	"ppt",
	"pptx",
	"xls",
	"xlsx",
	"html",
	"htm",
	"epub",
]);

/**
 * True when the materials beside a draft name a source the draft could cite: search results or fetched pages, a
 * published document imported as a reference, or notes and recorded materials that name an outlet, title or address.
 * A fact list that names none is nothing to cite (2026-11-08: drafts cited 《材料》第1条 and 参考资料/前文风险段.md).
 */
export function materialsNameSources(file: string, cwd: string): boolean {
	const filled = (dir: string) => existsSync(dir) && readdirSync(dir).some((name) => !name.startsWith("."));
	return draftFolders(file, cwd).some((dir) => {
		if ([join(dir, TOPIC_DIRS.search), join(dir, TOPIC_DIRS.web)].some(filled)) return true;
		const material = join(dir, MATERIAL_FILE);
		if (existsSync(material) && SOURCE_MARK.test(readFileSync(material, "utf-8"))) return true;
		return parsedFiles(dir).some((path) => {
			// 报告.pdf.md was imported from 报告.pdf.
			const kind = (basename(path, ".md").match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
			return DOCUMENT_TYPES.has(kind) || SOURCE_MARK.test(readFileSync(path, "utf-8"));
		});
	});
}

/**
 * True when a draft cites outlets from the topic's searches or pages but has no reference list: the facts' addresses
 * are on disk and the reader gets none (two 2026-11-09 research briefs cited 《路透社》 and 央广网 inline only).
 */
export function lacksReferences(text: string, file: string, cwd: string): boolean {
	if (REFERENCES_HEADING.test(text)) return false;
	if (!/《[^》\n]{1,20}》报道|据[^，。\n]{1,12}(?:社|报|网|台)|https?:\/\//.test(text)) return false;
	const filled = (dir: string) => existsSync(dir) && readdirSync(dir).some((name) => !name.startsWith("."));
	return draftFolders(file, cwd).some((dir) => [join(dir, TOPIC_DIRS.search), join(dir, TOPIC_DIRS.web)].some(filled));
}

/** Most numbered items the material check looks at: beyond that the materials serve a longer document. */
export const MATERIAL_CHECK_MAX = 12;

/** The marks that tell one material item apart: figures, Latin names, titles in 《》 and quoted terms. */
export function itemMarks(item: string): string[] {
	// Dates say when, not which: another item's date must not count as this one's mark.
	const undated = item.replace(/\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?|\d{1,2}月\d{1,2}日/g, " ");
	const marks = [
		...(undated.match(/\d+(?:\.\d+)?(?:万|亿|%|元|个|起|人|辆|艘)?/g) ?? []).filter((m) => m.length >= 2),
		...(undated.match(/[A-Za-z][A-Za-z0-9.-]{2,}/g) ?? []),
		// The words inside 《》 and quotes: a draft may drop the marks.
		...[...undated.matchAll(/《([^》]{2,20})》|“([^”]{2,20})”/g)].map((m) => m[1] ?? m[2]),
	];
	return [...new Set(marks)];
}

/**
 * The numbered items of a short fact list beside a draft that the draft does not use: none of their marks appears in
 * it (2026-11-09: two drafts each left out one of two or three given items although each proved a judgment).
 */
export function unusedMaterials(text: string, file: string, cwd: string): string[] {
	const items = draftFolders(file, cwd)
		.flatMap(parsedFiles)
		.flatMap((path) => readFileSync(path, "utf-8").split("\n"))
		.map((line) => line.match(/^\s*\d+[.、．]\s*(.+)$/)?.[1]?.trim() ?? "")
		.filter(Boolean);
	if (items.length === 0 || items.length > MATERIAL_CHECK_MAX) return [];
	return items.filter((item) => {
		const marks = itemMarks(item);
		return marks.length > 0 && !marks.some((m) => text.includes(m));
	});
}

/** The titles of the references imported beside a draft: 报告 for 参考资料/.parsed/报告.pdf.md. */
export function referenceTitles(file: string, cwd: string): string[] {
	return draftFolders(file, cwd)
		.flatMap(parsedFiles)
		.map((path) => basename(path, ".md").replace(/\.[^.]+$/, ""));
}

/** Whether a text names a source: a reference list, a research summary, a reference's title, or a dated citation
 * (2026年10月31日《路透社》报道). */
export function citesMaterials(text: string, titles: readonly string[]): boolean {
	if (/参考文献|研究成果摘要|\d{4}年\d{1,2}月\d{1,2}日《[^》\n]+》/.test(text)) return true;
	return titles.some((title) => title.length > 0 && text.includes(title));
}

/** The length the user asked for in a message (约1500字, 1500字左右), if any. */
export function requestedLength(message: string): number | undefined {
	const found = /约\s*(\d{3,6})\s*字|(\d{3,6})\s*字左右/.exec(message);
	return found ? Number(found[1] ?? found[2]) : undefined;
}

/** Most a draft may be off its requested length before the round asks to fix it: the same as word_count's, so the two
 * never disagree (a 2026-11-08 run kept cutting a draft word_count called long while the round passed it). */
export const LENGTH_TOLERANCE = DEFAULT_TOLERANCE;

/** The 公文 genre a draft's title names, as gongwen_check calls them; "" when it names none. */
export function gongwenGenre(text: string): string {
	const title = text.split("\n").find((line) => line.trim() !== "") ?? "";
	if (/调研报告|考察报告/.test(title)) return "调研报告";
	if (/讲话/.test(title)) return "领导讲话";
	if (/意见/.test(title)) return "工作意见";
	if (/方案/.test(title)) return "工作方案";
	if (/交流材料|经验总结/.test(title)) return "经验总结";
	if (/经验材料|做法和启示|的做法/.test(title)) return "经验材料";
	return "";
}

/** What the program checks in a finished draft instead of the model calling the tools: sentences over the limit,
 * rare characters and, for a 公文 whose title names its genre, the hard conflicts of gongwen_check. */
export function finishedChecks(text: string): string[] {
	const out: string[] = [];
	const long = longSentences(text);
	if (long.length > 0)
		out.push(
			t("style.longSentences", {
				count: long.length,
				limit: DEFAULT_SENTENCE_LIMIT,
				heads: long.map((s) => `“${s.head}”`).join("、"),
			}),
		);
	// Level-2 characters are common enough; only those beyond them.
	const rare = rareChars(text).filter((c) => c.level !== 2);
	if (rare.length > 0) out.push(t("style.rareChars", { chars: rare.map((c) => c.char).join("、") }));
	// A title that names a 公文 genre is enough: a speech's title names no document kind.
	const genre = gongwenGenre(text);
	const metrics = genre ? analyze(text) : null;
	// Length is the user's to set: the corpus minimum (1200 characters, else "write it as 党建") is left out.
	const fails = metrics ? hardFails(metrics, genre).filter((f) => f.key !== "chars") : [];
	if (fails.length > 0) out.push(t("style.gongwenFails", { genre, items: fails.map((f) => f.msg).join("；") }));
	return out;
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
	// The length the user's message asked for, if it named one.
	let target: number | undefined;
	pi.on("input", (event) => {
		written.clear();
		rounds = 0;
		target = requestedLength(event.text ?? "");
	});
	// After each write or edit of a draft, the program checks it: the model never has to remember to.
	pi.on("tool_result", (event, ctx) => {
		if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const path = (event.input as { path?: unknown }).path;
		const file = typeof path === "string" ? resolveToCwd(path, ctx.cwd) : "";
		if (!file || !isDraftPath(file, ctx.cwd) || !existsSync(file)) return;
		// The reread instruction once per draft per message; the check itself after every write.
		const first = !written.has(file);
		written.add(file);
		// The checks called without a file read this one.
		setLastDraft(file);
		const text = draftCheck(readFileSync(file, "utf-8")).text;
		return { content: [...event.content, { type: "text", text: first ? `${text}\n${STYLE_REVIEW}` : text }] };
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
			const found = ask ? await reviewDraft(text, ask) : undefined;
			// Findings that ask for facts only where there are materials to take them from.
			const materials = hasMaterials(file, ctx.cwd);
			const issues = found && keepAnswerable(found, materials);
			// What the program itself sees: a report with materials that names none, a length far from the one asked.
			const own: string[] = [];
			// A report that states figures from materials naming their sources, and cites none of them.
			const cites = citesMaterials(text, referenceTitles(file, ctx.cwd));
			if (inferRegister(text) === "report" && /\d/.test(text) && !cites && materialsNameSources(file, ctx.cwd))
				own.push(t("style.noCitation"));
			if (lacksReferences(text, file, ctx.cwd)) own.push(t("style.noReferences"));
			const unused = unusedMaterials(text, file, ctx.cwd);
			if (unused.length > 0)
				own.push(t("style.unusedMaterials", { items: unused.map((i) => `“${i.slice(0, 40)}”`).join("；") }));
			const chars = countText(bodyBeforeReferences(text)).total;
			if (target && Math.abs(chars - target) > target * LENGTH_TOLERANCE)
				own.push(t("style.length", { chars, target }));
			own.push(...finishedChecks(text));
			if (check.clean && !issues?.length && own.length === 0) continue;
			const review = issues?.length
				? `\n${t("style.reviewFound", { count: issues.length })}\n${formatReview(issues)}`
				: "";
			open.push([`${file}\n${check.text}${review}`, ...own, STYLE_REVIEW].join("\n"));
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
