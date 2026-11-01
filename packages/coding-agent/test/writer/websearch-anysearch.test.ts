// Unit tests for src/writer/websearch/anysearch.ts (fetch replaced; no network).

// Test API; stubEnv fixes the message language.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Functions under test.
import {
	anysearchExtract,
	anysearchPost,
	anysearchSearch,
	retryAfterMs,
	statusError,
} from "../../src/writer/websearch/anysearch.ts";
// Default configuration.
import { readSearchEnv } from "../../src/writer/websearch/core.ts";

// Chinese messages.
beforeEach(() => vi.stubEnv("WA_LANG", "zh"));
// Restore.
afterEach(() => vi.unstubAllEnvs());

/** JSON response. */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	// Real Response object.
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Recording fake fetch answering from a queue. */
function fakeFetch(...replies: (Response | Error)[]) {
	// Calls seen.
	const calls: { url: string; init: RequestInit }[] = [];
	// The function.
	const fn = async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const r = replies.shift();
		if (r instanceof Error) throw r;
		if (!r) throw new Error("no more replies");
		return r;
	};
	// Both.
	return { fn, calls };
}

// No real waiting.
const noSleep = async () => {};
// Config with a key and one without.
const withKey = readSearchEnv({ WA_SEARCH_KEY: "sk-test-4711", WA_SEARCH_URL: "https://any.example" }).config;
const anon = readSearchEnv({ WA_SEARCH_URL: "https://any.example" }).config;

describe("retryAfterMs and statusError", () => {
	it("bounds the back-off and maps statuses to messages", () => {
		// Seconds, absent, oversized.
		expect([retryAfterMs("3"), retryAfterMs(null), retryAfterMs("999")]).toEqual([3000, 1000, 10_000]);
		// Messages.
		expect(statusError(402).message).toContain("匿名额度已用完");
		expect(statusError(401).message).toContain("HTTP 401");
		expect(statusError(422, "https://x.example/").message).toContain("https://x.example/");
		expect(statusError(502).message).toBe("AnySearch 请求失败（HTTP 502）。");
	});
});

describe("anysearchPost", () => {
	it("sends JSON with the key only when configured and returns data", async () => {
		// Success twice.
		const f = fakeFetch(json(200, { code: 0, data: { ok: 1 } }), json(200, { code: 0, data: { ok: 2 } }));
		// With and without a key.
		expect(await anysearchPost(withKey, "/v1/search", { query: "q" }, undefined, f.fn, noSleep)).toEqual({ ok: 1 });
		expect(await anysearchPost(anon, "/v1/search", { query: "q" }, undefined, f.fn, noSleep)).toEqual({ ok: 2 });
		// Headers and URL.
		expect(f.calls[0].url).toBe("https://any.example/v1/search");
		expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-4711");
		expect((f.calls[1].init.headers as Record<string, string>).authorization).toBeUndefined();
	});
	it("retries a 429 once after Retry-After, then reports the rate limit", async () => {
		// 429 then success.
		const slept: number[] = [];
		const f = fakeFetch(json(429, {}, { "retry-after": "2" }), json(200, { code: 0, data: { ok: 1 } }));
		expect(await anysearchPost(anon, "/v1/search", {}, undefined, f.fn, async (ms) => void slept.push(ms))).toEqual({
			ok: 1,
		});
		expect(slept).toEqual([2000]);
		// Two 429s.
		const g = fakeFetch(json(429, {}), json(429, {}));
		await expect(anysearchPost(anon, "/v1/search", {}, undefined, g.fn, noSleep)).rejects.toThrow("请求过于频繁");
		expect(g.calls.length).toBe(2);
	});
	it("never surfaces a 402 body (it may hold generated credentials)", async () => {
		// 402 with fake credentials in the body.
		const f = fakeFetch(json(402, { code: -1, message: "username=gen-user password=gen-pass-123 key=sk-gen-999" }));
		// The error mentions none of them.
		const err = await anysearchPost(anon, "/v1/search", {}, undefined, f.fn, noSleep).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).not.toMatch(/gen-user|gen-pass|sk-gen/);
	});
	it("reports network errors, auth errors and a non-zero code", async () => {
		// Each failure.
		await expect(
			anysearchPost(anon, "/v1/search", {}, undefined, fakeFetch(new Error("ECONNREFUSED")).fn, noSleep),
		).rejects.toThrow("无法连接 AnySearch：ECONNREFUSED");
		await expect(
			anysearchPost(withKey, "/v1/search", {}, undefined, fakeFetch(json(403, {})).fn, noSleep),
		).rejects.toThrow("HTTP 403");
		await expect(
			anysearchPost(anon, "/v1/search", {}, undefined, fakeFetch(json(200, { code: 5 })).fn, noSleep),
		).rejects.toThrow("HTTP 200");
		// The key never appears in an error.
		const e = await anysearchPost(withKey, "/v1/search", {}, undefined, fakeFetch(json(401, {})).fn, noSleep).catch(
			(x: Error) => x,
		);
		expect((e as Error).message).not.toContain("sk-test-4711");
	});
});

describe("anysearchSearch and anysearchExtract", () => {
	it("builds the search body and maps results with dates", async () => {
		// One result with a dated snippet.
		const f = fakeFetch(
			json(200, {
				code: 0,
				data: {
					results: [
						{ title: "T", url: "https://a.example/", snippet: "2026-10-31 消息" },
						{ url: "https://b.example/", content: "3 hours ago long text" },
					],
				},
			}),
		);
		const out = await anysearchSearch(
			anon,
			"温州",
			{ max: 50, zone: "cn", language: "zh-CN" },
			undefined,
			f.fn,
			noSleep,
		);
		// Body: clamped count, json format, region, language.
		expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
			query: "温州",
			max_results: 10,
			format: "json",
			zone: "cn",
			language: "zh-CN",
		});
		// Mapped.
		expect(out).toEqual([
			{ title: "T", url: "https://a.example/", snippet: "2026-10-31 消息", date: "2026-10-31" },
			{ title: "", url: "https://b.example/", snippet: "3 hours ago long text", date: "3 hours ago" },
		]);
	});
	it("sends the strict extract body and maps the page", async () => {
		// One page.
		const f = fakeFetch(
			json(200, {
				code: 0,
				data: { url: "https://a.example/p", title: "P", content: "（发布时间：2026-10-30）正文" },
			}),
		);
		const page = await anysearchExtract(anon, "https://a.example/p", undefined, f.fn, noSleep);
		// Exactly {url}.
		expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ url: "https://a.example/p" });
		expect(page).toEqual({
			url: "https://a.example/p",
			title: "P",
			content: "（发布时间：2026-10-30）正文",
			date: "2026-10-30",
		});
		// No date in the text: the address's path date.
		const g = fakeFetch(json(200, { code: 0, data: { url: "https://r.example/x-2026-11-01/", content: "正文" } }));
		expect((await anysearchExtract(anon, "https://r.example/x-2026-11-01/", undefined, g.fn, noSleep)).date).toBe(
			"2026-11-01",
		);
	});
});
