// Unit tests for the times of materials (2026-11-10, the user: "The source material must include accurate timestamps";
// "if there's no date, don't write it down—and certainly don't fabricate one"): sourceOf, timeInSource,
// withSourceTimes, addMaterials and renderMaterial.

// Temp files.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Functions under test.
import {
	addMaterials,
	archivePage,
	archiveSearch,
	type Material,
	misattributedFigures,
	openTopic,
	renderMaterial,
	sourceOf,
	timeInSource,
	withSourceTimes,
} from "../../src/writer/topic/topic.ts";

// A topic folder per test.
let cwd = "";
let dir = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "jw-time-"));
	dir = openTopic(cwd, "低空经济").dir;
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// A search report as search_web writes it: numbered results, each with its address and date.
const REPORT = [
	"检索结果（deepseek，2 条）：低空经济",
	"1. 超15万家企业抢跑低空经济",
	"   https://finance.example/2025/doc-1.shtml#1（2025-12-27）",
	"   近期，国产首款800公斤级重载电动垂直起降飞行器AR-E800首飞成功。今年3月，政府工作报告再次提到低空经济。",
	"2. 另一条",
	"   https://other.example/b#2",
	"   2025年10月，某地发布方案。",
].join("\n");

describe("sourceOf", () => {
	it("finds a search result's entry and its date, and a fetched page with its own date", () => {
		archiveSearch(dir, "低空经济", REPORT, "2026-11-10 06:57", [
			"https://finance.example/2025/doc-1.shtml#1",
			"https://other.example/b#2",
		]);
		// The entry ends before the next result: its 2025年10月 is not the first one's.
		const first = sourceOf(dir, "https://finance.example/2025/doc-1.shtml#1");
		expect(first?.date).toBe("2025-12-27");
		expect(first?.text).toContain("AR-E800");
		expect(first?.text).not.toContain("2025年10月");
		// A result with no date has none.
		expect(sourceOf(dir, "https://other.example/b#2")?.date).toBe("");
		// A fetched page: its 发布日期 line.
		archivePage(
			dir,
			{ url: "https://news.example/p", title: "页", date: "2025-07-16", content: "正文" },
			"https://news.example/p",
			"sf",
			"t",
		);
		expect(sourceOf(dir, "https://news.example/p")?.date).toBe("2025-07-16");
		// A fetched page with no date of its own takes its search result's (2026-11-10, a 163.com page).
		archivePage(
			dir,
			{ url: "https://finance.example/2025/doc-1.shtml", title: "页", date: "", content: "正文" },
			"https://finance.example/2025/doc-1.shtml",
			"sf",
			"t",
		);
		const both = sourceOf(dir, "https://finance.example/2025/doc-1.shtml#1");
		expect(both?.date).toBe("2025-12-27");
		expect(both?.text).toContain("正文");
		expect(both?.text).toContain("AR-E800");
		// A result listed with an empty parameter is the same page (2026-11-10: …html?referFrom=).
		archiveSearch(dir, "乙", "1. 题\n   https://m.example/a.html?referFrom=（2025-12-03）\n   摘要", "t", [
			"https://m.example/a.html?referFrom=",
		]);
		archivePage(
			dir,
			{ url: "https://m.example/a.html", title: "a", date: "", content: "正文" },
			"https://m.example/a.html",
			"sf",
			"t",
		);
		expect(sourceOf(dir, "https://m.example/a.html")?.date).toBe("2025-12-03");
		// A parameter with a value names another page.
		expect(sourceOf(dir, "https://m.example/a.html?id=2")).toBeUndefined();
		// Nothing archived.
		expect(sourceOf(dir, "https://none.example/")).toBeUndefined();
	});
});

describe("timeInSource", () => {
	it("passes times the source writes or dates, and sends back invented ones", () => {
		const text = "近期，AR-E800首飞成功。今年3月，政府工作报告提到低空经济。2025-06-19 发布。";
		// The source's own date: the same day, or the same month.
		expect(timeInSource("2025年12月27日", text, "2025-12-27")).toBe(true);
		expect(timeInSource("2025年12月", text, "2025-12-27")).toBe(true);
		// 今年3月 in a text of 2025.
		expect(timeInSource("2025年3月", text, "2025-12-27")).toBe(true);
		// A numeric date in the text.
		expect(timeInSource("2025年6月19日", text, "")).toBe(true);
		// The year alone.
		expect(timeInSource("2025年", text, "2025-12-27")).toBe(true);
		// 近期 became 2025年10月: nowhere in the source (the 2026-11-10 run).
		expect(timeInSource("2025年10月", text, "2025-12-27")).toBe(false);
		// A day the source does not give, and a year it does not have.
		expect(timeInSource("2025年12月10日", text, "2025-12-27")).toBe(false);
		expect(timeInSource("2023年", text, "2025-12-27")).toBe(false);
		// Numbers for a date are checked the same way (2026-11-10: 2026-01-29 passed unchecked).
		expect(timeInSource("2025-06-19", text, "")).toBe(true);
		expect(timeInSource("2026-01-29", text, "2025-12-27")).toBe(false);
		expect(timeInSource("2025/12/27", text, "2025-12-27")).toBe(true);
		// Words with no date name none.
		expect(timeInSource("近期", text, "")).toBe(true);
	});
});

describe("withSourceTimes and addMaterials", () => {
	const item = (time?: string): Material => ({
		kind: "case",
		time,
		reporter: "中国经营报",
		subject: "AR-E800",
		fact: "国产首款800公斤级重载电动垂直起降飞行器AR-E800首飞成功",
		url: "https://finance.example/2025/doc-1.shtml#1",
	});

	beforeEach(() => {
		archiveSearch(dir, "低空经济", REPORT, "2026-11-10 06:57", [
			"https://finance.example/2025/doc-1.shtml#1",
			"https://other.example/b#2",
		]);
	});

	it("gives a web material with no time its source's date, and leaves it out when the source has none", () => {
		expect(withSourceTimes(dir, [item()])[0].time).toBe("2025年12月27日");
		const none = { ...item(), url: "https://other.example/b#2" };
		expect(withSourceTimes(dir, [none])[0].time).toBeUndefined();
		// A given time stays as given.
		expect(withSourceTimes(dir, [item("2025年3月")])[0].time).toBe("2025年3月");
	});

	it("sends back a time that is not in the source and writes one that is", () => {
		expect(addMaterials(dir, [item("2025年10月")]).problems.join()).toMatch(/2025年10月/);
		expect(addMaterials(dir, [item()])).toMatchObject({ total: 1, written: [1], skipped: 0, problems: [] });
		expect(readFileSync(join(dir, "素材.md"), "utf-8")).toContain(
			"时间：2025年12月27日｜报道方：中国经营报｜主体：AR-E800｜事实：国产首款800公斤级重载电动垂直起降飞行器AR-E800首飞成功｜报道日期：2025年12月27日｜来源：",
		);
		// The same fact again is skipped, not written twice.
		expect(addMaterials(dir, [item()])).toMatchObject({ total: 1, written: [], skipped: 1, problems: [] });
	});
});

describe("renderMaterial", () => {
	it("writes the source's date as 报道日期", () => {
		const line = renderMaterial(
			{ kind: "case", time: "2025年3月", subject: "国务院", fact: "国务院提出", url: "https://a.example/" },
			"2025-12-27",
		);
		expect(line).toBe(
			"- 案例｜时间：2025年3月｜主体：国务院｜事实：国务院提出｜报道日期：2025年12月27日｜来源：https://a.example/",
		);
	});

	it("leaves the time field out when there is no time", () => {
		const line = renderMaterial({
			kind: "data",
			fact: "全国低空经济企业\n达15.43万家",
			url: "https://a.example/",
		});
		// The fact on one line.
		expect(line).toBe("- 数据｜事实：全国低空经济企业 达15.43万家｜来源：https://a.example/");
	});
});

describe("misattributedFigures", () => {
	it("finds a figure cited to a dated outlet whose sources of that day do not hold it", () => {
		archiveSearch(dir, "低空经济", REPORT, "2026-11-10 06:57", [
			"https://finance.example/2025/doc-1.shtml#1",
			"https://other.example/b#2",
		]);
		archiveSearch(
			dir,
			"乙",
			"1. 题\n   https://c114.example/a.html（2026-02-03）\n   已有30个省市将低空经济纳入政府工作报告",
			"t",
			["https://c114.example/a.html"],
		);
		// The figure is in a source of another day (2026-11-10: a C114 figure cited to 证券时报网).
		const wrong = "据2026年1月29日《证券时报网》报道，全国已有30个省市将低空经济纳入政府工作报告。";
		expect(misattributedFigures(wrong, dir)).toEqual([wrong.slice(0, 60)]);
		// The same figure cited to its own source's day; a document's date; a sentence with no figure.
		expect(
			misattributedFigures("据2026年2月3日《C114通信网》报道，已有30个省市将低空经济纳入政府工作报告。", dir),
		).toEqual([]);
		expect(misattributedFigures("2025年12月22日《低空经济统计分类》印发，涵盖4个大类。", dir)).toEqual([]);
		expect(misattributedFigures("据2026年1月29日《证券时报网》报道，低空经济加快发展。", dir)).toEqual([]);
	});
});
