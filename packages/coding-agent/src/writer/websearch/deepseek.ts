/**
 * DeepSeek-style search backend (https://api-docs.deepseek.com/zh-cn/guides/search/): POST /v1/tools/search and
 * /v1/tools/fetch with DEEPSEEK_KEY as a Bearer key. The query takes operators: site:, after:YYYY-MM-DD, lang:.
 * Measured on 2026-11-08: dated results, a topic with site: of the outlets finds their reports of the last days;
 * a bare year in after: means the year after it. The key never appears in errors or logs.
 */

// Output messages.
import { t } from "../i18n/index.ts";
// Shared types and helpers.
import { type FetchResult, pageDate, type SearchConfig, type SearchResult } from "./core.ts";

/** fetch-compatible function (tests pass a fake). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Longest query the API takes (characters). */
export const DEEPSEEK_QUERY_MAX = 128;
/** Results asked for: the API gives 1–50, and as many as AnySearch keeps the lists comparable. */
export const DEEPSEEK_COUNT = 10;

/** Error for a non-success HTTP status (the body is not read). */
export function deepseekError(status: number, url = ""): Error {
	// Bad key.
	if (status === 401 || status === 403) return new Error(t("deepseek.auth", { status }));
	// No balance left.
	if (status === 402) return new Error(t("deepseek.balance"));
	// The page could not be read (blocked or unsupported).
	if (status === 404 && url) return new Error(t("deepseek.fetch", { url }));
	// Too many requests.
	if (status === 429) return new Error(t("deepseek.rate"));
	// Anything else.
	return new Error(t("deepseek.http", { status }));
}

/** POST a JSON body to path and return the parsed answer of a success. */
export async function deepseekPost(
	cfg: SearchConfig,
	path: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	fetchFn: FetchFn = fetch,
): Promise<Record<string, unknown>> {
	// Without a key there is no call.
	if (!cfg.deepseekKey) throw new Error(t("deepseek.noKey"));
	// Timeout combined with the caller's cancellation.
	const timeout = AbortSignal.timeout(cfg.timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	// The request; network errors become a readable message.
	let res: Response;
	try {
		res = await fetchFn(`${cfg.deepseekUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${cfg.deepseekKey}` },
			body: JSON.stringify(body),
			signal: combined,
		});
	} catch (e) {
		throw new Error(t("deepseek.network", { reason: e instanceof Error ? e.message : String(e) }));
	}
	// Failure: the status says enough.
	if (!res.ok) {
		await res.body?.cancel();
		throw deepseekError(res.status, typeof body.url === "string" ? body.url : "");
	}
	// A body that is not a JSON object counts as a failed answer.
	const json = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	if (!json || typeof json !== "object") throw new Error(t("deepseek.http", { status: res.status }));
	return json;
}

/** The query as the API reads it: after: with a bare year means from the next year on (measured 2026-11-08: after:2026
 * found nothing), while a writer means that year, so it becomes the year's first day. */
export function deepseekQuery(query: string, range: { after?: string; before?: string } = {}): string {
	// The date parameters become the API's own operators (api-docs.deepseek.com/zh-cn/guides/search, 2026-11-08).
	const ops = [range.after ? `after:${range.after}` : "", range.before ? `before:${range.before}` : ""].filter(
		Boolean,
	);
	return [query.replace(/\bafter:(\d{4})(?![-\d])/g, "after:$1-01-01"), ...ops].join(" ");
}

/** Search; the query carries any operators, question is the user's own question for the ranking. */
export async function deepseekSearch(
	cfg: SearchConfig,
	query: string,
	question: string | undefined,
	signal?: AbortSignal,
	fetchFn: FetchFn = fetch,
	range: { after?: string; before?: string } = {},
): Promise<SearchResult[]> {
	// The query as sent, operators included: the API refuses longer ones, and the model shortens it.
	const full = deepseekQuery(query, range);
	if (full.length > DEEPSEEK_QUERY_MAX)
		throw new Error(t("deepseek.long", { length: full.length, max: DEEPSEEK_QUERY_MAX }));
	// Request body; the question only when there is one, within the same limit.
	const body: Record<string, unknown> = { query: full, count: DEEPSEEK_COUNT };
	if (question?.trim()) body.ori_question = question.trim().slice(0, DEEPSEEK_QUERY_MAX);
	const data = await deepseekPost(cfg, "/v1/tools/search", body, signal, fetchFn);
	// Result list.
	const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
	return results.map((r) => ({
		title: String(r.title ?? ""),
		url: String(r.url ?? ""),
		// The longer summary is written for model reading.
		snippet: String(r.summary || r.snippet || ""),
		date: typeof r.date === "string" ? beijingDay(r.date) : "",
	}));
}

/**
 * The day of a result's date in Beijing time. The API gives midnight Beijing time in UTC (2026-07-02T16:00:00Z for a
 * page of 2026-07-03): its first ten characters were a day early for 17 of the 19 results whose address shows the
 * day (2026-11-10), and the drafts cited those days. A date without a time is taken as it is.
 */
export function beijingDay(stamp: string): string {
	// A time with its zone: the moment, moved to UTC+8.
	if (/T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp)) {
		const ms = Date.parse(stamp);
		if (!Number.isNaN(ms)) return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
	}
	return stamp.slice(0, 10);
}

/** Fetch one page's text. */
export async function deepseekFetch(
	cfg: SearchConfig,
	url: string,
	signal?: AbortSignal,
	fetchFn: FetchFn = fetch,
): Promise<FetchResult> {
	const data = await deepseekPost(cfg, "/v1/tools/fetch", { url }, signal, fetchFn);
	// Page text in Markdown.
	const content = String(data.content ?? "");
	return { url, title: String(data.title ?? ""), content, date: pageDate(content, url) };
}
