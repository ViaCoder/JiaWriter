// Unit tests for src/writer/browser/wall.ts. The rows are real measurements of 2026-11-05: 27 sites opened once
// in a test Chrome. Addresses are public; nothing of the pages' text is kept.

// Test API.
import { describe, expect, it } from "vitest";
// Function under test.
import { classifyPage, type PageFeatures } from "../../src/writer/browser/wall.ts";

/** asked, final address, status, elements, links, characters of text. */
type Row = [string, string, number, number, number, number];

/** Pages that stand in the way. */
const WALLS: Row[] = [
	["https://linux.do/", "https://linux.do/", 403, 33, 0, 0],
	["https://www.reuters.com/world/", "https://www.reuters.com/world/", 401, 9, 0, 0],
	["https://www.bloomberg.com/", "https://www.bloomberg.com/", 403, 39, 6, 665],
	["https://www.wsj.com/", "https://www.wsj.com/", 401, 9, 0, 0],
	["https://www.nytimes.com/", "https://www.nytimes.com/", 403, 9, 0, 0],
	["https://www.linkedin.com/feed/", "https://www.linkedin.com/feed/", 403, 45, 1, 689],
	["https://apnews.com/", "https://apnews.com/", 403, 47, 2, 258],
	["https://www.ft.com/", "https://www.ft.com/", 403, 66, 9, 300],
	["https://www.zhihu.com/", "https://www.zhihu.com/signin?next=%2F", 200, 239, 24, 468],
	["https://www.xiaohongshu.com/explore", "https://www.xiaohongshu.com/website-login/error", 200, 49, 0, 71],
	["https://www.baidu.com/s?wd=test", "https://wappass.baidu.com/static/captcha/tuxing.html", 200, 72, 1, 52],
	["https://www.sogou.com/web?query=test", "https://www.sogou.com/antispider/?m=1", 200, 59, 8, 253],
];
/** Pages to read, widgets on ordinary pages among them. */
const PAGES: Row[] = [
	["https://www.bbc.com/news", "https://www.bbc.com/news", 200, 1861, 155, 10301],
	["https://www.gov.cn/", "https://www.gov.cn/", 200, 711, 189, 1260],
	["https://www.news.cn/", "https://www.news.cn/", 200, 1999, 695, 5283],
	["https://docs.python.org/3/library/re.html", "https://docs.python.org/3/library/re.html", 200, 6127, 385, 67791],
	[
		"https://en.wikipedia.org/wiki/Urban_forestry",
		"https://en.wikipedia.org/wiki/Urban_forestry",
		200,
		6954,
		2016,
		136300,
	],
	["https://github.com/earendil-works/pi", "https://github.com/earendil-works/pi", 200, 2469, 276, 11578],
	["https://36kr.com/", "https://36kr.com/", 200, 1504, 370, 5388],
	["https://www.theguardian.com/international", "https://www.theguardian.com/international", 200, 5201, 353, 19843],
	["https://www.sina.com.cn/", "https://www.sina.com.cn/", 200, 3737, 1016, 9000],
	// A login address, with a full page of content on it.
	["https://weibo.com/", "https://weibo.com/newlogin?tabtype=weibo", 200, 1183, 47, 1039],
	// The search home page after a direct address: no gate, nothing to clear.
	["https://www.bing.com/search?q=test", "https://www.bing.com/?scope=web", 200, 520, 40, 281],
	["https://www.google.com/search?q=test", "https://www.google.com/webhp", 200, 332, 20, 87],
];

/** A row as the page script reports it. */
function features([, url, status, elements, links, textLen]: Row): PageFeatures {
	return { url, status, elements, links, textLen };
}

describe("classifyPage on measured sites", () => {
	it("knows every wall without reading a word", () => {
		const missed = WALLS.filter((r) => classifyPage(features(r), r[0]) !== "wall").map((r) => r[0]);
		expect(missed).toEqual([]);
	});

	it("never stops for an ordinary page", () => {
		const stopped = PAGES.filter((r) => classifyPage(features(r), r[0]) === "wall").map((r) => r[0]);
		expect(stopped).toEqual([]);
	});

	it("leaves a captcha widget on an ordinary small page alone", () => {
		// Demo pages of reCAPTCHA, hCaptcha and Turnstile: answered 200, stayed where they were.
		const small: Row[] = [
			["https://www.google.com/recaptcha/api2/demo", "https://www.google.com/recaptcha/api2/demo", 200, 47, 0, 91],
			["https://accounts.hcaptcha.com/demo", "https://accounts.hcaptcha.com/demo", 200, 43, 0, 238],
			["https://demo.turnstile.workers.dev/", "https://demo.turnstile.workers.dev/", 200, 28, 2, 106],
		];
		for (const r of small) expect(classifyPage(features(r), r[0])).not.toBe("wall");
	});
});

describe("classifyPage edges", () => {
	const page = (over: Partial<PageFeatures> = {}): PageFeatures => ({
		url: "https://a.example/x",
		status: 200,
		elements: 40,
		links: 2,
		textLen: 100,
		...over,
	});

	it("calls a small page with nothing against it a suspect, not a wall", () => {
		expect(classifyPage(page(), "https://a.example/x")).toBe("suspect");
	});

	it("takes a missing page as an answer", () => {
		expect(classifyPage(page({ status: 404, links: 30 }), "https://a.example/x")).toBe("page");
	});

	it("reads a large page whatever its status", () => {
		expect(classifyPage(page({ status: 403, elements: 900 }), "https://a.example/x")).toBe("page");
	});

	it("does not stop on a gate the user asked for, or on a word in the query", () => {
		const login = "https://a.example/login";
		expect(classifyPage(page({ url: login, links: 30 }), login)).toBe("page");
		const query = "https://a.example/s?q=captcha";
		expect(classifyPage(page({ url: query, links: 30 }), query)).toBe("page");
	});

	it("survives an address that cannot be read", () => {
		expect(classifyPage(page({ url: "nonsense", links: 30 }), "nonsense")).toBe("page");
	});
});
