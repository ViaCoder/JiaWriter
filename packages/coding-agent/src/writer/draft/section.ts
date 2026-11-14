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

/** Parts that open or close a document without a heading of their own. */
const NO_HEADING = new Set(["引言", "开篇", "前言", "导语", "开头", "结语", "结尾", "结束语", "参考文献"]);

/**
 * The heading a section opens with: the outline line up to its first colon, or the line itself; none for an opening
 * or closing part (2026-11-12: a run's 开篇 got "## 开篇", which the heading check then flagged). A heading the model
 * gives loses its # marks, which the program adds (the same run passed "## 一、发展现状" and got "## ## 一、发展现状").
 */
export function headingOf(line: string, given?: string): string {
	if (given !== undefined) return given.replace(/^#+\s*/, "").trim();
	const head = line.split(/[：:]/)[0].trim();
	return NO_HEADING.has(head.replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, "")) ? "" : head;
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
	return [
		"You write one section of a Chinese official document for the program that assembles the document. The request gives the document's purpose, the outline, this section's judgments and its material (fact records the program extracted from the sources), and the text written so far. Write from those alone: every fact and figure from the records, none from memory, each record used at most once.",
		...rules,
		// Quoted people (the user, 2026-11-12: material from international outlets "with quotes from individuals—particularly
		// those containing metaphors or other vivid, expressive language" makes the output read as machine-written).
		"A person quoted in the materials gives the document a fact, a figure or a decision, attributed to them in plain words (大众汽车首席执行官布鲁默表示，2025年在华销量下降10%); their images, metaphors, emphasis and rhetoric stay out, and so does any rhetoric of your own",
		// What the first clean run still did (exp-p24t RD3, 2026-11-12): an opening that described the report itself, four
		// paragraphs opening as 名词+副词+动词, and measures opening in turn with 针对…问题, 围绕…问题, 着眼…问题 and no actor.
		"Paragraphs open differently from one another, with the judgment or the measure itself: never by restating the problem it answers (not 针对起降设施不足的问题，要增加设施 but 民航局会同地方政府按飞行需求增建起降点), never by describing what the document does (not 本报告梳理现状、分析问题 but the first fact or judgment), and a measure names who does it",
		// 2026-11-12, exp-p24u RI1: 总裁Poetzl表示, 首席执行官Filosa表示, 主席Mueller称 beside Alexander Seitz in full.
		"A foreign person is named as Chinese documents name them: the full name in Chinese transliteration (福特首席执行官吉姆·法利), never a bare Latin surname; a company or product keeps its usual name (Stellantis, eVTOL)",
		// Exemplars (the user, 2026-11-12: material that already reads as machine-written carries its register into the
		// text; a paragraph of a published document in the request gives the model a register to match instead).
		"The request may carry 范例: paragraphs of published official documents of this section's kind. Match their shape, the judgment or the measure first and the figures and parallel elements after it, sentences of their length, no commentary; take no fact, phrase or subject from them",
		"Return the section's text only: its heading line when one is given, then its paragraphs, joined to the text written so far without repeating it; no notes, no preamble, no code fence, no reference list",
	].join("\n");
}

/** The request for one section, with everything it is written from. */
export function sectionRequest(input: SectionInput): string {
	const parts = [
		`文件要求：\n${input.brief || "（见大纲）"}`,
		`大纲：\n${input.outline.trim()}`,
		`本节：${input.line}`,
		input.heading ? `本节标题行：${input.heading}` : "本节不设标题",
		input.items.length > 0 ? `本节要点：\n${input.items.map((i) => `- ${i}`).join("\n")}` : "",
		exemplarText(input),
		`本节素材（程序从来源提取的事实记录，事实和数字只从这里取）：\n${input.materials.length > 0 ? input.materials.join("\n") : "（无）"}`,
		input.previous.trim()
			? `前文（已写好的部分，接着写，不要重复）：\n${lastChars(input.previous, MAX_PREVIOUS)}`
			: "前文：无，这是第一节",
		input.chars ? `本节篇幅：约 ${input.chars} 字` : "",
		input.notes?.trim() ? `补充要求：${input.notes.trim()}` : "",
	];
	return parts.filter(Boolean).join("\n\n");
}

/** The 范例 part of a request: the exemplar paragraphs of the section's kind, each under its source; empty for none. */
function exemplarText(input: SectionInput): string {
	const found = exemplarsFor(input.line, input.heading, !input.previous.trim());
	if (found.length === 0) return "";
	return `范例（公开文件的段落，学它的开头、句式和节奏，内容和用语不照搬）：\n${found
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
	return m ? m[1].replace(/^大纲[：:]\s*/, "").trim() : "";
}
