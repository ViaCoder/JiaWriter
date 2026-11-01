// Unit tests for src/writer/text-stats.ts.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import {
	compareTarget,
	countText,
	headingOf,
	lineColumn,
	splitSections,
	splitSentences,
} from "../../src/writer/text-stats.ts";

describe("lineColumn", () => {
	it("counts lines and columns from 1", () => {
		// Two lines.
		const text = "第一行\n第二行";
		// Start of the text.
		expect(lineColumn(text, 0)).toEqual({ line: 1, column: 1 });
		// Third character of line 2.
		expect(lineColumn(text, 6)).toEqual({ line: 2, column: 3 });
	});
});

describe("splitSentences", () => {
	it("splits at Chinese and English end marks and line breaks, keeping closing quotes", () => {
		// Mixed text.
		const text = "他说：“好。”随后离开！Prices rose 3.5% in May. Costs fell\n第二段没有句号";
		// Sentence texts.
		expect(splitSentences(text).map((s) => s.text)).toEqual([
			"他说：“好。”",
			"随后离开！",
			"Prices rose 3.5% in May.",
			"Costs fell",
			"第二段没有句号",
		]);
	});
	it("records where each sentence starts and skips empty pieces", () => {
		// Leading spaces and a lone mark.
		const sentences = splitSentences("  甲。。\n\n乙？");
		// Two sentences.
		expect(sentences.map((s) => [s.text, s.start])).toEqual([
			["甲。。", 2],
			["乙？", 7],
		]);
	});
});

describe("countText", () => {
	it("counts characters, words, numbers and punctuation", () => {
		// Mixed text.
		const c = countText("支持 Wi-Fi 和 5G，覆盖率达 18.5%。");
		// Han: 支持和覆盖率达 = 7; words: Wi-Fi, G; numbers: 5, 18.5%; punctuation: ，。 only.
		expect(c).toEqual({ cjk: 7, words: 2, numbers: 2, punct: 2, total: 11 });
	});
	it("leaves Markdown markers out of the punctuation count", () => {
		// Heading, bullet, quote and bold markers around 4 Han characters and one 。.
		expect(countText("## 标题\n- **重点**\n> 引文。").punct).toBe(1);
	});
	it("returns zeros for empty text", () => {
		// Nothing.
		expect(countText("")).toEqual({ cjk: 0, words: 0, numbers: 0, punct: 0, total: 0 });
	});
});

describe("headingOf", () => {
	it("recognizes Markdown, 一、 and （一） headings", () => {
		// Markdown.
		expect(headingOf("## 二、主要问题")).toEqual({ level: 2, title: "二、主要问题" });
		// Chinese level 1.
		expect(headingOf("一、总体情况")).toEqual({ level: 1, title: "一、总体情况" });
		// Chinese level 2, half-width brackets too.
		expect(headingOf("(三)下一步打算")).toEqual({ level: 2, title: "(三)下一步打算" });
	});
	it("treats sentences and long numbered paragraphs as body text", () => {
		// Ends with a full stop.
		expect(headingOf("一、全年完成投资12亿元。")).toBeUndefined();
		// Ordinary line.
		expect(headingOf("今年以来，全市经济平稳。")).toBeUndefined();
		// Over 40 characters after 一、.
		expect(headingOf(`一、${"很".repeat(41)}`)).toBeUndefined();
	});
});

describe("splitSections", () => {
	it("splits at headings and keeps a non-empty lead section", () => {
		// Lead text plus two sections.
		const sections = splitSections("导语\n# 标题\n正文一\n一、小节\n正文二");
		// Titles, levels, lines and bodies.
		expect(sections).toEqual([
			{ title: "", level: 0, line: 1, text: "导语" },
			{ title: "标题", level: 1, line: 2, text: "正文一" },
			{ title: "一、小节", level: 1, line: 4, text: "正文二" },
		]);
	});
	it("drops an empty lead section", () => {
		// Starts with a heading.
		expect(splitSections("# 甲\n乙").map((s) => s.title)).toEqual(["甲"]);
	});
});

describe("compareTarget", () => {
	it("reports within, over and under", () => {
		// 5% over a 10% band.
		expect(compareTarget(1050, 1000, 0.1)).toEqual({ diff: 50, ratio: 0.05, status: "within" });
		// 20% over.
		expect(compareTarget(1200, 1000, 0.1).status).toBe("over");
		// 20% under.
		expect(compareTarget(800, 1000, 0.1).status).toBe("under");
	});
	it("handles a zero target", () => {
		// Ratio 0, so within.
		expect(compareTarget(10, 0, 0.1)).toEqual({ diff: 10, ratio: 0, status: "within" });
	});
});
