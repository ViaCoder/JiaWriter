// Functional tests for src/writer/browser/search.ts and fetch.ts against a scripted fake extension:
// the order of human actions (open, consent click, typing, Enter, scrolling, Next), page limits,
// challenges with and without a person, result ranking, and reading pages and documents.

// Test API.
import { describe, expect, it } from "vitest";
// Engine definitions.
import { ENGINES } from "../../src/writer/browser/engines.ts";
// Modules under test.
import {
	awaitContent,
	browserFetch,
	docKind,
	documentText,
	type Probe,
	pageVerdict,
} from "../../src/writer/browser/fetch.ts";
import {
	type BrowserDeps,
	browserSearch,
	clampPages,
	DEFAULT_TIMING,
	type SerpTab,
	searchEngine,
	VERIFY_WAIT_DEFAULT_S,
	type VerifyEvent,
	verifyWaitMs,
} from "../../src/writer/browser/search.ts";
// Document fixtures.
import { makeDocx, makePdf, wp } from "./doc-fixtures.ts";

/** Behaviour of one fake engine. */
interface EngineScript {
	// Results pages it has.
	pages: number;
	// Consent dialog on the home page.
	consent?: boolean;
	// Bot check instead of results (until a person solves it after `solveAfter` looks).
	challenge?: boolean;
	solveAfter?: number;
	// No search box.
	noBox?: boolean;
	// Enter does not submit.
	enterDead?: boolean;
	// A verification page already on the home page (cleared after `solveAfter` looks).
	homeChallenge?: boolean;
	// The pager is drawn only after reading further down.
	lazyNext?: boolean;
	// Results load in place when scrolled to the bottom (pages counts the loads).
	infinite?: boolean;
}

/** A fake extension for search: every call is logged as "op" or "op:detail". */
function fakeSearch(scripts: Record<string, EngineScript>, interactive = false) {
	// Call log.
	const log: string[] = [];
	// Tab id → engine and page shown (0 = home).
	const tabs = new Map<number, { engine: string; page: number; looks: number; scrolled: boolean }>();
	let nextTab = 1;
	// Pacing keys.
	const paced: string[] = [];
	// Interface notes.
	const notes: VerifyEvent[] = [];
	// Set to true to act as Esc.
	const esc = { on: false };
	// Timeouts given to the typing calls.
	const typeMs: number[] = [];
	const deps: BrowserDeps = {
		call: async (op, args, ms) => {
			const tab = args.tab as number;
			const st = tabs.get(tab);
			if (op === "open") {
				const engine = ["bing", "baidu", "sogou"].find((e) => String(args.url).includes(e)) ?? "google";
				tabs.set(nextTab, { engine, page: 0, looks: 0, scrolled: false });
				log.push(`open:${engine}`);
				return { tab: nextTab++ };
			}
			if (op === "run" && args.script === "serp" && st) {
				const sc = scripts[st.engine];
				st.looks++;
				if (st.page === 0)
					return JSON.stringify({
						results: [],
						next: false,
						challenge: !!sc.homeChallenge && st.looks <= (sc.solveAfter ?? Number.POSITIVE_INFINITY),
						consent: !!sc.consent,
						url: `https://${st.engine}/`,
					});
				if (sc.challenge && st.looks <= (sc.solveAfter ?? Number.POSITIVE_INFINITY))
					return JSON.stringify({ results: [], next: false, challenge: true, consent: false, url: "" });
				// An infinite page lists every load so far; a paged one only the current page.
				const shown = sc.infinite ? Array.from({ length: st.page }, (_, k) => k + 1) : [st.page];
				const results = shown.flatMap((pg, k) =>
					[0, 1].map((i) => ({
						u: `https://site${i}.example.com/${st.engine}/p${pg}`,
						t: `芯片 ${st.engine} ${pg}-${i}`,
						s: "出口管制",
						r: k * 2 + i,
					})),
				);
				return JSON.stringify({
					results,
					next: st.page < sc.pages && (!sc.lazyNext || st.scrolled),
					challenge: false,
					consent: false,
					url: `https://${st.engine}/search?p=${st.page}`,
				});
			}
			if (op === "human_type" && st) {
				log.push(`type:${args.text}`);
				typeMs.push(ms ?? 0);
				if (scripts[st.engine].noBox) return { typed: false };
				if (scripts[st.engine].enterDead) return { typed: true, navigated: false };
				st.page = 1;
				return { typed: true, navigated: true, newTab: null };
			}
			if (op === "human_click" && st) {
				const target = args.target as { selectors: string[]; text?: string };
				if (target.text) log.push(`text:${target.text}`);
				const what = /pnnext|sb_pagN|#page a|sogou_next/.test(target.selectors.join(" "))
					? "next"
					: target.selectors.join(" ").includes("consent") || target.selectors.includes("#bnp_btn_accept")
						? "consent"
						: "submit";
				log.push(`click:${what}`);
				if (what === "next") {
					st.page++;
					st.scrolled = false;
				}
				if (what === "submit") st.page = 1;
				return { clicked: true, navigated: what !== "consent", newTab: null };
			}
			if (op === "navigate") {
				log.push(`navigate:${args.url}`);
				return {};
			}
			// Looking for Next on screen (not logged: it does not touch the page).
			if (op === "find" && st) {
				const sc = scripts[st.engine];
				return {
					found: st.page > 0 && st.page < sc.pages && !sc.infinite && (!sc.lazyNext || st.scrolled),
					via: "ax",
				};
			}
			if (op === "human_scroll" && st && args.px === 800) st.scrolled = true;
			// A scroll to the bottom loads the next batch of an infinite page.
			if (
				op === "human_scroll" &&
				st &&
				args.px === 900 &&
				scripts[st.engine].infinite &&
				st.page < scripts[st.engine].pages
			)
				st.page++;
			log.push(op);
			return true;
		},
		sleep: async () => {},
		random: () => 0.5,
		pace: async (key) => {
			paced.push(key);
		},
		interactive,
		notify: (n) => notes.push(n),
		aborted: () => esc.on,
		run: "t",
	};
	return { deps, log, paced, notes, esc, typeMs };
}

/** Options with no real waits. */
const opts = (pages = 3, extra = {}) => ({
	engines: ["bing", "google"] as const,
	pages,
	timing: DEFAULT_TIMING,
	...extra,
});

describe("clampPages", () => {
	it("keeps 3–5 pages per engine", () => {
		expect(clampPages(undefined)).toBe(3);
		expect(clampPages(1)).toBe(3);
		expect(clampPages(4)).toBe(4);
		expect(clampPages(9)).toBe(5);
		expect(clampPages(Number.NaN)).toBe(3);
	});
});

describe("searchEngine / browserSearch", () => {
	it("searches Bing then Google like a person, 3 pages each, and ranks the merged results", async () => {
		const f = fakeSearch({ bing: { pages: 5, consent: true }, google: { pages: 5 } });
		const out = await browserSearch(f.deps, "芯片出口管制", { ...opts(3), engines: ["bing", "google"] });
		// Bing first: open, consent click, type, scroll and Next twice, scroll; then Google.
		expect(f.log).toEqual([
			"open:bing",
			"click:consent",
			"type:芯片出口管制",
			"human_scroll",
			"click:next",
			"human_scroll",
			"click:next",
			"human_scroll",
			"open:google",
			"type:芯片出口管制",
			"human_scroll",
			"click:next",
			"human_scroll",
			"click:next",
			"human_scroll",
		]);
		expect(f.paced).toEqual(["engine:bing", "engine:google"]);
		expect(out.outcomes.map((o) => [o.engine, o.pages, o.stopped])).toEqual([
			["bing", 3, ""],
			["google", 3, ""],
		]);
		// 2 results × 3 pages × 2 engines, all different addresses.
		expect(out.ranked).toHaveLength(12);
		// The last results page of each engine stays open with its links.
		expect(out.outcomes[0].serp?.refs).toEqual({
			"https://site0.example.com/bing/p3": 0,
			"https://site1.example.com/bing/p3": 1,
		});
	});

	it("stops at the engine's last page and at five pages at most", async () => {
		const f = fakeSearch({ bing: { pages: 2 }, google: { pages: 9 } });
		const out = await browserSearch(f.deps, "q", { ...opts(5), engines: ["bing", "google"] });
		expect(out.outcomes.map((o) => o.pages)).toEqual([2, 5]);
	});

	it("gives up on a challenge in print mode and closes that tab", async () => {
		const f = fakeSearch({ bing: { pages: 3, challenge: true }, google: { pages: 3 } });
		const o = await searchEngine(f.deps, "bing", "q", { ...opts(3), engines: ["bing"] });
		expect(o.stopped).toBe("verification");
		expect(o.serp).toBeNull();
		expect(f.log.at(-1)).toBe("close");
	});

	it("hands a challenge to the person in interactive mode and continues once it is solved", async () => {
		const f = fakeSearch({ bing: { pages: 3, challenge: true, solveAfter: 10 }, google: { pages: 3 } }, true);
		const o = await searchEngine(f.deps, "bing", "q", { ...opts(3), engines: ["bing"] });
		expect(f.log).toContain("activate");
		expect(f.notes).toEqual([
			{ kind: "verify", engine: "bing", seconds: VERIFY_WAIT_DEFAULT_S },
			{ kind: "verify_ok", engine: "bing" },
		]);
		expect(o.pages).toBe(3);
	});

	it("reports a missing search box, clicks the button when Enter does not submit, and applies a time filter", async () => {
		const noBox = fakeSearch({ bing: { pages: 3, noBox: true }, google: { pages: 3 } });
		expect((await searchEngine(noBox.deps, "bing", "q", opts())).stopped).toBe("no search box");
		const dead = fakeSearch({ bing: { pages: 3, enterDead: true }, google: { pages: 3 } });
		const o = await searchEngine(dead.deps, "bing", "q", { ...opts(), fresh: "day" });
		expect(dead.log.slice(0, 3)).toEqual(["open:bing", "type:q", "click:submit"]);
		expect(dead.log).toContain("navigate:https://bing/search?p=1&filters=ex1%3A%22ez1%22");
		expect(o.pages).toBe(3);
	});
});

describe("pageVerdict / docKind", () => {
	const p = (over: Partial<Probe>): Probe => ({
		title: "",
		textLen: 0,
		excerpt: "",
		challengeIframe: false,
		cfChallenge: false,
		cfCleared: false,
		...over,
	});
	it("tells walls, content and empty pages apart", () => {
		expect(pageVerdict(p({ excerpt: "x".repeat(600) }))).toBe("content");
		expect(pageVerdict(p({ excerpt: "x".repeat(600), challengeIframe: true }))).toBe("content");
		expect(pageVerdict(p({ excerpt: "Just a moment...", cfChallenge: true }))).toBe("challenge");
		expect(pageVerdict(p({ title: "Access denied", excerpt: "Access denied" }))).toBe("challenge");
		expect(pageVerdict(p({ excerpt: "short" }))).toBe("blank");
		expect(pageVerdict(p({ excerpt: "x".repeat(250), cfCleared: true, cfChallenge: true }))).toBe("content");
	});
	it("recognises documents by path and type", () => {
		expect(docKind("https://a.example.com/r.PDF")).toBe("pdf");
		expect(docKind("https://a.example.com/r", "application/pdf")).toBe("pdf");
		expect(docKind("https://a.example.com/r.docx")).toBe("docx");
		expect(docKind("https://a.example.com/r.html", "text/html")).toBe("");
	});
});

/** A fake extension for fetch: one page whose probe and article are given. */
function fakeFetch(probes: Probe[], extra: { serpUrl?: string; newTab?: boolean; interactive?: boolean } = {}) {
	const log: string[] = [];
	let look = 0;
	const deps: BrowserDeps = {
		call: async (op, args) => {
			log.push(op === "run" ? `run:${args.script}` : op);
			if (op === "open") return { tab: 7 };
			if (op === "info") return { url: extra.serpUrl ?? "" };
			if (op === "run" && args.script === "serp")
				return JSON.stringify({ results: [{ u: "https://news.example.com/a", r: 4 }], url: extra.serpUrl });
			if (op === "human_click")
				return extra.newTab
					? { clicked: true, navigated: false, newTab: 8 }
					: { clicked: true, navigated: true, newTab: null };
			if (op === "run" && args.script === "probe")
				return JSON.stringify(probes[Math.min(look++, probes.length - 1)]);
			if (op === "run" && args.script === "article")
				return JSON.stringify({
					title: "标题",
					published: "",
					markdown: "# 标题\n\n正文",
					contentType: "text/html",
				});
			if (op === "run" && args.script === "meta")
				return JSON.stringify({ pub: "2026-10-31T08:00:00Z", final_url: "https://news.example.com/a" });
			if (op === "download")
				return {
					base64: Buffer.from(makePdf(["first page text", "second page text"])).toString("base64"),
					url: String(args.url),
				};
			return true;
		},
		sleep: async () => {},
		random: () => 0,
		pace: async () => {},
		interactive: !!extra.interactive,
		run: "t",
	};
	return { deps, log };
}

const ok = async () => {};
const content: Probe = {
	title: "t",
	textLen: 900,
	excerpt: "y".repeat(900),
	challengeIframe: false,
	cfChallenge: false,
	cfCleared: false,
};
const wall: Probe = {
	title: "Just a moment",
	textLen: 20,
	excerpt: "Just a moment",
	challengeIframe: false,
	cfChallenge: true,
	cfCleared: false,
};

describe("awaitContent", () => {
	it("returns content once its length is stable, and gives up on a lasting wall or an empty page", async () => {
		expect(await awaitContent(fakeFetch([content]).deps, 1, DEFAULT_TIMING)).toBe("content");
		expect(await awaitContent(fakeFetch([wall]).deps, 1, DEFAULT_TIMING)).toBe("challenge");
		const blank = { ...content, textLen: 3, excerpt: "abc" };
		expect(await awaitContent(fakeFetch([blank]).deps, 1, DEFAULT_TIMING)).toBe("blank");
		// A wall that clears.
		expect(await awaitContent(fakeFetch([wall, wall, content]).deps, 1, DEFAULT_TIMING)).toBe("content");
	});
});

describe("documentText", () => {
	it("reads PDF pages with markers and a Word file", async () => {
		expect(await documentText("pdf", makePdf(["alpha page", "beta page"]))).toMatch(
			/<!-- page 1 -->[\s\S]*alpha page[\s\S]*<!-- page 2 -->[\s\S]*beta page/,
		);
		expect(await documentText("docx", makeDocx(wp("正文一段")))).toContain("正文一段");
	});
});

describe("browserFetch", () => {
	const serp: SerpTab = {
		engine: "bing",
		tab: 3,
		url: "https://bing/search?p=1",
		refs: { "https://news.example.com/a": 4 },
	};

	it("clicks a result on the open results page, reads it, and goes back", async () => {
		const f = fakeFetch([content], { serpUrl: serp.url });
		const page = await browserFetch(f.deps, "https://news.example.com/a", [serp], DEFAULT_TIMING, ok);
		expect(page).toEqual({
			url: "https://news.example.com/a",
			title: "标题",
			content: "# 标题\n\n正文",
			date: "2026-10-31",
		});
		expect(f.log).toEqual([
			"info",
			"run:serp",
			"human_click",
			"run:probe",
			"run:probe",
			"human_scroll",
			"run:article",
			"run:meta",
			"back",
		]);
	});

	it("closes the tab a result link opened, and opens other addresses in a new tab", async () => {
		const nt = fakeFetch([content], { serpUrl: serp.url, newTab: true });
		await browserFetch(nt.deps, "https://news.example.com/a", [serp], DEFAULT_TIMING, ok);
		expect(nt.log.at(-1)).toBe("close");
		const other = fakeFetch([content], { serpUrl: "https://bing/elsewhere" });
		await browserFetch(other.deps, "https://news.example.com/a", [serp], DEFAULT_TIMING, ok);
		expect(other.log.slice(0, 2)).toEqual(["info", "open"]);
		expect(other.log.at(-1)).toBe("close");
	});

	it("reports a lasting bot check, downloads documents, and applies the address policy", async () => {
		const blocked = fakeFetch([wall]);
		await expect(browserFetch(blocked.deps, "https://x.example.com/", [], DEFAULT_TIMING, ok)).rejects.toThrow(
			/blocked/,
		);
		expect(blocked.log.at(-1)).toBe("close");
		const doc = fakeFetch([content]);
		const pdf = await browserFetch(
			doc.deps,
			"https://x.example.com/files/%E6%8A%A5%E5%91%8A.pdf",
			[],
			DEFAULT_TIMING,
			ok,
		);
		expect(pdf.title).toBe("报告.pdf");
		expect(pdf.content).toContain("second page text");
		expect(doc.log).toEqual(["download"]);
		const refuse = async () => Promise.reject(new Error("local network address refused"));
		await expect(browserFetch(doc.deps, "http://192.168.77.1/", [], DEFAULT_TIMING, refuse)).rejects.toThrow(
			/refused/,
		);
	});
});

describe("verifyWaitMs", () => {
	it("reads JW_VERIFY_WAIT as whole seconds, 0–300, with 90 by default", () => {
		expect(verifyWaitMs(undefined)).toBe(90_000);
		expect(verifyWaitMs("")).toBe(90_000);
		expect(verifyWaitMs("0")).toBe(0);
		expect(verifyWaitMs("45")).toBe(45_000);
		expect(verifyWaitMs("999")).toBe(300_000);
		expect(verifyWaitMs("-1")).toBe(90_000);
		expect(verifyWaitMs("soon")).toBe(90_000);
	});
});

describe("verification waits", () => {
	it("gives up after the configured wait with a 30-second reminder, and reports it", async () => {
		// Never solved; a 60 s wait.
		const f = fakeSearch({ bing: { pages: 3, challenge: true } }, true);
		const o = await searchEngine(f.deps, "bing", "q", {
			...opts(3),
			engines: ["bing"],
			timing: { ...DEFAULT_TIMING, humanWaitMs: 60_000 },
		});
		expect(o.stopped).toBe("verification");
		expect(f.notes).toEqual([
			{ kind: "verify", engine: "bing", seconds: 60 },
			{ kind: "verify_left", engine: "bing", seconds: 30 },
			{ kind: "verify_timeout", engine: "bing" },
		]);
	});

	it("does not wait at all with JW_VERIFY_WAIT=0", async () => {
		// Interactive, but waiting is off.
		const f = fakeSearch({ bing: { pages: 3, challenge: true, solveAfter: 2 } }, true);
		const o = await searchEngine(f.deps, "bing", "q", {
			...opts(3),
			engines: ["bing"],
			timing: { ...DEFAULT_TIMING, humanWaitMs: 0 },
		});
		expect([o.stopped, f.notes.length]).toEqual(["verification", 0]);
	});

	it("ends the wait at once on Esc and searches no further engine", async () => {
		// Esc pressed while the person is asked.
		const f = fakeSearch({ bing: { pages: 3, challenge: true }, google: { pages: 3 } }, true);
		const notify = f.deps.notify;
		f.deps.notify = (ev) => {
			notify?.(ev);
			if (ev.kind === "verify") f.esc.on = true;
		};
		const out = await browserSearch(f.deps, "q", { ...opts(3), engines: ["bing", "google"] });
		expect(out.outcomes.map((o) => [o.engine, o.stopped])).toEqual([["bing", "aborted"]]);
		expect(f.log).not.toContain("open:google");
	});

	it("waits for a verification shown on the home page before typing", async () => {
		// Cleared after a few looks.
		const f = fakeSearch({ baidu: { pages: 3, homeChallenge: true, solveAfter: 3 } }, true);
		const o = await searchEngine(f.deps, "baidu", "国务院 政策", { ...opts(3), engines: ["baidu"] });
		expect(f.notes[0]).toEqual({ kind: "verify", engine: "baidu", seconds: VERIFY_WAIT_DEFAULT_S });
		expect(f.log).toContain("type:国务院 政策");
		expect(o.pages).toBe(3);
	});

	it("skips a resting engine without opening it", async () => {
		// Bing rests after an earlier uncleared verification.
		const f = fakeSearch({ bing: { pages: 3 }, baidu: { pages: 3 } });
		const out = await browserSearch(f.deps, "q", {
			...opts(3),
			engines: ["bing", "baidu"],
			resting: new Set(["bing"] as const),
		});
		expect(out.outcomes.map((o) => [o.engine, o.stopped, o.pages])).toEqual([
			["bing", "verification (resting)", 0],
			["baidu", "", 3],
		]);
		expect(f.log).not.toContain("open:bing");
	});
});

describe("paging and typing", () => {
	it("reads further down when the pager is drawn late, and clicks Next by its label", async () => {
		// A pager drawn late (Baidu selectors).
		const f = fakeSearch({ baidu: { pages: 3, lazyNext: true } });
		const o = await searchEngine(f.deps, "baidu", "q", { ...opts(3), engines: ["baidu"] });
		expect(o.pages).toBe(3);
		expect(f.log).toContain("text:^\\s*下一页");
	});

	it("gives typing more time for longer queries", async () => {
		// 4 characters and 20 characters.
		const f = fakeSearch({ bing: { pages: 1 } });
		await searchEngine(f.deps, "bing", "abcd", { ...opts(3), engines: ["bing"] });
		await searchEngine(f.deps, "bing", "a".repeat(20), { ...opts(3), engines: ["bing"] });
		expect(f.typeMs).toEqual([DEFAULT_TIMING.loadMs + 30_000 + 4 * 1500, DEFAULT_TIMING.loadMs + 30_000 + 20 * 1500]);
	});
});

describe("pages that load more in place", () => {
	it("scrolls to the bottom for each further page and counts only the new results", async () => {
		// Sogou-like: two loads available, three pages asked for.
		const f = fakeSearch({ sogou: { pages: 2, infinite: true } });
		const o = await searchEngine(f.deps, "sogou", "q", {
			...opts(3),
			engines: ["sogou"],
			specs: { ...ENGINES, sogou: { ...ENGINES.sogou, infinite: true } },
		});
		expect(o.pages).toBe(2);
		expect(o.hits.map((h) => h.url)).toEqual([
			"https://site0.example.com/sogou/p1",
			"https://site1.example.com/sogou/p1",
			"https://site0.example.com/sogou/p2",
			"https://site1.example.com/sogou/p2",
		]);
		// No Next click on such a page.
		expect(f.log.some((l) => l === "click:next")).toBe(false);
	});
});
