// JiaWriter search backend evaluation (P4): one round of fixed queries and page extractions
// per configured backend, a comparison table on stdout and the raw results on disk. It helps
// the user judge the backends; it decides nothing. One request per item, no retries.
// The only key is ANYSEARCH_KEY (optional), read from the environment and never printed; sf runs without a model.
// Usage: node scripts/writer-search-eval.mjs <output dir> [anysearch] [sf]   (default: anysearch)

// Output files.
import { mkdirSync, writeFileSync } from "node:fs";
// Path helpers.
import { dirname, join } from "node:path";
// Entry-point check.
import { fileURLToPath } from "node:url";
// AnySearch backend.
import { anysearchExtract, anysearchSearch } from "../packages/coding-agent/src/writer/websearch/anysearch.ts";
// Configuration and result cleanup shared with the tools.
import { normalizeResults, readSearchEnv } from "../packages/coding-agent/src/writer/websearch/core.ts";
// sf backend.
import { locateSf, parseSfFetch, parseSfSearch, runSf, sfChildEnv, sfError, sfSearchArgs } from "../packages/coding-agent/src/writer/websearch/sf.ts";

/** Today in Asia/Taipei as YYYY-MM-DD (en-CA formats dates that way). */
export function todayTaipei(now = new Date()) {
	// Calendar date in the user's time zone.
	return now.toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

/** The fixed queries: broad international news, Chinese news, and a dated event query. */
export function queries(today) {
	// Each query with the options both backends understand.
	return [
		{ id: "intl-news", query: "world news today", zone: "intl", language: "en", fresh: "day" },
		{ id: "zh-news", query: "今日国内要闻", zone: "cn", language: "zh-CN", fresh: "day" },
		{ id: "event", query: `Reuters world news ${today}`, zone: "intl", language: "en", fresh: "day" },
	];
}

/** Section pages of authoritative outlets to extract. */
export const PAGES = ["https://www.reuters.com/world/", "https://www.bbc.com/news/world", "https://www.news.cn/world/"];

/** search(q) and fetch(url) of one backend, built from the configuration. */
export function backendOps(backend, cfg, env, cwd) {
	// AnySearch over HTTP.
	if (backend === "anysearch") {
		return {
			search: (q) => anysearchSearch(cfg, q.query, { max: 10, zone: q.zone, language: q.language }),
			fetch: (url) => anysearchExtract(cfg, url),
		};
	}
	// sf as a child process.
	const agentDir = join(env.HOME ?? "", ".jiawriter", "agent");
	const bin = locateSf(cfg, process.platform, process.arch, dirname(process.execPath), agentDir);
	// No driver model (as in the tool) and no human waits: nobody watches an evaluation.
	const opts = { cwd, env: sfChildEnv(env, false, agentDir), timeoutMs: cfg.timeoutMs };
	// Run one sf command and return its stdout, or throw sf's error.
	const sf = async (args) => {
		const run = await runSf(bin, args, opts);
		if (run.code !== 0) throw sfError(run, cfg.timeoutMs);
		return run.stdout;
	};
	return {
		search: async (q) => parseSfSearch(await sf(sfSearchArgs(q.query, { fresh: q.fresh, language: q.language }))),
		fetch: async (url) => parseSfFetch(await sf(["fetch", "--json", "--", url]), url),
	};
}

/** One round over the queries and pages; every item records its time and error. */
export async function evalBackend(ops, items, pages, blocklist, clock = Date.now) {
	// Search rows.
	const searches = [];
	for (const q of items) {
		// Start time.
		const t0 = clock();
		try {
			// Cleaned results, as the tool would show them.
			const results = normalizeResults(await ops.search(q), blocklist).slice(0, 10);
			searches.push({ id: q.id, ms: clock() - t0, count: results.length, dated: results.filter((r) => r.date).length, results, error: "" });
		} catch (e) {
			searches.push({ id: q.id, ms: clock() - t0, count: 0, dated: 0, results: [], error: e instanceof Error ? e.message : String(e) });
		}
	}
	// Extraction rows.
	const fetches = [];
	for (const url of pages) {
		// Start time.
		const t0 = clock();
		try {
			// Text length and date.
			const page = await ops.fetch(url);
			fetches.push({ url, ms: clock() - t0, ok: page.content.trim().length > 0, chars: page.content.length, date: page.date, error: "" });
		} catch (e) {
			fetches.push({ url, ms: clock() - t0, ok: false, chars: 0, date: "", error: e instanceof Error ? e.message : String(e) });
		}
	}
	// Both lists.
	return { searches, fetches };
}

/** Summary numbers of one backend's round. */
export function summarize(round) {
	// Totals over searches.
	const results = round.searches.reduce((n, s) => n + s.count, 0);
	const dated = round.searches.reduce((n, s) => n + s.dated, 0);
	// Fetch successes.
	const ok = round.fetches.filter((f) => f.ok).length;
	// Mean of a list of milliseconds (0 when empty).
	const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
	return {
		searches: round.searches.length,
		withResults: round.searches.filter((s) => s.count > 0).length,
		results,
		datedPct: results ? Math.round((100 * dated) / results) : 0,
		searchMs: mean(round.searches.map((s) => s.ms)),
		fetchOk: `${ok}/${round.fetches.length}`,
		fetchChars: mean(round.fetches.filter((f) => f.ok).map((f) => f.chars)),
		fetchMs: mean(round.fetches.map((f) => f.ms)),
		errors: [...round.searches, ...round.fetches].filter((x) => x.error).length,
	};
}

/** Markdown comparison table, one column per backend. */
export function formatTable(summaries) {
	// Row labels and summary fields.
	const rows = [
		["有结果的查询", "withResults", (s) => `${s.withResults}/${s.searches}`],
		["结果总数", "results"],
		["带日期或时效标记的比例", "datedPct", (s) => `${s.datedPct}%`],
		["平均检索耗时（毫秒）", "searchMs"],
		["抽取成功", "fetchOk"],
		["抽取正文平均长度（字符）", "fetchChars"],
		["平均抽取耗时（毫秒）", "fetchMs"],
		["出错次数", "errors"],
	];
	// Backend names.
	const names = Object.keys(summaries);
	// Header, separator, one line per row.
	return [
		`| 指标 | ${names.join(" | ")} |`,
		`|---|${names.map(() => "---").join("|")}|`,
		...rows.map(([label, key, fmt]) => `| ${label} | ${names.map((n) => (fmt ? fmt(summaries[n]) : summaries[n][key])).join(" | ")} |`),
	].join("\n");
}

/** Run the evaluation for the named backends and write raw.json and table.md into outDir. */
export async function runSearchEval(outDir, backends, env = process.env, makeOps = backendOps) {
	// Output directory.
	mkdirSync(outDir, { recursive: true });
	// Shared configuration (timeout, blocklist, AnySearch key, JW_SF).
	const config = readSearchEnv(env);
	// Fixed items for today.
	const items = queries(todayTaipei());
	// Raw rounds and summaries per backend.
	const raw = {};
	const summaries = {};
	for (const b of backends) {
		// One round; a backend that cannot start is recorded as all errors.
		let ops;
		try {
			ops = makeOps(b, config, env, outDir);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			ops = { search: async () => { throw new Error(msg); }, fetch: async () => { throw new Error(msg); } };
		}
		raw[b] = await evalBackend(ops, items, PAGES, config.blocklist);
		summaries[b] = summarize(raw[b]);
	}
	// Files.
	const table = formatTable(summaries);
	writeFileSync(join(outDir, "raw.json"), `${JSON.stringify({ date: todayTaipei(), items, pages: PAGES, raw }, null, 2)}\n`);
	writeFileSync(join(outDir, "table.md"), `${table}\n`);
	// The table for stdout.
	return table;
}

// Command line.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	// Output directory and backends.
	const [outDir, ...names] = process.argv.slice(2);
	if (!outDir || names.some((n) => n !== "anysearch" && n !== "sf")) {
		console.error("用法：node scripts/writer-search-eval.mjs <输出目录> [anysearch] [sf]");
		process.exit(2);
	}
	// Run and print.
	console.log(await runSearchEval(outDir, names.length ? names : ["anysearch"]));
}
