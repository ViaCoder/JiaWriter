// Tests for scripts/writer-search-eval.mjs (node:test, fake backends, no network).

// Assertions.
import assert from "node:assert/strict";
// Temp output directory.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test runner.
import { test } from "node:test";
// Functions under test.
import {
	backendOps,
	evalBackend,
	formatTable,
	PAGES,
	queries,
	runSearchEval,
	summarize,
	todayTaipei,
} from "./writer-search-eval.mjs";

// Chinese messages from the shared i18n layer.
process.env.JW_LANG = "zh";

test("todayTaipei uses the Asia/Taipei calendar date", () => {
	// 2026-10-31 20:00 UTC is already 1 November in Taipei.
	assert.equal(todayTaipei(new Date("2026-10-31T20:00:00Z")), "2026-11-01");
});

test("queries include a dated event query and PAGES are https section pages", () => {
	// Three fixed queries.
	const q = queries("2026-11-01");
	assert.deepEqual(q.map((x) => x.id), ["intl-news", "zh-news", "event"]);
	assert.equal(q[2].query, "Reuters world news 2026-11-01");
	// Three pages.
	assert.equal(PAGES.length, 3);
	assert.ok(PAGES.every((p) => p.startsWith("https://")));
});

test("backendOps builds AnySearch ops and explains a missing sf", () => {
	// AnySearch ops are functions.
	const ops = backendOps("anysearch", { timeoutMs: 1000 }, {}, tmpdir());
	assert.equal(typeof ops.search, "function");
	assert.equal(typeof ops.fetch, "function");
	// sf nowhere.
	assert.throws(() => backendOps("sf", { sfPath: "/nonexistent/sf", timeoutMs: 1000 }, { HOME: "/nonexistent" }, tmpdir()), /search_fetch|Windows/);
});

test("evalBackend times every item and records errors", async () => {
	// Clock advancing 10 ms per read.
	let t = 0;
	const clock = () => (t += 10);
	// One good and one failing search; one good and one empty page.
	const ops = {
		search: async (q) => {
			if (q.id === "b") throw new Error("HTTP 429");
			return [{ title: "2026-11-01 头条", url: "https://a.example/", snippet: "", date: "" }, { title: "x", url: "https://spam.example/", snippet: "", date: "" }];
		},
		fetch: async (url) => ({ url, title: "", content: url.includes("good") ? "正文" : " ", date: "" }),
	};
	const round = await evalBackend(ops, [{ id: "a", query: "q" }, { id: "b", query: "q" }], ["https://good.example/", "https://empty.example/"], ["spam.example"], clock);
	// Searches: blocklist applied, date found, error kept.
	assert.deepEqual(round.searches.map((s) => [s.id, s.count, s.dated, s.ms, s.error]), [["a", 1, 1, 10, ""], ["b", 0, 0, 10, "HTTP 429"]]);
	// Fetches: an empty page is a failure.
	assert.deepEqual(round.fetches.map((f) => [f.ok, f.chars]), [[true, 2], [false, 1]]);
});

test("summarize and formatTable produce the comparison", () => {
	// A small round.
	const s = summarize({
		searches: [{ count: 4, dated: 1, ms: 100, error: "" }, { count: 0, dated: 0, ms: 300, error: "x" }],
		fetches: [{ ok: true, chars: 1000, ms: 50, error: "" }, { ok: false, chars: 0, ms: 150, error: "y" }],
	});
	assert.deepEqual(s, { searches: 2, withResults: 1, results: 4, datedPct: 25, searchMs: 200, fetchOk: "1/2", fetchChars: 1000, fetchMs: 100, errors: 2 });
	// Table with two backends.
	const table = formatTable({ anysearch: s, sf: s }).split("\n");
	assert.equal(table[0], "| 指标 | anysearch | sf |");
	assert.ok(table.includes("| 带日期或时效标记的比例 | 25% | 25% |"));
});

test("runSearchEval writes raw.json and table.md and survives a backend that cannot start", async () => {
	// Output directory.
	const dir = mkdtempSync(join(tmpdir(), "wa-seval-"));
	try {
		// Fake ops for anysearch; sf fails to start.
		const makeOps = (b) => {
			if (b === "sf") throw new Error("sf missing");
			return { search: async () => [{ title: "t", url: "https://a.example/", snippet: "", date: "" }], fetch: async (url) => ({ url, title: "", content: "x", date: "" }) };
		};
		const table = await runSearchEval(dir, ["anysearch", "sf"], {}, makeOps);
		// Table and files.
		assert.ok(table.includes("| 有结果的查询 | 3/3 | 0/3 |"));
		assert.ok(table.includes("| 出错次数 | 0 | 6 |"));
		const raw = JSON.parse(readFileSync(join(dir, "raw.json"), "utf-8"));
		assert.equal(raw.raw.sf.searches[0].error, "sf missing");
		assert.equal(readFileSync(join(dir, "table.md"), "utf-8").trim(), table);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
