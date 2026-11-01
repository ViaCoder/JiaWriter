/**
 * readability_check: rare Chinese characters (outside level 1 of 通用规范汉字表), overlong Chinese
 * sentences, and the Flesch reading ease of English text. Reports only; the text is not changed.
 */

// The character table.
import { TGH_LEVEL1, TGH_LEVEL2, TGH_LEVEL3 } from "./data/tgh-chars.ts";
// Output messages.
import { t, type WriterLang } from "./i18n/index.ts";
// Code, URL and quotation masking.
import { maskText } from "./style/check.ts";
// Positions and sentences.
import { lineColumn, splitSentences } from "./text-stats.ts";

/** Table level of a character: 1, 2, 3, or 0 for a character outside the table. */
export type CharLevel = 0 | 1 | 2 | 3;

/** One rare character. */
export interface RareChar {
	// The character.
	char: string;
	// Its level (2, 3 or 0).
	level: CharLevel;
	// Occurrences.
	count: number;
	// 1-based line of the first occurrence.
	line: number;
}

/** One overlong sentence. */
export interface LongSentence {
	// 1-based line.
	line: number;
	// Han characters in it.
	length: number;
	// First characters, for the report.
	head: string;
}

/** English readability. */
export interface EnglishStats {
	// Words.
	words: number;
	// Sentences that contain English words.
	sentences: number;
	// Estimated syllables.
	syllables: number;
	// Flesch reading ease, one decimal (higher is easier; 60-70 is plain English).
	flesch: number;
	// Words of 4 or more syllables.
	longWords: number;
}

/** Full report. */
export interface ReadabilityReport {
	// Han characters checked.
	cjk: number;
	// Characters outside level 1, most frequent first.
	rare: RareChar[];
	// Chinese sentences.
	sentences: number;
	// Average Han characters per Chinese sentence, one decimal.
	average: number;
	// Limit used for long sentences.
	limit: number;
	// Sentences over the limit.
	long: LongSentence[];
	// English statistics (undefined when the text has no English words).
	english: EnglishStats | undefined;
}

/** Default length limit of a Chinese sentence, in Han characters (a 6,670-character report draft had a
 * median of 54 and a 90th percentile of 89, so 100 flags only the sentences that are really overlong). */
export const DEFAULT_SENTENCE_LIMIT = 100;
/** Characters of a long sentence shown in the report. */
const HEAD_CHARS = 20;
/** Most rare characters and long sentences listed. */
const MAX_LISTED = 40;

// Lookup table built on first use: character -> level.
let levels: Map<string, CharLevel> | undefined;

/** Level of one Han character. */
export function charLevel(char: string): CharLevel {
	// Build the lookup once.
	if (!levels) {
		// Empty map.
		levels = new Map();
		// Fill each level.
		for (const [chars, level] of [
			[TGH_LEVEL1, 1],
			[TGH_LEVEL2, 2],
			[TGH_LEVEL3, 3],
		] as const)
			for (const c of chars) levels.set(c, level);
	}
	// 0 for a character the table does not list.
	return levels.get(char) ?? 0;
}

/** Han characters outside level 1, with counts, most frequent first. */
export function rareChars(text: string): RareChar[] {
	// Findings by character.
	const found = new Map<string, RareChar>();
	// Every Han character with its offset.
	for (const m of text.matchAll(/\p{Script=Han}/gu)) {
		// The character.
		const char = m[0];
		// Its level.
		const level = charLevel(char);
		// Common characters are fine.
		if (level === 1) continue;
		// Seen before: count it.
		const seen = found.get(char);
		// Increment.
		if (seen) seen.count++;
		// First time: remember where.
		else found.set(char, { char, level, count: 1, line: lineColumn(text, m.index).line });
	}
	// Most frequent first, then in text order.
	return [...found.values()].sort((a, b) => b.count - a.count || a.line - b.line);
}

/** Chinese sentences longer than limit Han characters. */
export function longSentences(text: string, limit = DEFAULT_SENTENCE_LIMIT): LongSentence[] {
	// Sentences of the text.
	return splitSentences(text)
		.map((s) => ({ s, length: s.text.match(/\p{Script=Han}/gu)?.length ?? 0 }))
		.filter((x) => x.length > limit)
		.map((x) => ({
			line: lineColumn(text, x.s.start).line,
			length: x.length,
			head: [...x.s.text].slice(0, HEAD_CHARS).join(""),
		}));
}

/** Estimated syllables of an English word (vowel groups, silent final e, at least 1). */
export function countSyllables(word: string): number {
	// Lower-case letters only.
	const w = word.toLowerCase().replace(/[^a-z]/g, "");
	// Empty input.
	if (w === "") return 0;
	// Short words have one syllable.
	if (w.length <= 3) return 1;
	// Drop a silent ending: -e, -es, -ed (but keep -le as in "table" and -ted/-ded as in "needed").
	const trimmed = w.replace(/(?:[^laeiouy]es|[^laeiouydt]ed|[^laeiouy]e)$/, (m) => m[0]).replace(/^y/, "");
	// Vowel groups.
	const groups = trimmed.match(/[aeiouy]+/g)?.length ?? 0;
	// At least one.
	return Math.max(1, groups);
}

/** Flesch reading ease of the English parts (undefined without English words). */
export function englishReadability(text: string): EnglishStats | undefined {
	// English words.
	const words = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
	// Nothing to measure.
	if (words.length === 0) return undefined;
	// Sentences that contain English words.
	const sentences = Math.max(1, splitSentences(text).filter((s) => /[A-Za-z]{2,}/.test(s.text)).length);
	// Syllables of each word.
	const counts = words.map(countSyllables);
	// Total syllables.
	const syllables = counts.reduce((a, b) => a + b, 0);
	// Flesch: 206.835 - 1.015 (words/sentence) - 84.6 (syllables/word).
	const flesch = 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length);
	// The statistics.
	return {
		words: words.length,
		sentences,
		syllables,
		flesch: Math.round(flesch * 10) / 10,
		longWords: counts.filter((c) => c >= 4).length,
	};
}

/** Run the checks on text (code and URLs are left out). */
export function readabilityCheck(text: string, limit = DEFAULT_SENTENCE_LIMIT): ReadabilityReport {
	// Code and URLs are not prose; quotations are kept as written by their authors and also skipped.
	const masked = maskText(text);
	// Chinese sentences (those with Han characters).
	const zhSentences = splitSentences(masked).filter((s) => /\p{Script=Han}/u.test(s.text));
	// Han characters in them.
	const cjk = masked.match(/\p{Script=Han}/gu)?.length ?? 0;
	// The report.
	return {
		cjk,
		rare: rareChars(masked),
		sentences: zhSentences.length,
		average: zhSentences.length > 0 ? Math.round((cjk * 10) / zhSentences.length) / 10 : 0,
		limit,
		long: longSentences(masked, limit),
		english: englishReadability(masked),
	};
}

/** Report text in lang. */
export function formatReadability(report: ReadabilityReport, lang?: WriterLang): string {
	// Output lines.
	const out = [t("read.title", {}, lang)];
	// Character summary.
	out.push(
		t(
			"read.chars",
			{ cjk: report.cjk, rare: report.rare.reduce((a, r) => a + r.count, 0), kinds: report.rare.length },
			lang,
		),
	);
	// Message key of each level.
	const levelKey = { 0: "read.level0", 2: "read.level2", 3: "read.level3" } as const;
	// Listed rare characters.
	for (const r of report.rare.slice(0, MAX_LISTED))
		out.push(
			t(
				"read.rare",
				{ char: r.char, level: t(levelKey[r.level as 0 | 2 | 3], {}, lang), count: r.count, line: r.line },
				lang,
			),
		);
	// Sentence summary.
	out.push(
		t(
			"read.sentences",
			{ count: report.sentences, average: report.average, limit: report.limit, long: report.long.length },
			lang,
		),
	);
	// Listed long sentences.
	for (const s of report.long.slice(0, MAX_LISTED))
		out.push(t("read.long", { line: s.line, length: s.length, head: s.head }, lang));
	// English statistics.
	const e = report.english;
	// Only when the text has English words.
	if (e)
		out.push(
			t("read.english", { words: e.words, sentences: e.sentences, score: e.flesch, longWords: e.longWords }, lang),
		);
	// Closing line.
	out.push(t(report.rare.length === 0 && report.long.length === 0 ? "read.clean" : "read.advice", {}, lang));
	// One block of text.
	return out.join("\n");
}
