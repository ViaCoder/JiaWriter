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
	it("returns the requested and final URLs of web_fetch calls that loaded text", () => {
		// A redirect that loaded, a failure and an empty page.
		const call = (id: string, url: string) => ({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "web_fetch", arguments: { url } }],
		});
		const result = (id: string, url: string, chars: number, isError = false) => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "web_fetch",
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
