/**
 * AnySearch backend (https://www.anysearch.com/docs): POST /v1/search and /v1/extract.
 * Anonymous use works (rate-limited per IP); ANYSEARCH_KEY adds `Authorization: Bearer`.
 * The key never appears in errors or logs. A 402 body is never read: for anonymous callers
 * it may carry generated credentials.
 */

// Output messages.
import { t } from "../i18n/index.ts";
// Shared types and helpers.
import { absoluteDate, type FetchResult, pageDate, type SearchConfig, type SearchResult } from "./core.ts";

/** fetch-compatible function (tests pass a fake). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
/** Sleep function (tests pass an instant one). */
export type SleepFn = (ms: number) => Promise<void>;

/** Most results AnySearch returns for one search. */
export const ANYSEARCH_MAX = 10;

/** Longest single back-off after a 429 (ms). */
const MAX_BACKOFF_MS = 10_000;

/** Real sleep. */
const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Back-off from a Retry-After header in seconds (1 s when absent), capped. */
export function retryAfterMs(header: string | null): number {
	// Seconds as a number.
	const s = Number(header);
	// Bounded wait.
	return Math.min(MAX_BACKOFF_MS, Number.isFinite(s) && s > 0 ? s * 1000 : 1000);
}

/** Error for a non-success HTTP status (the body is not read). */
export function statusError(status: number, url = ""): Error {
	// Quota: anonymous 402 bodies may hold generated credentials.
	if (status === 402) return new Error(t("anysearch.quota"));
	// Bad or expired key.
	if (status === 401 || status === 403) return new Error(t("anysearch.auth", { status }));
	// Rate limit.
	if (status === 429) return new Error(t("anysearch.rate"));
	// Extraction failed.
	if (status === 422) return new Error(t("anysearch.extract", { url }));
	// Anything else.
	return new Error(t("anysearch.http", { status }));
}

/** POST a JSON body to path and return `data` of a successful reply; one bounded retry on 429. */
export async function anysearchPost(
	cfg: SearchConfig,
	path: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	fetchFn: FetchFn = fetch,
	sleep: SleepFn = realSleep,
): Promise<Record<string, unknown>> {
	// Headers; the key only when configured.
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cfg.anysearchKey) headers.authorization = `Bearer ${cfg.anysearchKey}`;
	// At most two attempts (the second only after a 429).
	for (let attempt = 1; ; attempt++) {
		// Timeout combined with the caller's cancellation.
		const timeout = AbortSignal.timeout(cfg.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		// The request; network errors become a readable message.
		let res: Response;
		try {
			res = await fetchFn(`${cfg.anysearchUrl}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: combined,
			});
		} catch (e) {
			throw new Error(t("anysearch.network", { reason: e instanceof Error ? e.message : String(e) }));
		}
		// One bounded back-off on the first 429.
		if (res.status === 429 && attempt === 1) {
			await res.body?.cancel();
			await sleep(retryAfterMs(res.headers.get("retry-after")));
			continue;
		}
		// Failure: never read the body (a 402 may hold credentials).
		if (!res.ok) {
			await res.body?.cancel();
			throw statusError(res.status, typeof body.url === "string" ? body.url : "");
		}
		// Success envelope {code: 0, data}.
		// A body that is not JSON counts as a failed answer, and its text stays out of the message.
		const json = (await res.json().catch(() => ({}))) as { code?: number; data?: Record<string, unknown> };
		if (json.code !== 0 || !json.data) throw new Error(t("anysearch.http", { status: res.status }));
		// The payload.
		return json.data;
	}
}

/** Search; zone is "cn" or "intl", language e.g. "zh-CN" or "en". */
export async function anysearchSearch(
	cfg: SearchConfig,
	query: string,
	opts: { zone?: string; language?: string; tag?: string },
	signal?: AbortSignal,
	fetchFn: FetchFn = fetch,
	sleep: SleepFn = realSleep,
): Promise<SearchResult[]> {
	// Request body: always the most it gives, so that enough is left after selecting; JSON, optional region and language.
	const body: Record<string, unknown> = { query, max_results: ANYSEARCH_MAX, format: "json" };
	if (opts.zone) body.zone = opts.zone;
	if (opts.language) body.language = opts.language;
	// A capability tag searches a vertical source (academic.paper: papers).
	if (opts.tag) body.tag = opts.tag;
	// The call.
	const data = await anysearchPost(cfg, "/v1/search", body, signal, fetchFn, sleep);
	// Result list.
	const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
	// Common shape; the date comes from the content when the snippet has none.
	return results.map((r) => {
		// The cleaned content is the fuller text when there is one: everything found goes in.
		const short = String(r.snippet ?? "");
		const content = String(r.content ?? "");
		const snippet = content.length > short.length ? content : short;
		return {
			title: String(r.title ?? ""),
			url: String(r.url ?? ""),
			snippet,
			// The head of the text only: further in, a date is about something else.
			// Absolute dates only: an age in page text is its menus.
			date: absoluteDate(`${short} ${content.slice(0, 2000)}`),
		};
	});
}

/** Extract one page (the strict body holds exactly one url field). */
export async function anysearchExtract(
	cfg: SearchConfig,
	url: string,
	signal?: AbortSignal,
	fetchFn: FetchFn = fetch,
	sleep: SleepFn = realSleep,
): Promise<FetchResult> {
	// The call.
	const data = await anysearchPost(cfg, "/v1/extract", { url }, signal, fetchFn, sleep);
	// Page text.
	const content = String(data.content ?? "");
	// Final address.
	const final = String(data.url ?? url);
	// Common shape; the date from the text, else from the address.
	return {
		url: final,
		title: String(data.title ?? ""),
		content,
		date: pageDate(content, final),
	};
}
