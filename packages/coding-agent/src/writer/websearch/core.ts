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

// Absolute dates: 2026-10-31, 2026/10/31, 2026.10.31, 2026年10月31日.
const DATE_RE = /(20\d{2})[-/.年](1[0-2]|0?[1-9])[-/.月](3[01]|[12]\d|0?[1-9])日?/;
// Relative markers within days: 3 hours ago, 2 days ago, 5 分钟前, 2 小时前, 3 天前, 昨天, 刚刚.
const RELATIVE_RE = /\b\d{1,2}\s*(?:minutes?|mins?|hours?|hrs?|days?)\s+ago\b|\d{1,2}\s*(?:分钟|小时|天)前|昨天|刚刚/i;

/** First date in text as YYYY-MM-DD, else a relative-time marker, else "". */
export function findDate(text: string): string {
	// Absolute date first.
	const m = DATE_RE.exec(text);
	// Zero-padded.
	if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
	// Relative marker as written.
	const r = RELATIVE_RE.exec(text);
	// The marker or nothing.
	return r ? r[0] : "";
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
	if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
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

/** Clean a backend's raw results: everything stays except hosts the user blocked and repeats; dates are filled in. */
export function normalizeResults(raw: readonly SearchResult[], blocklist: readonly string[]): SearchResult[] {
	// Kept results.
	const out: SearchResult[] = [];
	// URLs already kept (without the fragment).
	const seen = new Set<string>();
	// Each raw result.
	for (const r of raw) {
		// Dedupe key.
		const key = r.url.replace(/#.*$/, "");
		// Duplicates and blocked hosts are dropped.
		if (seen.has(key) || isBlocked(hostOf(r.url), blocklist)) continue;
		seen.add(key);
		// Snippet in one line, in full.
		const snippet = cleanWebText(r.snippet).replace(/\s+/g, " ").trim();
		// Date from the backend, else from the title/snippet, else from the URL path.
		out.push({
			title: cleanWebText(r.title).trim() || r.url,
			url: r.url,
			snippet,
			date: r.date || findDate(`${r.title} ${snippet}`) || urlDate(r.url),
		});
	}
	// The results.
	return out;
}

/** The web_search report: heading and numbered results. */
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

/** The web_fetch report: heading with source and date, then the bounded text. */
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
