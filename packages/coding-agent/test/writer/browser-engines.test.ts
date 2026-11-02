// Unit tests for src/writer/browser/engines.ts, rank.ts, pacing.ts and guard.ts.

// Temp folders.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Modules under test.
import { DEFAULT_ENGINES, ENGINES, parseEngines, resultTarget, withFresh } from "../../src/writer/browser/engines.ts";
import { checkPublicUrl, isPrivateAddress } from "../../src/writer/browser/guard.ts";
import { pace, paceDelay, readPacing, recordVisit } from "../../src/writer/browser/pacing.ts";
import { bm25, rankHits, terms } from "../../src/writer/browser/rank.ts";

// Scratch folder.
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wae-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("ENGINES / parseEngines", () => {
	it("defaults to Bing then Google and keeps a valid custom order", () => {
		expect(DEFAULT_ENGINES).toEqual(["bing", "google"]);
		expect(ENGINES.bing.home).toBe("https://www.bing.com/");
		expect(parseEngines(undefined)).toEqual(["bing", "google"]);
		expect(parseEngines("google, bing, google, baidu")).toEqual(["google", "bing"]);
		expect(parseEngines("baidu")).toEqual(["bing", "google"]);
	});
});

describe("resultTarget", () => {
	it("decodes Bing and Google wrappers and leaves direct links", () => {
		const target = "https://news.example.com/2026/11/01/a?b=1";
		const enc = Buffer.from(target).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(resultTarget(`https://www.bing.com/ck/a?!&&p=abc&u=a1${enc}&ntb=1`)).toBe(target);
		expect(resultTarget(`https://www.google.com/url?q=${encodeURIComponent(target)}&sa=U`)).toBe(target);
		// Google's usual form: an empty q and the target in url (seen on the real results page, 2026-11-02).
		expect(
			resultTarget(
				`https://www.google.com/url?sa=t&rct=j&q=&esrc=s&source=web&url=${encodeURIComponent(target)}&ved=x`,
			),
		).toBe(target);
		expect(resultTarget(target)).toBe(target);
		// Undecodable wrappers stay as they are.
		expect(resultTarget("https://www.bing.com/ck/a?u=zz")).toBe("https://www.bing.com/ck/a?u=zz");
		expect(resultTarget("not a url")).toBe("not a url");
	});
});

describe("withFresh", () => {
	it("adds each engine's time filter and nothing else", () => {
		expect(withFresh("https://www.google.com/search?q=a", "google", "week")).toBe(
			"https://www.google.com/search?q=a&tbs=qdr%3Aw",
		);
		expect(withFresh("https://www.bing.com/search?q=a", "bing", "day")).toBe(
			"https://www.bing.com/search?q=a&filters=ex1%3A%22ez1%22",
		);
		expect(withFresh("https://www.bing.com/search?q=a", "bing", "year")).toBe("https://www.bing.com/search?q=a");
		expect(withFresh("https://www.bing.com/search?q=a", "bing", undefined)).toBe("https://www.bing.com/search?q=a");
	});
});

describe("terms / bm25", () => {
	it("splits English words and Chinese character pairs", () => {
		expect(terms("AI 芯片出口 a 5G")).toEqual(["ai", "芯片", "片出", "出口", "5g"]);
		expect(terms("中")).toEqual(["中"]);
	});
	it("scores documents with the query terms higher", () => {
		const s = bm25(terms("芯片 出口"), [terms("芯片出口管制新规"), terms("天气预报"), terms("芯片")]);
		expect(s[0]).toBeGreaterThan(s[2]);
		expect(s[2]).toBeGreaterThan(s[1]);
		expect(s[1]).toBe(0);
	});
});

describe("rankHits", () => {
	it("merges duplicates, lifts results both engines agree on, and orders by relevance", () => {
		const ranked = rankHits("芯片出口管制", [
			{ engine: "bing", pos: 0, url: "https://a.example.com/x", title: "体育新闻", snippet: "足球" },
			{ engine: "bing", pos: 1, url: "https://b.example.com/y/", title: "芯片出口管制新规发布", snippet: "商务部" },
			{
				engine: "google",
				pos: 0,
				url: "https://b.example.com/y#top",
				title: "芯片出口管制",
				snippet: "更长的摘要：商务部发布",
			},
			{ engine: "google", pos: 1, url: "https://c.example.com/z", title: "出口数据", snippet: "" },
		]);
		expect(ranked.map((r) => r.url)).toEqual([
			"https://b.example.com/y/",
			"https://c.example.com/z",
			"https://a.example.com/x",
		]);
		expect(ranked[0].engines).toEqual(["bing", "google"]);
		expect(ranked[0].snippet).toBe("更长的摘要：商务部发布");
		expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
	});
});

describe("pacing", () => {
	it("computes the remaining jittered gap", () => {
		expect(paceDelay(undefined, 1000, 5000, 0.5)).toBe(0);
		expect(paceDelay(4000, 1000, 4500, 0)).toBe(500);
		expect(paceDelay(4000, 1000, 4500, 1)).toBe(1000);
		expect(paceDelay(0, 1000, 9000, 1)).toBe(0);
	});
	it("records visits, drops entries older than a day, and ignores a broken file", async () => {
		const file = join(dir, "p", "pacing.json");
		expect(readPacing(file)).toEqual({});
		recordVisit(file, "old", 1);
		recordVisit(file, "engine:bing", 90_000_000);
		expect(readPacing(file)).toEqual({ "engine:bing": 90_000_000 });
		writeFileSync(file, "{broken");
		expect(readPacing(file)).toEqual({});
		// A second visit right away waits the gap.
		const waits: number[] = [];
		const sleep = async (ms: number) => {
			waits.push(ms);
		};
		expect(await pace(file, "host:x", 60_000, sleep, () => 0)).toBe(0);
		const w = await pace(file, "host:x", 60_000, sleep, () => 0);
		expect(w).toBeGreaterThan(59_000);
		expect(waits).toEqual([w]);
	});
});

describe("isPrivateAddress / checkPublicUrl", () => {
	it("flags local and reserved addresses", () => {
		for (const ip of [
			"127.0.0.1",
			"10.1.2.3",
			"172.20.0.1",
			"192.168.77.1",
			"169.254.1.1",
			"100.64.0.1",
			"0.0.0.0",
			"::1",
			"fd00::1",
			"fe80::1",
			"::ffff:10.0.0.1",
		])
			expect(isPrivateAddress(ip), ip).toBe(true);
		for (const ip of ["203.0.113.5", "198.51.100.7", "8.8.8.8", "2001:db8::1", "example.com"])
			expect(isPrivateAddress(ip), ip).toBe(false);
	});
	it("refuses other schemes, local names and names resolving to private addresses", async () => {
		const lookup = async (h: string) => (h === "intra.example.com" ? ["192.168.77.5"] : ["203.0.113.9"]);
		await expect(checkPublicUrl("https://news.example.com/a", lookup)).resolves.toBeUndefined();
		await expect(checkPublicUrl("file:///etc/passwd", lookup)).rejects.toThrow(/http/);
		await expect(checkPublicUrl("http://localhost:8080/", lookup)).rejects.toThrow(/local/);
		await expect(checkPublicUrl("http://[::1]/", lookup)).rejects.toThrow(/local network/);
		await expect(checkPublicUrl("http://intra.example.com/", lookup)).rejects.toThrow(/local network/);
		await expect(checkPublicUrl("nonsense", lookup)).rejects.toThrow(/web address/);
		// A name this computer cannot resolve is left to Chrome.
		await expect(
			checkPublicUrl("https://x.example.com/", async () => Promise.reject(new Error("ENOTFOUND"))),
		).resolves.toBeUndefined();
	});
});
