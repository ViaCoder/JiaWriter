/**
 * Blocks → .docx with an export profile, and a check of the finished file's XML. Every run that
 * holds Chinese text or Chinese punctuation (including the ambiguous “” — …) carries
 * w:hint="eastAsia" and the level's Chinese font in the eastAsia slot, so quotes render full-width;
 * the document defaults carry the same, and the check reads the final XML instead of trusting styles.
 */

// docx writer.
import {
	AlignmentType,
	convertMillimetersToTwip,
	Document,
	ExternalHyperlink,
	Footer,
	HeadingLevel,
	LineRuleType,
	Packer,
	PageNumber,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
} from "docx";
// Unzip for the check.
import { strFromU8, unzipSync } from "fflate";
// Document blocks.
import type { Block, Span } from "./blocks.ts";
// Profile types.
import type { ExportProfile, LevelFormat } from "./profile.ts";
// Punctuation counters for the check.
import { countAsciiNextToHan, pairQuotes } from "./punct.ts";

/** Chinese characters and the punctuation that must use the Chinese font. */
const NEEDS_EAST_ASIA = /[\p{Script=Han}‘’“”—…　-〿＀-￯]/u;
/** Page-number size (四号) in points. */
const PAGE_NUMBER_PT = 14;

/** Alignment value for a profile alignment. */
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, both: AlignmentType.BOTH } as const;

/** Run fonts for a level; the hint only when the text needs the Chinese font. */
function runFont(f: LevelFormat, text: string) {
	// All four slots named; no fallback fonts.
	return {
		ascii: f.latin,
		hAnsi: f.latin,
		cs: f.latin,
		eastAsia: f.eastAsia,
		...(NEEDS_EAST_ASIA.test(text) ? { hint: "eastAsia" } : {}),
	};
}

/** Color of hyperlink text (Word's own hyperlink blue). */
const LINK_COLOR = "0563C1";

/** One run of text in a level's format; link text is blue and underlined like Word's hyperlinks. */
function textRun(text: string, f: LevelFormat, bold: boolean, link = false): TextRun {
	// Size in half-points, black text (blue for a link).
	return new TextRun({
		text,
		bold: bold || f.bold,
		size: f.sizePt * 2,
		color: link ? LINK_COLOR : "000000",
		...(link ? { underline: {} } : {}),
		font: runFont(f, text),
	});
}

/** A span as a run, or as a working hyperlink around its run. */
function spanRun(s: Span, f: LevelFormat): TextRun | ExternalHyperlink {
	// Plain text.
	if (!s.link) return textRun(s.text, f, s.bold);
	// The URL text, clickable in Word.
	return new ExternalHyperlink({ link: s.link, children: [textRun(s.text, f, s.bold, true)] });
}

/** Paragraph spacing: fixed line height, nothing before or after. */
function spacing(profile: ExportProfile) {
	// Twips (1 pt = 20).
	return { line: profile.lineSpacingPt * 20, lineRule: LineRuleType.EXACT, before: 0, after: 0 };
}

/** First-line indent in characters, with a twip value for readers that ignore character units. */
function indent(f: LevelFormat) {
	// No indent.
	if (f.indentChars === 0) return undefined;
	// 100 per character; one character is one font size wide.
	return { firstLineChars: f.indentChars * 100, firstLine: f.indentChars * f.sizePt * 20 };
}

/** Paragraph of spans in a level's format. */
function paragraph(
	spans: Span[],
	f: LevelFormat,
	profile: ExportProfile,
	heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel],
): Paragraph {
	// Runs with their bold flags.
	return new Paragraph({
		heading,
		alignment: ALIGN[f.align],
		indent: indent(f),
		spacing: spacing(profile),
		children: spans.map((s) => spanRun(s, f)),
	});
}

/** An empty paragraph at the body's line height: the blank line after the title. */
function blankLine(profile: ExportProfile): Paragraph {
	// No runs; the exact line spacing gives it one line's height.
	return new Paragraph({ spacing: spacing(profile), children: [] });
}

/** Style options for a heading level (outline in Word's navigation pane, same fonts as the runs). */
function styleFor(f: LevelFormat, profile: ExportProfile) {
	// Run and paragraph defaults of the style.
	return {
		run: {
			font: { ascii: f.latin, hAnsi: f.latin, cs: f.latin, eastAsia: f.eastAsia, hint: "eastAsia" },
			size: f.sizePt * 2,
			bold: f.bold,
			color: "000000",
		},
		paragraph: { alignment: ALIGN[f.align], spacing: spacing(profile) },
	};
}

/** The document's paragraphs and tables. */
function children(blocks: Block[], profile: ExportProfile): (Paragraph | Table)[] {
	// Levels.
	const L = profile.levels;
	// One element per block (the title also brings the blank line after it).
	return blocks.flatMap((b) => {
		switch (b.kind) {
			case "title":
				// The user, 2026-11-04: a blank line between the title and the text that follows.
				return [paragraph(b.spans, L.title, profile, HeadingLevel.TITLE), blankLine(profile)];
			case "h1":
				return paragraph(b.spans, L.h1, profile, HeadingLevel.HEADING_1);
			case "h2":
				return paragraph(b.spans, L.h2, profile, HeadingLevel.HEADING_2);
			case "h3":
				return paragraph(b.spans, L.h3, profile, HeadingLevel.HEADING_3);
			case "item":
				// The number in front of the text; bullets are dropped (Chinese documents number their items).
				return paragraph(b.marker ? [{ text: b.marker, bold: false }, ...b.spans] : b.spans, L.body, profile);
			case "code":
				// Verbatim lines, no indent.
				return new Paragraph({
					spacing: spacing(profile),
					children: b.lines.flatMap((line, i) =>
						i === 0
							? [textRun(line, L.table, false)]
							: [new TextRun({ break: 1 }), textRun(line, L.table, false)],
					),
				});
			case "table":
				// Full-width table, header row bold.
				return new Table({
					width: { size: 100, type: WidthType.PERCENTAGE },
					rows: b.rows.map(
						(row, r) =>
							new TableRow({
								children: row.map(
									(cell) =>
										new TableCell({
											children: [paragraph([{ text: cell, bold: r === 0 }], L.table, profile)],
										}),
								),
							}),
					),
				});
			default:
				return paragraph(b.spans, L.body, profile);
		}
	});
}

/** The .docx bytes of the blocks. */
export async function buildDocx(blocks: Block[], profile: ExportProfile): Promise<Uint8Array> {
	// Levels and page.
	const L = profile.levels;
	const pg = profile.page;
	// Footer with "— n —".
	const footer = new Footer({
		children: [
			new Paragraph({
				alignment: AlignmentType.CENTER,
				children: [
					new TextRun({
						children: ["— ", PageNumber.CURRENT, " —"],
						size: PAGE_NUMBER_PT * 2,
						font: {
							ascii: L.body.latin,
							hAnsi: L.body.latin,
							cs: L.body.latin,
							eastAsia: L.body.eastAsia,
							hint: "eastAsia",
						},
					}),
				],
			}),
		],
	});
	// The document.
	const doc = new Document({
		styles: {
			default: {
				document: styleFor(L.body, profile),
				title: styleFor(L.title, profile),
				heading1: styleFor(L.h1, profile),
				heading2: styleFor(L.h2, profile),
				heading3: styleFor(L.h3, profile),
			},
		},
		sections: [
			{
				properties: {
					page: {
						size: { width: convertMillimetersToTwip(pg.widthMm), height: convertMillimetersToTwip(pg.heightMm) },
						margin: {
							top: convertMillimetersToTwip(pg.topMm),
							bottom: convertMillimetersToTwip(pg.bottomMm),
							left: convertMillimetersToTwip(pg.leftMm),
							right: convertMillimetersToTwip(pg.rightMm),
						},
					},
				},
				footers: profile.pageNumbers ? { default: footer } : undefined,
				children: children(blocks, profile),
			},
		],
	});
	// Serialized.
	return new Uint8Array(await Packer.toBuffer(doc));
}

/** Findings of the XML check of a finished .docx. */
export interface DocxAudit {
	// Text runs in the body.
	runs: number;
	// Runs with Chinese text or punctuation.
	chineseRuns: number;
	// Of those, runs without w:hint="eastAsia".
	missingHint: number;
	// Of those, runs without an eastAsia font.
	missingEastAsia: number;
	// ASCII punctuation next to a Chinese character.
	asciiNextToHan: number;
	// Quotes without a partner in their paragraph.
	unpairedQuotes: number;
	// Distinct run sizes in points.
	sizesPt: number[];
	// Distinct exact line spacings in points.
	lineSpacingsPt: number[];
	// Hyperlinks in the body.
	hyperlinks: number;
	// Of those, links whose relationship has no external http(s) target (they would not open).
	brokenLinks: number;
}

/** XML text → plain text. */
function xmlText(s: string): string {
	// The five predefined entities.
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/** Check a finished .docx: hints, fonts, punctuation and quotes, sizes and line spacing. */
export function auditDocx(bytes: Uint8Array): DocxAudit {
	// The main part and its relationships (hyperlink targets).
	const RELS = "word/_rels/document.xml.rels";
	const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" || f.name === RELS });
	const xml = strFromU8(files["word/document.xml"]);
	const rels = files[RELS] ? strFromU8(files[RELS]) : "";
	// Counters.
	const a: DocxAudit = {
		runs: 0,
		chineseRuns: 0,
		missingHint: 0,
		missingEastAsia: 0,
		asciiNextToHan: 0,
		unpairedQuotes: 0,
		sizesPt: [],
		lineSpacingsPt: [],
		hyperlinks: 0,
		brokenLinks: 0,
	};
	// Each hyperlink needs an external http(s) relationship target.
	for (const m of xml.matchAll(/<w:hyperlink [^>]*r:id="([^"]+)"/g)) {
		a.hyperlinks++;
		const rel = new RegExp(`<Relationship [^>]*Id="${m[1]}"[^>]*>`).exec(rels)?.[0] ?? "";
		if (!/Target="https?:\/\/[^"]+"/.test(rel) || !/TargetMode="External"/.test(rel)) a.brokenLinks++;
	}
	// Size and spacing sets.
	const sizes = new Set<number>();
	const lines = new Set<number>();
	// Each paragraph.
	for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
		// Exact line spacing.
		const sp = /<w:spacing [^>]*w:line="(\d+)"[^>]*w:lineRule="exact"/.exec(p);
		if (sp) lines.add(Number(sp[1]) / 20);
		// Paragraph text.
		let text = "";
		// Each run.
		for (const r of p.match(/<w:r[ >][\s\S]*?<\/w:r>/g) ?? []) {
			// Its text.
			const rt = xmlText(
				(r.match(/<w:t(?: [^>]*)?>[\s\S]*?<\/w:t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, "")).join(""),
			);
			if (rt === "") continue;
			a.runs++;
			text += rt;
			// Size.
			const sz = /<w:sz w:val="(\d+)"/.exec(r);
			if (sz) sizes.add(Number(sz[1]) / 2);
			// Chinese runs need the hint and the font.
			if (NEEDS_EAST_ASIA.test(rt)) {
				a.chineseRuns++;
				if (!/w:hint="eastAsia"/.test(r)) a.missingHint++;
				if (!/w:eastAsia="[^"]+"/.test(r)) a.missingEastAsia++;
			}
		}
		// Punctuation and quotes of the paragraph (word-internal apostrophes are not quotes).
		a.asciiNextToHan += countAsciiNextToHan(text);
		a.unpairedQuotes += pairQuotes(text.replace(/(?<=\w)['’](?=\w)/g, "")).unpairedCount;
	}
	// Sorted sets.
	a.sizesPt = [...sizes].sort((x, y) => x - y);
	a.lineSpacingsPt = [...lines].sort((x, y) => x - y);
	// The findings.
	return a;
}
