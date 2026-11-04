// Unit tests for src/writer/export/docx.ts: the written XML (fonts, sizes, spacing, hints, page) and the check.

// Unzip to read the parts.
import { convertMillimetersToTwip } from "docx";
import { strFromU8, unzipSync } from "fflate";
// Test API.
import { describe, expect, it } from "vitest";
// Read-back.
import { docxToPages } from "../../src/writer/docs/docx-read.ts";
// Blocks.
import { parseBlocks } from "../../src/writer/export/blocks.ts";
// Functions under test.
import { auditDocx, buildDocx } from "../../src/writer/export/docx.ts";
// Profiles.
import { DEFAULT_ZH } from "../../src/writer/export/profile.ts";
// Fixtures.
import { makeDocx } from "./doc-fixtures.ts";

/** One part of a .docx as text. */
function part(bytes: Uint8Array, name: string): string {
	// Unzipped part.
	return strFromU8(unzipSync(bytes)[name]);
}

/** Runs of document.xml whose text contains s. */
function runsWith(xml: string, s: string): string[] {
	// Runs that hold the text.
	return (xml.match(/<w:r>[\s\S]*?<\/w:r>/g) ?? []).filter((r) => r.includes(s));
}

// A draft with every level, a quote, a list item, a table and code.
const DRAFT =
	"# 大标题\n\n## 一、一级\n\n### （一）二级\n\n#### 1．三级\n\n正文“引号”和 English。\n\n1. 第一项\n\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n\n```\ncode()\n```";

describe("buildDocx", () => {
	it("writes each level's fonts and sizes, the hint on Chinese runs, exact 32 pt spacing and the page", async () => {
		// The file.
		const bytes = await buildDocx(parseBlocks(DRAFT), DEFAULT_ZH);
		const doc = part(bytes, "word/document.xml");
		// Level fonts in the eastAsia slot, Times New Roman in ascii/hAnsi, sizes in half-points.
		const expectRun = (text: string, font: string, sz: number) => {
			const r = runsWith(doc, text)[0];
			expect(r).toContain(`w:eastAsia="${font}"`);
			expect(r).toContain('w:ascii="Times New Roman"');
			expect(r).toContain('w:hAnsi="Times New Roman"');
			expect(r).toContain(`<w:sz w:val="${sz}"/>`);
			expect(r).toContain('w:hint="eastAsia"');
		};
		expectRun("大标题", "方正小标宋简体", 44);
		expectRun("一、一级", "黑体", 36);
		expectRun("（一）二级", "楷体_GB2312", 36);
		expectRun("1．三级", "黑体", 36);
		expectRun("正文“引号”", "方正仿宋_GBK", 36);
		// A run without Chinese gets no hint.
		expect(runsWith(doc, "code()")[0]).not.toContain("w:hint");
		// Exact 32 pt line spacing and the 2-character indent of the body.
		expect(doc).toContain('w:line="640" w:lineRule="exact"');
		expect(doc).toContain('w:firstLineChars="200"');
		// Page margins (GB/T 9704) and A4.
		expect(doc).toContain(`w:top="${convertMillimetersToTwip(37)}"`);
		expect(doc).toContain(`w:left="${convertMillimetersToTwip(28)}"`);
		// Document defaults with the body font and the hint.
		const styles = part(bytes, "word/styles.xml");
		const defaults = /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(styles)?.[0] ?? "";
		expect(defaults).toContain('w:eastAsia="方正仿宋_GBK"');
		expect(defaults).toContain('w:hint="eastAsia"');
		// Page number field in the footer.
		const footer = Object.keys(unzipSync(bytes)).find((n) => n.startsWith("word/footer")) ?? "";
		expect(part(bytes, footer)).toContain("PAGE");
	});
	it("leaves the footer out when the profile turns page numbers off, and reads back with the importer", async () => {
		// No footer.
		const bytes = await buildDocx(parseBlocks(DRAFT), { ...DEFAULT_ZH, pageNumbers: false });
		expect(Object.keys(unzipSync(bytes)).some((n) => n.startsWith("word/footer"))).toBe(false);
		// Headings come back as headings.
		const page = docxToPages(bytes)[0];
		expect(page.startsWith("# 大标题\n\n# 一、一级\n\n## （一）二级\n\n### 1．三级\n\n正文“引号”和 English。")).toBe(
			true,
		);
	});
});

describe("buildDocx: title spacing and hyperlinks", () => {
	it("puts a blank line after the title and makes links work", async () => {
		// Title, a paragraph with a link.
		const bytes = await buildDocx(parseBlocks("# 大标题\n\n正文见[报道](https://a.example/n)。"), DEFAULT_ZH);
		const xml = part(bytes, "word/document.xml");
		// The paragraphs in order: title, an empty one at the body's exact line height, then the text.
		const paras = xml.match(/<w:p>[\s\S]*?<\/w:p>|<w:p [\s\S]*?<\/w:p>/g) ?? [];
		expect(paras[0]).toContain("大标题");
		expect(paras[1]).not.toContain("<w:t");
		expect(paras[1]).toContain('w:line="640"');
		expect(paras[2]).toContain("正文见");
		// The URL is a hyperlink with an external relationship, blue and underlined.
		const id = /<w:hyperlink [^>]*r:id="([^"]+)"/.exec(xml)?.[1] ?? "";
		expect(part(bytes, "word/_rels/document.xml.rels")).toMatch(
			new RegExp(
				`<Relationship [^>]*Id="${id}"[^>]*Target="https://a.example/n"[^>]*TargetMode="External"|<Relationship [^>]*Target="https://a.example/n"[^>]*Id="${id}"`,
			),
		);
		expect(runsWith(xml, "https://a.example/n")[0] ?? xml).toMatch(/w:color w:val="0563C1"/);
		const a = auditDocx(bytes);
		expect([a.hyperlinks, a.brokenLinks]).toEqual([1, 0]);
	});
});

describe("auditDocx", () => {
	it("finds nothing to fix in a built file", async () => {
		// The check of a clean export.
		const a = auditDocx(await buildDocx(parseBlocks(DRAFT), DEFAULT_ZH));
		expect({ ...a, runs: a.runs > 0, chineseRuns: a.chineseRuns > 5 }).toEqual({
			runs: true,
			chineseRuns: true,
			missingHint: 0,
			missingEastAsia: 0,
			asciiNextToHan: 0,
			unpairedQuotes: 0,
			sizesPt: [18, 22],
			lineSpacingsPt: [32],
			hyperlinks: 0,
			brokenLinks: 0,
		});
	});
	it("counts hyperlinks and those without an external target", () => {
		// A link whose relationship is missing would not open.
		const a = auditDocx(
			makeDocx('<w:p><w:hyperlink r:id="rId9"><w:r><w:t>https://a.example</w:t></w:r></w:hyperlink></w:p>'),
		);
		expect([a.hyperlinks, a.brokenLinks]).toEqual([1, 1]);
	});
	it("counts a missing hint, a missing font, ASCII marks next to Chinese and an unpaired quote", () => {
		// Hand-made runs: no rPr at all; ASCII comma; an unpaired quote; an English run with an apostrophe.
		const a = auditDocx(
			makeDocx(
				'<w:p><w:r><w:t>中文,标点</w:t></w:r><w:r><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr><w:t>“未闭合</w:t></w:r><w:r><w:t>don\'t</w:t></w:r></w:p>',
			),
		);
		expect([a.runs, a.chineseRuns, a.missingHint, a.missingEastAsia, a.asciiNextToHan, a.unpairedQuotes]).toEqual([
			3, 2, 1, 2, 1, 1,
		]);
	});
});
