// Unit tests for src/writer/websearch/core.ts.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import {
	cleanWebText,
	DEFAULT_ANYSEARCH_URL,
	findDate,
	formatFetch,
	formatSearch,
	hostOf,
	isBlocked,
	isHttpUrl,
	MAX_FETCH_CHARS,
	normalizeResults,
	readSearchEnv,
	urlDate,
} from "../../src/writer/websearch/core.ts";

describe("readSearchEnv", () => {
	it("defaults to auto (browser, else anonymous AnySearch) with a 300 s timeout, Bing then Google, 3 pages", () => {
		// Empty environment.
		const { config, errors } = readSearchEnv({});
		// Defaults.
		expect(errors).toEqual([]);
		expect(config).toEqual({
			backend: "auto",
			anysearchUrl: DEFAULT_ANYSEARCH_URL,
			anysearchKey: "",
			sfPath: "",
			timeoutMs: 300_000,
			blocklist: [],
			engines: ["bing", "google"],
			pages: 3,
			verifyWaitMs: 180_000,
		});
	});
	it("reads every variable and reports an unknown backend", () => {
		// All set.
		const { config } = readSearchEnv({
			JW_SEARCH: " SF ",
			JW_SEARCH_URL: "http://h/",
			JW_SEARCH_KEY: "k",
			JW_SF: "/x/sf",
			JW_SEARCH_TIMEOUT: "60",
			JW_SEARCH_BLOCK: "Spam.example, .junk.example",
			JW_ENGINES: "google",
			JW_SEARCH_PAGES: "9",
			JW_VERIFY_WAIT: "45",
		});
		// Parsed.
		expect(config).toEqual({
			backend: "sf",
			anysearchUrl: "http://h",
			anysearchKey: "k",
			sfPath: "/x/sf",
			timeoutMs: 60_000,
			blocklist: ["spam.example", "junk.example"],
			engines: ["google"],
			pages: 5,
			verifyWaitMs: 45_000,
		});
		// The browser backends are known; pages below 3 become 3.
		expect(readSearchEnv({ JW_SEARCH: "browser", JW_SEARCH_PAGES: "1" }).config).toMatchObject({
			backend: "browser",
			pages: 3,
		});
		// Unknown backend.
		expect(readSearchEnv({ JW_SEARCH: "exa", JW_LANG: "zh" }).errors[0]).toContain("「exa」");
	});
});

describe("URL helpers", () => {
	it("accepts only http(s), reads hosts and matches blocked domains by label", () => {
		// Schemes.
		expect([isHttpUrl("https://a.example/"), isHttpUrl("file:///etc/passwd"), isHttpUrl("nope")]).toEqual([
			true,
			false,
			false,
		]);
		// Hosts.
		expect([hostOf("https://WWW.A.example/x"), hostOf("::")]).toEqual(["www.a.example", ""]);
		// Suffix match on labels only.
		expect([isBlocked("a.spam.example", ["spam.example"]), isBlocked("notspam.example", ["spam.example"])]).toEqual([
			true,
			false,
		]);
	});
});

describe("findDate", () => {
	it("finds absolute and relative dates", () => {
		// ISO, slash and Chinese forms; relative markers; nothing.
		expect(findDate("published 2026-10-31T08:00")).toBe("2026-10-31");
		expect(findDate("新华社2026年10月3日电")).toBe("2026-10-03");
		expect(findDate("3 hours ago · Reuters")).toBe("3 hours ago");
		expect(findDate("5 小时前")).toBe("5 小时前");
		expect(findDate("no date here")).toBe("");
	});
});

describe("urlDate", () => {
	it("reads separated and compact dates from the path only", () => {
		// Reuters slug, slash path, news.cn and people.com.cn compact forms.
		expect(urlDate("https://www.reuters.com/world/bulgaria-votes-runoff-2026-11-01/")).toBe("2026-11-01");
		expect(urlDate("https://a.example/2026/10/31/story.html")).toBe("2026-10-31");
		expect(urlDate("https://www.news.cn/world/20261101/abc/c.html")).toBe("2026-11-01");
		expect(urlDate("http://world.people.com.cn/n1/2026/1101/c1002-1.html")).toBe("2026-11-01");
		// Longer numbers, query strings, hosts and bad URLs carry no date.
		expect(urlDate("https://a.example/item/1202611015")).toBe("");
		expect(urlDate("https://a.example/p?d=2026-11-01")).toBe("");
		expect(urlDate("https://2026-11-01.example/")).toBe("");
		expect(urlDate("not a url")).toBe("");
	});
});

describe("normalizeResults", () => {
	it("keeps http(s), drops duplicates and blocked hosts, fills dates, bounds the count", () => {
		// Raw results.
		const raw = [
			{ title: "A", url: "https://a.example/x", snippet: "  2026-10-30\n  report ", date: "" },
			{ title: "A again", url: "https://a.example/x#frag", snippet: "", date: "" },
			{ title: "Spam", url: "https://ads.spam.example/", snippet: "", date: "" },
			{ title: "Local", url: "file:///x", snippet: "", date: "" },
			{ title: "", url: "https://b.example/", snippet: "", date: "1 day ago" },
			{ title: "C", url: "https://c.example/", snippet: "", date: "" },
		];
		// Cleaned.
		const out = normalizeResults(raw, ["spam.example"], 2);
		// A date only in the URL path is used last.
		expect(
			normalizeResults([{ title: "T", url: "https://r.example/x-2026-11-01/", snippet: "", date: "" }], [], 5)[0]
				.date,
		).toBe("2026-11-01");
		// Two kept, date filled, title defaulted.
		expect(out).toEqual([
			{ title: "A", url: "https://a.example/x", snippet: "2026-10-30 report", date: "2026-10-30" },
			{ title: "https://b.example/", url: "https://b.example/", snippet: "", date: "1 day ago" },
		]);
	});
});

describe("cleanWebText", () => {
	it("removes comments and characters a reader cannot see", () => {
		expect(cleanWebText("甲<!-- 注释\n两行 -->乙")).toBe("甲乙");
		// Zero-width, bidirectional marks, soft hyphen, BOM and the tag block.
		expect(cleanWebText("a\u200Bb\u202Ec\u00ADd\uFEFFe\u{E0041}f")).toBe("abcdef");
		// Ordinary text stays, spaces and line breaks too.
		expect(cleanWebText("Wi-Fi 第1段，\n«引文» 😀")).toBe("Wi-Fi 第1段，\n«引文» 😀");
	});

	it("cleans the titles and snippets of search results", () => {
		const [r] = normalizeResults(
			[{ title: "标\u200B题", url: "https://a.example/", snippet: "摘<!-- x -->要", date: "" }],
			[],
			5,
		);
		expect([r.title, r.snippet]).toEqual(["标题", "摘要"]);
	});
});

describe("reports", () => {
	it("formats search results, and an empty result", () => {
		// Two results, Chinese.
		const text = formatSearch(
			"q",
			"anysearch",
			[
				{ title: "T", url: "https://a.example/", snippet: "s", date: "2026-10-31" },
				{ title: "U", url: "https://b.example/", snippet: "", date: "" },
			],
			"zh",
		);
		// Lines.
		expect(text.split("\n").slice(0, 4)).toEqual([
			"检索结果（anysearch，2 条）：q",
			"1. T",
			"   https://a.example/（2026-10-31）",
			"   s",
		]);
		// Nothing found.
		expect(formatSearch("q", "sf", [], "en")).toBe("No results for: q");
	});
	it("formats a fetched page and clips long text", () => {
		// Short page.
		const short = formatFetch({ url: "https://a.example/", title: "T", content: "正文", date: "" }, "sf", "zh");
		expect(short).toBe("网页正文（sf）：T\n来源：https://a.example/\n\n正文");
		// Long page.
		const long = formatFetch(
			{ url: "u", title: "", content: "字".repeat(MAX_FETCH_CHARS + 5), date: "" },
			"sf",
			"zh",
		);
		expect(long.endsWith(`（正文过长，已截取前 ${MAX_FETCH_CHARS} 字）`)).toBe(true);
	});
});
