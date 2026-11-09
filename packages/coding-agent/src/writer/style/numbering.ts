/**
 * Numbering in official documents and reports (the user, 2026-11-08): level-1 headings 一、, level-2 （一）, usually only
 * those two; 1. and （1） for a third and fourth level where one is needed; no 一是/二是, 一要/二要 or 其一 inside the text.
 * In Markdown the levels are ##, ###, #### and #####.
 */

import { bodyBeforeReferences } from "../text-stats.ts";

/** One wrong number or list marker: the words in the draft and the form they should take. */
export interface NumberingIssue {
	// The words, character for character.
	quote: string;
	// What they should be.
	form: string;
}

/** Chinese numerals as headings use them. */
const ZH = "[一二三四五六七八九十]+";

/** The numbering of each Markdown heading level, with an example of it. */
const LEVELS: Readonly<Record<number, { pattern: RegExp; example: string }>> = {
	2: { pattern: new RegExp(`^${ZH}、`), example: "一、" },
	3: { pattern: new RegExp(`^（${ZH}）`), example: "（一）" },
	4: { pattern: /^\d+\.(?!\d)/, example: "1." },
	5: { pattern: /^（\d+）/, example: "（1）" },
};

/** Any heading number, of whatever form, so a wrong one is told from none. */
const ANY_NUMBER = new RegExp(
	`^(?:${ZH}[、.．]|[（(]${ZH}[）)]|\\d+[.．、]|[（(]\\d+[）)]|第${ZH}(?:部分|章|节)?[、，,：:\\s]?)`,
);

/** Headings whose number does not fit their level. */
export function headingIssues(text: string): NumberingIssue[] {
	const issues: NumberingIssue[] = [];
	// The body only: 参考文献 is no numbered part of it (2026-11-09: the check had a brief number it 三、参考文献).
	for (const line of bodyBeforeReferences(text).split("\n")) {
		const m = /^(#{2,5})\s+(.*\S)\s*$/.exec(line);
		if (!m) continue;
		const level = LEVELS[m[1].length];
		const title = m[2];
		if (!level || level.pattern.test(title)) continue;
		// The words after any number the heading has, under the right one.
		const words = title.replace(ANY_NUMBER, "").trim();
		issues.push({ quote: line.trim(), form: `${m[1]} ${level.example}${words}` });
	}
	return issues;
}

/** Ordinal list markers inside the text: 一是, 二要, 其一, each at the start of a sentence or clause (主要做法，一是). */
export function listMarkers(text: string): string[] {
	const found = text.matchAll(new RegExp(`(?:^|[。；：，,！？\\n])\\s*((?:${ZH})(?:是|要)|其${ZH}[，,、])`, "g"));
	return [...new Set([...found].map((m) => m[1]))];
}
