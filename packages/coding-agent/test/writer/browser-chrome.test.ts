// Functional test of the browser backend in a real Chrome (Chrome for Testing, headless=new, temp
// profile): the extension, the native messaging host, the page scripts and the trusted input, against
// local look-alike Bing and Google pages. Nothing touches the user's Chrome or a real website.
// Needs Chrome for Testing (JW_TEST_CHROME, or ~/.local/share/wa-test-tools/cft-*/chrome-linux64/chrome);
// skipped when it is missing (CI) or on Windows.

// Chrome process.
import { type ChildProcess, spawn } from "node:child_process";
// Files.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
// Fixture server.
import { createServer, type Server } from "node:http";
// Home and temp folders.
import { homedir, tmpdir } from "node:os";
// Paths.
import { join, resolve } from "node:path";
// Test API.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Units under test.
import { bridgeAddress, bridgeCall, HOST_NAME } from "../../src/writer/browser/bridge.ts";
import type { EngineSpec } from "../../src/writer/browser/engines.ts";
import { ENGINES, type EngineName } from "../../src/writer/browser/engines.ts";
import { browserFetch } from "../../src/writer/browser/fetch.ts";
import { hostManifest } from "../../src/writer/browser/install.ts";
import { type BrowserDeps, browserSearch, DEFAULT_TIMING } from "../../src/writer/browser/search.ts";
// A PDF to download.
import { makePdf } from "./doc-fixtures.ts";

/** Chrome for Testing, or "" when none is installed. */
function testChrome(): string {
	// Explicit path.
	if (process.env.JW_TEST_CHROME && existsSync(process.env.JW_TEST_CHROME)) return process.env.JW_TEST_CHROME;
	// The tools folder of the dev machine.
	const root = join(homedir(), ".local/share/wa-test-tools");
	if (!existsSync(root)) return "";
	for (const d of readdirSync(root)
		.filter((n) => n.startsWith("cft-"))
		.sort()
		.reverse()) {
		const c = join(root, d, "chrome-linux64", "chrome");
		if (existsSync(c)) return c;
	}
	return "";
}

// The browser to use and whether to run at all.
const CHROME = process.platform === "win32" ? "" : testChrome();
// Repository paths.
const EXT = resolve(__dirname, "../../../../search_fetch/src/search_fetch/extension");
const HOST_ENTRY = resolve(__dirname, "fixtures/browser-host.ts");

/** One results page of a fake engine: two results, a tall spacer, and Next at the bottom while pages remain. */
function serpPage(engine: "bing" | "google" | "baidu", base: string, q: string, page: number): string {
	// Result links point at the fixture articles.
	const items = [1, 2]
		.map((i) => {
			const href = `${base}/article?e=${engine}&p=${page}&i=${i}`;
			const title = `${q} ${engine} 第${page}页 结果${i}`;
			if (engine === "baidu")
				// Baidu (2026-11-03): the link is a /link?url= wrapper; the container's mu holds the real address.
				return `<div class="result c-container" mu="${href}"><h3><a href="${base}/link?url=w${page}${i}">${title}</a></h3><div class="c-abstract">摘要 ${q} ${page}-${i}</div></div>`;
			return engine === "bing"
				? `<li class="b_algo"><h2><a href="${href}">${title}</a></h2><div class="b_caption"><p>摘要 ${q} ${page}-${i}</p></div></li>`
				: `<div class="MjjYud"><a href="${href}"><h3>${title}</h3></a><div class="VwiC3b">摘要 ${q} ${page}-${i}</div></div>`;
		})
		.join("");
	// Next link far below, so it must be scrolled into view.
	const nextHref = `${base}/${engine}/search?q=${encodeURIComponent(q)}&page=${page + 1}`;
	// Baidu's pager: hashed classes, and the label hidden from innerText (only textContent has it).
	const baiduPager = `<div id="page"><a class="n prev_296JA disabled" href="#"><span style="display:none">上一页</span><svg width="18" height="18"></svg></a>${
		page < 4
			? `<a class="n next_d-g2R" href="${nextHref}"><span style="display:none">下一页</span><svg width="18" height="18"></svg></a>`
			: ""
	}</div>`;
	const next =
		engine === "baidu"
			? baiduPager
			: page < 4
				? engine === "bing"
					? `<a class="sb_pagN" title="Next page" href="${nextHref}">下一页</a>`
					: `<a id="pnnext" href="${nextHref}">下一页</a>`
				: "";
	// Baidu also shows its own modules with placeholder mu hosts and no title link.
	const module = `<div class="result-op c-container" mu="https://nourl.ubs.baidu.com/61344"><div>百度推荐</div></div>`;
	const list =
		engine === "bing"
			? `<ol id="b_results">${items}</ol>`
			: engine === "baidu"
				? `<div id="content_left">${module}${items}</div>`
				: `<div id="search">${items}</div>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>${q}</title></head><body>${list}<div style="height:2400px"></div>${next}${RECORDER}</body></html>`;
}

// Page script that reports every click, key and input with its isTrusted flag and whether a global of
// the driver is visible, and every attribute added or changed on the page's elements.
const RECORDER = `<script>for (const t of ["click","keydown","input","wheel"]) document.addEventListener(t, (e) => {
  if (t === "wheel" && window.__w) return; if (t === "wheel") window.__w = 1;
  navigator.sendBeacon("/log", JSON.stringify({ t, trusted: e.isTrusted, path: location.pathname, value: e.target && e.target.value || "",
    globals: Object.keys(window).filter((k) => /^__(sf|wa)/.test(k)).join(",") }));
}, true);
new MutationObserver((ms) => { for (const m of ms) navigator.sendBeacon("/log", JSON.stringify({ t: "attr", trusted: true, path: location.pathname, value: m.attributeName, globals: "" })); })
  .observe(document.documentElement, { attributes: true, subtree: true });</script>`;

/** Home page of a fake engine: a consent banner (Bing) and a search form. */
function homePage(engine: "bing" | "google" | "baidu", base: string): string {
	// Field names as on the real sites.
	const field =
		engine === "bing"
			? `<textarea id="sb_form_q" name="q"></textarea>`
			: engine === "baidu"
				? `<textarea id="chat-textarea" name="wd"></textarea><button id="chat-submit-button" type="submit">搜索</button>`
				: `<textarea name="q"></textarea>`;
	const consent =
		engine === "bing"
			? `<div id="bnp"><button id="bnp_btn_accept" onclick="document.getElementById('bnp').remove()">接受</button></div>`
			: "";
	// Enter in the textarea submits, as on the real pages.
	return `<!doctype html><html><head><meta charset="utf-8"><title>${engine}</title></head><body>${consent}<form action="${base}/${engine}/search">${field}</form>
<script>document.querySelector("textarea").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.form.submit(); } });</script>${RECORDER}</body></html>`;
}

/** Sogou's home page (2026-11-03): one text field without a name, Enter submits. */
function sogouHome(base: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>sogou</title></head><body><form action="${base}/sogou/web"><input id="query" name="query" type="text" style="width:500px"></form>${RECORDER}</body></html>`;
}

/** Sogou's results page: /link wrappers with the real address in a data-url block, no pager, and two more
 * results each time the page is scrolled to the bottom (three batches in all). */
function sogouSerp(base: string, q: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${q}</title></head><body><div class="results"></div><div style="height:1600px"></div>
<script>
let batch = 0;
function more() {
  if (batch >= 3) return; batch++;
  for (const i of [1, 2]) {
    const d = document.createElement("div"); d.className = "vrwrap";
    d.innerHTML = '<h3><a href="${base}/link?url=s' + batch + i + '">${q} 搜狗 第' + batch + '批 结果' + i + '</a></h3><div class="space-txt">摘要</div><div data-url="${base}/article?e=sogou&p=' + batch + '&i=' + i + '"></div>';
    document.querySelector(".results").appendChild(d);
  }
}
more();
addEventListener("scroll", () => { if (innerHeight + scrollY >= document.documentElement.scrollHeight - 40) setTimeout(more, 300); });
</script>${RECORDER}</body></html>`;
}

/** An article with navigation and footer noise. */
function articlePage(): string {
	// Readability should keep the paragraphs and drop the rest.
	const paras = Array.from(
		{ length: 8 },
		(_, i) =>
			`<p>第${i + 1}段：商务部于2026年10月30日发布芯片出口管制的新规定，说明了适用范围和过渡期安排，并回答了企业关心的问题。</p>`,
	).join("");
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>出口管制新规 - 示例新闻</title><meta property="article:published_time" content="2026-10-30T09:00:00+08:00"></head>
<body><nav><a href="/">首页</a><a href="/x">导航链接</a></nav><article><h1>出口管制新规</h1>${paras}<p>原文见<a href="https://www.example.com/notice">公告</a>。</p></article><footer>版权所有 示例网站</footer></body></html>`;
}

// Fixture server state.
let server: Server;
let base = "";
const events: { t: string; trusted: boolean; path: string; value: string; globals: string }[] = [];
// Chrome and the scratch folder.
let chrome: ChildProcess | null = null;
let dir = "";
let agentDir = "";

describe.skipIf(!CHROME)("browser backend in Chrome for Testing", () => {
	beforeAll(async () => {
		// Short scratch path (Unix socket length limit).
		dir = mkdtempSync(join(tmpdir(), "wac-"));
		agentDir = join(dir, "a");
		// Fixture server.
		const pdf = Buffer.from(makePdf(["report page one", "report page two"]));
		server = createServer((req, res) => {
			const u = new URL(req.url ?? "/", base);
			if (u.pathname === "/log") {
				let body = "";
				req.on("data", (c) => {
					body += c;
				});
				req.on("end", () => {
					events.push(JSON.parse(body));
					res.end();
				});
				return;
			}
			if (u.pathname === "/sogou/") {
				res.setHeader("content-type", "text/html; charset=utf-8");
				res.end(sogouHome(base));
				return;
			}
			if (u.pathname === "/sogou/web") {
				res.setHeader("content-type", "text/html; charset=utf-8");
				res.end(sogouSerp(base, u.searchParams.get("query") ?? ""));
				return;
			}
			if (u.pathname === "/doc.pdf") {
				res.setHeader("content-type", "application/pdf");
				res.end(pdf);
				return;
			}
			res.setHeader("content-type", "text/html; charset=utf-8");
			const m = /^\/(bing|google|baidu)\/(search)?$/.exec(u.pathname);
			if (m && !m[2]) res.end(homePage(m[1] as "bing", base));
			else if (m)
				res.end(
					serpPage(
						m[1] as "bing",
						base,
						u.searchParams.get("q") ?? u.searchParams.get("wd") ?? "",
						Number(u.searchParams.get("page") ?? 1),
					),
				);
			else res.end(articlePage());
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		// Host launcher and manifest in the temp profile (Chrome for Testing reads <user-data-dir>/NativeMessagingHosts).
		const profile = join(dir, "profile");
		mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
		const launcher = join(dir, "host.sh");
		writeFileSync(
			launcher,
			`#!/bin/sh\nexport JW_DIR="${agentDir}"\nexec "${process.execPath}" "${HOST_ENTRY}" "$@"\n`,
		);
		chmodSync(launcher, 0o700);
		writeFileSync(join(profile, "NativeMessagingHosts", `${HOST_NAME}.json`), hostManifest(launcher));
		// Chrome with the extension; --no-sandbox because Ubuntu's AppArmor refuses an unpacked CfT sandbox (test only).
		chrome = spawn(
			CHROME,
			[
				"--headless=new",
				"--no-sandbox",
				`--user-data-dir=${profile}`,
				"--no-first-run",
				"--no-default-browser-check",
				`--load-extension=${EXT}`,
				"about:blank",
			],
			{ stdio: "ignore", detached: true },
		);
		// Wait for the extension to start the host.
		const address = bridgeAddress(agentDir, process.platform);
		for (let i = 0; i < 60; i++) {
			try {
				await bridgeCall(address, "status", {}, 2000);
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		throw new Error("extension did not connect");
	}, 60_000);

	afterAll(async () => {
		// Stop Chrome (its process group) and the server; remove the scratch folder.
		if (chrome?.pid) {
			try {
				process.kill(-chrome.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
		rmSync(dir, { recursive: true, force: true });
	});

	/** Driver surroundings over the real bridge (no pacing waits). */
	function deps(): BrowserDeps {
		const address = bridgeAddress(agentDir, process.platform);
		return {
			call: (op, args, ms) => bridgeCall(address, op, args, ms),
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			random: Math.random,
			pace: async () => {},
			interactive: false,
			run: "chrome-test",
		};
	}

	it("searches both engines with trusted input, reads a clicked result and a PDF, and closes its tabs", async () => {
		// The engines pointed at the fixture server.
		const specs: Record<EngineName, EngineSpec> = {
			...ENGINES,
			bing: { ...ENGINES.bing, home: `${base}/bing/` },
			google: { ...ENGINES.google, home: `${base}/google/` },
		};
		const d = deps();
		const out = await browserSearch(d, "芯片出口 rules", {
			engines: ["bing", "google"],
			pages: 3,
			timing: { ...DEFAULT_TIMING, engineGapMs: 0, hostGapMs: 0, loadMs: 15_000 },
			specs,
		});
		// Three pages each (Next was scrolled to and clicked), two results per page.
		expect(out.outcomes.map((o) => [o.engine, o.pages, o.stopped, o.read])).toEqual([
			["bing", 3, "", "ax"],
			["google", 3, "", "ax"],
		]);
		expect(out.ranked).toHaveLength(12);
		expect(out.ranked[0].title).toContain("芯片出口 rules");
		// The pages saw only trusted events, and the box received the full query.
		await new Promise((r) => setTimeout(r, 500));
		expect(events.length).toBeGreaterThan(10);
		expect(events.filter((e) => !e.trusted)).toEqual([]);
		// The page's elements were never given attributes, and no driver global is visible to the page.
		expect(events.filter((e) => e.t === "attr")).toEqual([]);
		expect(events.filter((e) => e.globals)).toEqual([]);
		expect(events.filter((e) => e.t === "input" && e.path === "/bing/").at(-1)?.value).toBe("芯片出口 rules");
		expect(events.some((e) => e.t === "wheel" && e.path === "/google/search")).toBe(true);
		// A result on Google's last page is clicked there; the tab goes back to the results.
		const serps = out.outcomes.flatMap((o) => (o.serp ? [o.serp] : []));
		const target = Object.keys(serps[1].refs)[0];
		const page = await browserFetch(
			d,
			target,
			serps,
			{ ...DEFAULT_TIMING, hostGapMs: 0, loadMs: 15_000 },
			async () => {},
		);
		expect(page.title).toContain("出口管制新规");
		expect(page.content).toContain("第8段：商务部于2026年10月30日发布");
		expect(page.content).toContain("[公告](https://www.example.com/notice)");
		expect(page.content).not.toContain("导航链接");
		expect(page.content).not.toContain("版权所有");
		expect(page.date).toBe("2026-10-30");
		const back = (await d.call("info", { tab: serps[1].tab }, 5000)) as { url: string };
		expect(back.url).toBe(serps[1].url);
		// A PDF through Chrome's own network stack.
		const pdf = await browserFetch(d, `${base}/doc.pdf`, serps, { ...DEFAULT_TIMING, hostGapMs: 0 }, async () => {});
		expect(pdf.content).toContain("report page two");
		// Every tab of the run closes.
		expect(await d.call("close_run", { run: "chrome-test" }, 10_000)).toBe(2);
	}, 420_000);

	it("finds Baidu's box and its hidden-label Next link on screen (accessibility tree), and keeps the real addresses from mu", async () => {
		// Baidu pointed at the fixture server, with CSS selectors that match nothing: only the accessibility tree can find the controls.
		const specs: Record<EngineName, EngineSpec> = {
			...ENGINES,
			baidu: { ...ENGINES.baidu, home: `${base}/baidu/`, box: ["#nope"], submit: ["#nope"], next: ["#nope"] },
		};
		// How each typing and click found its target.
		const vias: string[] = [];
		const base0 = deps();
		const d: BrowserDeps = {
			...base0,
			call: async (op, args, ms) => {
				const r = await base0.call(op, args, ms);
				if (op === "human_type" || op === "human_click") vias.push(`${op}:${(r as { via?: string }).via}`);
				return r;
			},
		};
		const out = await browserSearch(d, "国务院 常务会议", {
			engines: ["baidu"],
			pages: 3,
			timing: { ...DEFAULT_TIMING, engineGapMs: 0, hostGapMs: 0, loadMs: 15_000 },
			specs,
		});
		// Three pages, two results each, every address the article itself (no /link wrapper, no module).
		expect(out.outcomes.map((o) => [o.engine, o.pages, o.stopped, o.read])).toEqual([["baidu", 3, "", "ax"]]);
		const urls = out.outcomes[0].hits.map((h) => h.url);
		expect(urls).toHaveLength(6);
		expect(urls.every((u) => u.startsWith(`${base}/article?e=baidu&`))).toBe(true);
		// Typed into the box and clicked Next twice, all found on screen.
		expect(vias).toEqual(["human_type:ax", "human_click:ax", "human_click:ax"]);
		await d.call("close_run", { run: "chrome-test" }, 10_000);
	}, 420_000);

	it("reads Sogou's in-place loads by scrolling and keeps the real addresses from data-url", async () => {
		// Sogou pointed at the fixture server; no selectors, so the box is found on screen.
		const specs: Record<EngineName, EngineSpec> = {
			...ENGINES,
			sogou: { ...ENGINES.sogou, home: `${base}/sogou/`, box: ["#nope"] },
		};
		const vias: string[] = [];
		const base0 = deps();
		const d: BrowserDeps = {
			...base0,
			call: async (op, args, ms) => {
				const r = await base0.call(op, args, ms);
				if (op === "human_type") vias.push((r as { via?: string }).via ?? "");
				return r;
			},
		};
		const out = await browserSearch(d, "国务院 常务会议", {
			engines: ["sogou"],
			pages: 3,
			timing: { ...DEFAULT_TIMING, engineGapMs: 0, hostGapMs: 0, loadMs: 15_000 },
			specs,
		});
		// One reading round can load more than one batch (as on the real site: 8 → 24 after one scroll), so the
		// rounds are two or three; every batch is read.
		expect([out.outcomes[0].stopped, out.outcomes[0].read]).toEqual(["", "ax"]);
		expect(out.outcomes[0].pages).toBeGreaterThanOrEqual(2);
		const urls = out.outcomes[0].hits.map((h) => h.url);
		expect(urls).toHaveLength(6);
		expect(urls.every((u) => u.startsWith(`${base}/article?e=sogou&`))).toBe(true);
		expect(vias).toEqual(["ax"]);
		await d.call("close_run", { run: "chrome-test" }, 10_000);
	}, 420_000);
});
