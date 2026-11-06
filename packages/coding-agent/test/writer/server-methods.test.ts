// The claude and codex methods of web_search and web_fetch, against a fake upstream on loopback.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import writerSearchExtension from "../../src/extensions/writer-search/index.ts";
import { setCurrentTopic } from "../../src/writer/topic/current.ts";
import { addMaterials, archivedUrls, materialUrls } from "../../src/writer/topic/topic.ts";
import { setWriterModel, type WriterModelState } from "../../src/writer/writer-model.ts";

/** A request the upstream saw. */
interface Seen {
	path: string;
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
}

const KEY = "dummy-upstream-key-for-tests";
let cwd = "";
let seen: Seen[] = [];
let server: Server;
let upstream = "";
/** Stream events of the next answers; the last one repeats. */
let answers: Record<string, unknown>[][] = [];

beforeEach(async () => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "jw-server-")));
	vi.stubEnv("JW_LANG", "zh");
	vi.stubEnv("JW_DIR", join(cwd, "agent"));
	vi.stubEnv("JW_SEARCH_BLOCK", "");
	setCurrentTopic(undefined);
	seen = [];
	answers = [];
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			seen.push({
				path: (req.url ?? "").split("?")[0],
				headers: req.headers,
				body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
			});
			const events = answers.length > 1 ? answers.shift() : answers[0];
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const e of events ?? []) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	setCurrentTopic(undefined);
	setWriterModel({ kind: "none" });
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(cwd, { recursive: true, force: true });
});

/** Tools of a fresh instance, with the conversation's thinking level read through level(). */
function tools(level: () => string = () => "off"): Map<string, ToolDefinition> {
	const map = new Map<string, ToolDefinition>();
	writerSearchExtension({
		registerTool: (t: ToolDefinition) => map.set(t.name, t),
		registerCommand: () => undefined,
		on: () => () => undefined,
		getThinkingLevel: level,
	} as unknown as ExtensionAPI);
	return map;
}

/** The context of a conversation on the fake upstream, whatever API it was detected as. */
function context(extra: Record<string, unknown> = {}): ExtensionToolContext {
	return {
		cwd,
		hasUI: false,
		model: {
			id: "conversation-model",
			api: "openai-completions",
			provider: "jw",
			baseUrl: `${upstream}/v1`,
			reasoning: true,
			compat: { forceAdaptiveThinking: true },
			maxTokens: 8000,
			...extra,
		},
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: KEY }) },
	} as unknown as ExtensionToolContext;
}

/** Run one tool. */
async function run(map: Map<string, ToolDefinition>, name: string, params: Record<string, unknown>, ctx = context()) {
	const tool = map.get(name);
	if (!tool) throw new Error(`missing tool ${name}`);
	const result = await tool.execute("call-1", params, undefined, undefined, ctx);
	const first = result.content[0];
	return { text: first?.type === "text" ? first.text : "", details: result.details as Record<string, unknown> };
}

/** A Claude reply stream. */
function claude(blocks: Record<string, unknown>[]): Record<string, unknown>[] {
	return [
		{
			type: "message_start",
			message: {
				id: "m",
				type: "message",
				role: "assistant",
				model: "x",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		...blocks.flatMap((block, index) =>
			block.type === "text"
				? [
						{ type: "content_block_start", index, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
						{ type: "content_block_stop", index },
					]
				: [
						{ type: "content_block_start", index, content_block: block },
						{ type: "content_block_stop", index },
					],
		),
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
}

/** A Responses reply stream. */
function codex(output: Record<string, unknown>[]): Record<string, unknown>[] {
	const response = { id: "r", object: "response", created_at: 1, model: "x", status: "completed", output: [] };
	return [
		{ type: "response.created", sequence_number: 0, response },
		{ type: "response.completed", sequence_number: 1, response: { ...response, output } },
	];
}

const URL_A = "https://news.example.com/a";
const SEARCHED = [
	{ type: "server_tool_use", id: "s1", name: "web_search", input: {} },
	{
		type: "web_search_tool_result",
		tool_use_id: "s1",
		content: [
			{ type: "web_search_result", url: URL_A, title: "新闻", page_age: "2026-10-31", encrypted_content: "x" },
		],
	},
	{ type: "text", text: "上游写的回答" },
];
const CODEX_SEARCHED = [
	{
		type: "web_search_call",
		id: "w",
		status: "completed",
		action: { type: "search", query: "q", sources: [{ type: "url", url: URL_A }] },
	},
	{
		type: "message",
		id: "m",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "上游写的回答", annotations: [] }],
	},
];

/** The files of a topic folder under one sub-folder. */
function filesIn(topic: string, sub: string): string[] {
	const dir = join(topic, sub);
	return existsSync(dir) ? readdirSync(dir) : [];
}

describe("web_search with the upstream methods", () => {
	it("claude: asks the upstream, reports, and archives where every search goes", async () => {
		answers = [claude(SEARCHED)];
		const s = await run(tools(), "web_search", { query: "温州", method: "claude" });
		expect(seen).toHaveLength(1);
		expect(seen[0].path).toBe("/v1/messages");
		expect(seen[0].headers["x-api-key"]).toBe(KEY);
		expect(s.text).toContain("上游写的回答");
		expect(s.text).toContain("检索结果（claude，1 条）：温州");
		expect(s.text).toContain(URL_A);
		expect(s.details.backend).toBe("claude");
		// The same folder as every other search.
		const topic = s.details.topicDir as string;
		const [file] = filesIn(topic, "检索");
		expect(file).toBeTruthy();
		expect(readFileSync(join(topic, "检索", file), "utf-8")).toContain("上游写的回答");
	});

	it("codex: goes to the Responses path even when the detected API is Chat Completions", async () => {
		answers = [codex(CODEX_SEARCHED)];
		const s = await run(tools(), "web_search", { query: "温州", method: "codex" });
		expect(seen[0].path).toBe("/v1/responses");
		expect(s.text).toContain("检索结果（codex，1 条）：温州");
		expect(filesIn(s.details.topicDir as string, "检索")).toHaveLength(1);
	});

	it("gives material_add its sources, without counting as pages that were opened", async () => {
		answers = [claude(SEARCHED)];
		const s = await run(tools(), "web_search", { query: "温州", method: "claude" });
		const topic = s.details.topicDir as string;
		expect(materialUrls(topic)).toContain("news.example.com/a");
		expect(archivedUrls(topic)).toEqual([]);
		const item = {
			kind: "case",
			time: "2026年",
			reporter: "路透社",
			subject: "甲",
			action: "乙",
			url: URL_A,
		} as const;
		expect(addMaterials(topic, [item])).toBe(1);
	});

	it("never touches AnySearch or the browser", async () => {
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(String(input));
			return fetchReal(input, init);
		});
		answers = [claude(SEARCHED)];
		await run(tools(), "web_search", { query: "q", method: "claude" });
		expect(requests.filter((r) => !r.startsWith(upstream))).toEqual([]);
	});

	it("follows the conversation's model and its thinking level at the time of the call", async () => {
		let level = "high";
		const map = tools(() => level);
		answers = [claude(SEARCHED)];
		await run(map, "web_search", { query: "q", method: "claude" });
		level = "low";
		await run(map, "web_search", { query: "q", method: "claude" });
		expect(seen[0].body.model).toBe("conversation-model");
		expect(seen[0].body.output_config).toEqual({ effort: "high" });
		expect(seen[1].body.output_config).toEqual({ effort: "low" });
	});

	it("reports an upstream that did not search, and sends nothing without a model", async () => {
		answers = [claude([{ type: "text", text: "凭记忆回答" }])];
		await expect(run(tools(), "web_search", { query: "q", method: "claude" })).rejects.toThrow("上游没有执行搜索");
		const ctx = { ...context(), model: undefined } as ExtensionToolContext;
		await expect(run(tools(), "web_search", { query: "q", method: "claude" }, ctx)).rejects.toThrow("没有设置模型");
		expect(seen).toHaveLength(1);
	});

	it("runs one call at a time", () => {
		for (const name of ["web_search", "web_fetch"]) expect(tools().get(name)?.executionMode).toBe("sequential");
	});
});

describe("web_fetch with the upstream methods", () => {
	const page = [
		{ type: "server_tool_use", id: "s2", name: "web_fetch", input: {} },
		{
			type: "web_fetch_tool_result",
			tool_use_id: "s2",
			content: {
				type: "web_fetch_result",
				url: URL_A,
				retrieved_at: null,
				content: {
					type: "document",
					title: "新闻",
					citations: null,
					source: { type: "text", media_type: "text/plain", data: "页面原文" },
				},
			},
		},
		{ type: "text", text: "好" },
	];

	it("claude: keeps the page with the others, where material_add finds its source", async () => {
		answers = [claude(page)];
		const f = await run(tools(), "web_fetch", { url: URL_A, method: "claude" });
		expect(f.text).toContain("页面原文");
		expect(f.details.backend).toBe("claude");
		const topic = f.details.topicDir as string;
		const [file] = filesIn(topic, "网页");
		expect(readFileSync(join(topic, "网页", file), "utf-8")).toContain("页面原文");
		expect(archivedUrls(topic)).toContain("news.example.com/a");
	});

	it("passes on an address the local methods would refuse", async () => {
		answers = [claude(page)];
		await run(tools(), "web_fetch", { url: "not a web address", method: "claude" });
		expect(JSON.stringify(seen[0].body.messages)).toContain("not a web address");
	});

	it("codex: keeps what the upstream wrote once it opened the page", async () => {
		answers = [
			codex([
				{ type: "web_search_call", id: "w", status: "completed", action: { type: "open_page", url: URL_A } },
				{
					type: "message",
					id: "m",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "页面全文", annotations: [] }],
				},
			]),
		];
		const f = await run(tools(), "web_fetch", { url: URL_A, method: "codex" });
		expect(f.text).toContain("页面全文");
		expect(filesIn(f.details.topicDir as string, "网页")).toHaveLength(1);
		expect(archivedUrls(f.details.topicDir as string)).toContain("news.example.com/a");
	});

	it("names a PDF and a page that was not opened", async () => {
		answers = [
			claude([
				{
					type: "web_fetch_tool_result",
					tool_use_id: "s2",
					content: {
						type: "web_fetch_result",
						url: URL_A,
						retrieved_at: null,
						content: {
							type: "document",
							title: null,
							citations: null,
							source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
						},
					},
				},
			]),
			claude([{ type: "text", text: "打不开" }]),
		];
		await expect(run(tools(), "web_fetch", { url: URL_A, method: "claude" })).rejects.toThrow("method=sf");
		await expect(run(tools(), "web_fetch", { url: URL_A, method: "claude" })).rejects.toThrow("上游没有打开这个页面");
	});
});

describe("the prompt", () => {
	/** The text a model reads for one tool. */
	function words(name: string): string {
		const tool = tools().get(name);
		return [tool?.description, ...(tool?.promptGuidelines ?? [])].join("\n");
	}

	it("leaves the choice to the model, with no default", () => {
		for (const name of ["web_search", "web_fetch"]) {
			expect(words(name)).toContain("none is the default");
			expect(words(name)).not.toContain("Without method");
			expect(words(name)).not.toContain("JW_SEARCH");
		}
	});

	it("uses the upstream methods only when the user's prompt says the upstream supports them", () => {
		for (const name of ["web_search", "web_fetch"]) {
			expect(words(name)).toContain("only when the user's prompt says the upstream supports it");
			expect(words(name)).toContain("claude for Claude models, codex for Codex and GPT models");
		}
	});

	it("names the configured model when there is one", () => {
		expect(words("web_search")).not.toContain("The configured model is");
		setWriterModel({ kind: "ready", model: "claude-test" } as unknown as WriterModelState);
		expect(words("web_search")).toContain("The configured model is claude-test.");
	});
});

/** The real fetch, kept before a test stubs it. */
const fetchReal = globalThis.fetch;
