// Arguments as models send them.
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import writerSearchExtension from "../../src/extensions/writer-search/index.ts";
import { cleanFetchArgs, cleanSearchArgs, shownSearchArgs } from "../../src/writer/websearch/args.ts";

describe("cleanSearchArgs", () => {
	it("drops what a method does not use", () => {
		const full = {
			query: "q",
			engines: ["bing"],
			pages: 3,
			fresh: "week",
			zone: "intl",
			language: "en",
			max_results: 5,
			other: 1,
		};
		const all = ["engines", "pages", "fresh", "zone", "language"];
		expect(cleanSearchArgs({ ...full, method: "codex" })).toEqual({
			query: "q",
			method: "codex",
			fresh: "week",
			ignored: all.filter((name) => name !== "fresh"),
		});
		expect(cleanSearchArgs({ ...full, method: "claude" })).toEqual({ query: "q", method: "claude", ignored: all });
		expect(cleanSearchArgs({ ...full, method: "anysearch" })).toEqual({
			query: "q",
			method: "anysearch",
			zone: "intl",
			language: "en",
			ignored: ["engines", "pages", "fresh"],
		});
		expect(cleanSearchArgs({ ...full, method: "browser" })).toEqual({
			query: "q",
			method: "browser",
			engines: ["bing"],
			pages: 3,
			fresh: "week",
			ignored: ["zone", "language"],
		});
	});

	it("shows a call as it took effect", () => {
		const call = { query: "q", method: "codex", engines: [], fresh: "year", language: "", pages: 3, zone: "intl" };
		expect(shownSearchArgs(call)).toEqual({ query: "q", method: "codex", fresh: "year" });
		expect(shownSearchArgs({ query: "q", method: "browser", pages: 4 })).toEqual({
			query: "q",
			method: "browser",
			pages: 4,
		});
	});

	it("counts only real values as ignored, as in the reported call", () => {
		const call = { query: "q", method: "codex", engines: [], fresh: "year", language: "en", pages: 3, zone: "intl" };
		expect(cleanSearchArgs(call).ignored).toEqual(["pages", "zone", "language"]);
		expect(
			cleanSearchArgs({ query: "q", method: "codex", engines: [], pages: null, fresh: "" }).ignored,
		).toBeUndefined();
	});

	it("drops empty values that strict models send for unused fields", () => {
		const out = cleanSearchArgs({ query: "q", method: "browser", engines: null, pages: null, fresh: null });
		expect(out).toEqual({ query: "q", method: "browser" });
		expect(cleanSearchArgs({ query: "q", method: "browser", engines: [], pages: "", fresh: "" })).toEqual({
			query: "q",
			method: "browser",
		});
		expect(cleanSearchArgs({ query: "q", method: "anysearch", zone: "", language: " " })).toEqual({
			query: "q",
			method: "anysearch",
		});
	});

	it.each([
		["a list", ["Bing", "GOOGLE"], ["bing", "google"]],
		["a string", "bing, google", ["bing", "google"]],
		["sites", ["www.google.com", "https://bing.com/"], ["google", "bing"]],
		["Chinese names", "百度、搜狗", ["baidu", "sogou"]],
		["repeats", ["bing", "Bing"], ["bing"]],
		["unknown names among them", ["bing", "yahoo"], ["bing"]],
	])("reads engines given as %s", (_name, engines, wanted) => {
		expect(cleanSearchArgs({ query: "q", method: "browser", engines }).engines).toEqual(wanted);
	});

	it("drops engines that name nothing known, so the default applies", () => {
		expect(cleanSearchArgs({ query: "q", method: "browser", engines: ["yahoo"] }).engines).toBeUndefined();
	});

	it("repairs the other fields", () => {
		const out = cleanSearchArgs({ query: ["甲", "乙"], method: " Browser ", pages: "4", fresh: "WEEK" });
		expect(out).toEqual({ query: "甲 乙", method: "browser", pages: 4, fresh: "week" });
		expect(cleanSearchArgs({ query: "q", method: "browser", pages: "many", fresh: "soon" })).toEqual({
			query: "q",
			method: "browser",
		});
		expect(cleanSearchArgs({ query: "q", method: "anysearch", zone: "INTL" }).zone).toBe("intl");
		expect(cleanSearchArgs({ query: "q", method: "anysearch", zone: "europe" }).zone).toBeUndefined();
	});

	it("takes an engine named as the method for the browser on that engine", () => {
		expect(cleanSearchArgs({ query: "q", method: "Google" })).toEqual({
			query: "q",
			method: "browser",
			engines: ["google"],
		});
		expect(cleanSearchArgs({ query: "q", method: "bing", engines: ["baidu"] }).engines).toEqual(["bing", "baidu"]);
	});

	it("leaves a missing or unknown method for the schema to report", () => {
		expect(cleanSearchArgs({ query: "q" })).toEqual({ query: "q" });
		expect(cleanSearchArgs({ query: "q", method: null })).toEqual({ query: "q" });
		expect(cleanSearchArgs({ query: "q", method: "exa" }).method).toBe("exa");
		expect(cleanSearchArgs(undefined)).toEqual({ query: undefined });
	});
});

describe("cleanFetchArgs", () => {
	it("keeps the address exactly and tidies the method", () => {
		const url = " https://Example.com/路径?q=1 ";
		expect(cleanFetchArgs({ url, method: " SF ", engines: ["bing"], pages: 3 })).toEqual({ url, method: "sf" });
		expect(cleanFetchArgs({ url, method: null })).toEqual({ url });
		expect(cleanFetchArgs({ url })).toEqual({ url });
		// Only codex takes these, and only with real values.
		expect(cleanFetchArgs({ url, method: "codex", lineno: 120, find: " 绿化 " })).toEqual({
			url,
			method: "codex",
			lineno: 120,
			find: "绿化",
		});
		expect(cleanFetchArgs({ url, method: "codex", lineno: 0, find: "" })).toEqual({ url, method: "codex" });
		expect(cleanFetchArgs({ url, method: "codex", lineno: "x", find: null })).toEqual({ url, method: "codex" });
		expect(cleanFetchArgs({ url, method: "browser", lineno: 5, find: "绿化" })).toEqual({ url, method: "browser" });
	});
});

describe("preparing a call", () => {
	it("cleans a call before it is checked", () => {
		const map = new Map<string, ToolDefinition>();
		writerSearchExtension({
			registerTool: (t: ToolDefinition) => map.set(t.name, t),
			registerCommand: () => undefined,
			on: () => undefined,
		} as unknown as ExtensionAPI);
		const prepared = map.get("search_web")?.prepareArguments?.({ query: "q", method: "codex", engines: ["bing"] });
		expect(prepared).toEqual({ query: "q", method: "codex", ignored: ["engines"] });
		expect(map.get("fetch_web")?.prepareArguments?.({ url: "u", method: "SF" })).toEqual({ url: "u", method: "sf" });
	});
});
