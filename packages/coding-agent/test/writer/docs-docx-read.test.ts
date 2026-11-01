// Unit tests for src/writer/docs/docx-read.ts.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import { decodeXml, docxToPages, headingStyles } from "../../src/writer/docs/docx-read.ts";
// Fixtures.
import { makeDocx, wp } from "./doc-fixtures.ts";

// Styles: a localized heading 1 (id "1"), Title, and a custom style with an outline level.
const STYLES =
	'<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>' +
	'<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>' +
	'<w:style w:type="paragraph" w:styleId="MyH"><w:name w:val="我的标题"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>' +
	'<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
	'<w:style w:type="character" w:styleId="Strong"><w:name w:val="heading 2"/></w:style>';

describe("decodeXml", () => {
	it("decodes named and numeric entities, &amp; last", () => {
		// All forms.
		expect(decodeXml("&lt;a&gt; &quot;x&quot; &apos;y&apos; &#20013;&#x6587; &amp;lt;")).toBe(
			"<a> \"x\" 'y' 中文 &lt;",
		);
	});
});

describe("headingStyles", () => {
	it("maps heading N, Title and outline levels of paragraph styles only", () => {
		// Character styles and plain styles are left out.
		expect([...headingStyles(STYLES)]).toEqual([
			["1", 1],
			["Title", 1],
			["MyH", 2],
		]);
		expect(headingStyles("").size).toBe(0);
	});
});

describe("docxToPages", () => {
	it("reads headings, paragraphs, tables and recorded page breaks; skips field codes and deletions", () => {
		// Two pages: a styled title and heading, a body with a tab and a field code, a table, a page break, a deleted run.
		const body =
			wp("总体报告", "Title") +
			wp("一、背景", "1") +
			"<w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:tab/><w:t>正文</w:t></w:r><w:r><w:instrText> PAGE </w:instrText></w:r></w:p>" +
			"<w:tbl><w:tr><w:tc>" +
			wp("指标") +
			"</w:tc><w:tc>" +
			wp("数值") +
			"</w:tc></w:tr>" +
			"<w:tr><w:tc>" +
			wp("产值") +
			"</w:tc><w:tc>" +
			wp("1|2") +
			"</w:tc></w:tr></w:tbl>" +
			"<w:p><w:r><w:lastRenderedPageBreak/><w:t>第二页</w:t></w:r><w:r><w:delText>删掉的</w:delText></w:r></w:p>" +
			'<w:p><w:pPr><w:pStyle w:val="MyH"/></w:pPr><w:r><w:t>（一）细节</w:t></w:r></w:p>' +
			'<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>直接设大纲级别</w:t></w:r></w:p>';
		const pages = docxToPages(makeDocx(body, STYLES));
		// Page 1 and page 2.
		expect(pages).toEqual([
			"# 总体报告\n\n# 一、背景\n\n第一段 正文\n\n| 指标 | 数值 |\n| --- | --- |\n| 产值 | 1\\|2 |",
			"第二页\n\n## （一）细节\n\n### 直接设大纲级别",
		]);
	});
	it("puts everything on one page when Word recorded no breaks, and rejects a file without a body", () => {
		// No styles part at all.
		expect(docxToPages(makeDocx(wp("甲") + wp("乙")))).toEqual(["甲\n\n乙"]);
		// A zip without word/document.xml.
		expect(() => docxToPages(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))).toThrow(
			/document\.xml/,
		);
	});
});
