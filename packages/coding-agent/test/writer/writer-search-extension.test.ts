// Functional tests for the built-in writer-search extension (src/extensions/writer-search/index.ts):
// both tools end to end over a fake sf script and a fake AnySearch fetch. No network.

// Temp files.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Extension API types.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
// The prompt builder that shows snippets and guidelines.
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
// Extension under test.
import writerSearchExtension from "../../src/extensions/writer-search/index.ts";
// Main-model state store.
import { setWriterModel, type WriterModelState } from "../../src/writer/writer-model.ts";

// Working directory of each test (also holds the fake sf and its log).
let cwd = "";
// Fresh directory, Chinese output, a ready main model.
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "wa-search-"));
	vi.stubEnv("WA_LANG", "zh");
	vi.stubEnv("WA_KEY", "sk-main-test-1");
	for (const k of ["WA_SEARCH", "WA_SF", "WA_SEARCH_KEY", "WA_SEARCH_BLOCK", "SF_URL", "SF_KEY", "SF_MODEL", "SF_API"])
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
if (process.argv[2] === "search") console.log(JSON.stringify({ query: "q", blocks: [{ results: [
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
	// Fake API with only registerTool.
	writerSearchExtension({ registerTool: (t: ToolDefinition) => map.set(t.name, t) } as unknown as ExtensionAPI);
	return map;
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

describe("writer-search over sf", () => {
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
