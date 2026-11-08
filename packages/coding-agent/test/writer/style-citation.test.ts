// The form of citations (src/writer/style/citation.ts): xx年xx月xx日《xx》报道 (the user, 2026-11-08).
import { describe, expect, it } from "vitest";
import { citationIssues, formatCitationIssues } from "../../src/writer/style/citation.ts";

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
