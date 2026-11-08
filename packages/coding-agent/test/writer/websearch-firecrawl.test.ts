// Unit tests for src/writer/websearch/firecrawl.ts (fetch replaced; no network).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSearchEnv } from "../../src/writer/websearch/core.ts";
import {
	FIRECRAWL_MAX_AGE_MS,
	firecrawlError,
	firecrawlFetch,
	firecrawlPost,
	firecrawlSearch,
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
		expect(out).toEqual([{ title: "T", url: "https://apnews.com/a", snippet: "S", date: "3 hours ago" }]);
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
