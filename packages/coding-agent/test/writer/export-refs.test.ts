// Unit tests for src/writer/export/refs.ts: the reference list of a draft and the URLs a session opened.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import {
	checkEntry,
	checkReferences,
	normalizeUrl,
	openedUrls,
	referenceEntries,
	splitEntry,
	unopenedUrls,
	entryNames,
	uncitedReferences,
} from "../../src/writer/export/refs.ts";

describe("normalizeUrl", () => {
	it("compares URLs by host without www., path without the trailing slash and query; refuses non-web URLs", () => {
		// Same page, written two ways.
		expect(normalizeUrl("https://WWW.Example.com/a/b/#top")).toBe("example.com/a/b");
		expect(normalizeUrl("http://example.com/a/b?x=1.")).toBe("example.com/a/b?x=1");
		// No http(s), no dotted host, no URL.
		expect([
			normalizeUrl("ftp://example.com/a"),
			normalizeUrl("https://localhost/a"),
			normalizeUrl("见网页"),
		]).toEqual(["", "", ""]);
	});
});

describe("referenceEntries", () => {
	it("reads the entries under a references heading or label line, up to the next heading of its level", () => {
		// A heading section with a sub-heading, then a later section; a label-line section at the end.
		const md =
			"# 题\n\n正文。\n\n## 五、参考文献\n\n1. 甲\n\n### 网络资料\n\n- 乙\n\n## 附录\n\n丙\n\n**资料来源：**\n\n丁\n```\n戊\n```\n";
		expect(referenceEntries(md)).toEqual(["1. 甲", "- 乙", "丁"]);
		// No section, no entries.
		expect(referenceEntries("# 题\n\n正文。")).toEqual([]);
	});
});

describe("splitEntry", () => {
	it("takes the URLs out and keeps the link labels as the entry's text", () => {
		// A Markdown link and a bare URL with a final stop.
		expect(splitEntry("1. [报道](https://a.example/n)，又见https://b.example/x.")).toEqual({
			urls: ["https://a.example/n", "https://b.example/x"],
			text: "1.  报道 ，又见 ",
		});
	});
});

describe("checkEntry", () => {
	it("reports a missing URL, a missing or generic title, and a URL the session did not open", () => {
		// Opened in the session.
		const opened = new Set(["example.com/b"]);
		expect(checkEntry("1. [新华社：某项报道，2026年11月1日](https://example.com/b)", opened)).toEqual([]);
		expect(checkEntry("2. 某机构年度报告", opened)).toEqual(["url"]);
		expect(checkEntry("3. [链接](https://example.com/b)", opened)).toEqual(["title"]);
		expect(checkEntry("4. https://example.com/c", opened)).toEqual(["title", "opened"]);
		// Without session data the opened check is skipped.
		expect(checkEntry("5. Reuters: Markets rally, 2026-11-01 https://example.com/c")).toEqual([]);
	});
});

describe("checkReferences / unopenedUrls", () => {
	it("checks every entry and lists the URLs still to open, once each", () => {
		// Two entries with the same unopened URL, one fine.
		const md =
			"## 参考文献\n\n1. [某报告，2026年](https://example.com/a)\n2. [另一份报告，2026年](https://example.com/a)\n3. [第三份报告，2026年](https://example.com/b)\n";
		const report = checkReferences(md, ["https://example.com/b"]);
		expect([report.entries, report.issues.map((i) => i.problems)]).toEqual([3, [["opened"], ["opened"]]]);
		expect(unopenedUrls(report)).toEqual(["https://example.com/a"]);
	});
});

describe("openedUrls", () => {
	it("returns the requested and final URLs of fetch_web calls that loaded text", () => {
		// A redirect that loaded, a failure and an empty page.
		const call = (id: string, url: string) => ({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "fetch_web", arguments: { url } }],
		});
		const result = (id: string, url: string, chars: number, isError = false) => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "fetch_web",
			isError,
			details: { url, chars },
		});
		const msgs = [
			call("1", "https://a.example/old"),
			result("1", "https://a.example/new", 500),
			call("2", "https://b.example"),
			result("2", "https://b.example", 0),
			call("3", "https://c.example"),
			result("3", "https://c.example", 900, true),
		];
		expect(openedUrls(msgs)).toEqual(["https://a.example/new", "https://a.example/old"]);
	});
});

// 2026-11-09: a third of 94 entries in ten research reports were cited nowhere in the text; the body named only an
// institution (据中国民航局数据), or another outlet than the entry.
describe("entryNames / uncitedReferences", () => {
	const REPORT = [
		"# 我国低空经济发展研究报告",
		"",
		"中国民航局预测，2025年市场规模达1.5万亿元。2025年12月30日《上海证券报》报道，美团无人机开通65条航线。",
		"2025年11月12日《光明日报》刊文指出，制度规范存在空白[6]。",
		"",
		"## 参考文献",
		"",
		"1. [逐空而上！低空经济加速启航万亿新赛道，新华社，2025-12-22](https://www.news.cn/20251222/c.html)",
		"2. [国家先后设立两个“低空司”，低空经济前景如何？，中国网《北京周报》，2026-05-25](http://www.beijingreview.cn/a.html)",
		"3. [向天空要生产力！低空经济万翼齐扬，上海证券报，2025-12-30](https://m.cnstock.com/611057)",
		"4. [迈入规模化落地关键期——2025年低空经济大事记，现代物流报，2025-12-31](https://news.xd56b.com/36187.html)",
		"5. https://example.com/12345",
		"6. [协同发力激发低空经济发展动能，求是网，2025-11-12](https://www.qstheory.cn/a.html)",
	].join("\n");

	it("entryNames: the outlets and the longer titles, without dates or addresses", () => {
		expect(entryNames("[向天空要生产力！低空经济万翼齐扬，上海证券报，2025-12-30](https://m.cnstock.com/611057)")).toEqual([
			"向天空要生产力！低空经济万翼齐扬",
			"上海证券报",
		]);
		expect(entryNames("2. [国家先后设立两个“低空司”，中国网《北京周报》，2026-05-25](http://x.cn/a)")).toContain("北京周报");
		expect(entryNames("5. https://example.com/12345")).toEqual([]);
	});

	it("uncitedReferences: entries named nowhere in the text and with no [n] marker", () => {
		const body = REPORT.split("## 参考文献")[0];
		// 3 is cited by its outlet, 6 by its marker, 5 names nothing to look for.
		expect(uncitedReferences(REPORT, body)).toEqual([1, 2, 4]);
	});
});
