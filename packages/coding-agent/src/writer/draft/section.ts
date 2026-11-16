/**
 * One section of a long document, written in a context of its own: the writing rules, the outline, this section's
 * material facts and the text written so far, and nothing else. The conversation that researched the topic holds
 * search results, tool output and the model's own summaries, and a model writing inside it takes their style (the
 * user, 2026-11-12: "when tools like search are invoked, this context can inadvertently bleed into" the writing, and
 * "higher levels of reasoning often tend to exacerbate this AI-like quality"). So the main model only names the
 * section; the program builds the clean request, asks the model once with a small reasoning budget, and puts the text
 * into the draft. Pure text work here; the extension reads and writes the files.
 */

// The rules every section follows.
import { WRITING_MANUAL } from "../prompts/manuals.ts";
// Where the reference list starts, so a section goes before it.
import { REFERENCES_HEADING } from "../text-stats.ts";
// Paragraphs of published official documents, for the shape of a section's kind.
import { exemplarsFor } from "./exemplars.ts";

/** Reasoning tokens a section may use: a small budget, since long reasoning writes in the model's own register. */
export const SECTION_REASONING_TOKENS = 1024;
/** Longest wait for one section. */
export const SECTION_TIMEOUT_MS = 240_000;
/** Most characters of the text written so far that go with a request: the latest, for the joins and the register. */
export const MAX_PREVIOUS = 6000;

/** What a section is written from. */
export interface SectionInput {
	// The outline's head: what the document is, for whom, how long.
	brief: string;
	// The whole outline, so the section knows its place.
	outline: string;
	// This section's outline line, and the lines under it.
	line: string;
	items: string[];
	// The heading the section opens with; empty for none.
	heading: string;
	// The material of this section, as 素材.md lines: facts the program extracted from the sources.
	materials: string[];
	// The text written so far.
	previous: string;
	// About how many characters, when asked.
	chars?: number;
	// The user's further requirements, as the main model relays them.
	notes?: string;
}

/** A section's outline line, with the outline's head and the lines indented under it; undefined when none matches. */
export function outlinePart(
	outline: string,
	section: string,
): { brief: string; line: string; items: string[]; open: boolean } | undefined {
	const lines = outline.split("\n");
	const key = compact(section);
	if (!key) return undefined;
	// The head: everything before the first checklist line.
	const first = lines.findIndex((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l));
	const brief = (first < 0 ? lines : lines.slice(0, first))
		.filter((l) => l.trim() && !/^#/.test(l.trim()))
		.join("\n")
		.trim();
	// The checklist line whose text holds the words given, or whose words the given text holds (the main model may
	// name the section by its heading alone).
	const at = lines.findIndex((l, i) => {
		if (i < first || first < 0) return false;
		const m = /^\s*[-*]\s*\[[ xX]\]\s*(.*)$/.exec(l);
		if (!m) return false;
		const text = compact(m[1]);
		return text.includes(key) || key.includes(text);
	});
	if (at < 0) return undefined;
	const line = lines[at].replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "").trim();
	const open = /\[ \]/.test(lines[at]);
	// The lines under it: indented, up to the next checklist line.
	const items: string[] = [];
	for (let i = at + 1; i < lines.length; i++) {
		if (/^\s*[-*]\s*\[[ xX]\]/.test(lines[i]) || (lines[i].trim() && !/^\s/.test(lines[i]))) break;
		if (lines[i].trim()) items.push(lines[i].trim().replace(/^[-*]\s*/, ""));
	}
	return { brief, line, items, open };
}

/** text without spaces, punctuation and list marks, for matching one line against another. */
function compact(text: string): string {
	return text.replace(/[\s\-*[\]xX：:，,。.、；;（）()《》“”"'【】]/g, "").toLowerCase();
}

/** The length a text asks for (约1500字, 1500字左右), if any: a user's message or an outline's head. */
export function requestedLength(text: string): number | undefined {
	const found = /约\s*(\d{3,6})\s*字|(\d{3,6})\s*字左右/.exec(text);
	return found ? Number(found[1] ?? found[2]) : undefined;
}

/** Parts of an outline that carry no text of their own. */
const NO_TEXT = /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?(?:参考文献|附录|附件)/;

/** Fewest characters a section is asked for when the budget is nearly spent. */
const MIN_BUDGET = 100;

/**
 * About how long a section should be when the call names no length: what the document's target leaves after the
 * text written so far, shared equally among the outline's open lines that carry text, rounded to tens; an opening or
 * closing part without a heading gets at most a tenth of the target. Undefined without a target or for a line already
 * written (a rewrite names its own length). exp-p24q5 (2026-11-14): three sections of 604, 654 and 490 characters for
 * a 1,500-character report, then six edits to cut it.
 */
export function sectionBudget(
	outline: string,
	line: string,
	written: number,
	target: number | undefined,
): number | undefined {
	if (!target) return undefined;
	const open = outline
		.split("\n")
		.filter((l) => /^\s*[-*]\s*\[ \]/.test(l))
		.map((l) => l.replace(/^\s*[-*]\s*\[ \]\s*/, "").trim())
		.filter((l) => !NO_TEXT.test(l));
	if (!open.some((l) => compact(l) === compact(line))) return undefined;
	const share = Math.max(MIN_BUDGET, Math.round(Math.max(0, target - written) / open.length / 10) * 10);
	return headingOf(line) ? share : Math.min(share, Math.round(target / 10));
}

/** Open outline lines that still carry text to write, after this one. */
export function openTextLines(outline: string): number {
	return outline
		.split("\n")
		.filter((l) => /^\s*[-*]\s*\[ \]/.test(l))
		.map((l) => l.replace(/^\s*[-*]\s*\[ \]\s*/, "").trim())
		.filter((l) => !NO_TEXT.test(l)).length;
}

/** Parts that open or close a document without a heading of their own. */
const NO_HEADING = new Set(["引言", "开篇", "前言", "导语", "开头", "结语", "结尾", "结束语", "参考文献"]);

/**
 * The heading a section opens with: the outline line up to its first colon, or the line itself; none for an opening
 * or closing part (2026-11-12: a run's 开篇 got "## 开篇", which the heading check then flagged). A heading the model
 * gives loses its # marks, which the program adds (the same run passed "## 一、发展现状" and got "## ## 一、发展现状").
 */
export function headingOf(line: string, given?: string): string {
	// A heading the model gives is used, unless it is one of the labels that never head a part (the user, 2026-11-15:
	// the opening "need no label or title").
	const bare = (text: string) =>
		text
			.replace(/^#+\s*/, "")
			.replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, "")
			.trim();
	if (given !== undefined) return NO_HEADING.has(bare(given)) ? "" : given.replace(/^#+\s*/, "").trim();
	// An outline line written as a heading (- [ ] ## 一、发展现状：…) loses its marks the same way (2026-11-17, l11: every
	// section came out as "## ## 一、…" and the model spent edits taking the doubled marks out).
	const head = line
		.split(/[：:]/)[0]
		.replace(/^#+\s*/, "")
		.trim();
	return NO_HEADING.has(bare(head)) ? "" : head;
}

/** Labels of a closing part, which a document does not have (the user, 2026-11-15: "结语 is no need"). */
export const CLOSING_LABELS: ReadonlySet<string> = new Set([
	"结语",
	"结尾",
	"结束语",
	"尾声",
	"结束",
	"小结",
	"总结与展望",
	"结论与展望",
	"展望",
]);

/** Whether an outline line or a heading names a closing part. */
export function isClosingLine(line: string): boolean {
	const head = line
		.replace(/^#+\s*/, "")
		.split(/[：:]/)[0]
		.replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, "")
		.trim();
	return CLOSING_LABELS.has(head);
}

/**
 * The 素材.md items of one section: those tagged 【part】 whose part names this section (or which the section names);
 * all items when none is tagged for it, since the model then picks the ones that prove the section's judgments.
 */
export function sectionMaterials(materialText: string, section: string): string[] {
	const items = materialText.split("\n").filter((l) => l.startsWith("- "));
	const key = compact(section);
	const tagged = items.filter((l) => {
		const m = /^- 【([^】]+)】/.exec(l);
		if (!m) return false;
		const tag = compact(m[1]);
		return tag.length > 0 && (key.includes(tag) || tag.includes(key));
	});
	return tagged.length > 0 ? tagged : items;
}

/** The rules the section is written under: the writing manual less its order of work, and what a section is. */
export function sectionInstructions(): string {
	// The "Order" item is for the main model, which runs the document; here the order is given.
	const rules = WRITING_MANUAL.filter((r) => !r.startsWith("Order:"));
	// Claude Code's phrasing (the user, 2026-11-15): headed sections, direct sentences, examples where words are vague.
	return [
		"You write one section of a Chinese official document. The program assembles the document; another request did the research. The request gives the document's purpose, the outline, this section's judgments, its materials (fact records the program extracted from the sources) and the text written so far.",
		"# What to write from",
		"- Every fact and figure comes from the material records, none from memory. Use each record at most once.",
		// Quoted people (the user, 2026-11-12: material from international outlets "with quotes from individuals—particularly
		// those containing metaphors or other vivid, expressive language" makes the output read as machine-written).
		"- A person quoted in the materials gives the document a fact, a figure or a decision, attributed in plain words (大众汽车首席执行官布鲁默表示，2025年在华销量下降10%). Leave out their images, metaphors, emphasis and rhetoric, and add none of your own.",
		// Exemplars (the user, 2026-11-12: material that already reads as machine-written carries its register into the
		// text; a paragraph of a published document in the request gives the model a register to match instead).
		"- The request may carry exemplars: paragraphs of published official documents of this section's kind. Match their shape (the judgment or the measure first, the figures and parallel elements after), their sentence length and their lack of commentary. Take no fact, phrase or subject from them.",
		"# How to write",
		...rules.map((r) => `- ${r}`),
		// What the first clean run still did (exp-p24t RD3, 2026-11-12): an opening that described the report itself, four
		// paragraphs opening as 名词+副词+动词, and measures opening in turn with 针对…问题, 围绕…问题, 着眼…问题 and no actor.
		"- Open paragraphs differently from one another, with the judgment or the measure itself. Never restate the problem a measure answers (not 针对起降设施不足的问题，要增加设施 but 民航局会同地方政府按飞行需求增建起降点). Never describe what the document does (not 本报告梳理现状、分析问题 but the first fact or judgment). A measure names who does it.",
		// 2026-11-12, exp-p24u RI1: 总裁Poetzl表示, 首席执行官Filosa表示, 主席Mueller称 beside Alexander Seitz in full.
		"- Name a foreign person as Chinese documents do: the full name in Chinese transliteration (福特首席执行官吉姆·法利), never a bare Latin surname. A company or product keeps its usual name (Stellantis, eVTOL).",
		"# Output",
		"Return the section's text only: its heading line when one is given, then its paragraphs, continuing the text written so far without repeating it. No notes, no preamble, no code fence, no reference list.",
	].join("\n");
}

/** The request for one section, with everything it is written from. */
export function sectionRequest(input: SectionInput): string {
	// English labels (the user, 2026-11-15: only the necessary Chinese); the content is the document's.
	const parts = [
		`Brief:\n${input.brief || "(see the outline)"}`,
		`Outline:\n${input.outline.trim()}`,
		`This section: ${input.line}`,
		input.heading ? `Heading line: ${input.heading}` : "No heading for this section",
		// The opening (exp-p24q5, 2026-11-14): written first with the materials' figures, which the sections then used
		// again; four edits removed them, and the opening ended as two sentences of judgment. So it is asked for that.
		isOpening(input)
			? "This is the opening: two or three sentences on the overall situation and the judgment, with no heading and no label such as 引言. Figures, cases and names wait for the sections below; none here."
			: "",
		input.items.length > 0 ? `Points of this section:\n${input.items.map((i) => `- ${i}`).join("\n")}` : "",
		exemplarText(input),
		`Materials (fact records the program extracted from the sources; every fact and figure comes from here):\n${input.materials.length > 0 ? input.materials.join("\n") : "(none)"}`,
		input.previous.trim()
			? `Text so far (continue it, do not repeat it):\n${lastChars(input.previous, MAX_PREVIOUS)}`
			: "Text so far: none, this is the first section",
		lengthText(input),
		input.notes?.trim() ? `Further requirements: ${input.notes.trim()}` : "",
	];
	return parts.filter(Boolean).join("\n\n");
}

/**
 * Characters one material record takes in the text: a judgment sentence and the case or figure that proves it. Three
 * 3,000-character reports came out at 4,221, 4,907 and 5,244 characters (2026-11-16/17) with ten to seventeen
 * records a section and about 90 characters spent on each, since the rules say to use every record given.
 */
export const CHARS_PER_MATERIAL = 120;

/** How many material records a length holds. */
export function materialCapacity(chars: number): number {
	return Math.max(2, Math.round(chars / CHARS_PER_MATERIAL));
}

/** The length line of a request: the length, and when the materials outnumber what it holds, which to use. */
export function lengthText(input: Pick<SectionInput, "chars" | "materials">): string {
	if (!input.chars) return "";
	const holds = materialCapacity(input.chars);
	if (input.materials.length <= holds) return `Length: about ${input.chars} characters`;
	return `Length: about ${input.chars} characters, which holds about ${holds} of the ${input.materials.length} material records. Use the ones that prove this section's judgments most directly, one per judgment, and leave the rest out: the length rules over the materials.`;
}

/** Whether the section is the document's opening: no heading, nothing written yet. */
function isOpening(input: SectionInput): boolean {
	return !input.heading && !input.previous.trim();
}

/**
 * The 范例 part of a request: the exemplar paragraphs of the section's kind, each under its source; empty for none,
 * and for the opening, whose exemplar would show figures the opening is asked to leave out.
 */
function exemplarText(input: SectionInput): string {
	if (isOpening(input)) return "";
	const found = exemplarsFor(input.line, input.heading);
	if (found.length === 0) return "";
	return `Exemplars (paragraphs of published documents: match their openings, sentence forms and rhythm, not their content or wording):\n${found
		.map((e) => `【${e.source}】\n${e.text}`)
		.join("\n")}`;
}

/** The last n characters of text, from a line start. */
function lastChars(text: string, n: number): string {
	const t = text.trim();
	if (t.length <= n) return t;
	const cut = t.slice(t.length - n);
	const nl = cut.indexOf("\n");
	return nl < 0 ? cut : cut.slice(nl + 1);
}

/** The model's reply as section text: no code fence, no leading notes, and the heading line once. */
export function cleanSectionText(reply: string, heading: string): string {
	let text = reply.trim();
	// A fenced reply: its inside.
	const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(text);
	if (fence) text = fence[1].trim();
	if (!heading) return text;
	const want = `## ${heading}`;
	const lines = text.split("\n");
	// A heading the model wrote itself, at any level, with the same words: replaced by the one asked.
	const first = lines.findIndex((l) => l.trim());
	if (first >= 0 && /^#+\s/.test(lines[first]) && compact(lines[first].replace(/^#+\s*/, "")) === compact(heading))
		lines[first] = want;
	else lines.unshift(want, "");
	return lines.join("\n").trim();
}

/**
 * The draft with the section in it: a section under the same heading replaced, else the text added before the
 * reference list, else at the end; a draft that is still empty gets the title first.
 */
export function spliceSection(draft: string, heading: string, text: string, title = ""): string {
	let body = draft.trimEnd();
	if (!body.trim() && title) body = `# ${title}`;
	if (heading) {
		const lines = body.split("\n");
		const at = lines.findIndex((l) => /^#+\s/.test(l) && compact(l.replace(/^#+\s*/, "")) === compact(heading));
		if (at >= 0) {
			// Up to the next heading of the same or a higher level.
			const level = (/^#+/.exec(lines[at]) ?? [""])[0].length;
			let end = lines.length;
			for (let i = at + 1; i < lines.length; i++) {
				const m = /^(#+)\s/.exec(lines[i]);
				if (m && m[1].length <= level) {
					end = i;
					break;
				}
			}
			return `${[...lines.slice(0, at), text, "", ...lines.slice(end)].join("\n").trimEnd()}\n`;
		}
	}
	// Before the references, when the draft has them.
	const refs = body.search(REFERENCES_HEADING);
	if (refs >= 0) return `${body.slice(0, refs).trimEnd()}\n\n${text}\n\n${body.slice(refs).trimEnd()}\n`;
	return `${body ? `${body}\n\n` : ""}${text}\n`;
}

/** The outline with the section's line ticked. */
export function markOutline(outline: string, line: string): string {
	const key = compact(line);
	return outline
		.split("\n")
		.map((l) => {
			const m = /^(\s*[-*]\s*)\[ \](\s*)(.*)$/.exec(l);
			return m && compact(m[3]) === key ? `${m[1]}[x]${m[2]}${m[3]}` : l;
		})
		.join("\n");
}

/** The document's title from its outline's first heading (# 大纲：X, or # X). */
export function outlineTitle(outline: string): string {
	const m = /^#\s*(.+)$/m.exec(outline);
	if (!m) return "";
	// "# 《X》提纲" names the outline, not the document (l12, 2026-11-17: the draft's title came out as 《…》提纲).
	const title = m[1]
		.replace(/^大纲[：:]\s*/, "")
		.replace(/\s*(?:提纲|大纲)\s*$/, "")
		.trim();
	return title.replace(/^《(.+)》$/, "$1").trim();
}
