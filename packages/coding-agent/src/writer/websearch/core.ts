/**
 * Web search plugin core: configuration, result normalization and the reports the model reads.
 * Backends (anysearch.ts, sf.ts) return SearchResult / FetchResult; everything here is pure.
 */

// Engine names of the browser backend.
import { type EngineName, parseEngines } from "../browser/engines.ts";
// JW_VERIFY_WAIT.
import { verifyWaitMs } from "../browser/search.ts";
// Output messages.
import { t, type WriterLang } from "../i18n/index.ts";

/** One search result. */
export interface SearchResult {
	// Title ("" when the source gives none).
	title: string;
	// Address.
	url: string;
	// Short summary ("" when none).
	snippet: string;
	// Publication date YYYY-MM-DD or a relative-time marker ("" when unknown).
	date: string;
}

/** One fetched page. */
export interface FetchResult {
	// Address that was fetched (after redirects when the backend knows it).
	url: string;
	// Title ("" when none).
	title: string;
	// Page text (Markdown or plain text).
	content: string;
	// Publication date or relative-time marker ("" when unknown).
	date: string;
	// The site's own name when the page gives one.
	site?: string;
	// Text left out because a reader of the page cannot see it (browser method).
	filtered?: string[];
	// The text may not be the page asked for: a wall of some kind (browser method).
	unsure?: boolean;
}

/** Plugin configuration from JW_SEARCH_* and JW_SF. */
export interface SearchConfig {
	// AnySearch API root.
	anysearchUrl: string;
	// AnySearch key ("" = anonymous).
	anysearchKey: string;
	// DeepSeek-style search API root.
	deepseekUrl: string;
	// Its key ("" = the method is not available).
	deepseekKey: string;
	// Firecrawl API root.
	firecrawlUrl: string;
	// Its key ("" = the method is not available).
	firecrawlKey: string;
	// Explicit sf path ("" = look in the standard places).
	sfPath: string;
	// Timeout of one backend call (ms).
	timeoutMs: number;
	// Hosts whose results are dropped (suffix match).
	blocklist: string[];
	// Browser backend: engines in order.
	engines: EngineName[];
	// Browser backend: results pages per engine (3–5).
	pages: number;
	// Longest wait for a person to clear a verification page (JW_VERIFY_WAIT, ms; 0: no wait).
	verifyWaitMs: number;
}

/** Default AnySearch API root. */
export const DEFAULT_ANYSEARCH_URL = "https://api.anysearch.com";
/** Default DeepSeek-style search API root. */
export const DEFAULT_DEEPSEEK_URL = "https://api.deepseek.com";
/** Default Firecrawl API root. */
export const DEFAULT_FIRECRAWL_URL = "https://api.firecrawl.dev";
/** Default timeout of one call (s): a browser-driven sf search can take minutes. */
export const DEFAULT_TIMEOUT_S = 300;
/** Longest page text handed to the model (characters). */
export const MAX_FETCH_CHARS = 24_000;

/** Read the plugin configuration. */
export function readSearchEnv(env: NodeJS.ProcessEnv): SearchConfig {
	// Pages per engine: 3–5, default 3.
	const pages = Math.round(Number(env.JW_SEARCH_PAGES ?? ""));
	// Timeout in seconds (positive number), else the default.
	const seconds = Number(env.JW_SEARCH_TIMEOUT ?? "");
	// The configuration.
	return {
		anysearchUrl: (env.JW_SEARCH_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_ANYSEARCH_URL,
		anysearchKey: (env.ANYSEARCH_KEY ?? "").trim(),
		deepseekUrl: (env.JW_DEEPSEEK_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_DEEPSEEK_URL,
		deepseekKey: (env.DEEPSEEK_KEY ?? "").trim(),
		firecrawlUrl: (env.JW_FIRECRAWL_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_FIRECRAWL_URL,
		firecrawlKey: (env.FIRECRAWL_KEY ?? "").trim(),
		sfPath: (env.JW_SF ?? "").trim(),
		timeoutMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_S) * 1000,
		blocklist: (env.JW_SEARCH_BLOCK ?? "")
			.split(/[,\s]+/)
			.map((h) => h.trim().toLowerCase().replace(/^\.+/, ""))
			.filter(Boolean),
		engines: parseEngines(env.JW_ENGINES),
		pages: Number.isFinite(pages) && pages > 0 ? Math.max(3, Math.min(5, pages)) : 3,
		verifyWaitMs: verifyWaitMs(env.JW_VERIFY_WAIT),
	};
}

/** True for an absolute http(s) URL. */
export function isHttpUrl(url: string): boolean {
	// Parse; anything else is refused.
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/** Host of a URL in lower case ("" when it does not parse). */
export function hostOf(url: string): string {
	// Parse.
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** True when host is a blocked domain or one of its subdomains. */
export function isBlocked(host: string, blocklist: readonly string[]): boolean {
	// Label-aligned suffix match.
	return blocklist.some((d) => host === d || host.endsWith(`.${d}`));
}

// Every date a backend or page gives becomes one calendar day, YYYY-MM-DD, or nothing (2026-11-10, the user: "The
// source material must include accurate timestamps"; "if there's no date, don't write it down"). The model never
// works a date out of 9小时前 or Nov 7, 2026 itself.

// Absolute dates: 2026-10-31, 2026/10/31, 2026.10.31, 2026年10月31日.
const DATE_RE = /(20\d{2})[-/.年](1[0-2]|0?[1-9])[-/.月](3[01]|[12]\d|0?[1-9])日?/;
// English month names, as firecrawl's news results give them.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
// Nov 7, 2026 / November 7 2026, and 7 Nov 2026 / 7 November, 2026.
const EN_MDY_RE = new RegExp(`\\b${MONTH}\\s+(3[01]|[12]\\d|0?[1-9]),?\\s+(20\\d{2})\\b`, "i");
const EN_DMY_RE = new RegExp(`\\b(3[01]|[12]\\d|0?[1-9])\\s+${MONTH},?\\s+(20\\d{2})\\b`, "i");
// Ages within days: 3 hours ago, 2 days ago, 5 分钟前, 9小时前, 3 天前, 昨天, 前天, 刚刚.
const RELATIVE_RE =
	/\b(\d{1,2})\s*(minutes?|mins?|hours?|hrs?|days?)\s+ago\b|(\d{1,2})\s*(分钟|小时|天)前|(昨天|前天|刚刚|今天)/i;

/** A calendar day as YYYY-MM-DD. */
function day(y: number | string, m: number | string, d: number | string): string {
	return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The first absolute date in text as YYYY-MM-DD (numbers, 年月日 or an English month), else "". */
export function absoluteDate(text: string): string {
	const m = DATE_RE.exec(text);
	if (m) return day(m[1], m[2], m[3]);
	const a = EN_MDY_RE.exec(text);
	if (a) return day(a[3], MONTHS.indexOf(a[1].toLowerCase()) + 1, a[2]);
	const b = EN_DMY_RE.exec(text);
	return b ? day(b[3], MONTHS.indexOf(b[2].toLowerCase()) + 1, b[1]) : "";
}

/** The local day an age given as 9小时前 or 3 days ago points to, counted back from `now`; "" when text has none. */
export function relativeDate(text: string, now: number): string {
	const r = RELATIVE_RE.exec(text);
	if (!r) return "";
	// The age in hours: minutes and 刚刚 count as now, days as 24 hours, 昨天 and 前天 as one and two days.
	const n = Number(r[1] ?? r[3] ?? 0);
	const unit = (r[2] ?? r[4] ?? r[5] ?? "").toLowerCase();
	// 昨天 and 前天 first: they end in 天 too.
	const named = unit === "昨天" ? 24 : unit === "前天" ? 48 : -1;
	const hours = named >= 0 ? named : /^h|小时/.test(unit) ? n : /^d|天$/.test(unit) ? n * 24 : 0;
	const at = new Date(now - hours * 3600_000);
	return day(at.getFullYear(), at.getMonth() + 1, at.getDate());
}

/** A search result's date as YYYY-MM-DD: an absolute date, else its age counted back from `now`, else "". */
export function dayOf(text: string, now: number = Date.now()): string {
	return absoluteDate(text) || relativeDate(text, now);
}

/**
 * A fetched page's date: an absolute date in its first `head` characters, else the one in its address. A relative
 * marker in a page is its menus ("刚刚" in a 2025 article on jiemian.com, 2026-11-10), not its age; and a page whose
 * text has no date (finance.sina.cn) still has one in its address.
 */
export function pageDate(content: string, url: string, head = 3000): string {
	return absoluteDate(content.slice(0, head)) || urlDate(url);
}

// Compact path dates: /20261101/ (news.cn) and /2026/1101/ (people.com.cn), not inside longer numbers.
const COMPACT_DATE_RE = /(?<!\d)(20\d{2})\/?(1[0-2]|0[1-9])(3[01]|[12]\d|0[1-9])(?!\d)/;

/** Date written in a URL's path (…-2026-11-01/, /2026/11/01/, /20261101/) as YYYY-MM-DD, else "". */
export function urlDate(url: string): string {
	// Path only: hosts and query strings carry ids, not dates.
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		return "";
	}
	// Separated forms, as in text.
	const m = DATE_RE.exec(path);
	if (m) return day(m[1], m[2], m[3]);
	// Compact forms.
	const c = COMPACT_DATE_RE.exec(path);
	// The date or nothing.
	return c ? `${c[1]}-${c[2]}-${c[3]}` : "";
}

// Characters a reader cannot see: zero-width and bidirectional marks, variation selectors, the BOM and the
// tag block U+E0000–U+E0FFF. They can hide or reorder words in what a program reads.
const INVISIBLE =
	// biome-ignore lint/suspicious/noMisleadingCharacterClass: separate characters, none meant to combine with the next.
	/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]|\uDB40[\uDC00-\uDFFF]/g;

/** Web text without HTML comments and characters a reader cannot see, from every backend. */
export function cleanWebText(text: string): string {
	// Comments first: they may span lines.
	return text.replace(/<!--[\s\S]*?-->/g, "").replace(INVISIBLE, "");
}

/** How much of a snippet is searched for its date. */
const DATE_CHARS = 300;

/** Clean a backend's raw results: everything stays except hosts the user blocked and repeats; dates become days. */
export function normalizeResults(
	raw: readonly SearchResult[],
	blocklist: readonly string[],
	// The moment of the search, for ages such as 9小时前.
	now: number = Date.now(),
): SearchResult[] {
	// Kept results.
	const out: SearchResult[] = [];
	// URLs already kept (without the fragment).
	const seen = new Set<string>();
	// Each raw result.
	for (const r of raw) {
		// Dedupe key.
		const key = r.url.replace(/#.*$/, "");
		// Duplicates and blocked hosts are dropped.
		if ((key && seen.has(key)) || isBlocked(hostOf(r.url), blocklist)) continue;
		seen.add(key);
		// Snippet in one line, in full.
		const snippet = cleanWebText(r.snippet).replace(/\s+/g, " ").trim();
		// Date from the backend, else from the title/snippet, else from the URL path.
		out.push({
			title: cleanWebText(r.title).trim() || r.url,
			url: r.url,
			snippet,
			// The head of the text only: further in, a date is about something else.
			date: r.date || dayOf(`${r.title} ${snippet.slice(0, DATE_CHARS)}`, now) || urlDate(r.url),
		});
	}
	// The results.
	return out;
}

/** The search_web report: heading and numbered results. */
export function formatSearch(
	query: string,
	backend: string,
	results: readonly SearchResult[],
	lang?: WriterLang,
): string {
	// Nothing found.
	if (results.length === 0) return t("search.none", { query }, lang);
	// One block per result.
	const items = results.map((r, i) =>
		t(
			"search.item",
			{
				n: i + 1,
				title: r.title,
				url: r.url,
				snippet: r.snippet,
				date: r.date ? t("search.date", { date: r.date }, lang) : "",
			},
			lang,
		),
	);
	// Heading, results.
	return [t("search.title", { backend, count: results.length, query }, lang), ...items].join("\n");
}

/** The fetch_web report: heading with source and date, then the bounded text. */
export function formatFetch(page: FetchResult, backend: string, lang?: WriterLang): string {
	// Bounded text.
	const clipped = page.content.length > MAX_FETCH_CHARS;
	// Text the model receives.
	const body = clipped ? page.content.slice(0, MAX_FETCH_CHARS) : page.content;
	// Heading, text, and a note when clipped.
	return [
		t(
			"fetch.title",
			{
				backend,
				title: page.title || page.url,
				url: page.url,
				date: page.date ? t("search.date", { date: page.date }, lang) : "",
				site: page.site?.trim() ? t("fetch.site", { site: page.site.trim() }, lang) : "",
			},
			lang,
		),
		"",
		body.trim(),
		...(clipped ? ["", t("fetch.clipped", { chars: MAX_FETCH_CHARS }, lang)] : []),
	].join("\n");
}
