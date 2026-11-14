// Unit tests for src/writer/docs/xlsx-read.ts and pptx-read.ts: a spreadsheet's sheets as Markdown tables with dates
// and shared strings resolved, a presentation's slides with titles, tables and notes, and both through importFile.

// Files.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The import entry point.
import { IMPORT_EXTS, importFile } from "../../src/writer/docs/import.ts";
// Slides reader.
import { pptxToPages, relTargets, slideLines } from "../../src/writer/docs/pptx-read.ts";
// Spreadsheet reader.
import {
	columnOf,
	dateStyles,
	isDateFormat,
	MAX_ROWS,
	markdownTable,
	serialToDate,
	sheetRows,
	xlsxToPages,
} from "../../src/writer/docs/xlsx-read.ts";
// Fixtures.
import { makePptx, makeXlsx, shape, slideTable } from "./doc-fixtures.ts";

// Working folder of each test.
let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "wa-office-"));
	vi.stubEnv("JW_LANG", "zh");
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("xlsx helpers", () => {
	it("columnOf, serialToDate, isDateFormat, dateStyles, markdownTable", () => {
		expect([columnOf("A1"), columnOf("Z3"), columnOf("AA10"), columnOf("AB2")]).toEqual([0, 25, 26, 27]);
		// 2026-01-15 is serial 46037; a fraction is a time.
		expect(serialToDate(46037)).toBe("2026-01-15");
		expect(serialToDate(46037.5)).toBe("2026-01-15 12:00");
		expect(isDateFormat("yyyy-mm-dd")).toBe(true);
		expect(isDateFormat('0.00"万元"')).toBe(false);
		expect(isDateFormat("#,##0")).toBe(false);
		// Style 1 is the built-in date 14, style 2 a custom date format, style 0 and 3 are not dates.
		const styles =
			'<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>' +
			'<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>';
		expect([...dateStyles(styles)]).toEqual([1, 2]);
		expect(
			markdownTable([
				["a", "b|c"],
				["1", "2"],
			]),
		).toBe("| a | b\\|c |\n| --- | --- |\n| 1 | 2 |");
		expect(markdownTable([])).toBe("");
	});

	it("sheetRows: types, gaps, inline strings, formulas and the row limit", () => {
		const xml =
			'<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>内联</t></is></c></row>' +
			'<row r="2"><c r="A2"><f>1+1</f><v>2</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="str"><v>公式文本</v></c></row>' +
			'<row r="3"><c r="A3" s="1"><v>46037</v></c></row><row r="4"/><row r="5"/></sheetData>';
		const { rows, cut } = sheetRows(xml, ["甲"], new Set([1]));
		expect(rows).toEqual([
			["甲", "", "内联"],
			["2", "TRUE", "公式文本"],
			["2026-01-15", "", ""],
		]);
		expect(cut).toBe(false);
		// More rows than the limit: cut, and said so.
		const many = `<sheetData>${Array.from({ length: MAX_ROWS + 3 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("")}</sheetData>`;
		const long = sheetRows(many, [], new Set());
		expect([long.rows.length, long.cut]).toEqual([MAX_ROWS, true]);
	});

	it("xlsxToPages: one page per sheet with content, headed by its name; empty sheets dropped", () => {
		const bytes = makeXlsx([
			{
				name: "2025年数据",
				rows: [
					["地区", "产值（亿元）", "日期"],
					["东区", 12.5, { date: 46037 }],
					["西区", 8, null],
				],
			},
			{ name: "空表", rows: [] },
			{ name: "备注", rows: [["说明 & 来源"]] },
		]);
		const pages = xlsxToPages(bytes);
		expect(pages).toHaveLength(2);
		expect(pages[0]).toBe(
			"## 2025年数据\n\n| 地区 | 产值（亿元） | 日期 |\n| --- | --- | --- |\n| 东区 | 12.5 | 2026-01-15 |\n| 西区 | 8 |  |",
		);
		expect(pages[1]).toBe("## 备注\n\n| 说明 & 来源 |\n| --- |");
		// Not a workbook.
		expect(() => xlsxToPages(new Uint8Array([1, 2, 3]))).toThrow();
	});
});

describe("pptx helpers", () => {
	it("relTargets resolves relative and absolute targets; slideLines reads titles, text and tables", () => {
		const rels =
			'<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/><Relationship Id="rId2" Target="/ppt/media/a.png"/></Relationships>';
		expect([...relTargets(rels, "ppt/slides")]).toEqual([
			["rId1", "ppt/notesSlides/notesSlide1.xml"],
			["rId2", "ppt/media/a.png"],
		]);
		const xml = `<p:sld><p:spTree>${shape(["年度总结"], true)}${shape(["第一点", "第二&lt;点&gt;"])}${slideTable([
			["项目", "数量"],
			["A", "3"],
		])}${shape([])}</p:spTree></p:sld>`;
		expect(slideLines(xml)).toEqual([
			"## 年度总结",
			"第一点",
			"第二<点>",
			"| 项目 | 数量 |\n| --- | --- |\n| A | 3 |",
		]);
	});

	it("pptxToPages: one page per slide in order, notes after the text, empty slides dropped", () => {
		const bytes = makePptx([
			{ body: shape(["汇报提纲"], true) + shape(["一、情况", "二、问题"]), notes: "讲三分钟" },
			{ body: shape([]) },
			{
				body:
					shape(["主要数据"], true) +
					slideTable([
						["指标", "值"],
						["增速", "5%"],
					]),
			},
		]);
		expect(pptxToPages(bytes)).toEqual([
			"## 汇报提纲\n\n一、情况\n\n二、问题\n\n备注：讲三分钟",
			"## 主要数据\n\n| 指标 | 值 |\n| --- | --- |\n| 增速 | 5% |",
		]);
		expect(() => pptxToPages(new Uint8Array([1, 2, 3]))).toThrow();
	});
});

describe("importFile with Office files", () => {
	/** Write a file under cwd and return its absolute path. */
	function put(rel: string, data: Uint8Array): string {
		const p = join(cwd, rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, data);
		return p;
	}

	it("imports a spreadsheet and a presentation with page markers, and lists both extensions", async () => {
		expect(IMPORT_EXTS).toContain(".xlsx");
		expect(IMPORT_EXTS).toContain(".pptx");
		const xlsx = await importFile(
			put(
				"参考资料/数据.xlsx",
				makeXlsx([
					{ name: "表1", rows: [["a"]] },
					{ name: "表2", rows: [["b"]] },
				]),
			),
			cwd,
		);
		expect([xlsx.status, xlsx.pages]).toEqual(["ok", 2]);
		const text = readFileSync(join(cwd, xlsx.out), "utf-8");
		expect(text).toContain("<!-- page 1 -->\n## 表1");
		expect(text).toContain("<!-- page 2 -->\n## 表2");
		const pptx = await importFile(put("参考资料/汇报.pptx", makePptx([{ body: shape(["题目"], true) }])), cwd);
		expect([pptx.status, pptx.pages]).toEqual(["ok", 1]);
		expect(readFileSync(join(cwd, pptx.out), "utf-8")).toContain("## 题目");
	});
});
