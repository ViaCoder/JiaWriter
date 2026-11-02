/**
 * web_fetch through the user's Chrome: a result still shown on an open results page is clicked
 * there (and the tab goes back afterwards), any other address opens in a new tab. The page is
 * given time to load or to clear a bot check, scrolled like a reader, and its main text is taken
 * with Readability in the page. Documents (PDF, Word) are downloaded through Chrome and parsed here.
 */

// Word and PDF parsing.
import { docxToPages } from "../docs/docx-read.ts";
import { pdfPages } from "../docs/import.ts";
// Dates in metadata.
import { type FetchResult, findDate } from "../websearch/core.ts";
// Real addresses behind result links.
import { resultTarget } from "./engines.ts";
// Address policy.
import { checkPublicUrl } from "./guard.ts";
// Driver dependencies, timing and open results pages.
import type { BrowserDeps, BrowserTiming, SerpTab } from "./search.ts";

/** The probe.js snapshot. */
export interface Probe {
	// Document title.
	title: string;
	// Length of the visible text.
	textLen: number;
	// First 800 characters of the visible text.
	excerpt: string;
	// A challenge frame (Turnstile, reCAPTCHA, hCaptcha…) is present.
	challengeIframe: boolean;
	// Cloudflare's challenge script is present.
	cfChallenge: boolean;
	// Cloudflare's clearance token is filled in.
	cfCleared: boolean;
}

/** Text every major bot wall shows. */
const CHALLENGE_MARKS = [
	"just a moment",
	"verify you are human",
	"are you a robot",
	"checking your browser",
	"unusual traffic",
	"access denied",
	"请验证",
	"人机验证",
];
/** Visible text that counts as a loaded page (characters). */
const CONTENT_MIN = 200;
/** Longest wait for content to appear or settle (ms). */
const SETTLE_MS = 12_000;
/** Longest wait for a bot check to clear by itself (ms). */
const CHALLENGE_MS = 45_000;
/** Longest wait for Chrome's load event when opening, clicking or going back (ms): busy news sites keep
 * loading ads long after the text is there, and awaitContent watches the text itself. */
const PAGE_LOAD_MS = 10_000;

/** State of a loading page: a bot wall, readable content, or nothing yet. */
export function pageVerdict(p: Probe): "challenge" | "content" | "blank" {
	// A solved check is not a wall.
	if (p.cfCleared) return p.excerpt.length >= CONTENT_MIN ? "content" : "blank";
	// Wall wording on a short page.
	const text = `${p.title} ${p.excerpt}`.toLowerCase();
	const marks = CHALLENGE_MARKS.some((m) => text.includes(m));
	// Real content wins over a consent banner or an embedded captcha widget.
	if (p.excerpt.length >= 500 && !marks) return "content";
	if (p.cfChallenge || p.challengeIframe || (marks && p.excerpt.length < 300)) return "challenge";
	// Enough text.
	return p.excerpt.length >= CONTENT_MIN ? "content" : "blank";
}

/** Document type by address: "pdf", "docx" or "" for a web page. */
export function docKind(url: string, contentType = ""): "pdf" | "docx" | "" {
	// Path ending or declared type.
	let path = "";
	try {
		path = new URL(url).pathname.toLowerCase();
	} catch {
		// Not a URL.
	}
	if (path.endsWith(".pdf") || contentType.includes("application/pdf")) return "pdf";
	if (path.endsWith(".docx") || contentType.includes("wordprocessingml")) return "docx";
	return "";
}

/** Read the probe (an empty snapshot on failure). */
async function probe(deps: BrowserDeps, tab: number): Promise<Probe> {
	// Run in the page's own world (it reads window._cf_chl_opt).
	try {
		const raw = await deps.call("run", { tab, script: "probe", world: "MAIN" }, 20_000);
		return JSON.parse(String(raw)) as Probe;
	} catch {
		return { title: "", textLen: 0, excerpt: "", challengeIframe: false, cfChallenge: false, cfCleared: false };
	}
}

/** Wait until the page shows settled content; "challenge" when a wall stays up, "blank" when nothing came. */
export async function awaitContent(
	deps: BrowserDeps,
	tab: number,
	timing: BrowserTiming,
): Promise<"content" | "challenge" | "blank"> {
	// Deadlines start when each state is first seen.
	let blankSince = -1;
	let chalSince = -1;
	let handed = false;
	let lastLen = -1;
	// Elapsed time by our own sleeps (tests use fake sleeps).
	for (let t = 0; ; t += 1000) {
		const p = await probe(deps, tab);
		const v = pageVerdict(p);
		if (v === "content") {
			// Same text length twice in a row: settled.
			if (p.textLen === lastLen || t >= SETTLE_MS) return "content";
			lastLen = p.textLen;
		} else if (v === "challenge") {
			if (chalSince < 0) chalSince = t;
			// A person may solve it (once, interactive mode only).
			if (deps.interactive && !handed) {
				handed = true;
				await deps.call("activate", { tab }, 10_000).catch(() => {});
				deps.notify?.("verification:page");
			}
			const limit = deps.interactive ? Math.max(CHALLENGE_MS, timing.humanWaitMs) : CHALLENGE_MS;
			if (t - chalSince >= limit) return "challenge";
			// Content after a clearance starts fresh.
			blankSince = -1;
			lastLen = -1;
		} else {
			if (blankSince < 0) blankSince = t;
			if (t - blankSince >= SETTLE_MS) return "blank";
		}
		await deps.sleep(1000);
	}
}

/** Text of a downloaded document as Markdown pages. */
export async function documentText(kind: "pdf" | "docx", bytes: Uint8Array): Promise<string> {
	// Pages with markers when there are several.
	const pages = kind === "pdf" ? await pdfPages(bytes) : docxToPages(bytes);
	return pages.length > 1 ? pages.map((p, i) => `<!-- page ${i + 1} -->\n${p}`).join("\n\n") : (pages[0] ?? "");
}

/** Download a document through Chrome and parse it. */
async function fetchDocument(deps: BrowserDeps, url: string, kind: "pdf" | "docx"): Promise<FetchResult> {
	// Chrome makes the request with the user's cookies.
	const got = (await deps.call("download", { url }, 120_000)) as { base64: string; url: string };
	const text = await documentText(kind, new Uint8Array(Buffer.from(got.base64, "base64")));
	// Title from the file name.
	const name = decodeURIComponent(new URL(got.url || url).pathname.split("/").pop() || url);
	return { url: got.url || url, title: name, content: text, date: "" };
}

/** Fetch one page; serps are the results pages still open (their links are clicked when they hold url); check is the address policy. */
export async function browserFetch(
	deps: BrowserDeps,
	url: string,
	serps: readonly SerpTab[],
	timing: BrowserTiming,
	check: (url: string) => Promise<void> = checkPublicUrl,
): Promise<FetchResult> {
	// Public web addresses only.
	await check(url);
	// Documents by address go straight to the download.
	const kind = docKind(url);
	if (kind) {
		await deps.pace(`host:${new URL(url).hostname}`, timing.hostGapMs);
		return fetchDocument(deps, url, kind);
	}
	// Not too soon after the last visit to this site.
	await deps.pace(`host:${new URL(url).hostname}`, timing.hostGapMs);
	// The tab to read, and how to leave it.
	let tab = -1;
	let leave: "back" | "close" = "close";
	// A results page that shows this link: click it there.
	const serp = serps.find((s) => s.refs[url] !== undefined);
	if (serp) {
		try {
			const info = (await deps.call("info", { tab: serp.tab }, 10_000)) as { url: string };
			// Read the results again (after going back the page may have been reloaded) and find the link.
			const rep =
				info.url === serp.url
					? (JSON.parse(
							String(
								await deps.call(
									"run",
									{ tab: serp.tab, script: "serp", args: { engine: serp.engine } },
									20_000,
								),
							),
						) as {
							results?: { u: string; r: number }[];
						})
					: {};
			const hit = rep.results?.find((x) => resultTarget(x.u) === url);
			if (hit) {
				await deps.sleep(Math.round(600 + deps.random() * 1400));
				const r = (await deps.call(
					"human_click",
					{ tab: serp.tab, target: { ref: hit.r }, run: deps.run, load_ms: Math.min(timing.loadMs, PAGE_LOAD_MS) },
					timing.loadMs + 30_000,
				)) as { clicked: boolean; navigated: boolean; newTab: number | null };
				if (r.newTab !== null && r.newTab !== undefined) tab = r.newTab;
				else if (r.navigated) {
					tab = serp.tab;
					leave = "back";
				}
			}
		} catch {
			// The results tab is gone: open the address instead.
			tab = -1;
		}
	}
	// Otherwise a new tab, as when a person opens a link they were given.
	if (tab < 0) {
		const opened = (await deps.call(
			"open",
			{ url, run: deps.run, load_ms: Math.min(timing.loadMs, PAGE_LOAD_MS) },
			timing.loadMs + 15_000,
		)) as { tab: number };
		tab = opened.tab;
		leave = "close";
	}
	try {
		// Content, a wall, or nothing.
		const state = await awaitContent(deps, tab, timing);
		if (state === "challenge") throw new Error(`blocked: ${url} shows a bot check`);
		// Read like a person: a few wheel turns (lazy content loads too).
		if (state === "content")
			await deps.call("human_scroll", { tab, steps: 2 + Math.floor(deps.random() * 3) }, 40_000);
		// Main text and metadata.
		const art = JSON.parse(String(await deps.call("run", { tab, script: "article" }, 40_000))) as {
			title: string;
			published: string;
			markdown: string;
			contentType: string;
		};
		const meta = JSON.parse(String(await deps.call("run", { tab, script: "meta" }, 20_000))) as {
			pub: string;
			final_url: string;
		};
		// A document Chrome shows in its viewer.
		const shownKind = docKind(meta.final_url || url, art.contentType);
		if (shownKind) return await fetchDocument(deps, meta.final_url || url, shownKind);
		if (!art.markdown.trim()) throw new Error(`no text on ${url}`);
		// The page.
		return {
			url: meta.final_url || url,
			title: art.title,
			content: art.markdown,
			date: findDate(meta.pub || art.published || ""),
		};
	} finally {
		// Back to the results page, or close the tab.
		if (leave === "back") {
			await deps.sleep(Math.round(500 + deps.random() * 1000));
			await deps
				.call("back", { tab, load_ms: Math.min(timing.loadMs, PAGE_LOAD_MS) }, timing.loadMs + 15_000)
				.catch(() => {});
		} else await deps.call("close", { tab }, 10_000).catch(() => {});
	}
}
