// Unit tests for src/writer/export/blocks.ts.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import { parseBlocks, parseInline, punctMarkdown } from "../../src/writer/export/blocks.ts";

describe("parseInline", () => {
	it("keeps bold, writes links as 文本（URL） with the URL linked, drops other marks and keeps an unclosed **", () => {
		// Bold, link, emphasis, code.
		expect(parseInline("前**重点**后，见[通知](https://a.example/n)，*斜体*与`代码`")).toEqual([
			{ text: "前", bold: false },
			{ text: "重点", bold: true },
			{ text: "后，见通知（", bold: false },
			{ text: "https://a.example/n", bold: false, link: "https://a.example/n" },
			{ text: "），斜体与代码", bold: false },
		]);
		// A link whose label is its URL, and an unclosed **.
		expect(parseInline("[https://a.example](https://a.example) a**b")).toEqual([
			{ text: "https://a.example", bold: false, link: "https://a.example" },
			{ text: " a**b", bold: false },
		]);
	});

	it("links bare URLs, leaving a sentence mark after them as text", () => {
		// The final ASCII stop belongs to the sentence; a bold URL stays bold.
		expect(parseInline("见https://a.example/x?q=1. 与**https://b.example**")).toEqual([
			{ text: "见", bold: false },
			{ text: "https://a.example/x?q=1", bold: false, link: "https://a.example/x?q=1" },
			{ text: ". 与", bold: false },
			{ text: "https://b.example", bold: true, link: "https://b.example" },
		]);
	});
});

describe("parseBlocks", () => {
	it("reads title, heading levels, joined paragraphs, list items, tables and code", () => {
		// A small draft.
		const md = [
			"# 标题",
			"",
			"## 一、背景",
			"第一行",
			"第二行",
			"English line",
			"next line",
			"",
			"### （一）情况",
			"#### 1.细节",
			"##### 更深",
			"> 引文",
			"",
			"- 要点",
			"2) 第二项",
			"",
			"| 指标 | 数值 |",
			"|---|:---:|",
			"| 产值 | 5 |",
			"",
			"```",
			"a, b",
			"```",
			"---",
		].join("\n");
		expect(parseBlocks(md)).toEqual([
			{ kind: "title", spans: [{ text: "标题", bold: false }] },
			{ kind: "h1", spans: [{ text: "一、背景", bold: false }] },
			{ kind: "para", spans: [{ text: "第一行第二行English line next line", bold: false }] },
			{ kind: "h2", spans: [{ text: "（一）情况", bold: false }] },
			{ kind: "h3", spans: [{ text: "1.细节", bold: false }] },
			{ kind: "h3", spans: [{ text: "更深", bold: false }] },
			{ kind: "para", spans: [{ text: "引文", bold: false }] },
			{ kind: "item", marker: "", spans: [{ text: "要点", bold: false }] },
			{ kind: "item", marker: "2．", spans: [{ text: "第二项", bold: false }] },
			{
				kind: "table",
				rows: [
					["指标", "数值"],
					["产值", "5"],
				],
			},
			{ kind: "code", lines: ["a, b"] },
		]);
	});
	it("runs the fix function on text but never on code", () => {
		// Upper-casing stands in for the punctuation pass.
		const up = (s: string) => s.toUpperCase();
		expect(parseBlocks("# a\n\nb\n\n- c\n\n| d |\n|---|\n\n```\ne\n```", up)).toEqual([
			{ kind: "title", spans: [{ text: "A", bold: false }] },
			{ kind: "para", spans: [{ text: "B", bold: false }] },
			{ kind: "item", marker: "", spans: [{ text: "C", bold: false }] },
			{ kind: "table", rows: [["D"]] },
			{ kind: "code", lines: ["e"] },
		]);
	});
});

describe("punctMarkdown", () => {
	it("fixes text after block marks and per table cell, and leaves code and rules alone", () => {
		// Marks stay, text is fixed.
		const up = (s: string) => s.toUpperCase();
		expect(punctMarkdown("## a\n- b\n1. c\n> d\n| e | f |\n|---|---|\n```\ng\n```\n\nh", up)).toBe(
			"## A\n- B\n1. C\n> D\n| E | F |\n|---|---|\n```\ng\n```\n\nH",
		);
	});
});
