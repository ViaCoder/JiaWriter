// Unit tests for src/writer/export/punct.ts (the plan's punctuation regression cases).

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import { countAsciiNextToHan, normalizePunct, pairQuotes } from "../../src/writer/export/punct.ts";

// Text only.
const p = (s: string) => normalizePunct(s).text;

describe("normalizePunct", () => {
	it("turns ASCII punctuation into Chinese punctuation, also between English terms", () => {
		// Commas between English terms, colon, question mark, brackets, final stop.
		expect(p("支持 5G, Wi-Fi 和 NB-IoT.")).toBe("支持 5G，Wi-Fi 和 NB-IoT。");
		expect(p("问题: 为什么? (见附件)")).toBe("问题：为什么？（见附件）");
		expect(p("He said: AI is useful. Then he left.")).toBe("He said：AI is useful。Then he left。");
		expect(p("等等...")).toBe("等等……");
	});
	it("turns a dash between Chinese characters into —, and keeps it elsewhere", () => {
		// -, – and -- between Chinese characters.
		expect(p("北京-上海")).toBe("北京—上海");
		expect(p("北京 – 上海")).toBe("北京—上海");
		expect(p("北京--上海")).toBe("北京—上海");
		// Terms, versions and ranges keep their hyphen.
		expect(p("Wi-Fi、NB-IoT、gpt-5.4、2020-2025")).toBe("Wi-Fi、NB-IoT、gpt-5.4、2020-2025");
	});
	it("keeps numbers, times, versions, URLs, e-mail, code, links and abbreviations", () => {
		// Each protected kind.
		expect(p("共 1,000 人，占 18.7%，π 约 3.14，10:30 开会.")).toBe("共 1,000 人，占 18.7%，π 约 3.14，10:30 开会。");
		expect(p("见 https://example.com/a,b?x=1 和 a.b@example.com.")).toBe(
			"见 https://example.com/a,b?x=1 和 a.b@example.com。",
		);
		expect(p("运行 `f(x, y)` 后, 见 [说明](https://example.com/doc).")).toBe(
			"运行 `f(x, y)` 后，见 [说明](https://example.com/doc)。",
		);
		expect(p("U.S. policy, e.g. tariffs, don't change.")).toBe("U.S. policy，e.g. tariffs，don't change。");
		expect(p("v1.2.3 发布.")).toBe("v1.2.3 发布。");
	});
	it("writes a leading list number with the full-width stop", () => {
		// 1. → 1．
		expect(p("1. 背景")).toBe("1．背景");
		expect(p("12.总体要求")).toBe("12．总体要求");
	});
	it("pairs quotes per paragraph, nested, and reports an unpaired one without flipping the rest", () => {
		// Straight double quotes with a nested single quote.
		expect(p("他说\"这是'试点'工作\"。")).toBe("他说“这是‘试点’工作”。");
		// English quotation inside Chinese text.
		expect(p('报告称"growth is slowing".')).toBe("报告称“growth is slowing”。");
		// Unpaired: reported, and the next paragraph is unaffected.
		const bad = normalizePunct('他说"开始');
		expect(bad.text).toBe("他说“开始");
		expect(bad.unpaired).toEqual([2]);
		expect(normalizePunct('下一段"正常"。')).toEqual({ text: "下一段“正常”。", unpaired: [] });
		// A stray closing quote.
		expect(normalizePunct("结束”了").unpaired).toEqual([2]);
	});
});

describe("pairQuotes", () => {
	it("alternates by level and counts what is left open", () => {
		// Two pairs, then one open quote.
		expect(pairQuotes('"a" "b" "c')).toEqual({ text: "“a” “b” “c", unpairedCount: 1 });
		// Curly quotes are kept in place.
		expect(pairQuotes("“a”")).toEqual({ text: "“a”", unpairedCount: 0 });
	});
});

describe("countAsciiNextToHan", () => {
	it("counts ASCII marks touching a Chinese character only", () => {
		// Two hits; the decimal point and the URL do not count.
		expect(countAsciiNextToHan("中文,English 3.5 见https://a.example 结束.")).toBe(2);
		expect(countAsciiNextToHan("全部中文标点，没有问题。")).toBe(0);
	});
});
