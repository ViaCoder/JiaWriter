/**
 * Built-in JiaWriter extension: the read-only writing checks style_check, word_count and
 * readability_check. Each reads a text file or inline text and returns a report in the
 * JW_LANG language; none of them changes the text.
 */

// The drafts an automatic check reads, and the materials beside them.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
// Walking from a draft up to the writing folder.
import { basename, dirname, isAbsolute, join, relative } from "node:path";
// One request to the session's model, for the semantic review.
import { completeSimple } from "@earendil-works/pi-ai/compat";
// Text for the automatic check as shown.
import { Text } from "@earendil-works/pi-tui";
// Parameter schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Upstream path resolution (cwd, ~).
import { resolveToCwd } from "../../core/tools/path-utils.ts";
// One form for a stopped call.
import { blockedText } from "../../writer/blocked.ts";
// Which files are drafts.
import { isDraftPath } from "../../writer/docs/auto.ts";
// The imported references beside a draft.
import { parsedFiles } from "../../writer/docs/import.ts";
// One section written in a clean context.
import {
	cleanSectionText,
	headingOf,
	markOutline,
	outlinePart,
	outlineTitle,
	SECTION_REASONING_TOKENS,
	SECTION_TIMEOUT_MS,
	sectionInstructions,
	sectionMaterials,
	sectionRequest,
	spliceSection,
} from "../../writer/draft/section.ts";
// Reference entries the body never cites.
import { uncitedReferences } from "../../writer/export/refs.ts";
// The 公文 parameter check, run by the program at the end of a turn.
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// One clean request to the model, for the review and the sections.
import {
	type AskBudget,
	type Complete,
	modelAsker,
	REVIEW_REASONING_TOKENS,
	REVIEW_TIMEOUT_MS,
	withReviewBudget,
} from "../../writer/model-ask.ts";
// The semantic review line.
import { STYLE_REVIEW } from "../../writer/prompts/manuals.ts";

export { type AskBudget, type Complete, modelAsker, REVIEW_REASONING_TOKENS, REVIEW_TIMEOUT_MS, withReviewBudget };

// Readability check.
import {
	DEFAULT_SENTENCE_LIMIT,
	formatReadability,
	longSentences,
	rareChars,
	readabilityCheck,
} from "../../writer/readability.ts";
// AI-style check.
import { formatStyleReport, inferRegister, styleCheck, styleClean, styleMustFix } from "../../writer/style/check.ts";
// The program's checks of a draft, as one table.
import { runDraftChecks } from "../../writer/style/draft-checks.ts";
// The default threshold for the schema description.
import { DEFAULT_NEGATION_THRESHOLD } from "../../writer/style/patterns.ts";
// The semantic review by a separate request.
import { formatReview, keepAnswerable, type ReviewIssue, reviewDraft } from "../../writer/style/review.ts";
// Length as writers count it.
import { bodyBeforeReferences, countText, REFERENCES_HEADING } from "../../writer/text-stats.ts";
// Shared input loading.
import { loadToolText, setLastDraft } from "../../writer/tool-input.ts";
// The materials folders and file of a topic.
import { MATERIAL_FILE, misattributedFigures, TOPIC_DIRS } from "../../writer/topic/topic.ts";
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

/** The outline of a long document, beside its drafts. */
const OUTLINE_FILE = "大纲.md";
/** Tools whose result changes a draft at input.path, which the program then checks. */
const DRAFT_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "draft_section"]);

/** Automatic rounds of revision after one message of the user, so a draft that cannot be cleaned does not loop. */
export const MAX_ROUNDS = 2;
/** Replies cut off by the output limit with no tool call that the program resumes in a row (2026-11-10: a research
 * run's reply ran 114,946 tokens of hidden reasoning, stopped at the limit with one sentence, and the run ended
 * with no draft). */
export const MAX_CUT_RESUMES = 2;

/** True when the last reply stopped at the output limit before it called a tool: the turn ended on nothing. */
export function cutOffWithoutCalls(messages: readonly unknown[] | undefined): boolean {
	const last = [...(messages ?? [])].reverse().find((m) => (m as { role?: string }).role === "assistant") as
		| { stopReason?: string; content?: { type?: string }[] }
		| undefined;
	return last?.stopReason === "length" && !(last.content ?? []).some((c) => c.type === "toolCall");
}

/** The automatic check of a draft: the rules for its register, then the semantic review only a reader can do. */
export function draftCheck(text: string): { clean: boolean; mustFix: boolean; text: string } {
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
	// clean: nothing to show; mustFix: something a careful human writer would not leave, which asks for another round.
	return {
		clean: styleClean(report) && found.fail.length === 0,
		mustFix: styleMustFix(report) || found.fail.length > 0,
		text: `${styleText}${lines}`,
	};
}

/**
 * True while a draft's outline (大纲.md beside it) still has a section to write ("- [ ]"): a long document written one
 * section per turn is not yet whole, so its length and unused materials are not judged (2026-11-09).
 */
export function outlineOpen(file: string): boolean {
	if (basename(file) === OUTLINE_FILE) return false;
	const outline = join(dirname(file), OUTLINE_FILE);
	return existsSync(outline) && /^\s*[-*]\s*\[ \]/m.test(readFileSync(outline, "utf-8"));
}

/** The folders from a draft's own up to the writing folder, where its materials may be. */
export function draftFolders(file: string, cwd: string): string[] {
	const dirs: string[] = [];
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		dirs.push(dir);
		// Stop at the writing folder, at the root, or at once for a draft outside the writing folder (on Windows a draft
		// on another drive gives an absolute relative path: CI 42539031250, 2026-11-09).
		const rel = relative(cwd, dir);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || dirname(dir) === dir) return dirs;
	}
}

/**
 * Whether a call would write 素材.md itself: write or edit with its path, or a bash command naming it (2026-11-14: after
 * material_add sent items back, a run appended its own lines to 素材.md with edit four times and tried cat >>). The
 * file holds facts the program extracted and checked; the model's own lines there would be neither.
 */
export function touchesMaterials(tool: string, input: unknown): boolean {
	const args = (input ?? {}) as { path?: unknown; command?: unknown };
	if ((tool === "write" || tool === "edit") && typeof args.path === "string")
		return basename(args.path.trim()) === MATERIAL_FILE;
	return tool === "bash" && typeof args.command === "string" && args.command.includes(MATERIAL_FILE);
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
		// An item whose source is a file in 参考资料 names no source of its own: that file is judged below by what it says
		// (2026-11-09: a brief from the user's two figures was told to cite, and cited the notes file).
		const named = existsSync(material)
			? readFileSync(material, "utf-8")
					.split("\n")
					.filter((line) => !/来源：《参考资料[/\\]/.test(line))
					.join("\n")
			: "";
		if (SOURCE_MARK.test(named)) return true;
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
	// An outlet in brackets counts too: （路透社） (2026-11-10, a brief with no reference list).
	if (
		!/《[^》\n]{1,20}》报道|据[^，。\n]{1,12}(?:社|报|网|台)|[（(][^）)\n]{1,10}(?:社|报|网|台)[^）)\n]{0,14}[）)]|https?:\/\//.test(
			text,
		)
	)
		return false;
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

/** Words that report research the writer did: a survey, a visit, a meeting, a questionnaire. */
// The phrases real reports use for their research (1,575 published texts, 2026-11-09): 座谈, 走访, 开展专题调研,
// 进行实地调研, 赴……调研, 调研组.
const METHOD_WORDS =
	/调研组|(?:进行|开展|组织)了?(?:专题|深入|实地)?调研|赴[^，。\n]{1,10}调研|实地走访|入户走访|走访了|座谈|问卷|抽样调查|调研了解到|调研发现|实地察看/g;

/**
 * What the semantic review reads beside a draft: 素材.md, where each fact stands with its source, and the user's imported
 * references; not the saved searches and pages, which made one review of a research brief take 498 s (2026-11-10).
 */
export function reviewMaterialText(file: string, cwd: string): string {
	const texts: string[] = [];
	for (const dir of draftFolders(file, cwd)) {
		const material = join(dir, MATERIAL_FILE);
		if (existsSync(material)) texts.push(readFileSync(material, "utf-8"));
		for (const path of parsedFiles(dir)) texts.push(readFileSync(path, "utf-8"));
	}
	return texts.join("\n");
}

/** Every text of the materials beside a draft: 素材.md, imported references, saved searches and pages. */
export function materialText(file: string, cwd: string): string {
	const texts: string[] = [];
	for (const dir of draftFolders(file, cwd)) {
		const material = join(dir, MATERIAL_FILE);
		if (existsSync(material)) texts.push(readFileSync(material, "utf-8"));
		for (const path of parsedFiles(dir)) texts.push(readFileSync(path, "utf-8"));
		for (const sub of [TOPIC_DIRS.search, TOPIC_DIRS.web]) {
			const folder = join(dir, sub);
			if (!existsSync(folder)) continue;
			for (const name of readdirSync(folder))
				if (name.endsWith(".md")) texts.push(readFileSync(join(folder, name), "utf-8"));
		}
	}
	return texts.join("\n");
}

/**
 * The research steps a draft reports that no material mentions (2026-11-09: three report runs opened with a survey
 * team and checks the materials never named, though a rule forbade it): empty when the materials speak of research.
 */
export function inventedMethods(text: string, file: string, cwd: string): string[] {
	const found = [...new Set(text.match(METHOD_WORDS) ?? [])];
	if (found.length === 0) return [];
	const materials = materialText(file, cwd);
	if (!materials.trim() || /调研|走访|座谈|问卷|调查/.test(materials)) return [];
	return found;
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

/** What the program checks in a finished draft instead of the model calling the tools: sentences over the limit and
 * rare characters. */
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
	// Each reference entry cited where its fact is used, so the reader can tell which source holds which fact.
	const uncited = uncitedReferences(text, bodyBeforeReferences(text));
	// Each with the words looked for, so the model knows what the text has to name (2026-11-09: a run that could not
	// tell went to read the program's source).
	if (uncited.length > 0)
		out.push(
			t("style.uncitedRefs", {
				entries: uncited.map((u) => t("style.uncitedEntry", { n: u.n, names: u.names.join("、") })).join("；"),
			}),
		);
	return out;
}

/** The paragraphs of a draft that a run wrote: those of `after` that `before` does not hold as they stand. */
export function changedParagraphs(before: string, after: string): string[] {
	const old = new Set(before.split(/\n/).map((line) => line.trim()));
	return after
		.split(/\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "" && !old.has(line));
}

/** The lines of a report on `after` that its report on `before` did not have: what this run brought in. */
export function freshLines(before: readonly string[], after: readonly string[]): string[] {
	const old = new Set(before);
	return after.filter((line) => !old.has(line));
}

/** The review findings that quote what this run wrote; the rest the user saw and kept. */
export function inChanged(issues: readonly ReviewIssue[], changed: readonly string[]): ReviewIssue[] {
	return issues.filter((issue) => changed.some((paragraph) => paragraph.includes(issue.quote.trim())));
}

/**
 * What the program itself sees in a finished draft: a report with materials that cites none, no references, research
 * steps the materials do not record, materials left out (when first written), a length far from the one asked, and
 * the sentence and reference checks.
 */
export function ownFindings(
	text: string,
	file: string,
	cwd: string,
	opts: { target?: number; firstWrite: boolean },
): string[] {
	const own: string[] = [];
	// A report that states figures from materials naming their sources, and cites none of them.
	const cites = citesMaterials(text, referenceTitles(file, cwd));
	if (inferRegister(text) === "report" && /\d/.test(text) && !cites && materialsNameSources(file, cwd))
		own.push(t("style.noCitation"));
	if (lacksReferences(text, file, cwd)) own.push(t("style.noReferences"));
	const methods = inventedMethods(text, file, cwd);
	if (methods.length > 0) own.push(t("style.inventedMethods", { words: methods.join("、") }));
	// Figures cited to a dated outlet whose sources of that date do not hold them (2026-11-10).
	const wrong = draftFolders(file, cwd).flatMap((dir) => misattributedFigures(text, dir));
	if (wrong.length > 0)
		own.push(t("style.misattributed", { count: wrong.length, items: wrong.map((s) => `“${s}”`).join("；") }));
	// The whole document's measures wait until its outline has no section left (written one per turn); materials
	// left out are named when the draft is first written, not again with each revision.
	if (!outlineOpen(file)) {
		const unused = opts.firstWrite ? unusedMaterials(text, file, cwd) : [];
		if (unused.length > 0)
			own.push(t("style.unusedMaterials", { items: unused.map((i) => `“${i.slice(0, 40)}”`).join("；") }));
		const chars = countText(bodyBeforeReferences(text)).total;
		if (opts.target && Math.abs(chars - opts.target) > opts.target * LENGTH_TOLERANCE)
			own.push(t("style.length", { chars, target: opts.target }));
	}
	own.push(...finishedChecks(text));
	return own;
}

/** Extension factory; `complete` reaches the model for the semantic review (tests pass a stand-in). */
/**
 * An automatic check as the user sees it: the report without the editor's instructions to the model, which are English
 * prompt text (2026-11-10: the reread instructions showed in English under a Chinese report).
 */
export function shownRound(content: string): string {
	return content
		.split("\n")
		.filter((line) => line !== STYLE_REVIEW)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export default function writerToolsExtension(pi: ExtensionAPI, complete: Complete = completeSimple): void {
	// The automatic check is shown with its report only; the model still gets all of it.
	pi.registerMessageRenderer("jiawriter-style-round", (message, { outputPad }, theme) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		return new Text(theme.fg("customMessageText", shownRound(text)), outputPad, 1, (line) =>
			theme.bg("customMessageBg", line),
		);
	});
	// Drafts written since the user's last message, and the automatic rounds they have had.
	const written = new Set<string>();
	// Each draft as it was before this message changed it ("" for a new one): a revision is checked for what it
	// brought in only (2026-11-09: asked to change a date, a run also cut a phrase of the notice the user had kept,
	// because the review read the whole notice again).
	const before = new Map<string, string>();
	let rounds = 0;
	// Cut-off replies resumed since the user's last message.
	let cutResumes = 0;
	// A new message from the user starts again.
	// The length the user's message asked for, if it named one.
	let target: number | undefined;
	// A document written one section per turn is still open: the length asked at its start stays the target.
	let documentOpen = false;
	pi.on("input", (event) => {
		written.clear();
		before.clear();
		rounds = 0;
		cutResumes = 0;
		target = requestedLength(event.text ?? "") ?? (documentOpen ? target : undefined);
	});
	// The draft before its first change in this message; the materials file is material_add's alone.
	pi.on("tool_call", (event, ctx) => {
		if (touchesMaterials(event.toolName, event.input))
			return {
				block: true,
				reason: blockedText({ why: t("topic.materialByTool", { tool: event.toolName }), next: "change" }),
			};
		if (!DRAFT_TOOLS.has(event.toolName)) return undefined;
		const path = (event.input as { path?: unknown }).path;
		const file = typeof path === "string" ? resolveToCwd(path, ctx.cwd) : "";
		if (file && isDraftPath(file, ctx.cwd) && !before.has(file))
			before.set(file, existsSync(file) ? readFileSync(file, "utf-8") : "");
		return undefined;
	});
	// After each write or edit of a draft, the program checks it: the model never has to remember to.
	pi.on("tool_result", (event, ctx) => {
		if (event.isError || !DRAFT_TOOLS.has(event.toolName)) return;
		const path = (event.input as { path?: unknown }).path;
		const file = typeof path === "string" ? resolveToCwd(path, ctx.cwd) : "";
		if (!file || !isDraftPath(file, ctx.cwd) || !existsSync(file)) return;
		// The reread instruction once per draft per message; the check itself after every write.
		const first = !written.has(file);
		written.add(file);
		// The checks called without a file read this one.
		setLastDraft(file);
		const draft = readFileSync(file, "utf-8");
		// The length and the sentence checks come with each write, so the model needs no tool for them (2026-11-09: a
		// report run called word_count ten times and readability_check three times).
		const chars = countText(bodyBeforeReferences(draft)).total;
		const tolerance = Math.round(LENGTH_TOLERANCE * 100);
		const length = target
			? t("style.lengthNowTarget", { chars, target, tolerance })
			: t("style.lengthNow", { chars });
		const text = [draftCheck(draft).text, length, ...finishedChecks(draft)].join("\n");
		return { content: [...event.content, { type: "text", text: first ? `${text}\n${STYLE_REVIEW}` : text }] };
	});
	// When a reply ends, each draft it wrote gets the rules and one separate semantic review; while either finds
	// something, the program asks for another round, at most MAX_ROUNDS.
	pi.on("agent_end", async (event, ctx) => {
		documentOpen = [...written].some((file) => existsSync(file) && outlineOpen(file));
		// A reply cut off before its tool call is resumed first; the checks follow when the work is done.
		if (cutOffWithoutCalls(event?.messages) && cutResumes < MAX_CUT_RESUMES) {
			cutResumes++;
			pi.sendMessage(
				{ customType: "jiawriter-cut-resume", content: t("style.cutResume"), display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return;
		}
		if (rounds >= MAX_ROUNDS || written.size === 0) return;
		const ask = modelAsker(ctx, complete);
		const open: string[] = [];
		for (const file of written) {
			if (!existsSync(file)) continue;
			const text = readFileSync(file, "utf-8");
			// A revision of a draft that was there before this message: only what it brought in counts.
			const old = before.get(file) ?? "";
			const revision = old.trim() !== "";
			const changed = revision ? changedParagraphs(old, text) : [];
			const check = draftCheck(text);
			const checkLines = revision ? freshLines(draftCheck(old).text.split("\n"), check.text.split("\n")) : [];
			const mustFix = revision ? check.mustFix && checkLines.length > 0 : check.mustFix;
			// Findings that ask for facts only where there are materials to take them from; the review reads them too.
			const materials = hasMaterials(file, ctx.cwd);
			const given = materials ? reviewMaterialText(file, ctx.cwd) : "";
			const reviewed = ask ? await reviewDraft(text, ask, given) : undefined;
			// An unfounded inference is judged against what the review read: with no record of facts it is a guess.
			const found = given.trim() ? reviewed : reviewed?.filter((issue) => issue.category !== "unfounded-inference");
			const answerable = found && keepAnswerable(found, materials);
			const issues = answerable && revision ? inChanged(answerable, changed) : answerable;
			// What the program itself sees; a length far from the one asked is the whole document's, so it counts in a
			// revision too.
			const own = ownFindings(text, file, ctx.cwd, { target, firstWrite: !revision });
			// In a revision, what the draft already had before this message is the user's, not this run's.
			const ownNow = revision
				? freshLines(ownFindings(old, file, ctx.cwd, { target, firstWrite: false }), own)
				: own;
			if (!mustFix && !issues?.length && ownNow.length === 0) continue;
			const review = issues?.length
				? `\n${t("style.reviewFound", { count: issues.length })}\n${formatReview(issues)}`
				: "";
			const checkText = revision ? (mustFix ? checkLines.join("\n") : "") : check.text;
			open.push([`${file}\n${checkText}${review}`, ...ownNow, STYLE_REVIEW].join("\n"));
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

	// draft_section: one section of a long document, written by the model in a context of its own (the writing rules,
	// the outline, the section's material excerpts, the text so far), so that the research in this conversation does
	// not colour it (the user, 2026-11-12).
	pi.registerTool({
		// Name the model calls.
		name: "draft_section",
		// Name shown in the interface.
		label: "Draft section",
		// Full description sent to the model.
		description:
			"Writes one section of a long document into its draft from 大纲.md beside it and its items in 素材.md, in a context free of this conversation, and ticks the outline line. Once per section, in order, after the outline.\n\nUsage:\n - section: the words of its line in 大纲.md\n - heading: its heading in the document (default: the line up to its colon; empty for none)\n - chars: about how long\n - notes: the user's requirements, in their words",
		// Argument schema.
		parameters: Type.Object({
			path: Type.String({ description: "The draft file" }),
			section: Type.String(),
			heading: Type.Optional(Type.String()),
			chars: Type.Optional(Type.Number()),
			notes: Type.Optional(Type.String()),
		}),
		// Writes the draft and the outline.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		// Build the clean request, ask once, put the text in.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const file = resolveToCwd(params.path, ctx.cwd);
			// The outline beside the draft, else in a folder above it (2026-11-12: a run wrote it in the topic folder).
			const outlineFile =
				draftFolders(file, ctx.cwd)
					.map((dir) => join(dir, OUTLINE_FILE))
					.find((p) => existsSync(p)) ?? join(dirname(file), OUTLINE_FILE);
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
			if (!existsSync(outlineFile)) return fail(t("draft.noOutline", { path: params.path }));
			const outline = readFileSync(outlineFile, "utf-8");
			const part = outlinePart(outline, params.section);
			if (!part) return fail(t("draft.noSection", { section: params.section }));
			const ask = modelAsker(
				ctx,
				complete,
				{ reasoningTokens: SECTION_REASONING_TOKENS, timeoutMs: SECTION_TIMEOUT_MS },
				true,
			);
			if (!ask) return fail(t("draft.noModel"));
			const heading = headingOf(part.line, params.heading);
			const previous = existsSync(file) ? readFileSync(file, "utf-8") : "";
			// The section's excerpts from every 素材.md beside or above the draft.
			const materials = draftFolders(file, ctx.cwd).flatMap((dir) => {
				const material = join(dir, MATERIAL_FILE);
				return existsSync(material) ? sectionMaterials(readFileSync(material, "utf-8"), part.line) : [];
			});
			const request = sectionRequest({
				brief: part.brief,
				outline,
				line: part.line,
				items: part.items,
				heading,
				materials,
				previous: bodyBeforeReferences(previous),
				chars: params.chars,
				notes: params.notes,
			});
			let reply: string;
			try {
				reply = await ask(sectionInstructions(), request);
			} catch (error) {
				return fail(t("draft.failed", { reason: error instanceof Error ? error.message : String(error) }));
			}
			const text = cleanSectionText(reply, heading);
			if (!text.trim()) return fail(t("draft.failed", { reason: "empty reply" }));
			const draft = spliceSection(previous, heading, text, outlineTitle(outline));
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, draft);
			writeFileSync(outlineFile, markOutline(outline, part.line));
			const chars = countText(text).total;
			const total = countText(bodyBeforeReferences(draft)).total;
			return {
				content: [
					{
						type: "text",
						text: t("draft.written", { heading: heading || part.line, chars, path: params.path, total }),
					},
				],
				details: { file, chars, total },
			};
		},
	});

	// style_check.
	pi.registerTool({
		// Name the model calls.
		name: "style_check",
		// Name shown in the interface.
		label: "Style check",
		// Full description sent to the model.
		description:
			"Finds AI-style writing in a draft, with line and column: contrast frames, stock phrases, negative assertions, list and bold overuse. It already runs on every write; call it only for a file you did not write",
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
		description:
			"Counts text as writers do, whole or per section, against a target. The program gives a draft's length after each write and checks it at the end of each run; call this only for one section or for text outside a draft",
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
		description:
			"Finds rare Chinese characters and long sentences, and rates English readability. The program reports both after each write of a draft; call this only for a file you did not write",
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
