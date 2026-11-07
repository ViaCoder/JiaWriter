// The claude and codex methods of search_web and fetch_web, against a fake upstream on loopback.
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
/** Requests to Codex's own search endpoint. */
let direct: Seen[] = [];
/** Its next answers. */
let endpoint: Record<string, unknown>[] = [];

beforeEach(async () => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "jw-server-")));
	vi.stubEnv("JW_LANG", "zh");
	vi.stubEnv("JW_DIR", join(cwd, "agent"));
	vi.stubEnv("JW_SEARCH_BLOCK", "");
	setCurrentTopic(undefined);
	seen = [];
	direct = [];
	endpoint = [];
	answers = [];
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const request = {
				path: (req.url ?? "").split("?")[0],
				headers: req.headers,
				body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
			};
			// Codex's own endpoint is counted apart, and is missing unless a test gives it answers.
			if (request.path.endsWith("/alpha/search")) {
				direct.push(request);
				const reply = endpoint.shift();
				res.writeHead(reply ? 200 : 404, { "content-type": "application/json" });
				res.end(JSON.stringify(reply ?? {}));
				return;
			}
			seen.push(request);
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
			api: "anthropic-messages",
			provider: "jw",
			baseUrl: `${upstream}/v1`,
			reasoning: true,
			compat: { forceAdaptiveThinking: true },
			maxTokens: 8000,
			...extra,
		},
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: KEY }) },
		sessionManager: { getSessionId: () => "session-1" },
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

describe("codex's own search endpoint, through the tools", () => {
	it("searches with the time window, reads the page's own text and keeps both", async () => {
		const page = "页面原文。".repeat(200);
		endpoint = [
			{
				output: "检索到的正文",
				results: [{ type: "text_result", ref_id: "turn0search0", url: URL_A, title: "新闻" }],
			},
			{ output: page, results: [{ url: URL_A, title: "新闻" }] },
			{ output: "含绿化的一段" },
		];
		const map = tools();
		const s = await run(map, "search_web", { query: "温州", method: "codex", fresh: "week" });
		expect(direct[0].path).toBe("/v1/alpha/search");
		expect(direct[0].body.id).toBe("session-1");
		expect(direct[0].body.commands).toMatchObject({ search_query: [{ q: "温州", recency: 7 }] });
		expect(s.text).toContain("检索到的正文");
		expect(s.text).toContain(URL_A);
		const f = await run(map, "fetch_web", { url: "turn0search0", method: "codex" });
		expect(direct[1].body.commands).toMatchObject({ open: [{ ref_id: "turn0search0" }] });
		expect(f.text).toContain("页面原文");
		expect(f.details.url).toBe(URL_A);
		const topic = f.details.topicDir as string;
		expect(readFileSync(join(topic, "网页", filesIn(topic, "网页")[0]), "utf-8")).toContain(page);
		const part = await run(map, "fetch_web", { url: URL_A, method: "codex", find: "绿化" });
		expect(direct[2].body.commands).toMatchObject({ find: [{ ref_id: URL_A, pattern: "绿化" }] });
		expect(part.text).toContain("含绿化的一段");
		// The part has its own file: the whole page is still there.
		const files = filesIn(topic, "网页");
		expect(files).toHaveLength(2);
		expect(files.map((f) => readFileSync(join(topic, "网页", f), "utf-8")).join("")).toContain(page);
		// Nothing went through the hosted tool.
		expect(seen).toHaveLength(0);
	});

	it("uses the hosted tool where the endpoint is missing, and asks once per session", async () => {
		answers = [codex(CODEX_SEARCHED)];
		const map = tools();
		await run(map, "search_web", { query: "甲", method: "codex" });
		await run(map, "search_web", { query: "乙", method: "codex" });
		expect(direct).toHaveLength(1);
		expect(seen.map((s) => s.path)).toEqual(["/v1/responses", "/v1/responses"]);
	});
});

describe("search_web with the upstream methods", () => {
	it("claude: asks the upstream, reports, and archives where every search goes", async () => {
		answers = [claude(SEARCHED)];
		const s = await run(tools(), "search_web", { query: "温州", method: "claude" });
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
		const s = await run(
			tools(),
			"search_web",
			{ query: "温州", method: "codex" },
			context({ api: "openai-completions" }),
		);
		expect(seen[0].path).toBe("/v1/responses");
		expect(s.text).toContain("检索结果（codex，1 条）：温州");
		expect(filesIn(s.details.topicDir as string, "检索")).toHaveLength(1);
	});

	it("gives material_add its sources, without counting as pages that were opened", async () => {
		answers = [claude(SEARCHED)];
		const s = await run(tools(), "search_web", { query: "温州", method: "claude" });
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
		await run(tools(), "search_web", { query: "q", method: "claude" });
		expect(requests.filter((r) => !r.startsWith(upstream))).toEqual([]);
	});

	it("follows the conversation's model and its thinking level at the time of the call", async () => {
		let level = "high";
		const map = tools(() => level);
		answers = [claude(SEARCHED)];
		await run(map, "search_web", { query: "q", method: "claude" });
		level = "low";
		await run(map, "search_web", { query: "q", method: "claude" });
		expect(seen[0].body.model).toBe("conversation-model");
		expect(seen[0].body.output_config).toEqual({ effort: "high" });
		expect(seen[1].body.output_config).toEqual({ effort: "low" });
	});

	it("reports an upstream that did not search, and sends nothing without a model", async () => {
		answers = [claude([{ type: "text", text: "凭记忆回答" }])];
		await expect(run(tools(), "search_web", { query: "q", method: "claude" })).rejects.toThrow("上游没有执行搜索");
		const ctx = { ...context(), model: undefined } as ExtensionToolContext;
		await expect(run(tools(), "search_web", { query: "q", method: "claude" }, ctx)).rejects.toThrow("没有设置模型");
		expect(seen).toHaveLength(1);
	});

	it("tells the model which parameters had no effect, and sends none of them", async () => {
		answers = [claude(SEARCHED)];
		const s = await run(tools(), "search_web", { query: "q", method: "claude", ignored: ["pages", "fresh"] });
		expect(s.text).toContain("claude 方式不使用这些参数，它们没有生效：pages, fresh。");
		const sent = JSON.stringify(seen[0].body);
		expect(sent).not.toContain("fresh");
		expect(sent).not.toContain("pages");
	});

	it("tells that once per method", async () => {
		answers = [claude(SEARCHED)];
		const list = tools();
		const args = { query: "q", method: "claude", ignored: ["pages"] };
		expect((await run(list, "search_web", args)).text).toContain("没有生效");
		expect((await run(list, "search_web", args)).text).not.toContain("没有生效");
	});

	it("runs one call at a time", () => {
		for (const name of ["search_web", "fetch_web"]) expect(tools().get(name)?.executionMode).toBe("sequential");
	});
});

describe("fetch_web with the upstream methods", () => {
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
		const f = await run(tools(), "fetch_web", { url: URL_A, method: "claude" });
		expect(f.text).toContain("页面原文");
		expect(f.details.backend).toBe("claude");
		const topic = f.details.topicDir as string;
		const [file] = filesIn(topic, "网页");
		expect(readFileSync(join(topic, "网页", file), "utf-8")).toContain("页面原文");
		expect(archivedUrls(topic)).toContain("news.example.com/a");
	});

	it("passes on an address the local methods would refuse", async () => {
		answers = [claude(page)];
		await run(tools(), "fetch_web", { url: "not a web address", method: "claude" });
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
					content: [{ type: "output_text", text: "页面全文".repeat(200), annotations: [] }],
				},
			]),
		];
		const f = await run(tools(), "fetch_web", { url: URL_A, method: "codex" });
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
		await expect(run(tools(), "fetch_web", { url: URL_A, method: "claude" })).rejects.toThrow("method=sf");
		await expect(run(tools(), "fetch_web", { url: URL_A, method: "claude" })).rejects.toThrow(
			"上游没有给出这个页面的内容",
		);
	});
});

describe("the tool descriptions", () => {
	it("name no default and no removed setting", () => {
		for (const name of ["search_web", "fetch_web"]) {
			const text = tools().get(name)?.description ?? "";
			expect(text).not.toContain("Without method");
			expect(text).not.toContain("JW_SEARCH");
		}
	});

	it("name the configured model when there is one", () => {
		expect(tools().get("search_web")?.description).not.toContain("The configured model is");
		setWriterModel({ kind: "ready", model: "claude-test" } as unknown as WriterModelState);
		expect(tools().get("search_web")?.description).toContain("The configured model is claude-test.");
	});
});

/** The real fetch, kept before a test stubs it. */
const fetchReal = globalThis.fetch;
