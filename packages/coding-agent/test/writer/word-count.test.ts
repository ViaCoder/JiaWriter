// Unit tests for src/writer/word-count.ts.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import { DEFAULT_TOLERANCE, formatWordCount, wordCount } from "../../src/writer/word-count.ts";

// A small document with two sections.
const DOC = "# 标题\n导语一句。\n一、情况\n全年增长5%。\n二、问题\nAI adoption is slow.";

describe("wordCount", () => {
	it("counts the whole text and, when asked, each section", () => {
		// With sections.
		const report = wordCount(DOC, { bySection: true });
		// Whole text: 16 Han characters, 4 words, 1 number; punctuation 。、。、. without the # marker.
		expect(report.counts).toEqual({ cjk: 16, words: 4, numbers: 1, punct: 5, total: 21 });
		// Section titles and totals (heading text included).
		expect(report.sections.map((s) => [s.title, s.level, s.counts.total])).toEqual([
			["标题", 1, 6],
			["一、情况", 1, 8],
			["二、问题", 1, 7],
		]);
		// No target.
		expect(report.target).toBeUndefined();
	});
	it("compares with a target using the default or given tolerance", () => {
		// Default tolerance.
		const report = wordCount("一二三四五六七八九十", { target: 10 });
		// Exactly on target.
		expect(report.target).toEqual({ diff: 0, ratio: 0, status: "within", target: 10, tolerance: DEFAULT_TOLERANCE });
		// Too short with a tight band.
		expect(wordCount("一二三", { target: 10, tolerance: 0.05 }).target?.status).toBe("under");
		// A zero target is ignored.
		expect(wordCount("一", { target: 0 }).target).toBeUndefined();
	});
});

describe("formatWordCount", () => {
	it("writes totals, indented sections and the target line in Chinese", () => {
		// Report with everything.
		const text = formatWordCount(wordCount(DOC, { bySection: true, target: 10 }), "zh");
		// Lines.
		expect(text.split("\n")).toEqual([
			"字数统计",
			"合计 21 字（汉字 16，英文词 4，数字 1），另有标点 5 个。",
			"- 标题：6 字",
			"- 一、情况：8 字",
			"- 二、问题：7 字",
			"目标 10 字，相差 +11 字（+110%），偏长。",
		]);
	});
	it("writes the tolerance band and the lead section in English", () => {
		// Lead text without a heading, on target.
		const text = formatWordCount(wordCount("one two three", { bySection: true, target: 3 }), "en");
		// Lead section label.
		expect(text).toContain("- (before the first heading): 3");
		// Band.
		expect(text).toContain(
			"Target 3, difference 0 (0%), within the allowed range (±20%); no need to change the length.",
		);
	});
});
