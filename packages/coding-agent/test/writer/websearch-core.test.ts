// Unit tests for src/writer/websearch/core.ts.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import {
	cleanWebText,
	DEFAULT_ANYSEARCH_URL,
	formatFetch,
	formatSearch,
	hostOf,
	isBlocked,
	isHttpUrl,
	MAX_FETCH_CHARS,
	normalizeResults,
	pageDate,
	readSearchEnv,
	urlDate,
} from "../../src/writer/websearch/core.ts";

describe("readSearchEnv", () => {
	it("defaults to anonymous AnySearch settings, a 300 s timeout, Bing then Google, 3 pages", () => {
		// Empty environment.
		const config = readSearchEnv({});
		// Defaults.
		expect(config).toEqual({
			anysearchUrl: DEFAULT_ANYSEARCH_URL,
			anysearchKey: "",
			deepseekUrl: "https://api.deepseek.com",
			deepseekKey: "",
			firecrawlUrl: "https://api.firecrawl.dev",
			firecrawlKey: "",
			sfPath: "",
			timeoutMs: 300_000,
			blocklist: [],
			engines: ["bing", "google"],
			pages: 3,
			verifyWaitMs: 180_000,
		});
	});
	it("reads every variable and ignores JW_SEARCH, which is gone", () => {
		// All set.
		const config = readSearchEnv({
			JW_SEARCH: "exa",
			JW_SEARCH_URL: "http://h/",
			ANYSEARCH_KEY: "k",
			JW_DEEPSEEK_URL: "http://d/",
			DEEPSEEK_KEY: " dk ",
			JW_FIRECRAWL_URL: "http://f//",
			FIRECRAWL_KEY: "fk",
			JW_SF: "/x/sf",
			JW_SEARCH_TIMEOUT: "60",
			JW_SEARCH_BLOCK: "Spam.example, .junk.example",
			JW_ENGINES: "google",
			JW_SEARCH_PAGES: "9",
			JW_VERIFY_WAIT: "45",
		});
		// Parsed.
		expect(config).toEqual({
			anysearchUrl: "http://h",
			anysearchKey: "k",
			deepseekUrl: "http://d",
			deepseekKey: "dk",
			firecrawlUrl: "http://f",
			firecrawlKey: "fk",
			sfPath: "/x/sf",
			timeoutMs: 60_000,
			blocklist: ["spam.example", "junk.example"],
			engines: ["google"],
			pages: 5,
			verifyWaitMs: 45_000,
		});
		// Pages below 3 become 3.
		expect(readSearchEnv({ JW_SEARCH_PAGES: "1" }).pages).toBe(3);
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
	it("keeps every result but repeats and blocked hosts, and fills dates", () => {
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
		const out = normalizeResults(raw, ["spam.example"]);
		// A date only in the URL path is used last.
		expect(
			normalizeResults([{ title: "T", url: "https://r.example/x-2026-11-01/", snippet: "", date: "" }], [])[0].date,
		).toBe("2026-11-01");
		// All kept, any kind of address, date filled, title defaulted.
		expect(out).toEqual([
			{ title: "A", url: "https://a.example/x", snippet: "2026-10-30 report", date: "2026-10-30" },
			{ title: "Local", url: "file:///x", snippet: "", date: "" },
			{ title: "https://b.example/", url: "https://b.example/", snippet: "", date: "1 day ago" },
			{ title: "C", url: "https://c.example/", snippet: "", date: "" },
		]);
		// A long snippet stays whole.
		const long = "长".repeat(5000);
		expect(normalizeResults([{ title: "T", url: "u", snippet: long, date: "" }], [])[0].snippet).toBe(long);
		// Many results all stay.
		const many = Array.from({ length: 100 }, (_, i) => ({
			title: "T",
			url: `https://a.example/${i}`,
			snippet: "",
			date: "",
		}));
		expect(normalizeResults(many, [])).toHaveLength(100);
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
		expect(short).toBe("网页正文（sf）：T\n网址：https://a.example/\n\n正文");
		// Long page.
		const long = formatFetch(
			{ url: "u", title: "", content: "字".repeat(MAX_FETCH_CHARS + 5), date: "" },
			"sf",
			"zh",
		);
		expect(long.endsWith(`（正文过长，已截取前 ${MAX_FETCH_CHARS} 字）`)).toBe(true);
	});
});

// 2026-11-10: a page's "刚刚" was its menus, and a page with no date in its text had one in its address.
describe("pageDate", () => {
	it("takes an absolute date near the top, else the address's, never a relative marker", () => {
		expect(pageDate("标题\n2026-02-10 14:10 来源：中国航空报", "https://a.example/p")).toBe("2026-02-10");
		expect(pageDate("正文", "https://finance.sina.cn/2026-07-03/detail.d.html")).toBe("2026-07-03");
		expect(pageDate("刚刚 · 首页", "https://m.jiemian.com/article/1.html")).toBe("");
		expect(pageDate(`${"字".repeat(250)}2026年1月2日`, "https://a.example/", 200)).toBe("");
	});
});
