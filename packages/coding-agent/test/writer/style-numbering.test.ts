// Numbering in documents (src/writer/style/numbering.ts): 一、 then （一）, no 一是/一要 (the user, 2026-11-08).
import { describe, expect, it } from "vitest";
import { headingIssues, listMarkers, plainHeadings } from "../../src/writer/style/numbering.ts";

describe("plainHeadings", () => {
	it("finds numbered lines and a bare references label written without heading marks (l12, 2026-11-17)", () => {
		const text = [
			"# 报告",
			"",
			"## 一、发展现状",
			"",
			"国家政策框架已经建立。",
			"",
			"（一）政策框架",
			"",
			"中央文件构成顶层设计。",
			"",
			"二、主要问题",
			"",
			"参考文献",
			"",
			"[1] 某文件，2025年1月3日。",
		].join("\n");
		expect(plainHeadings(text)).toEqual([
			{ quote: "（一）政策框架", form: "### （一）政策框架" },
			{ quote: "二、主要问题", form: "## 二、主要问题" },
			{ quote: "参考文献", form: "## 参考文献" },
		]);
	});

	it("leaves sentences, headings with marks, list items and long lines alone", () => {
		const text = [
			"### （一）政策框架",
			"（一）政策框架已经建立，各地陆续出台配套文件。",
			"一、二、三级网络覆盖全市。",
			"- 一、要点",
			"1. 参考文献见后",
			"（二）" + "字".repeat(31),
			"```",
			"（三）代码里的行",
			"```",
		].join("\n");
		expect(plainHeadings(text)).toEqual([]);
	});
});

describe("headingIssues", () => {
	it("passes headings numbered for their level, and the title", () => {
		const text = "# 关于禁渔的调研报告\n\n## 一、主要成效\n\n### （一）水质改善\n\n#### 1. 干流\n\n##### （1）上游";
		expect(headingIssues(text)).toEqual([]);
	});
	it("gives each wrong or missing number the right one, keeping the words", () => {
		const text = "## 1、主要成效\n### 一、水质改善\n## 存在问题\n### (二)渔民安置\n## 第三部分 对策建议";
		expect(headingIssues(text)).toEqual([
			{ quote: "## 1、主要成效", form: "## 一、主要成效" },
			{ quote: "### 一、水质改善", form: "### （一）水质改善" },
			{ quote: "## 存在问题", form: "## 一、存在问题" },
			{ quote: "### (二)渔民安置", form: "### （一）渔民安置" },
			{ quote: "## 第三部分 对策建议", form: "## 一、对策建议" },
		]);
	});
});

describe("headingIssues and the references", () => {
	it("leaves the references heading unnumbered", () => {
		// 2026-11-09: the check asked for 三、参考文献.
		expect(headingIssues("## 一、基本情况\n\n正文。\n\n## 参考文献\n\n- 《材料》")).toEqual([]);
	});
});

describe("listMarkers", () => {
	it("finds ordinal markers at the start of a sentence or clause, once each", () => {
		const text = "一是加强领导。二是完善机制；三是强化保障。主要做法，一是建台账。其一，摸清底数。一要压实责任。";
		expect(listMarkers(text)).toEqual(["一是", "二是", "三是", "其一，", "一要"]);
	});
	it("leaves words that only contain the characters alone", () => {
		expect(listMarkers("全市统一是关键。他说一不二。要统一要求。")).toEqual([]);
	});
});
