// Unit and functional tests for src/writer/export/xlsx.ts and pptx.ts: the sheets and slides a draft gives, the files
// they build (read back with the import readers), and the export entry point writing them.

// Files.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Zip.
import { strFromU8, unzipSync } from "fflate";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Readers of the two formats.
import { pptxToPages } from "../../src/writer/docs/pptx-read.ts";
import { xlsxToPages } from "../../src/writer/docs/xlsx-read.ts";
// The blocks and the export entry point.
import { parseBlocks } from "../../src/writer/export/blocks.ts";
import { defaultOutput, exportDraft } from "../../src/writer/export/export.ts";
// Functions under test.
import { buildPptx, MAX_LINES, slidesOf } from "../../src/writer/export/pptx.ts";
import { buildXlsx, columnName, numberOf, sheetName, sheetsOf, xmlText } from "../../src/writer/export/xlsx.ts";

/** A report with two tables and three sections. */
const DRAFT = [
	"# 老旧小区改造情况报告",
	"",
	"2021年至2025年，全市累计改造老旧小区286个。",
	"",
	"## 一、主要做法",
	"",
	"### （一）先征求意见再定清单",
	"",
	"东湖街道在改造中先征求意见，居民需求有78%纳入改造内容。",
	"",
	"- 入户走访1200户",
	"- 召开议事会12次",
	"",
	"| 年份 | 改造小区（个） | 投入（亿元） |",
	"| --- | --- | --- |",
	"| 2024 | 60 | 3.2 |",
	"| 2025 | 72 | 4.1 |",
	"",
	"## 二、存在的问题",
	"",
	"改造后引入物业服务的小区中，有41个物业费收缴率低于60%。",
	"",
	"| 街道 | 低于60%的小区 |",
	"| --- | --- |",
	"| 东湖 | 12 |",
	"| 西山 | 29 |",
	"",
	"## 参考文献",
	"",
	"1. [改造情况，住建局，2026-01-05](https://example.com/report)",
].join("\n");

/** Every part of a zip parses as XML in the loosest sense: tags balance. */
function partsBalance(bytes: Uint8Array): string[] {
	const bad: string[] = [];
	for (const [name, data] of Object.entries(unzipSync(bytes))) {
		const xml = strFromU8(data);
		const opens = (xml.match(/<[A-Za-z:][^\s/>]*(?:\s[^>]*?)?(?<!\/)>/g) ?? []).filter(
			(t) => !t.startsWith("<?"),
		).length;
		const closes = (xml.match(/<\/[A-Za-z:][^>]*>/g) ?? []).length;
		if (opens !== closes) bad.push(`${name}: ${opens} open, ${closes} close`);
	}
	return bad;
}

// Working folder of each test.
let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "wa-office-out-"));
	vi.stubEnv("JW_LANG", "zh");
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("xlsx", () => {
	it("helpers: XML text, column names, numbers as written, unique sheet names", () => {
		expect(xmlText('a<b>&"c"')).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
		expect([columnName(0), columnName(25), columnName(26), columnName(27)]).toEqual(["A", "Z", "AA", "AB"]);
		expect([
			numberOf("12"),
			numberOf("-3.5"),
			numberOf("1,267"),
			numberOf("45%"),
			numberOf("3.2亿"),
			numberOf(""),
		]).toEqual([12, -3.5, 1267, 0.45, undefined, undefined]);
		const taken = new Set(["一、主要做法"]);
		expect(sheetName("一、主要做法", taken)).toBe("一、主要做法 2");
		expect(sheetName("a/b?c*d", new Set())).toBe("abcd");
		expect(sheetName("字".repeat(40), new Set())).toHaveLength(31);
		expect(sheetName("", new Set())).toBe("表");
	});

	it("sheetsOf: a sheet per table named by the heading above it; the text as lines when there is no table", () => {
		const sheets = sheetsOf(parseBlocks(DRAFT));
		expect(sheets.map((s) => s.name)).toEqual(["（一）先征求意见再定清单", "二、存在的问题"]);
		expect(sheets[0].rows[0]).toEqual(["年份", "改造小区（个）", "投入（亿元）"]);
		const plain = sheetsOf(parseBlocks("# 通知\n\n正文一。\n\n- 事项甲\n"));
		expect(plain).toEqual([{ name: "正文", rows: [["通知"], ["正文一。"], [expect.stringContaining("事项甲")]] }]);
	});

	it("buildXlsx: a workbook the import reader reads back, numbers as numbers, the header first", () => {
		const bytes = buildXlsx(parseBlocks(DRAFT));
		expect(partsBalance(bytes)).toEqual([]);
		const pages = xlsxToPages(bytes);
		expect(pages).toHaveLength(2);
		expect(pages[0]).toBe(
			"## （一）先征求意见再定清单\n\n| 年份 | 改造小区（个） | 投入（亿元） |\n| --- | --- | --- |\n| 2024 | 60 | 3.2 |\n| 2025 | 72 | 4.1 |",
		);
		expect(pages[1]).toContain("| 西山 | 29 |");
		// Numbers are stored as numbers, the header as inline strings in the bold style.
		const sheet = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]);
		expect(sheet).toContain('<c r="B2"><v>60</v></c>');
		expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">');
	});
});

describe("pptx", () => {
	it("slidesOf: a cover, a slide per level-1 heading, tables on their own, continuation when long", () => {
		const slides = slidesOf(parseBlocks(DRAFT));
		expect(slides.map((s) => `${s.kind}:${s.title}`)).toEqual([
			"cover:老旧小区改造情况报告",
			"text:老旧小区改造情况报告",
			"text:一、主要做法",
			"table:一、主要做法",
			"text:二、存在的问题",
			"table:二、存在的问题",
			"text:参考文献",
		]);
		const making = slides[2];
		if (making.kind !== "text") throw new Error("text slide expected");
		expect(making.lines.map((l) => [l.bold, l.bullet])).toEqual([
			[true, false],
			[false, false],
			[false, true],
			[false, true],
		]);
		// Many paragraphs: a continuation slide with （续）.
		const long = `# 题\n\n## 一、节\n\n${Array.from({ length: MAX_LINES + 2 }, (_, i) => `第${i}段。`).join("\n\n")}`;
		expect(slidesOf(parseBlocks(long)).map((s) => s.title)).toEqual(["题", "一、节", "一、节（续）"]);
	});

	it("buildPptx: a deck the import reader reads back, slide by slide, with titles, text and tables", () => {
		const bytes = buildPptx(parseBlocks(DRAFT));
		expect(partsBalance(bytes)).toEqual([]);
		const pages = pptxToPages(bytes);
		expect(pages).toHaveLength(7);
		expect(pages[0]).toBe("## 老旧小区改造情况报告");
		expect(pages[2]).toContain("## 一、主要做法\n\n（一）先征求意见再定清单\n\n东湖街道");
		expect(pages[3]).toBe(
			"## 一、主要做法\n\n| 年份 | 改造小区（个） | 投入（亿元） |\n| --- | --- | --- |\n| 2024 | 60 | 3.2 |\n| 2025 | 72 | 4.1 |",
		);
		// The package names its parts and the deck its fonts.
		const files = unzipSync(bytes);
		expect(Object.keys(files)).toEqual(
			expect.arrayContaining([
				"ppt/presentation.xml",
				"ppt/slideMasters/slideMaster1.xml",
				"ppt/slideLayouts/slideLayout1.xml",
				"ppt/theme/theme1.xml",
			]),
		);
		expect(strFromU8(files["ppt/theme/theme1.xml"])).toContain('typeface="微软雅黑"');
	});
});

describe("exportDraft with the Office formats", () => {
	it("writes .xlsx and .pptx next to the draft and reports the format", async () => {
		const draft = join(cwd, "报告.md");
		writeFileSync(draft, DRAFT);
		// The path as the platform writes it (\w\稿.xlsx on Windows: CI 43618094874, 2026-11-15).
		expect(defaultOutput(join("/w", "稿.md"), "xlsx")).toBe(join("/w", "稿.xlsx"));
		expect(defaultOutput(join("/w", "稿.md"), "pptx")).toBe(join("/w", "稿.pptx"));
		const x = await exportDraft(draft, cwd, cwd, { format: "xlsx" });
		expect([x.out, x.format]).toEqual(["报告.xlsx", "xlsx"]);
		expect(xlsxToPages(new Uint8Array(readFileSync(join(cwd, x.out))))).toHaveLength(2);
		const p = await exportDraft(draft, cwd, cwd, { format: "pptx", output: "out/汇报.pptx" });
		expect([p.out, p.format]).toEqual(["out/汇报.pptx", "pptx"]);
		expect(pptxToPages(new Uint8Array(readFileSync(join(cwd, p.out))))[0]).toBe("## 老旧小区改造情况报告");
	});
});
