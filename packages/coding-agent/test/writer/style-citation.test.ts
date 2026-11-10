// The form of citations (src/writer/style/citation.ts): xx年xx月xx日《xx》报道 (the user, 2026-11-08).
import { describe, expect, it } from "vitest";
import {
	citationIssues,
	formatCitationIssues,
	isOutletName,
	numberedCitations,
} from "../../src/writer/style/citation.ts";

describe("citationIssues", () => {
	it("passes the forms the user asked for", () => {
		expect(citationIssues("2026年11月7日《路透社》报道，俄方代表团将参加谈判。")).toEqual([]);
		expect(
			citationIssues("据2021年6月7日《国务院关于长江流域生态环境保护工作情况的报告》，退捕渔船11万艘。"),
		).toEqual([]);
	});
	it("finds an outlet after a date without book-title marks, with or without the year", () => {
		expect(citationIssues("11月7日，路透社称俄方将派员参加。")).toEqual([
			{ quote: "11月7日，路透社", form: "YYYY年11月7日《路透社》报道" },
		]);
		expect(citationIssues("2026年10月31日新华网报道，……")).toEqual([
			{ quote: "2026年10月31日新华网", form: "2026年10月31日《新华网》报道" },
		]);
	});
	it("finds a date without its year before book-title marks, and a date put after the title", () => {
		expect(citationIssues("11月7日《路透社》报道，……")).toEqual([
			{ quote: "11月7日《路透社》", form: "YYYY年11月7日《路透社》" },
		]);
		expect(citationIssues("依据《国务院关于长江流域生态环境保护工作情况的报告》（2021年6月7日），……")).toEqual([
			{
				quote: "《国务院关于长江流域生态环境保护工作情况的报告》（2021年6月7日）",
				form: "2021年6月7日《国务院关于长江流域生态环境保护工作情况的报告》",
			},
		]);
		// With the word for the text between title and date (2026-11-10, a research report).
		expect(
			citationIssues("据大河财立方《低空经济产业发展的政策演进与实践案例》一文（2025年4月9日）梳理，……"),
		).toEqual([
			{
				quote: "《低空经济产业发展的政策演进与实践案例》一文（2025年4月9日）",
				form: "2025年4月9日《低空经济产业发展的政策演进与实践案例》一文",
			},
		]);
	});
	it("leaves dates that cite nothing alone", () => {
		const plain = [
			"临江市人民政府办公室\n2026年5月6日",
			"（——2021年6月7日在第十三届全国人民代表大会常务委员会第二十九次会议上）",
			"调研组于3月12日至15日走访了3个乡镇。",
			"本办法自2019年1月1日起施行。市住房城乡建设局负责解释。",
		];
		for (const text of plain) expect(citationIssues(text)).toEqual([]);
	});
});

describe("formatCitationIssues", () => {
	it("gives one line per issue with its right form", () => {
		expect(formatCitationIssues([{ quote: "11月7日，路透社", form: "YYYY年11月7日《路透社》报道" }])).toBe(
			"- “11月7日，路透社” → YYYY年11月7日《路透社》报道",
		);
	});
});

describe("citationIssues: outlet before the date, and in brackets", () => {
	it("finds them and gives the user's form", () => {
		// A 2026-11-09 research brief wrote these.
		const found = citationIssues(
			"据路透社2026年11月6日报道，油价重挫。WTI报90.83美元（路透社，11月6日）。彭博社11月7日调查显示，产量增加。",
		);
		expect(found.map((f) => f.form)).toEqual([
			"2026年11月6日《路透社》报道",
			"YYYY年11月6日《路透社》报道",
			"YYYY年11月7日《彭博社》",
		]);
		// The user's own form is not flagged.
		expect(citationIssues("2026年11月6日《路透社》报道，油价重挫。")).toEqual([]);
	});
});

describe("citationIssues: a bracketed source with no date", () => {
	it("asks for the date in the user's form", () => {
		expect(citationIssues("产销1649万辆（来源：央广网援引中汽协）。").map((f) => f.form)).toEqual([
			"YYYY年MM月DD日《央广网》报道",
		]);
		// A dated source in the user's form stays.
		expect(citationIssues("2026年1月14日《央广网》报道，产销1649万辆。")).toEqual([]);
	});
});

describe("citationIssues: outlets named 新闻, 周刊 or 杂志", () => {
	it("takes them for outlets", () => {
		expect(citationIssues("2026年11月7日CBS新闻报道，油轮遇袭。").map((f) => f.form)).toEqual([
			"2026年11月7日《CBS新闻》报道",
		]);
	});
});

describe("citationIssues: an outlet with no date", () => {
	it("finds it in the body and gives the user's form", () => {
		// A 2026-11-08 research brief wrote the first one.
		expect(citationIssues("伊朗称三艘油轮遇袭，路透社援引澳新银行称通行量不足六成。")).toEqual([
			{ quote: "路透社", form: "YYYY年MM月DD日《路透社》", undated: true },
		]);
		expect(citationIssues("据新华社报道，谈判将于下周举行。")).toEqual([
			{ quote: "据新华社报道", form: "YYYY年MM月DD日《新华社》报道", undated: true },
		]);
		// Words before 据 are not the outlet's name.
		expect(citationIssues("但据路透社援引消息人士称，……")).toEqual([
			{ quote: "据路透社", form: "YYYY年MM月DD日《路透社》", undated: true },
		]);
	});
	it("leaves generic words, dated forms, open source brackets and reference entries to other rules", () => {
		expect(citationIssues("相关新闻报道显示，本报报道后，各地电视台报道了此事。")).toEqual([]);
		expect(citationIssues("11月7日，据路透社报道，……").map((f) => f.quote)).toEqual(["11月7日，据路透社"]);
		expect(citationIssues("销量翻倍（来源：央视网援引中汽协）。")).toHaveLength(1);
		expect(
			citationIssues("正文。\n\n## 参考文献\n\n[油价周报，Rigzone刊发彭博社报道，2026-11-05](https://example.com)"),
		).toEqual([]);
	});
});

describe("citationIssues: a month with no day, and 刊文", () => {
	it("asks for the day and for book-title marks", () => {
		// 2026-11-09, a research report.
		expect(citationIssues("机队规模增长（2025年5月《中国民航报》）。")).toEqual([
			{ quote: "2025年5月《中国民航报》", form: "2025年5月DD日《中国民航报》", undated: true },
		]);
		expect(citationIssues("据统计（2025年11月11日求是网刊文）。").map((i) => i.form)).toEqual([
			"2025年11月11日《求是网》报道",
		]);
		expect(citationIssues("2026年11月6日《路透社》报道，油价下跌。")).toEqual([]);
	});
});

// 2026-11-09, a research report: 据《中国经济时报》报道 three times, with no date.
describe("citationIssues: book-title marks with no date", () => {
	it("asks for the date, and leaves dated ones and documents alone", () => {
		expect(citationIssues("据《中国经济时报》报道，核心零部件仍有瓶颈。")).toEqual([
			{ quote: "据《中国经济时报》报道", form: "YYYY年MM月DD日《中国经济时报》报道", undated: true },
		]);
		expect(citationIssues("2026年8月21日《中国经济时报》报道，核心零部件仍有瓶颈。")).toEqual([]);
		expect(citationIssues("按照《关于加快场景培育的实施意见》的要求推进。")).toEqual([]);
	});
});

// 2026-11-10, a research report: an outlet that carried an article, with no date.
describe("citationIssues: 《outlet》刊发", () => {
	it("flags an outlet that carried an article undated, not a dated one or a document", () => {
		expect(citationIssues("《21世纪经济报道》刊发的《低空经济下半场》一文披露，广东企业超1.5万家。")).toEqual([
			{ quote: "《21世纪经济报道》刊发", form: "YYYY年MM月DD日《21世纪经济报道》刊发", undated: true },
		]);
		expect(citationIssues("2026年7月3日《21世纪经济报道》刊发的文章披露，广东企业超1.5万家。")).toEqual([]);
		expect(citationIssues("《关于促进低空经济发展的意见》发表后，各地相继出台措施。")).toEqual([]);
	});
});

describe("numberedCitations", () => {
	it("finds a report's citations by number, not a paper's in GB/T 7714 or the user's form", () => {
		// A research report of 2026-11-10: numbers in the text, web pages in the references.
		const report =
			"# 我国低空经济发展研究报告\n\n据中国民航局预测，市场规模将达1.5万亿元[1]。标准规范仍不统一[6][7]。\n\n## 参考文献\n\n[1] [逐空而上，新华网，2025-12-22](https://www.news.cn/x.html)\n";
		expect(numberedCitations(report)).toEqual([
			"据中国民航局预测，市场规模将达1.5万亿元[1]",
			"标准规范仍不统一[6][7]",
		]);
		// An academic paper: its references are GB/T 7714.
		const paper =
			"# 论文\n\n已有研究指出[1]。\n\n## 参考文献\n\n[1] 张三. 低空经济研究[J]. 经济研究, 2025(3): 1-10.\n";
		expect(numberedCitations(paper)).toEqual([]);
		// The user's form.
		expect(numberedCitations("# 报告\n\n据2025年12月22日《新华网》报道，规模达1.5万亿元。\n")).toEqual([]);
	});
});

describe("isOutletName", () => {
	it("tells an outlet from a document", () => {
		for (const name of ["证券时报网", "新华社", "广州日报", "法治网", "中央电视台"])
			expect(isOutletName(name)).toBe(true);
		for (const name of ["低空经济数据治理研究报告", "低空经济及其核心产业统计分类（试行）", "相关报道"])
			expect(isOutletName(name)).toBe(false);
	});
});
