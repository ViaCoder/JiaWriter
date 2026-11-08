import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	citedAddresses,
	fixedFor,
	fixedFromEntries,
	fixTools,
	isOpening,
	mainTools,
	mainWay,
	provenId,
	readMainSearch,
	readProven,
	replyText,
	searchReasoning,
	serverItems,
	sourceOf,
	steered,
	textOf,
	withMainSearch,
	withoutProven,
	withProven,
	writeProven,
} from "../../src/writer/websearch/main-search.ts";

/** A reply with these records and words. */
function reply(items: Record<string, unknown>[], text = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [
			...items.map((item) => ({
				type: "thinking" as const,
				thinking: "x",
				thinkingSignature: JSON.stringify(item),
				serverItem: true,
			})),
			{ type: "thinking" as const, thinking: "real thinking", thinkingSignature: '{"type":"reasoning"}' },
			{ type: "text" as const, text },
		],
	} as AssistantMessage;
}

describe("mainWay", () => {
	it("names the tools an API can carry", () => {
		expect(mainWay("anthropic-messages")).toBe("claude");
		expect(mainWay("openai-responses")).toBe("codex");
		expect(mainWay("openai-codex-responses")).toBe("codex");
		expect(mainWay("openai-completions")).toBeUndefined();
		expect(mainWay(undefined)).toBeUndefined();
	});
});

describe("mainTools", () => {
	it("gives only tools shown to work, staying under the upstream's 10 rounds", () => {
		expect(mainTools("codex", new Set())).toEqual([]);
		expect(mainTools("codex", new Set(["fetch"]))).toEqual([{ type: "web_search", external_web_access: true }]);
		expect(mainTools("claude", new Set())).toEqual([]);
		expect(mainTools("claude", new Set(["search"])).map((t) => t.name)).toEqual(["web_search"]);
		const both = mainTools("claude", new Set(["search", "fetch"]));
		expect(both.map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
		expect(both.reduce((sum, t) => sum + Number(t.max_uses), 0)).toBeLessThan(10);
	});
});

describe("withMainSearch", () => {
	const own = { type: "function", name: "search_web" };

	it("adds the tools after the conversation's own", () => {
		const out = withMainSearch({ model: "m", tools: [own] }, "claude", new Set(["search"]));
		expect(out?.model).toBe("m");
		expect((out?.tools as unknown[]).length).toBe(2);
		expect((out?.tools as unknown[])[0]).toMatchObject(own);
	});

	it("tells our own search tool to leave upstream search to the upstream's, and leaves other tools alone", () => {
		const other = { type: "function", name: "write", description: "Write." };
		const mine = { ...own, description: "Search." };
		const out = withMainSearch({ tools: [mine, other] }, "codex", new Set(["search"]));
		const [first, second] = out?.tools as { description: string }[];
		expect(first.description).toMatch(/^Search\.\n - For upstream search use the web_search tool/);
		expect(second).toEqual(other);
	});

	it("leaves alone a request without tools, and one with nothing to add", () => {
		expect(withMainSearch({ model: "m" }, "codex", new Set(["search"]))).toBeUndefined();
		expect(withMainSearch({ tools: [] }, "codex", new Set(["search"]))).toBeUndefined();
		expect(withMainSearch({ tools: [own] }, "codex", new Set())).toBeUndefined();
	});

	it("asks Codex for its sources, keeping what was asked for", () => {
		const out = withMainSearch(
			{ tools: [own], include: ["reasoning.encrypted_content"] },
			"codex",
			new Set(["search"]),
		);
		expect(out?.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
	});

	it("leaves out or raises a reasoning level Codex's tool refuses", () => {
		const shown = new Set(["search"] as const);
		expect(withMainSearch({ tools: [own], reasoning: { effort: "none" } }, "codex", shown)).not.toHaveProperty(
			"reasoning",
		);
		expect(
			withMainSearch({ tools: [own], reasoning: { effort: "minimal", summary: "auto" } }, "codex", shown)?.reasoning,
		).toEqual({
			effort: "low",
			summary: "auto",
		});
		expect(withMainSearch({ tools: [own], reasoning: { effort: "high" } }, "codex", shown)?.reasoning).toEqual({
			effort: "high",
		});
		expect(withMainSearch({ tools: [own] }, "codex", shown)).not.toHaveProperty("reasoning");
	});
});

describe("readMainSearch", () => {
	it("reads what Codex did", () => {
		const found = readMainSearch(
			reply([
				{
					type: "web_search_call",
					action: {
						type: "search",
						query: "甲",
						queries: ["甲", "乙"],
						sources: [{ type: "url", url: "https://a.example/1" }],
					},
				},
				{ type: "web_search_call", action: { type: "open_page", url: "https://a.example/2" } },
				{ type: "web_search_call", action: { type: "find_in_page", url: "https://a.example/2", pattern: "x" } },
			]),
		);
		expect(found.queries).toEqual(["甲", "乙"]);
		expect(found.sources.map((s) => s.url)).toEqual(["https://a.example/1"]);
		expect(found.opened).toEqual(["https://a.example/2"]);
		expect(found.pages).toEqual([]);
	});

	it("reads what Claude did, and takes a page's text when it is plain", () => {
		const page = (url: string, source: Record<string, unknown>) => ({
			type: "web_fetch_tool_result",
			content: { type: "web_fetch_result", url, content: { type: "document", title: "标题", source } },
		});
		const found = readMainSearch(
			reply([
				{ type: "server_tool_use", name: "web_search", input: { query: "甲" } },
				{
					type: "web_search_tool_result",
					content: [{ url: "https://a.example/1", title: "一", page_age: "2026-11-01" }],
				},
				{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error" } },
				{ type: "server_tool_use", name: "web_fetch", input: { url: "https://a.example/2" } },
				page("https://a.example/2", { type: "text", media_type: "text/plain", data: "原文" }),
				page("https://a.example/3", { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }),
			]),
		);
		expect(found.queries).toEqual(["甲"]);
		expect(found.sources).toEqual([{ url: "https://a.example/1", title: "一", snippet: "", date: "2026-11-01" }]);
		expect(found.pages).toEqual([{ url: "https://a.example/2", title: "标题", content: "原文" }]);
	});

	it("finds nothing in a reply without records", () => {
		expect(readMainSearch(reply([]))).toEqual({ queries: [], sources: [], opened: [], pages: [] });
	});
});

describe("replyText and citedAddresses", () => {
	it("reads the reply's words and the addresses in them, each once", () => {
		const message = reply([], "见 [甲](https://a.example/1)，又见 https://a.example/2。再看 https://a.example/1 。");
		expect(replyText(message)).toContain("又见");
		expect(citedAddresses(message)).toEqual(["https://a.example/1", "https://a.example/2"]);
		expect(citedAddresses(reply([], "没有地址"))).toEqual([]);
	});
});

describe("the record of shown tools", () => {
	it("provenId keeps no address", () => {
		const id = provenId("https://relay.example.com/v1", "model");
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(id).not.toBe(provenId("https://relay.example.com/v1", "other"));
	});

	it("readProven and writeProven round-trip, and drop unknown tools", () => {
		const dir = mkdtempSync(join(tmpdir(), "jw-proven-"));
		const file = join(dir, "deep", "proven.json");
		expect(readProven(file)).toEqual({});
		writeProven(file, { a: ["search", "fetch"] });
		expect(readProven(file)).toEqual({ a: ["search", "fetch"] });
		writeFileSync(file, JSON.stringify({ a: ["search", "other"], b: "no" }));
		expect(readProven(file)).toEqual({ a: ["search"] });
		writeFileSync(file, "not json");
		expect(readProven(file)).toEqual({});
		rmSync(dir, { recursive: true });
	});
});

describe("isOpening", () => {
	it("is true only before the model has said anything", () => {
		expect(isOpening({ messages: [{ role: "user" }] })).toBe(true);
		expect(isOpening({ messages: [{ role: "user" }, { role: "assistant" }] })).toBe(false);
		expect(isOpening({})).toBe(false);
	});
});

describe("fixedFor", () => {
	it("gives a conversation's tools on its own upstream only", () => {
		const fixed = { id: "a", tools: ["search" as const] };
		expect([...fixedFor(fixed, "a")]).toEqual(["search"]);
		expect([...fixedFor(fixed, "b")]).toEqual([]);
		expect([...fixedFor(undefined, "a")]).toEqual([]);
	});
});

describe("withProven and withoutProven", () => {
	it("adds a tool once, keeps other upstreams, and forgets one upstream", () => {
		const one = withProven({ other: ["fetch"] }, "a", "search");
		expect(withProven(one, "a", "search")).toEqual({ other: ["fetch"], a: ["search"] });
		expect(withProven(one, "a", "fetch").a).toEqual(["search", "fetch"]);
		expect(withoutProven(one, "a")).toEqual({ other: ["fetch"] });
		expect(withoutProven(one, "missing")).toEqual(one);
	});
});

describe("fixTools", () => {
	const record = { a: ["search" as const] };
	it("takes the record only on a first request", () => {
		expect(fixTools(undefined, "a", { messages: [{ role: "user" }] }, record).tools).toEqual(["search"]);
		expect(fixTools(undefined, "a", { messages: [{ role: "assistant" }] }, record).tools).toEqual([]);
		expect(fixTools(undefined, "b", { messages: [{ role: "user" }] }, record).tools).toEqual([]);
	});
	it("never changes what is fixed", () => {
		const fixed = { id: "a", tools: [] };
		expect(fixTools(fixed, "a", { messages: [{ role: "user" }] }, record)).toBe(fixed);
	});
});

describe("fixedFromEntries", () => {
	it("gives the last set of the right kind", () => {
		const entries = [
			{ type: "custom", customType: "t", data: { id: "a", tools: [] } },
			{ type: "message" },
			{ type: "custom", customType: "other", data: { id: "x", tools: [] } },
			{ type: "custom", customType: "t", data: { id: "b", tools: ["search"] } },
		];
		expect(fixedFromEntries(entries, "t")?.id).toBe("b");
		expect(fixedFromEntries([], "t")).toBeUndefined();
	});
});

describe("searchReasoning", () => {
	it("drops none, raises minimal and leaves the rest", () => {
		expect(searchReasoning({ effort: "none" })).toEqual({});
		expect(searchReasoning({ effort: "minimal", summary: "auto" })).toEqual({
			reasoning: { effort: "low", summary: "auto" },
		});
		expect(searchReasoning({ effort: "high" })).toEqual({ reasoning: { effort: "high" } });
		expect(searchReasoning(undefined)).toEqual({});
	});
});

describe("steered", () => {
	it("adds the note to our search tool only", () => {
		expect(
			(steered({ name: "search_web", description: "Search." }) as { description: string }).description,
		).toContain("web_search tool");
		const other = { name: "read", description: "Read." };
		expect(steered(other)).toBe(other);
	});
});

describe("serverItems, textOf and sourceOf", () => {
	it("takes the records of a reply only", () => {
		expect(serverItems(reply([{ type: "web_search_call" }])).map((i) => i.type)).toEqual(["web_search_call"]);
	});
	it("takes text and leaves anything else out", () => {
		expect(textOf("a")).toBe("a");
		expect(textOf(1)).toBe("");
		expect(sourceOf("u", "t", 3)).toEqual({ url: "u", title: "t", snippet: "", date: "" });
	});
});

describe("how long the record takes", () => {
	it("reads a reply of 2000 records in under 50 ms", () => {
		const items = Array.from({ length: 2000 }, (_, i) => ({
			type: "web_search_call",
			action: { type: "search", query: `q${i}`, sources: [{ url: `https://a.example.com/${i}` }] },
		}));
		const message = reply(items);
		const started = performance.now();
		expect(readMainSearch(message).sources.length).toBe(2000);
		expect(performance.now() - started).toBeLessThan(50);
	});
});
