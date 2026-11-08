/**
 * style_check: deterministic AI-style check. It reports positions and labels only and never
 * changes the text; the model rewrites the flagged passages and runs the check again.
 */

// Output messages.
import { t, type WriterLang } from "../i18n/index.ts";
// Positions and sentences.
import { bodyBeforeReferences, lineColumn, splitSentences } from "../text-stats.ts";
// Pattern packs and negation lists.
import {
	DASH_PER_1000,
	DASHES,
	DEFAULT_NEGATION_THRESHOLD,
	DEFAULT_PACKS,
	FACTS,
	FACTS_PER_1000,
	NEGATION_EN,
	NEGATION_ZH,
	SPREAD_FLOOR,
	STYLE_PACKS,
	type StylePattern,
	VAGUE_PER_1000,
	VAGUE_ZH,
	WEAK_PER_1000,
} from "./patterns.ts";

/** One finding. */
export interface StyleHit {
	// Pattern id ("negation" for negative assertions).
	id: string;
	// Chinese label.
	zh: string;
	// English label.
	en: string;
	// Offset of the first character.
	start: number;
	// Offset after the last character.
	end: number;
	// 1-based line.
	line: number;
	// 1-based column.
	column: number;
	// Matched text.
	matched: string;
	// A weak sign, counted by density only.
	weak?: boolean;
}

/** Negative-assertion density. */
export interface NegationStats {
	// Sentences in the checked text.
	sentences: number;
	// Negative assertions found.
	count: number;
	// Count per 10 sentences, one decimal.
	per10: number;
	// Limit per 10 sentences.
	threshold: number;
	// True when per10 exceeds the threshold (and at least 2 were found).
	over: boolean;
	// Where they are.
	hits: StyleHit[];
}

/** List and bold usage. */
export interface StructureStats {
	// Non-empty lines.
	lines: number;
	// Lines that are list items.
	listLines: number;
	// Bold spans.
	bold: number;
	// More than a third of at least 6 lines are list items.
	listOver: boolean;
	// More than BOLD_PER_1000 bold spans per 1,000 characters.
	boldOver: boolean;
}

/** The kind of text: a report must carry facts; an official document (通知, 意见, 方案) follows official habits; other prose neither. */
export type StyleRegister = "report" | "official" | "general";

/** Measures of the whole text, where machine prose shows more than in any one phrase. */
export interface ProseStats {
	// The register the limits were taken for.
	register: StyleRegister;
	// Visible characters.
	chars: number;
	// Sentences ending in a full stop, question or exclamation mark (headings left out).
	sentences: number;
	// Standard deviation over mean of their lengths, two decimals.
	spread: number;
	// Every sentence cut to one size: at least 10 sentences and spread under SPREAD_FLOOR.
	spreadLow: boolean;
	// Vague quantities per 1,000 characters, one decimal, and whether over VAGUE_PER_1000 (from 300 characters).
	vaguePer1000: number;
	vagueOver: boolean;
	// Numbers with units per 1,000 characters, and whether a report of 600 characters or more has under FACTS_PER_1000.
	factsPer1000: number;
	factsLow: boolean;
	// Dashes per 1,000 characters, and whether over DASH_PER_1000.
	dashPer1000: number;
	dashOver: boolean;
	// Weak signs per 1,000 characters, and whether over WEAK_PER_1000.
	weakPer1000: number;
	weakOver: boolean;
}

/** Full report. */
export interface StyleReport {
	// Packs that were applied.
	packs: string[];
	// Pattern hits in text order.
	hits: StyleHit[];
	// Negative-assertion density.
	negation: NegationStats;
	// Format usage.
	structure: StructureStats;
	// Measures of the whole text.
	prose: ProseStats;
}

/** Options of styleCheck. */
export interface StyleOptions {
	// Pack names (DEFAULT_PACKS when empty).
	packs?: readonly string[];
	// Negative assertions allowed per 10 sentences.
	negationThreshold?: number;
	// The kind of text; inferred from its title when not given.
	register?: StyleRegister;
}

/** Bold spans allowed per 1,000 characters. */
export const BOLD_PER_1000 = 2;
/** Most hits listed in a report. */
export const MAX_LISTED = 60;

/** Replace code, URLs and direct quotations with spaces of the same length (line breaks kept). */
export function maskText(text: string): string {
	// Blank out one match.
	const blank = (m: string) => m.replace(/[^\n]/g, " ");
	// Fenced code blocks, inline code, URLs, then quotations in “”, 「」 and "".
	return text
		.replace(/```[\s\S]*?```/g, blank)
		.replace(/`[^`\n]*`/g, blank)
		.replace(/\bhttps?:\/\/\S+/g, blank)
		.replace(/“[^”\n]*”/g, blank)
		.replace(/「[^」\n]*」/g, blank)
		.replace(/"[^"\n]*"/g, blank);
}

/** Make a hit for match [start, end) of the original text. */
function makeHit(text: string, id: string, zh: string, en: string, start: number, end: number): StyleHit {
	// Position of the first character.
	const pos = lineColumn(text, start);
	// The finding with the original wording.
	return { id, zh, en, start, end, line: pos.line, column: pos.column, matched: text.slice(start, end) };
}

/** All matches of re in masked, reported against text. */
function matchAll(text: string, masked: string, re: RegExp, id: string, zh: string, en: string): StyleHit[] {
	// One hit per match.
	return [...masked.matchAll(re)].map((m) => makeHit(text, id, zh, en, m.index, m.index + m[0].length));
}

/** Pattern hits in text order; a hit inside an earlier, longer hit is dropped. */
export function findHits(text: string, patterns: readonly StylePattern[]): StyleHit[] {
	// Code, URLs and quotations are not the author's own prose.
	const masked = maskText(text);
	// Every match of every pattern.
	const all = patterns.flatMap((p) =>
		matchAll(text, masked, p.re, p.id, p.zh, p.en).map((hit) => (p.weak ? { ...hit, weak: true } : hit)),
	);
	// By start, longer first at the same start.
	all.sort((a, b) => a.start - b.start || b.end - a.end);
	// Kept hits.
	const kept: StyleHit[] = [];
	// Drop nested hits (无疑 inside 毫无疑问, for example).
	for (const hit of all) if (!kept.some((k) => k.start <= hit.start && hit.end <= k.end)) kept.push(hit);
	// In text order.
	return kept;
}

/** Negative assertions per 10 sentences, outside code and quotations. */
export function negationDensity(text: string, threshold = DEFAULT_NEGATION_THRESHOLD): NegationStats {
	// Code and quotations are masked.
	const masked = maskText(text);
	// Chinese and English matches, in text order.
	const hits = [
		...matchAll(text, masked, NEGATION_ZH, "negation", "否定式", "negation"),
		...matchAll(text, masked, NEGATION_EN, "negation", "否定式", "negation"),
	].sort((a, b) => a.start - b.start);
	// Sentences of the masked text.
	const sentences = splitSentences(masked).length;
	// Density with one decimal (0 for empty text).
	const per10 = sentences > 0 ? Math.round((hits.length * 100) / sentences) / 10 : 0;
	// Over only with at least two hits, so one sentence never fails a short text.
	return { sentences, count: hits.length, per10, threshold, over: hits.length >= 2 && per10 > threshold, hits };
}

/** List-line and bold usage. */
export function structureStats(text: string): StructureStats {
	// Non-empty lines outside code blocks, before a reference list: its entries are a list by nature (a 2026-11-08
	// brief merged its references into one line to quiet this check).
	const lines = maskText(bodyBeforeReferences(text))
		.split("\n")
		.filter((l) => l.trim() !== "");
	// Bullet or numbered list items (1、 needs no space after it).
	const listLines = lines.filter((l) => /^\s*(?:[-*+•]\s+|\d+[.)．]\s+|\d+、)/.test(l)).length;
	// **bold** spans.
	const bold = text.match(/\*\*[^*\n]+\*\*/g)?.length ?? 0;
	// Visible characters.
	const chars = text.replace(/\s/g, "").length;
	// The usage and its two limits.
	return {
		lines: lines.length,
		listLines,
		bold,
		listOver: lines.length >= 6 && listLines * 3 > lines.length,
		boldOver: chars > 0 && (bold * 1000) / chars > BOLD_PER_1000,
	};
}

/** A report when the title says so (报告, 调研, 总结, 情况, report, survey); official when it ends in a document kind; else general. */
export function inferRegister(text: string): StyleRegister {
	// The first line with words: the title, or the opening.
	const title = text.split("\n").find((line) => line.trim() !== "") ?? "";
	if (/报告|调研|调查|总结|情况|白皮书|\breport\b|\bsurvey\b/i.test(title)) return "report";
	// The kinds of official document, named at the end of the title (……的通知, 实施方案).
	if (/(通知|通报|意见|决定|办法|方案|规定|细则|规划|请示|批复|公告|通告|纪要|函)[》」\s*]*$/.test(title))
		return "official";
	// Headings numbered 一、 or （一） mark a Chinese document even when its title names no kind, or when only one
	// section of it is written ("（一）……" alone; such drafts skipped the document checks before 2026-11-08).
	return /^#{1,6}\s*(?:[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）)/m.test(text) ? "report" : "general";
}

/** Count per 1,000 characters, one decimal. */
function per1000(count: number, chars: number): number {
	return chars > 0 ? Math.round((count * 10000) / chars) / 10 : 0;
}

/** The measures of the whole text, for its register. */
export function proseStats(text: string, register: StyleRegister = inferRegister(text), weakHits = 0): ProseStats {
	// Code, links and quotations do not count, nor do headings.
	const body = maskText(text)
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
	const chars = body.replace(/\s/g, "").length;
	// Sentences with their own end mark, so list items and headings without one stay out.
	const lengths = (body.match(/[^。！？!?\n]+?(?:[。！？!?]|\.(?=\s|$))/g) ?? []).map((s) => s.trim().length);
	const mean = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
	const deviation = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lengths.length));
	const spread = mean > 0 ? Math.round((deviation / mean) * 100) / 100 : 0;
	// The three densities.
	const vaguePer1000 = per1000(body.match(VAGUE_ZH)?.length ?? 0, chars);
	const factsPer1000 = per1000(body.match(FACTS)?.length ?? 0, chars);
	const dashPer1000 = per1000(body.match(DASHES)?.length ?? 0, chars);
	const weakPer1000 = per1000(weakHits, chars);
	return {
		register,
		chars,
		sentences: lengths.length,
		spread,
		spreadLow: lengths.length >= 10 && spread < SPREAD_FLOOR,
		vaguePer1000,
		vagueOver: chars >= 300 && vaguePer1000 > VAGUE_PER_1000,
		factsPer1000,
		factsLow: register === "report" && chars >= 600 && factsPer1000 < FACTS_PER_1000,
		dashPer1000,
		dashOver: chars >= 300 && dashPer1000 > DASH_PER_1000,
		weakPer1000,
		// A short text with one weak sign is not judged by density.
		weakOver: weakHits >= 2 && weakPer1000 > WEAK_PER_1000,
	};
}

/** Run every check; throws on an unknown pack name. */
export function styleCheck(text: string, options: StyleOptions = {}): StyleReport {
	// Requested packs, or the defaults.
	const packs = options.packs && options.packs.length > 0 ? [...options.packs] : [...DEFAULT_PACKS];
	// Reject unknown names with the list of valid ones.
	for (const pack of packs)
		if (!(pack in STYLE_PACKS))
			throw new Error(t("style.badPack", { pack, packs: Object.keys(STYLE_PACKS).join(", ") }));
	// Patterns of all packs.
	const patterns = packs.flatMap((p) => STYLE_PACKS[p]);
	// The checks; weak signs count by their density.
	const hits = findHits(text, patterns);
	return {
		packs,
		hits,
		negation: negationDensity(text, options.negationThreshold),
		structure: structureStats(text),
		prose: proseStats(text, options.register, hits.filter((hit) => hit.weak).length),
	};
}

/** True when the report has nothing to fix. */
export function styleClean(report: StyleReport): boolean {
	// No hits, density and format inside their limits.
	const p = report.prose;
	return (
		report.hits.every((hit) => hit.weak) &&
		!p.weakOver &&
		!report.negation.over &&
		!report.structure.listOver &&
		!report.structure.boldOver &&
		!p.spreadLow &&
		!p.vagueOver &&
		!p.factsLow &&
		!p.dashOver
	);
}

/** Report text in lang. */
export function formatStyleReport(report: StyleReport, lang?: WriterLang): string {
	// Output lines.
	const out = [t("style.title", { packs: report.packs.join(", ") }, lang)];
	// Pattern hits.
	if (report.hits.length > 0) {
		// Heading with the count.
		out.push(t("style.hits", { count: report.hits.length }, lang));
		// Listed hits.
		for (const h of report.hits.slice(0, MAX_LISTED))
			out.push(
				t(
					"style.hit",
					{ line: h.line, column: h.column, label: lang === "en" ? h.en : h.zh, matched: h.matched },
					lang,
				),
			);
		// Hits left out.
		if (report.hits.length > MAX_LISTED) out.push(t("style.more", { count: report.hits.length - MAX_LISTED }, lang));
	}
	// Negation density.
	const n = report.negation;
	// Summary line.
	out.push(
		t(
			"style.negation",
			{
				count: n.count,
				sentences: n.sentences,
				per10: n.per10,
				threshold: n.threshold,
				status: t(n.over ? "style.negationOver" : "style.negationOk", {}, lang),
			},
			lang,
		),
	);
	// Positions only when over the threshold.
	if (n.over)
		for (const h of n.hits.slice(0, MAX_LISTED))
			out.push(t("style.negationHit", { line: h.line, column: h.column, matched: h.matched }, lang));
	// Format usage.
	const s = report.structure;
	// Summary line.
	out.push(t("style.structure", { listLines: s.listLines, lines: s.lines, bold: s.bold }, lang));
	// Too many list lines.
	if (s.listOver) out.push(t("style.listOver", {}, lang));
	// Too much bold.
	if (s.boldOver) out.push(t("style.boldOver", { limit: BOLD_PER_1000 }, lang));
	// Measures of the whole text, with what to do about each that is out of bounds.
	const p = report.prose;
	out.push(
		t(
			"style.prose",
			{
				register: p.register,
				spread: p.spread,
				vague: p.vaguePer1000,
				facts: p.factsPer1000,
				dashes: p.dashPer1000,
			},
			lang,
		),
	);
	if (p.spreadLow) out.push(t("style.spreadLow", {}, lang));
	if (p.vagueOver) out.push(t("style.vagueOver", { limit: VAGUE_PER_1000 }, lang));
	if (p.factsLow) out.push(t("style.factsLow", {}, lang));
	if (p.dashOver) out.push(t("style.dashOver", { limit: DASH_PER_1000 }, lang));
	// Closing line.
	out.push(t(styleClean(report) ? "style.clean" : "style.advice", {}, lang));
	// One block of text.
	return out.join("\n");
}
