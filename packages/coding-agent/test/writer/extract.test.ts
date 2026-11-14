// Unit tests for src/writer/topic/extract.ts: the extraction request, the fact lines read back, and the check of each
// fact against its source.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import {
	comparable,
	EXTRACT_REASONING_TOKENS,
	extractInstructions,
	extractRequest,
	factProblem,
	MAX_EXTRACT_CHARS,
	MAX_FACT,
	MAX_FACTS,
	parseFacts,
} from "../../src/writer/topic/extract.ts";

describe("extractInstructions / extractRequest", () => {
	it("asks for fact lines in the two forms, figures as the source gives them, and a small budget", () => {
		const text = extractInstructions();
		expect(text).toContain("案例｜时间：<time>｜主体：");
		expect(text).toContain("数据｜时间：<time>｜事实：");
		expect(text).toContain("never infer one");
		expect(text).toContain(`at most ${MAX_FACTS} lines`);
		expect(EXTRACT_REASONING_TOKENS).toBeLessThanOrEqual(1024);
	});

	it("gives the source's text without the archive's head lines, bounded, then what is needed and for which part", () => {
		const page =
			"# 标题\n\n网址：https://a.example/x\n发布日期：2026-01-14\n抓取方式：firecrawl\n抓取时间：2026-11-14 10:00\n\n---\n\n正文。";
		const request = extractRequest(page, "大众在华销量", "一、现状");
		expect(request).toContain("发布日期：2026-01-14");
		expect(request).not.toContain("抓取时间");
		expect(request).not.toContain("网址：");
		expect(request).toContain("需要的内容：大众在华销量");
		expect(request).toContain("用于：一、现状");
		// Nothing asked: the section's facts; no section: the whole document.
		expect(extractRequest("正文。", "", "")).toContain("需要的内容：与下面这一节有关的事实和数据\n\n用于：全文");
		// A long page is cut.
		const long = extractRequest("字".repeat(MAX_EXTRACT_CHARS + 100), "", "");
		expect(long).toContain("（后文略）");
		expect(long.length).toBeLessThan(MAX_EXTRACT_CHARS + 200);
	});
});

describe("parseFacts", () => {
	it("reads the two forms, with list marks, ASCII separators and a code fence tolerated", () => {
		const reply = [
			"```",
			"案例｜时间：2026年1月14日｜主体：大众汽车｜事实：2025年在华销量下降10%，为260万辆。",
			"- 数据 | 时间: 2025年 | 事实: 欧洲电动汽车销量增长15%",
			"1. 数据｜时间：｜事实：Stellantis计划2026年推出3款车型",
			"随口说的一句话",
			"案例｜时间：无｜主体：｜事实：欧盟对中国电动汽车加征关税",
			"```",
		].join("\n");
		expect(parseFacts(reply)).toEqual([
			{ kind: "case", time: "2026年1月14日", subject: "大众汽车", fact: "2025年在华销量下降10%，为260万辆" },
			{ kind: "data", time: "2025年", fact: "欧洲电动汽车销量增长15%" },
			{ kind: "data", fact: "Stellantis计划2026年推出3款车型" },
			// A 案例 line without a subject is a data line; 无 is no time.
			{ kind: "data", fact: "欧盟对中国电动汽车加征关税" },
		]);
		expect(parseFacts("")).toEqual([]);
		// At most MAX_FACTS.
		const many = Array.from({ length: MAX_FACTS + 5 }, (_, i) => `数据｜时间：｜事实：第${i}条`).join("\n");
		expect(parseFacts(many)).toHaveLength(MAX_FACTS);
	});
});

describe("factProblem / comparable", () => {
	const source =
		"Volkswagen said on January 14, 2026 that its China deliveries fell 10% to 2.6 million vehicles in 2025. " +
		"Stellantis CEO Antonio Filosa said the group would launch three models. 欧盟委员会称关税为 35.3%，涉及 1,267 家企业。";

	it("passes a fact whose numbers and Latin words are in the source, at any power of ten", () => {
		expect(factProblem("大众汽车2025年在华销量下降10%，为260万辆", source)).toBe("");
		expect(factProblem("Stellantis首席执行官Antonio Filosa表示将推出3款车型", source)).toBe("");
		expect(factProblem("欧盟关税为35.3%，涉及1267家企业", source)).toBe("");
		// 2.6 million as 2600000 too.
		expect(factProblem("在华交付2600000辆", source)).toBe("");
	});

	it("names the number or word the source does not hold, and a fact too long", () => {
		expect(factProblem("大众汽车2025年在华销量下降12%", source)).toBe("数字 12 不在来源里");
		expect(factProblem("在华销量为280万辆", source)).toBe("数字 280 不在来源里");
		expect(factProblem("Renault计划推出3款车型", source)).toBe("“Renault” 不在来源里");
		// Two-letter words (AI, EU) and a Chinese transliteration are not checked.
		expect(factProblem("EU关税为35.3%", source)).toBe("");
		expect(factProblem("雷诺计划推出3款车型", source)).toBe("");
		expect(factProblem("字".repeat(MAX_FACT + 1), source)).toContain(`超过 ${MAX_FACT} 字`);
	});

	it("comparable: folds width, case, spaces and marks", () => {
		expect(comparable("ＡＢＣ 12 “一二”")).toBe("abc12一二");
		expect(comparable("**粗体** `码`")).toBe("粗体码");
	});
});
