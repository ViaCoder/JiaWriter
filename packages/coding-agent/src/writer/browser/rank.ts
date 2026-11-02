/**
 * Local relevance ranking of search results gathered from several engines and pages.
 *
 * Each result gets three scores, each scaled to 0–1 over the candidate set:
 * - match: BM25 of the query against the title (counted twice) and the snippet;
 * - agreement: reciprocal-rank fusion of its positions on the engines that returned it, so a
 *   page that both Bing and Google put near the top rises;
 * - coverage: the share of the query's terms that appear in the title or snippet.
 * The final score is 0.45 × match + 0.35 × agreement + 0.20 × coverage.
 */

/** One result as an engine returned it. */
export interface EngineHit {
	// Engine name.
	engine: string;
	// Position on that engine across its pages (0 = first).
	pos: number;
	// Real address.
	url: string;
	// Title.
	title: string;
	// Snippet.
	snippet: string;
}

/** A ranked, merged result. */
export interface RankedHit {
	// Real address.
	url: string;
	// Title (from the first engine that had it).
	title: string;
	// Longest snippet among the engines.
	snippet: string;
	// Engines that returned it.
	engines: string[];
	// Final score.
	score: number;
}

// BM25 parameters (the usual values).
const K1 = 1.2;
const B = 0.75;
// Reciprocal-rank fusion constant: smaller values weigh top positions more.
const RRF_K = 10;
// Weights of the three scores.
const W_MATCH = 0.45;
const W_AGREE = 0.35;
const W_COVER = 0.2;

/** Terms of a text: English words and numbers, and pairs of adjacent Chinese characters (single characters when alone). */
export function terms(text: string): string[] {
	// Collected terms.
	const out: string[] = [];
	// Runs of letters/digits or of Han characters.
	for (const m of text.toLowerCase().matchAll(/[a-z0-9]+|\p{Script=Han}+/gu)) {
		const run = m[0];
		if (/^[a-z0-9]+$/.test(run)) {
			// One word; one-letter words carry no meaning (digits do).
			if (run.length > 1 || /\d/.test(run)) out.push(run);
		} else {
			// Han: overlapping pairs, or the single character.
			const chars = [...run];
			if (chars.length === 1) out.push(chars[0]);
			for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
		}
	}
	// The terms.
	return out;
}

/** BM25 score of each document for the query terms. */
export function bm25(query: readonly string[], docs: readonly string[][]): number[] {
	// Document count and average length.
	const n = docs.length;
	const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, n);
	// Unique query terms.
	const q = [...new Set(query)];
	// Documents containing each term.
	const df = new Map<string, number>(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
	// Score per document.
	return docs.map((d) => {
		let s = 0;
		for (const t of q) {
			const tf = d.filter((x) => x === t).length;
			if (tf === 0) continue;
			const nt = df.get(t) ?? 0;
			const idf = Math.log(1 + (n - nt + 0.5) / (nt + 0.5));
			s += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / Math.max(1, avg)));
		}
		return s;
	});
}

/** Scale values to 0–1 by the largest one (all zeros stay zero). */
function scaled(values: readonly number[]): number[] {
	// Largest value.
	const max = Math.max(0, ...values);
	// Divided by it.
	return values.map((v) => (max > 0 ? v / max : 0));
}

/** Merge hits by address and order them by the combined score (ties keep first-seen order). */
export function rankHits(query: string, hits: readonly EngineHit[]): RankedHit[] {
	// Merged entries in first-seen order.
	const merged = new Map<string, RankedHit & { rrf: number }>();
	for (const h of hits) {
		// Same page with or without fragment and trailing slash.
		const key = h.url.replace(/#.*$/, "").replace(/\/+$/, "");
		const e = merged.get(key);
		if (!e) {
			merged.set(key, {
				url: h.url,
				title: h.title,
				snippet: h.snippet,
				engines: [h.engine],
				score: 0,
				rrf: 1 / (RRF_K + h.pos + 1),
			});
			continue;
		}
		// Another engine (or page) with the same address.
		if (!e.engines.includes(h.engine)) {
			e.engines.push(h.engine);
			e.rrf += 1 / (RRF_K + h.pos + 1);
		}
		if (h.snippet.length > e.snippet.length) e.snippet = h.snippet;
		if (!e.title) e.title = h.title;
	}
	const list = [...merged.values()];
	// Query terms and document terms.
	const q = terms(query);
	const docs = list.map((e) => terms(`${e.title} ${e.title} ${e.snippet}`));
	// The three scores.
	const match = scaled(bm25(q, docs));
	const agree = scaled(list.map((e) => e.rrf));
	const uq = [...new Set(q)];
	const cover = docs.map((d) => (uq.length ? uq.filter((t) => d.includes(t)).length / uq.length : 0));
	// Combined.
	list.forEach((e, i) => {
		e.score = W_MATCH * match[i] + W_AGREE * agree[i] + W_COVER * cover[i];
	});
	// Highest first; stable for ties.
	return list
		.map((e, i) => ({ e, i }))
		.sort((a, b) => b.e.score - a.e.score || a.i - b.i)
		.map(({ e }) => ({
			url: e.url,
			title: e.title,
			snippet: e.snippet,
			engines: e.engines,
			score: Math.round(e.score * 1000) / 1000,
		}));
}
