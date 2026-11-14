// Unit tests for src/writer/websearch/firecrawl.ts (fetch replaced; no network).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayOf, readSearchEnv } from "../../src/writer/websearch/core.ts";
import {
	FIRECRAWL_MAX_AGE_MS,
	firecrawlError,
	firecrawlFetch,
	firecrawlPost,
	firecrawlRange,
	firecrawlSearch,
	RATE_WAIT_MS,
} from "../../src/writer/websearch/firecrawl.ts";

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

const cfg = readSearchEnv({ JW_FIRECRAWL_URL: "https://fc.example/", FIRECRAWL_KEY: "fc-test-key" });
const keyless = readSearchEnv({});

describe("firecrawlError", () => {
	it("names the cause by status", () => {
		expect(firecrawlError(401).message).toContain("FIRECRAWL_KEY");
		expect(firecrawlError(402).message).toContain("积分");
		expect(firecrawlError(429).message).toContain("429");
		expect(firecrawlError(404, "https://a.example/").message).toContain("https://a.example/");
		expect(firecrawlError(503).message).toContain("503");
	});
});

describe("firecrawlPost", () => {
	it("sends the key as a Bearer header, returns data, and keeps the key out of errors", async () => {
		const f = fakeFetch(json(200, { success: true, data: { web: [] } }), json(401, {}));
		expect(await firecrawlPost(cfg, "/v2/search", { query: "q" }, undefined, f.fn)).toEqual({ web: [] });
		expect(f.calls[0].url).toBe("https://fc.example/v2/search");
		expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer fc-test-key");
		const error = await firecrawlPost(cfg, "/v2/search", {}, undefined, f.fn).catch((e: Error) => e);
		expect(String(error)).not.toContain("fc-test-key");
	});
	it("waits as told after a 429 and tries once more, then gives up", async () => {
		const waits: number[] = [];
		const sleep = async (ms: number) => void waits.push(ms);
		const limited = new Response("{}", { status: 429, headers: { "retry-after": "2" } });
		const f = fakeFetch(limited, json(200, { success: true, data: { ok: 1 } }));
		expect(await firecrawlPost(cfg, "/v2/scrape", { url: "https://a.example/" }, undefined, f.fn, sleep)).toEqual({
			ok: 1,
		});
		expect(waits).toEqual([2000]);
		expect(f.calls).toHaveLength(2);
		// No Retry-After: the limit; a second 429 is the failure.
		const g = fakeFetch(json(429, {}), json(429, {}));
		await expect(firecrawlPost(cfg, "/x", {}, undefined, g.fn, sleep)).rejects.toThrow("429");
		expect(waits).toEqual([2000, RATE_WAIT_MS]);
	});
	it("needs a key, and reads a failed envelope or a network error as a failure", async () => {
		await expect(firecrawlPost(keyless, "/v2/search", {}, undefined, fakeFetch().fn)).rejects.toThrow(
			"FIRECRAWL_KEY",
		);
		await expect(
			firecrawlPost(cfg, "/x", {}, undefined, fakeFetch(json(200, { success: false })).fn),
		).rejects.toThrow("HTTP 200");
		await expect(firecrawlPost(cfg, "/x", {}, undefined, fakeFetch(new TypeError("down")).fn)).rejects.toThrow(
			"无法连接",
		);
	});
});

describe("firecrawlSearch", () => {
	it("asks for news without a time filter, and maps snippet and date", async () => {
		const f = fakeFetch(
			json(200, {
				success: true,
				data: { news: [{ title: "T", url: "https://apnews.com/a", snippet: "S", date: "3 hours ago" }] },
			}),
		);
		const out = await firecrawlSearch(cfg, "Ukraine", { news: true, fresh: "day" }, undefined, f.fn);
		expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ query: "Ukraine", limit: 10, sources: ["news"] });
		// The age becomes the day it points to (2026-11-10).
		expect(out).toEqual([{ title: "T", url: "https://apnews.com/a", snippet: "S", date: dayOf("3 hours ago") }]);
	});
	it("asks for web results with the time window, and reads description", async () => {
		const f = fakeFetch(
			json(200, { success: true, data: { web: [{ title: "W", url: "https://a.example/", description: "D" }] } }),
		);
		const out = await firecrawlSearch(cfg, "budget", { fresh: "month" }, undefined, f.fn);
		expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
			query: "budget",
			limit: 10,
			sources: ["web"],
			tbs: "qdr:m",
		});
		expect(out).toEqual([{ title: "W", url: "https://a.example/", snippet: "D", date: "" }]);
	});
});

describe("firecrawlFetch", () => {
	it("asks for the main text from a recent copy, and takes title, address and date", async () => {
		const f = fakeFetch(
			json(200, {
				success: true,
				data: {
					markdown: "Nov 7 (Reuters) - text",
					metadata: {
						title: ["Reuters title"],
						sourceURL: "https://reuters.com/x",
						statusCode: 200,
						publishedTime: "2026-11-07T07:50:24Z",
					},
				},
			}),
		);
		const page = await firecrawlFetch(cfg, "https://reuters.com/x", undefined, f.fn);
		expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
			url: "https://reuters.com/x",
			formats: ["markdown"],
			onlyMainContent: true,
			maxAge: FIRECRAWL_MAX_AGE_MS,
		});
		expect(page).toEqual({
			url: "https://reuters.com/x",
			title: "Reuters title",
			content: "Nov 7 (Reuters) - text",
			date: "2026-11-07",
		});
	});
	it("fails when the page itself failed behind a successful call", async () => {
		const f = fakeFetch(json(200, { success: true, data: { markdown: "", metadata: { statusCode: 404 } } }));
		await expect(firecrawlFetch(cfg, "https://a.example/gone", undefined, f.fn)).rejects.toThrow(
			"https://a.example/gone",
		);
	});
});

describe("firecrawlRange", () => {
	it("writes dates as Firecrawl's custom range, month/day/year", () => {
		expect(firecrawlRange("2024-12-01", "2024-12-31")).toBe("cdr:1,cd_min:12/1/2024,cd_max:12/31/2024");
		expect(firecrawlRange("2026-03-05")).toBe("cdr:1,cd_min:3/5/2026");
		expect(firecrawlRange(undefined, "2026-01-31")).toBe("cdr:1,cd_max:1/31/2026");
	});
	it("limits web results by dates, ahead of fresh, and leaves news unfiltered", async () => {
		const web = fakeFetch(json(200, { success: true, data: { web: [] } }));
		await firecrawlSearch(
			cfg,
			"budget",
			{ fresh: "week", after: "2026-10-01", before: "2026-10-31" },
			undefined,
			web.fn,
		);
		expect(JSON.parse(String(web.calls[0].init.body)).tbs).toBe("cdr:1,cd_min:10/1/2026,cd_max:10/31/2026");
		const news = fakeFetch(json(200, { success: true, data: { news: [] } }));
		await firecrawlSearch(cfg, "budget", { news: true, after: "2026-10-01" }, undefined, news.fn);
		expect(JSON.parse(String(news.calls[0].init.body)).tbs).toBeUndefined();
	});
});
