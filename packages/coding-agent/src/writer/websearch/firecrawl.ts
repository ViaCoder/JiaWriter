/**
 * Firecrawl backend (https://docs.firecrawl.dev): POST /v2/search and /v2/scrape with FIRECRAWL_KEY as a Bearer key.
 * Measured on 2026-11-08: news results hours old from major outlets, and the full text of Reuters articles; the time
 * filter works on web results only. The key never appears in errors or logs.
 */

// Output messages.
import { t } from "../i18n/index.ts";
// Shared types and helpers.
import { dayOf, type FetchResult, pageDate, type SearchConfig, type SearchResult } from "./core.ts";

/** fetch-compatible function (tests pass a fake). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Results asked for, as many as the other APIs give. */
export const FIRECRAWL_LIMIT = 10;
/** Oldest cached copy of a page taken (ms): news pages change within hours, the default is two days. */
export const FIRECRAWL_MAX_AGE_MS = 3_600_000;

/** The time windows of search_web as Firecrawl's tbs values (web results only). */
const TBS: Readonly<Record<string, string>> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };

/** Error for a non-success HTTP status (the body is not read). */
export function firecrawlError(status: number, url = ""): Error {
	// Bad key.
	if (status === 401 || status === 403) return new Error(t("firecrawl.auth", { status }));
	// No credits left.
	if (status === 402) return new Error(t("firecrawl.credits"));
	// Too many requests.
	if (status === 429) return new Error(t("firecrawl.rate"));
	// The page could not be read.
	if (url && (status === 404 || status === 408 || status === 500))
		return new Error(t("firecrawl.page", { url, status }));
	// Anything else.
	return new Error(t("firecrawl.http", { status }));
}

/** POST a JSON body to path and return `data` of a successful answer. */
export async function firecrawlPost(
	cfg: SearchConfig,
	path: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	fetchFn: FetchFn = fetch,
): Promise<unknown> {
	// Without a key there is no call.
	if (!cfg.firecrawlKey) throw new Error(t("firecrawl.noKey"));
	// Timeout combined with the caller's cancellation.
	const timeout = AbortSignal.timeout(cfg.timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	// The request; network errors become a readable message.
	let res: Response;
	try {
		res = await fetchFn(`${cfg.firecrawlUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${cfg.firecrawlKey}` },
			body: JSON.stringify(body),
			signal: combined,
		});
	} catch (e) {
		throw new Error(t("firecrawl.network", { reason: e instanceof Error ? e.message : String(e) }));
	}
	// Failure: the status says enough.
	if (!res.ok) {
		await res.body?.cancel();
		throw firecrawlError(res.status, typeof body.url === "string" ? body.url : "");
	}
	// Success envelope {success: true, data}.
	const json = (await res.json().catch(() => undefined)) as { success?: boolean; data?: unknown } | undefined;
	if (!json?.success || json.data === undefined) throw new Error(t("firecrawl.http", { status: res.status }));
	return json.data;
}

/** A custom date range in Firecrawl's tbs form, month/day/year (docs.firecrawl.dev/features/search, 2026-11-08). */
export function firecrawlRange(after?: string, before?: string): string {
	const mdy = (d: string) => {
		const [y, m, day] = d.split("-").map(Number);
		return `${m}/${day}/${y}`;
	};
	return ["cdr:1", after ? `cd_min:${mdy(after)}` : "", before ? `cd_max:${mdy(before)}` : ""]
		.filter(Boolean)
		.join(",");
}

/**
 * Search the web, or the news when news is set. Dates (YYYY-MM-DD) or else fresh (day, week, month, year) limit
 * web results only: Firecrawl's tbs does not filter news.
 */
export async function firecrawlSearch(
	cfg: SearchConfig,
	query: string,
	opts: { news?: boolean; fresh?: string; after?: string; before?: string },
	signal?: AbortSignal,
	fetchFn: FetchFn = fetch,
): Promise<SearchResult[]> {
	// Request body: one source, the time window where it applies.
	const body: Record<string, unknown> = { query, limit: FIRECRAWL_LIMIT, sources: [opts.news ? "news" : "web"] };
	if (!opts.news && (opts.after || opts.before)) body.tbs = firecrawlRange(opts.after, opts.before);
	else if (!opts.news && opts.fresh && TBS[opts.fresh]) body.tbs = TBS[opts.fresh];
	const data = (await firecrawlPost(cfg, "/v2/search", body, signal, fetchFn)) as Record<string, unknown> | unknown[];
	// Results grouped by source, or a flat list.
	const group = Array.isArray(data) ? data : (data[opts.news ? "news" : "web"] ?? []);
	const items = Array.isArray(group) ? (group as Record<string, unknown>[]) : [];
	return items.map((r) => ({
		title: String(r.title ?? ""),
		url: String(r.url ?? ""),
		snippet: String(r.snippet ?? r.description ?? ""),
		// News dates come as given ("3 hours ago", "Nov 7, 2026") and become days; web results have none.
		date: typeof r.date === "string" ? dayOf(r.date) : "",
	}));
}

/** Fetch one page's main text, from a cached copy at most an hour old. */
export async function firecrawlFetch(
	cfg: SearchConfig,
	url: string,
	signal?: AbortSignal,
	fetchFn: FetchFn = fetch,
): Promise<FetchResult> {
	const body = { url, formats: ["markdown"], onlyMainContent: true, maxAge: FIRECRAWL_MAX_AGE_MS };
	const data = (await firecrawlPost(cfg, "/v2/scrape", body, signal, fetchFn)) as Record<string, unknown>;
	const meta = (data.metadata ?? {}) as Record<string, unknown>;
	// The page itself may have failed behind a successful call.
	const status = Number(meta.statusCode ?? 200);
	if (status >= 400) throw firecrawlError(status, url);
	const content = String(data.markdown ?? "");
	// The title may come as a list.
	const title = Array.isArray(meta.title) ? String(meta.title[0] ?? "") : String(meta.title ?? "");
	// The publication time where the page states it (in the publisher's zone), else a date in the text or address.
	const published = typeof meta.publishedTime === "string" ? meta.publishedTime.slice(0, 10) : "";
	const final = String(meta.sourceURL ?? url);
	return { url: final, title, content, date: published || pageDate(content, final) };
}
