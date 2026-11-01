/**
 * Text statistics shared by the WriterAgent tools: positions, sentences, counts, sections and
 * the comparison with a target length.
 */

/** 1-based line and column of a string offset. */
export interface Position {
	// Line number, starting at 1.
	line: number;
	// Column number, starting at 1.
	column: number;
}

/** One sentence and where it starts. */
export interface Sentence {
	// Sentence text, trimmed.
	text: string;
	// Offset of the first character in the source text.
	start: number;
}

/** Counts of one piece of text. */
export interface TextCounts {
	// Chinese characters (Han script).
	cjk: number;
	// English words (letters, with inner hyphens or apostrophes).
	words: number;
	// Numbers such as 2026, 3.5 or 18%.
	numbers: number;
	// Punctuation marks.
	punct: number;
	// Length as writers count it: characters + words + numbers, punctuation left out.
	total: number;
}

/** One section of a document. */
export interface Section {
	// Heading text ("" for the text before the first heading).
	title: string;
	// Heading level (0 for the text before the first heading).
	level: number;
	// 1-based line of the heading.
	line: number;
	// Section text, heading line excluded.
	text: string;
}

/** Result of comparing a length with a target. */
export interface TargetCheck {
	// total - target.
	diff: number;
	// diff / target.
	ratio: number;
	// Inside the tolerance, too long or too short.
	status: "within" | "over" | "under";
}

/** Characters that end a sentence. */
const SENTENCE_END = "。！？!?";
/** Closing quotes and brackets that stay with the sentence they end. */
const CLOSERS = "”’」』）)\"'";

/** Line and column of offset in text. */
export function lineColumn(text: string, offset: number): Position {
	// Text before the offset.
	const before = text.slice(0, offset);
	// Last line break before the offset (-1 when on the first line).
	const lastBreak = before.lastIndexOf("\n");
	// Lines are counted by the breaks before the offset.
	return { line: before.split("\n").length, column: offset - lastBreak };
}

/** Split text into sentences at 。！？!?, at a period followed by a space, and at line breaks. */
export function splitSentences(text: string): Sentence[] {
	// Collected sentences.
	const out: Sentence[] = [];
	// Start of the current sentence.
	let start = 0;
	// Close the sentence that ends before offset end.
	const close = (end: number) => {
		// Raw slice.
		const raw = text.slice(start, end);
		// Leading whitespace, so start points at the first real character.
		const lead = raw.length - raw.trimStart().length;
		// Keep sentences that contain a letter, digit or Han character.
		if (/[\p{L}\p{N}]/u.test(raw)) out.push({ text: raw.trim(), start: start + lead });
		// Next sentence starts here.
		start = end;
	};
	// Walk the characters.
	for (let i = 0; i < text.length; i++) {
		// Current character.
		const ch = text[i];
		// A line break always ends a sentence.
		if (ch === "\n") {
			// Close before the break.
			close(i);
			// Continue after it.
			start = i + 1;
		} else if (SENTENCE_END.includes(ch) || (ch === "." && (i + 1 === text.length || /\s/.test(text[i + 1])))) {
			// Swallow repeated end marks and closing quotes.
			let end = i + 1;
			// Advance over them.
			while (end < text.length && (SENTENCE_END.includes(text[end]) || CLOSERS.includes(text[end]))) end++;
			// Close the sentence.
			close(end);
			// Resume after the swallowed marks.
			i = end - 1;
		}
	}
	// Last sentence without an end mark.
	close(text.length);
	// All sentences.
	return out;
}

/** Count Chinese characters, English words, numbers and punctuation. */
export function countText(text: string): TextCounts {
	// Han characters.
	const cjk = text.match(/\p{Script=Han}/gu)?.length ?? 0;
	// English words such as Wi-Fi or don't.
	const wordRe = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
	// Numbers, with decimal or thousands separators and an optional percent sign.
	const numberRe = /\d+(?:[.,]\d+)*%?/g;
	// Word count.
	const words = text.match(wordRe)?.length ?? 0;
	// Number count.
	const numbers = text.match(numberRe)?.length ?? 0;
	// Markdown markers (# headings, list bullets, quote marks, ** and __) are not punctuation.
	const prose = text.replace(/^[ \t]{0,3}(?:#{1,6}|[-*+>])[ \t]+/gm, " ").replace(/\*\*|__/g, " ");
	// Punctuation outside words and numbers (the hyphen of Wi-Fi and the point of 3.5 are not counted).
	const punct = prose.replace(wordRe, " ").replace(numberRe, " ").match(/\p{P}/gu)?.length ?? 0;
	// Writers' length leaves punctuation out.
	return { cjk, words, numbers, punct, total: cjk + words + numbers };
}

/** Heading level and title of a line: Markdown #, 一、 (level 1) or （一） (level 2); undefined for body text. */
export function headingOf(line: string): { level: number; title: string } | undefined {
	// Markdown heading.
	const md = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
	// Level from the number of #.
	if (md) return { level: md[1].length, title: md[2] };
	// Chinese level-1 heading such as 一、总体情况 (short line only, so numbered paragraphs stay body text).
	const zh1 = /^\s*([一二三四五六七八九十]+、.{1,40})$/.exec(line);
	// Level 1.
	if (zh1 && !/[。！？]$/.test(zh1[1])) return { level: 1, title: zh1[1].trim() };
	// Chinese level-2 heading such as （一）主要做法.
	const zh2 = /^\s*([（(][一二三四五六七八九十]+[）)].{1,40})$/.exec(line);
	// Level 2.
	if (zh2 && !/[。！？]$/.test(zh2[1])) return { level: 2, title: zh2[1].trim() };
	// Body text.
	return undefined;
}

/** Split a document into sections at its headings. */
export function splitSections(text: string): Section[] {
	// Lines of the document.
	const lines = text.split("\n");
	// Collected sections; the first one holds the text before any heading.
	const sections: Section[] = [{ title: "", level: 0, line: 1, text: "" }];
	// Body lines of the current section.
	let body: string[] = [];
	// Walk the lines.
	lines.forEach((line, index) => {
		// Heading on this line, if any.
		const heading = headingOf(line);
		// Body line: add it to the current section.
		if (!heading) {
			// Keep it.
			body.push(line);
			return;
		}
		// Finish the current section.
		sections[sections.length - 1].text = body.join("\n");
		// Start a new one.
		sections.push({ title: heading.title, level: heading.level, line: index + 1, text: "" });
		// Empty body for it.
		body = [];
	});
	// Finish the last section.
	sections[sections.length - 1].text = body.join("\n");
	// Drop an empty lead section.
	return sections.filter((s, i) => i > 0 || s.text.trim() !== "");
}

/** Compare total with target; tolerance is a fraction such as 0.1 for ±10%. */
export function compareTarget(total: number, target: number, tolerance: number): TargetCheck {
	// Signed difference.
	const diff = total - target;
	// Relative difference (0 when the target is 0).
	const ratio = target > 0 ? diff / target : 0;
	// Inside the band, above it or below it.
	const status = Math.abs(ratio) <= tolerance ? "within" : diff > 0 ? "over" : "under";
	// The comparison.
	return { diff, ratio, status };
}
