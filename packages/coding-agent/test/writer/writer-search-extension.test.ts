// Functional tests for the built-in writer-search extension (src/extensions/writer-search/index.ts):
// both tools end to end over a fake sf script, a fake AnySearch fetch, and a browser host with a fake
// extension behind it. No network.

// Temp files.
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Fake stdio of the browser host.
import { PassThrough } from "node:stream";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Extension API types.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
// The prompt builder that shows snippets and guidelines.
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
// Extension under test.
import writerSearchExtension from "../../src/extensions/writer-search/index.ts";
// Browser host and frames.
import { bridgeAddress, decodeFrames, encodeFrame, HOST_NAME, runHost } from "../../src/writer/browser/bridge.ts";
// Chrome's host folder of this system.
import { manifestDir } from "../../src/writer/browser/install.ts";
// Main-model state store.
import { setWriterModel, type WriterModelState } from "../../src/writer/writer-model.ts";

// These cases run fake sf scripts with a shebang line: Linux and macOS only.
const UNIX_ONLY = process.platform === "win32";

// Working directory of each test (also holds the fake sf and its log).
let cwd = "";
// Fresh directory, Chinese output, a ready main model.
beforeEach(() => {
	// Real path: macOS temp folders are symlinks (/var → /private/var), and sf reports the real cwd.
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "wa-search-")));
	vi.stubEnv("WA_LANG", "zh");
	vi.stubEnv("WA_KEY", "sk-main-test-1");
	// Own agent folder: the browser bridge looked up by auto is the test's, not this machine's.
	vi.stubEnv("WA_DIR", join(cwd, "agent"));
	for (const k of [
		"WA_SEARCH",
		"WA_SF",
		"WA_SEARCH_KEY",
		"WA_SEARCH_BLOCK",
		"WA_ENGINES",
		"WA_SEARCH_PAGES",
		"SF_URL",
		"SF_KEY",
		"SF_MODEL",
		"SF_API",
	])
		vi.stubEnv(k, "");
	setWriterModel({
		kind: "ready",
		root: "https://llm.example.com",
		api: "anthropic-messages",
		model: "m1",
	} as unknown as WriterModelState);
});
// Clean up.
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	setWriterModel({ kind: "none" });
});

/** Fake sf: logs argv, cwd and the driver variables (key only as present/absent), answers both commands. */
function fakeSf(): string {
	// Script path.
	const p = join(cwd, "sf");
	// Body: append one JSON line to sf-log.jsonl, then print the contract.
	writeFileSync(
		p,
		`#!${process.execPath}
const fs = require("node:fs");
const e = process.env;
fs.appendFileSync(${JSON.stringify(join(cwd, "sf-log.jsonl"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
  url: e.SF_URL, model: e.SF_MODEL, api: e.SF_API, key: e.SF_KEY ? "set" : "", noHuman: e.SEARCH_FETCH_NO_HUMAN || "" }) + "\\n");
if (process.argv[2] === "bridge") {
  if (process.argv[3] === "install") console.log("extension folder: /x/extension");
  else { console.log(JSON.stringify({ connected: false })); process.exit(1); }
} else if (process.argv[2] === "search") console.log(JSON.stringify({ query: "q", blocks: [{ results: [
  { u: "https://news.example.com/a", t: "温州 2026-10-31 消息" }, { u: "https://news.example.com/a#x", t: "dup" }] }] }));
else console.log(JSON.stringify({ final_url: "https://news.example.com/a", markdown: "（发布时间：2026-10-31）\\n正文内容" }));
`,
	);
	chmodSync(p, 0o755);
	return p;
}

/** Tools of a fresh extension instance (configuration is read at factory time). */
function tools(): Map<string, ToolDefinition> {
	// Collected tools.
	const map = new Map<string, ToolDefinition>();
	// Fake API with registerTool (commands are ignored here).
	writerSearchExtension({
		registerTool: (t: ToolDefinition) => map.set(t.name, t),
		registerCommand: () => undefined,
		on: () => () => undefined,
	} as unknown as ExtensionAPI);
	return map;
}

/** A command of a fresh extension instance (/sf by default). */
function sfCommand(name = "sf"): (args: string, ctx: unknown) => Promise<void> {
	// Collected command handlers.
	const cmds = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	writerSearchExtension({
		registerTool: () => undefined,
		registerCommand: (name: string, o: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			cmds.set(name, o.handler),
		on: () => () => undefined,
	} as unknown as ExtensionAPI);
	const h = cmds.get(name);
	if (!h) throw new Error(`missing /${name}`);
	return h;
}

/** Run one tool; hasUI chooses interactive or print mode. */
async function run(map: Map<string, ToolDefinition>, name: string, params: Record<string, unknown>, hasUI = false) {
	// The tool.
	const tool = map.get(name);
	if (!tool) throw new Error(`missing tool ${name}`);
	// Minimal context.
	const ctx = { cwd, hasUI } as ExtensionToolContext;
	// Execute.
	const result = await tool.execute("call-1", params, undefined, undefined, ctx);
	const first = result.content[0];
	return { text: first?.type === "text" ? first.text : "", details: result.details as Record<string, unknown> };
}

/** Lines of the fake sf log. */
function sfLog(): Record<string, unknown>[] {
	// One object per run.
	return readFileSync(join(cwd, "sf-log.jsonl"), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
}

describe.skipIf(UNIX_ONLY)("writer-search over sf", () => {
	it("searches and fetches through sf without a driver model, even with a ready main model", async () => {
		// sf backend with the fake binary.
		vi.stubEnv("WA_SEARCH", "sf");
		vi.stubEnv("WA_SF", fakeSf());
		const map = tools();
		// Search in print mode; a query starting with "-" stays a query.
		const s = await run(map, "web_search", { query: "-温州", fresh: "day" });
		expect(s.text).toContain("检索结果（sf，1 条）：-温州");
		expect(s.text).toContain("https://news.example.com/a（2026-10-31）");
		expect(s.text).not.toContain("提示：");
		// Fetch interactively.
		const f = await run(map, "web_fetch", { url: "https://news.example.com/a" }, true);
		expect(f.text.split("\n")[0]).toBe("网页正文（sf）：https://news.example.com/a");
		expect(f.text).toContain("正文内容");
		expect(f.details).toMatchObject({ date: "2026-10-31", backend: "sf" });
		// What sf received.
		const [a, b] = sfLog();
		expect(a).toEqual({
			argv: ["search", "--json", "--pages=1", "--fresh=day", "--", "-温州"],
			cwd,
			url: "",
			model: "",
			api: "",
			key: "",
			noHuman: "1",
		});
		expect(b).toMatchObject({ argv: ["fetch", "--json", "--", "https://news.example.com/a"], noHuman: "" });
	});
	it("clears the user's SF_* too, so sf makes no model call", async () => {
		// The user's own driver model in the environment.
		vi.stubEnv("WA_SEARCH", "sf");
		vi.stubEnv("WA_SF", fakeSf());
		vi.stubEnv("SF_URL", "https://cheap.example.com/v1");
		vi.stubEnv("SF_KEY", "sk-cheap");
		vi.stubEnv("SF_MODEL", "flash");
		// Works with no main model either.
		setWriterModel({ kind: "none" });
		await run(tools(), "web_search", { query: "q" });
		// sf saw all four cleared.
		expect(sfLog()[0]).toMatchObject({ url: "", key: "", model: "", api: "" });
	});
});

describe.skipIf(UNIX_ONLY)("/browser and /sf", () => {
	it("registers the host in Chrome's folder, shows the install steps, and refuses other arguments", async () => {
		// A temp home: registration writes into its Chrome folder.
		vi.stubEnv("HOME", join(cwd, "home"));
		const notes: { text: string; type: string }[] = [];
		const ctx = { cwd, ui: { notify: (text: string, type: string) => notes.push({ text, type }) } };
		// /browser, then /sf install (same page), then a bad argument to each.
		await sfCommand("browser")("", ctx);
		await sfCommand()("install", ctx);
		await sfCommand()("rm -rf", ctx);
		await sfCommand("browser")("x", ctx);
		// First time: registered, not connected, the steps with the extension folder.
		const manifest = join(manifestDir(process.platform, join(cwd, "home")), `${HOST_NAME}.json`);
		expect(existsSync(manifest)).toBe(true);
		expect(notes[0].type).toBe("warning");
		expect(notes[0].text).toContain("已向 Chrome 注册本机通信程序");
		expect(notes[0].text).toContain("Chrome 扩展未连接。");
		expect(notes[0].text).toContain("search_fetch/src/search_fetch/extension");
		// Second time: nothing new to register.
		expect(notes[1].text.startsWith("Chrome 扩展未连接。")).toBe(true);
		expect(notes[2]).toEqual({ text: "用法：/sf status 或 /sf install，与 /browser 相同。", type: "error" });
		expect(notes[3]).toEqual({ text: "用法：/browser 查看扩展是否连接和安装步骤。", type: "error" });
	});
});

/** A browser host in the test's agent folder with a fake extension: one site, two engines, one article. */
async function fakeBrowser() {
	// Chrome's side of the pipe.
	const toHost = new PassThrough();
	const fromHost = new PassThrough();
	// Tab → [engine, page].
	const tabs = new Map<number, [string, number]>();
	let nextTab = 1;
	const ops: string[] = [];
	// Answer one command.
	const answer = (m: Record<string, unknown>): unknown => {
		ops.push(String(m.op === "run" ? `run:${(m as { script: string }).script}` : m.op));
		const st = tabs.get(m.tab as number);
		switch (m.op) {
			case "status":
				return { version: "2.0.0" };
			case "open":
				tabs.set(nextTab, [
					String(m.url).includes("bing") ? "bing" : String(m.url).includes("google") ? "google" : "page",
					0,
				]);
				return { tab: nextTab++, url: m.url };
			case "human_type":
				if (st) st[1] = 1;
				return { typed: true, navigated: true, newTab: null };
			case "human_click":
				if (st) st[1]++;
				return { clicked: true, navigated: true, newTab: null };
			case "info":
				return { url: st ? `https://${st[0]}/s?p=${st[1]}` : "" };
			case "run": {
				const script = (m as { script: string }).script;
				if (script === "serp" && st) {
					const results =
						st[1] === 0
							? []
							: [
									{
										u: `https://news.example.com/${st[0]}-${st[1]}`,
										t: `温州 消息 ${st[0]} ${st[1]}`,
										s: "温州 报道",
										r: 0,
									},
								];
					return JSON.stringify({
						results,
						next: true,
						challenge: false,
						consent: false,
						url: `https://${st[0]}/s?p=${st[1]}`,
					});
				}
				if (script === "probe")
					return JSON.stringify({
						title: "t",
						textLen: 900,
						excerpt: "z".repeat(900),
						challengeIframe: false,
						cfChallenge: false,
						cfCleared: false,
					});
				if (script === "article")
					return JSON.stringify({
						title: "温州新闻",
						published: "",
						markdown: "温州正文",
						contentType: "text/html",
					});
				if (script === "meta")
					return JSON.stringify({ pub: "2026-11-01", final_url: "https://news.example.com/google-3" });
				return null;
			}
			default:
				return true;
		}
	};
	let rest: Buffer = Buffer.alloc(0);
	fromHost.on("data", (chunk: Buffer) => {
		const got = decodeFrames(Buffer.concat([rest, chunk]));
		rest = got.rest;
		for (const m of got.messages) {
			const msg = m as Record<string, unknown>;
			toHost.write(encodeFrame({ id: msg.id, ok: true, result: answer(msg) }));
		}
	});
	const address = bridgeAddress(join(cwd, "agent"), process.platform);
	const done = runHost({ input: toHost, output: fromHost, address });
	for (let i = 0; i < 50 && !existsSync(address.kind === "unix" ? address.path : address.file); i++)
		await new Promise((r) => setTimeout(r, 20));
	return {
		ops,
		stop: async () => {
			toHost.end();
			await done;
		},
	};
}

describe("writer-search over the browser", () => {
	it("searches Bing and Google through the extension and fetches a result by clicking it", async () => {
		const host = await fakeBrowser();
		try {
			const map = tools();
			// auto finds the connected extension.
			const s = await run(map, "web_search", { query: "温州", max_results: 20 });
			expect(s.text.split("\n")[0]).toBe("检索结果（浏览器（Bing 3 页、Google 3 页），6 条）：温州");
			expect(s.details.backend).toBe("browser");
			// The marker that the extension was seen.
			expect(existsSync(join(cwd, "agent", "browser", "seen"))).toBe(true);
			// A result on Google's last page is clicked on that page, then the tab goes back.
			const f = await run(map, "web_fetch", { url: "https://news.example.com/google-3" });
			expect(f.text.split("\n")[0]).toBe("网页正文（browser）：温州新闻");
			expect(f.details).toMatchObject({ backend: "browser", date: "2026-11-01" });
			expect(host.ops.slice(-9)).toEqual([
				"info",
				"run:serp",
				"human_click",
				"run:probe",
				"run:probe",
				"human_scroll",
				"run:article",
				"run:meta",
				"back",
			]);
		} finally {
			await host.stop();
		}
	}, 60_000);

	it("falls back to AnySearch with a note when the extension is not connected, and fails when browser is required", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						code: 0,
						data: { results: [{ title: "T", url: "https://a.example/x", snippet: "" }] },
					}),
					{ status: 200 },
				),
		);
		const s = await run(tools(), "web_search", { query: "q" });
		expect(s.text.split("\n")[0]).toBe(
			"Chrome 里的 WriterAgent 扩展没有连接，本次改用 AnySearch。安装扩展的步骤见 /browser。",
		);
		expect(s.details.backend).toBe("anysearch");
		vi.stubEnv("WA_SEARCH", "browser");
		await expect(run(tools(), "web_search", { query: "q" })).rejects.toThrow("Chrome 里的 WriterAgent 扩展没有连接");
	});
});

describe("writer-search over AnySearch", () => {
	it("reports results with dates, applies the blocklist and hides a 402 body", async () => {
		// Default backend; one blocked host.
		vi.stubEnv("WA_SEARCH_BLOCK", "spam.example");
		const calls: string[] = [];
		const replies = [
			new Response(
				JSON.stringify({
					code: 0,
					data: {
						results: [
							{ title: "T", url: "https://a.example/x", snippet: "2026-10-31 报道" },
							{ title: "S", url: "https://ads.spam.example/", snippet: "" },
						],
					},
				}),
				{ status: 200 },
			),
			new Response(JSON.stringify({ message: "password=gen-secret-1" }), { status: 402 }),
		];
		vi.stubGlobal("fetch", async (url: string) => {
			calls.push(url);
			return replies.shift() as Response;
		});
		const map = tools();
		// Search.
		const s = await run(map, "web_search", { query: "温州", zone: "cn" });
		expect(s.text).toContain("检索结果（anysearch，1 条）：温州");
		expect(s.text).not.toContain("spam.example");
		expect(calls[0]).toBe("https://api.anysearch.com/v1/search");
		// Quota exhausted: the body never surfaces.
		const err = await run(map, "web_fetch", { url: "https://a.example/x" }).catch((e: Error) => e);
		expect((err as Error).message).toBe("AnySearch 匿名额度已用完，可设置 WA_SEARCH_KEY 后重试。");
	});
	it("rejects a bad backend, an empty query and a non-http URL", async () => {
		// Unknown backend.
		vi.stubEnv("WA_SEARCH", "exa");
		await expect(run(tools(), "web_search", { query: "q" })).rejects.toThrow("WA_SEARCH 只能是");
		// Empty query and file URL.
		vi.stubEnv("WA_SEARCH", "");
		await expect(run(tools(), "web_search", { query: "  " })).rejects.toThrow("请提供检索词");
		await expect(run(tools(), "web_fetch", { url: "file:///etc/passwd" })).rejects.toThrow("只能抓取 http(s) 网址");
	});
});

describe("writer-search prompt text", () => {
	it("adds both snippets and the citation guideline", () => {
		// Prompt with both tools.
		const list = [...tools().values()];
		const prompt = buildSystemPrompt({
			cwd,
			selectedTools: list.map((t) => t.name),
			toolSnippets: Object.fromEntries(list.map((t) => [t.name, t.promptSnippet ?? ""])),
			promptGuidelines: list.flatMap((t) => t.promptGuidelines ?? []),
		});
		// Snippet lines and a guideline.
		expect(prompt).toContain("- web_search: Search the web for sources");
		expect(prompt).toContain("- web_fetch: Fetch a web page");
		expect(prompt).toContain("cite");
	});
});
