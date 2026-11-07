import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	citedAddresses,
	mainTools,
	mainWay,
	readMainSearch,
	replyText,
	withMainSearch,
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
		expect(first.description).toMatch(/^Search\. For upstream search call the web_search tool/);
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
