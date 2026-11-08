// Unit tests for src/writer/websearch/deepseek.ts (fetch replaced; no network).

// Test API; stubEnv fixes the message language.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Default configuration.
import { readSearchEnv } from "../../src/writer/websearch/core.ts";
// Functions under test.
import {
	DEEPSEEK_QUERY_MAX,
	deepseekError,
	deepseekFetch,
	deepseekPost,
	deepseekQuery,
	deepseekSearch,
} from "../../src/writer/websearch/deepseek.ts";

// Chinese messages.
beforeEach(() => vi.stubEnv("JW_LANG", "zh"));
afterEach(() => vi.unstubAllEnvs());

/** JSON response. */
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Recording fake fetch answering from a queue. */
function fakeFetch(...replies: (Response | Error)[]) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fn = async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const r = replies.shift();
		if (r instanceof Error) throw r;
		if (!r) throw new Error("no more replies");
		return r;
	};
	return { fn, calls };
}

// A configured backend, and one without a key.
const cfg = readSearchEnv({ JW_DEEPSEEK_URL: "https://ds.example/", DEEPSEEK_KEY: "sk-test-ds" });
const keyless = readSearchEnv({});

describe("deepseekError", () => {
	it("names the cause by status", () => {
		expect(deepseekError(401).message).toContain("DEEPSEEK_KEY");
		expect(deepseekError(402).message).toContain("余额");
		expect(deepseekError(404, "https://a.example/").message).toContain("https://a.example/");
		expect(deepseekError(429).message).toContain("429");
		expect(deepseekError(500).message).toContain("500");
	});
});

describe("deepseekPost", () => {
	it("sends the key as a Bearer header to the configured root, and never puts it in an error", async () => {
		const f = fakeFetch(json(200, { results: [] }), json(403, {}));
		await deepseekPost(cfg, "/v1/tools/search", { query: "q" }, undefined, f.fn);
		expect(f.calls[0].url).toBe("https://ds.example/v1/tools/search");
		expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-ds");
		const error = await deepseekPost(cfg, "/v1/tools/search", { query: "q" }, undefined, f.fn).catch((e: Error) => e);
		expect(String(error)).not.toContain("sk-test-ds");
	});
	it("needs a key, and turns network failures and non-JSON answers into readable errors", async () => {
		await expect(deepseekPost(keyless, "/v1/tools/search", {}, undefined, fakeFetch().fn)).rejects.toThrow(
			"DEEPSEEK_KEY",
		);
		await expect(deepseekPost(cfg, "/x", {}, undefined, fakeFetch(new TypeError("fetch failed")).fn)).rejects.toThrow(
			"无法连接",
		);
		await expect(
			deepseekPost(cfg, "/x", {}, undefined, fakeFetch(new Response("<html>", { status: 200 })).fn),
		).rejects.toThrow("HTTP 200");
	});
});

describe("deepseekQuery", () => {
	it("turns a bare year in after: into its first day, and leaves full dates and other words alone", () => {
		expect(deepseekQuery("budget site:ktar.com after:2026")).toBe("budget site:ktar.com after:2026-01-01");
		expect(deepseekQuery("x after:2026-09 y after:2025-03-01")).toBe("x after:2026-09 y after:2025-03-01");
		expect(deepseekQuery("2026 budget before:2026")).toBe("2026 budget before:2026");
	});
});

describe("deepseekSearch and deepseekFetch", () => {
	it("sends query and count, maps summary and the day of the date", async () => {
		const f = fakeFetch(
			json(200, {
				results: [
					{
						title: "T",
						url: "https://a.example/",
						snippet: "短",
						summary: "较长的摘要",
						date: "2026-11-06T16:00:00Z",
					},
					{ title: "U", url: "https://b.example/", snippet: "只有短的", date: null },
				],
			}),
		);
		const out = await deepseekSearch(cfg, "Ukraine site:apnews.com", "What happened?", undefined, f.fn);
		expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
			query: "Ukraine site:apnews.com",
			count: 10,
			ori_question: "What happened?",
		});
		expect(out).toEqual([
			{ title: "T", url: "https://a.example/", snippet: "较长的摘要", date: "2026-11-06" },
			{ title: "U", url: "https://b.example/", snippet: "只有短的", date: "" },
		]);
	});
	it("refuses a query longer than the API takes, before any request", async () => {
		const f = fakeFetch();
		await expect(deepseekSearch(cfg, "x".repeat(DEEPSEEK_QUERY_MAX + 1), undefined, undefined, f.fn)).rejects.toThrow(
			"请缩短",
		);
		expect(f.calls.length).toBe(0);
	});
	it("fetches a page's text with its date", async () => {
		const f = fakeFetch(json(200, { title: "页", content: "2026年11月6日 正文" }));
		const page = await deepseekFetch(cfg, "https://a.example/p", undefined, f.fn);
		expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ url: "https://a.example/p" });
		expect(page).toMatchObject({ url: "https://a.example/p", title: "页", content: "2026年11月6日 正文" });
		expect(page.date).not.toBe("");
	});
});
