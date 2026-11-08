/**
 * word_count: length of a draft as writers count it, per section, compared with a target.
 */

// Output messages.
import { t, type WriterLang } from "./i18n/index.ts";
// Counting, sections and the target comparison.
import { compareTarget, countText, splitSections, type TargetCheck, type TextCounts } from "./text-stats.ts";

/** Counts of one section. */
export interface SectionCount {
	// Heading ("" before the first heading).
	title: string;
	// Heading level.
	level: number;
	// Counts of the heading plus its body.
	counts: TextCounts;
}

/** Full report. */
export interface WordCountReport {
	// Whole text.
	counts: TextCounts;
	// Per section (empty unless asked for).
	sections: SectionCount[];
	// Target comparison (undefined without a target).
	target: (TargetCheck & { target: number; tolerance: number }) | undefined;
}

/** Options of wordCount. */
export interface WordCountOptions {
	// Count each section too.
	bySection?: boolean;
	// Target length.
	target?: number;
	// Allowed deviation as a fraction (default 0.1).
	tolerance?: number;
}

/** Default allowed deviation from the target. */
export const DEFAULT_TOLERANCE = 0.2;

/** Count the text. */
export function wordCount(text: string, options: WordCountOptions = {}): WordCountReport {
	// Whole-text counts.
	const counts = countText(text);
	// Section counts include the heading text itself.
	const sections = options.bySection
		? splitSections(text).map((s) => ({ title: s.title, level: s.level, counts: countText(`${s.title}\n${s.text}`) }))
		: [];
	// Tolerance in use.
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
	// Comparison when a target is given.
	const target =
		options.target !== undefined && options.target > 0
			? { ...compareTarget(counts.total, options.target, tolerance), target: options.target, tolerance }
			: undefined;
	// The report.
	return { counts, sections, target };
}

/** Percentage text such as +12.5% or -3%. */
function percent(ratio: number): string {
	// One decimal, trailing .0 dropped, explicit plus sign.
	const value = Math.round(ratio * 1000) / 10;
	// Signed text.
	return `${value > 0 ? "+" : ""}${value}%`;
}

/** Report text in lang. */
export function formatWordCount(report: WordCountReport, lang?: WriterLang): string {
	// Whole-text counts.
	const c = report.counts;
	// Heading and totals.
	const out = [
		t("count.title", {}, lang),
		t("count.total", { total: c.total, cjk: c.cjk, words: c.words, numbers: c.numbers, punct: c.punct }, lang),
	];
	// Sections, indented by level.
	for (const s of report.sections)
		out.push(
			`${"  ".repeat(Math.max(0, s.level - 1))}${t("count.section", { title: s.title || t("count.preamble", {}, lang), total: s.counts.total }, lang)}`,
		);
	// Target comparison.
	const g = report.target;
	// Only with a target.
	if (g) {
		// Status text.
		const status =
			g.status === "within"
				? t("count.within", { tolerance: percent(g.tolerance).replace("+", "") }, lang)
				: t(g.status === "over" ? "count.over" : "count.under", {}, lang);
		// Comparison line.
		out.push(
			t(
				"count.target",
				{ target: g.target, diff: `${g.diff > 0 ? "+" : ""}${g.diff}`, percent: percent(g.ratio), status },
				lang,
			),
		);
	}
	// One block of text.
	return out.join("\n");
}
