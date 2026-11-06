import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ServerCall, type ServerStyle, serverFetch, serverSearch } from "../src/api/server-search.ts";
import type { Api, Model } from "../src/types.ts";

/** A key that would be obvious if it leaked. */
const KEY = "dummy-key-value-for-tests";

/** One request the fake upstream saw. */
interface Seen {
	path: string;
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
}

/** What the fake upstream answers: a status with JSON, or a stream of events. */
type Answer = { status: number; json: unknown } | { events: Record<string, unknown>[] };

/** Requests seen, and answers still to give. */
let seen: Seen[];
let answers: ((request: Seen) => Answer)[];
let server: Server;
let baseUrl: string;

beforeEach(async () => {
	seen = [];
	answers = [];
	// A fake upstream: answers come from the test, one per request.
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const request: Seen = {
				// The beta endpoint adds a query; the path is what matters here.
				path: (req.url ?? "").split("?")[0],
				headers: req.headers,
				body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
			};
			seen.push(request);
			// The last answer repeats.
			const next = answers.length > 1 ? answers.shift() : answers[0];
			const answer = next?.(request) ?? { status: 500, json: {} };
			if ("status" in answer) {
				res.writeHead(answer.status, { "content-type": "application/json" });
				res.end(JSON.stringify(answer.json));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of answer.events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

/** A model as the conversation has it. */
function model(extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		type: "chat",
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		provider: "jw",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8000,
		...extra,
	} as Model<Api>;
}

/** A call on the fake upstream. */
function call(way: ServerCall["way"], extra: Partial<ServerCall> = {}): ServerCall {
	return { way, baseUrl, model: model(), apiKey: KEY, thinking: "off", styles: new Map(), ...extra };
}

/** Anthropic stream events of one reply. */
function claudeEvents(blocks: Record<string, unknown>[], stopReason = "end_turn"): Answer {
	const events: Record<string, unknown>[] = [
		{
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "test-model",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
	];
	blocks.forEach((block, index) => {
		if (block.type === "text") {
			events.push({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: [] } });
			events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
			for (const citation of (block.citations ?? []) as unknown[])
				events.push({ type: "content_block_delta", index, delta: { type: "citations_delta", citation } });
		} else events.push({ type: "content_block_start", index, content_block: block });
		events.push({ type: "content_block_stop", index });
	});
	events.push({
		type: "message_delta",
		delta: { stop_reason: stopReason, stop_sequence: null },
		usage: { output_tokens: 1 },
	});
	events.push({ type: "message_stop" });
	return { events };
}

/** A Responses stream that ends with this output. */
function codexEvents(output: Record<string, unknown>[]): Answer {
	const response = {
		id: "resp_1",
		object: "response",
		created_at: 1,
		model: "test-model",
		status: "completed",
		output: [],
		parallel_tool_calls: true,
		tool_choice: "auto",
		tools: [],
	};
	return {
		events: [
			{ type: "response.created", sequence_number: 0, response },
			{ type: "response.completed", sequence_number: 1, response: { ...response, output } },
		],
	};
}

/** A Responses message item with text and citations. */
function codexMessage(text: string, annotations: Record<string, unknown>[] = []): Record<string, unknown> {
	return {
		type: "message",
		id: "msg_1",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations }],
	};
}

/** A search the server ran. */
const USED = { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} };

/** A search result block. */
function results(...urls: string[]): Record<string, unknown> {
	return {
		type: "web_search_tool_result",
		tool_use_id: "srv_1",
		content: urls.map((url, i) => ({
			type: "web_search_result",
			url,
			title: `T${i}`,
			page_age: "May 1, 2026",
			encrypted_content: "x",
		})),
	};
}

/** A citation of one address. */
function citation(url: string, cited: string): Record<string, unknown> {
	return { type: "web_search_result_location", url, title: "Cited", cited_text: cited, encrypted_index: "x" };
}

/** A fetched page block. */
function fetched(source: Record<string, unknown>, url = "https://example.com/a"): Record<string, unknown> {
	return {
		type: "web_fetch_tool_result",
		tool_use_id: "srv_2",
		content: {
			type: "web_fetch_result",
			url,
			retrieved_at: null,
			content: { type: "document", title: "Page", citations: null, source },
		},
	};
}

describe("serverSearch, claude", () => {
	it("returns the text and the sources, with the tool Claude Code sends", async () => {
		answers = [() => claudeEvents([USED, results("https://example.com/a"), { type: "text", text: "Found it." }])];
		const out = await serverSearch(call("claude"), "some query");
		expect(out.text).toBe("Found it.");
		expect(out.sources).toEqual([{ url: "https://example.com/a", title: "T0", snippet: "", date: "May 1, 2026" }]);
		expect(seen).toHaveLength(1);
		expect(seen[0].path).toBe("/v1/messages");
		expect(seen[0].headers["x-api-key"]).toBe(KEY);
		expect(seen[0].body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]);
		expect(JSON.stringify(seen[0].body.messages)).toContain("Perform a web search for the query: some query");
	});

	it("merges citations into the sources, each address once", async () => {
		const url = "https://example.com/a";
		answers = [
			() =>
				claudeEvents([
					USED,
					results(url),
					{
						type: "text",
						text: "A",
						citations: [citation(url, "first"), citation(url, "second"), citation(url, "first")],
					},
					{ type: "text", text: "B", citations: [citation("https://example.com/b", "other")] },
				]),
		];
		const out = await serverSearch(call("claude"), "q");
		expect(out.sources).toHaveLength(2);
		expect(out.sources[0].snippet).toBe("first second");
		expect(out.sources[1]).toMatchObject({ url: "https://example.com/b", title: "Cited", snippet: "other" });
		expect(out.text).toBe("AB");
	});

	it("resumes a paused turn with the reply as it was", async () => {
		answers = [
			() => claudeEvents([USED, results("https://example.com/a")], "pause_turn"),
			() => claudeEvents([{ type: "text", text: "Done." }]),
		];
		const out = await serverSearch(call("claude"), "q");
		expect(out.text).toBe("Done.");
		expect(out.sources).toHaveLength(1);
		expect(seen).toHaveLength(2);
		const messages = seen[1].body.messages as { role: string; content: { type: string }[] }[];
		expect(messages[1].role).toBe("assistant");
		expect(messages[1].content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result"]);
	});

	it("stops resuming a turn that never ends", async () => {
		answers = [() => claudeEvents([USED, results("https://example.com/a")], "pause_turn")];
		await serverSearch(call("claude"), "q");
		expect(seen).toHaveLength(5);
	});

	it("reports a tool error object as a failure", async () => {
		const failed = {
			type: "web_search_tool_result",
			tool_use_id: "srv_1",
			content: { type: "web_search_tool_result_error", error_code: "too_many_requests" },
		};
		answers = [() => claudeEvents([USED, failed])];
		await expect(serverSearch(call("claude"), "q")).rejects.toMatchObject({
			code: "tool_error",
			message: "too_many_requests",
		});
	});

	it("refuses a reply when the upstream never searched", async () => {
		answers = [() => claudeEvents([{ type: "text", text: "From memory." }])];
		await expect(serverSearch(call("claude"), "q")).rejects.toMatchObject({ code: "no_search" });
	});

	it("follows the conversation's model and effort", async () => {
		const adaptive = model({
			api: "anthropic-messages",
			reasoning: true,
			compat: { forceAdaptiveThinking: true },
		} as Partial<Model<Api>>);
		answers = [() => claudeEvents([USED, results("https://example.com/a")])];
		await serverSearch(call("claude", { model: adaptive, thinking: "high" }), "q");
		expect(seen[0].body.model).toBe("test-model");
		expect(seen[0].body.thinking).toEqual({ type: "adaptive" });
		expect(seen[0].body.output_config).toEqual({ effort: "high" });
	});

	it("sends no thinking field for a model set up on another API", async () => {
		answers = [() => claudeEvents([USED, results("https://example.com/a")])];
		const other = model({ api: "openai-responses", reasoning: true });
		await serverSearch(call("claude", { model: other, thinking: "high" }), "q");
		expect(seen[0].body.thinking).toBeUndefined();
		expect(seen[0].body.output_config).toBeUndefined();
	});

	it("keeps the output limit of a request inside what the model can take", async () => {
		answers = [() => claudeEvents([USED, results("https://example.com/a")])];
		await serverSearch(call("claude", { model: model({ maxTokens: 128_000 }) }), "q");
		expect(seen[0].body.max_tokens).toBe(16_000);
		const old = model({ api: "anthropic-messages", reasoning: true, maxTokens: 128_000 });
		await serverSearch(call("claude", { model: old, thinking: "high" }), "q");
		const thinking = seen[1].body.thinking as { budget_tokens: number };
		expect(thinking.budget_tokens).toBeLessThan(seen[1].body.max_tokens as number);
		expect(seen[1].body.max_tokens).toBeLessThan(128_000);
	});

	it("uses a thinking budget on older models and none when thinking is off", async () => {
		answers = [() => claudeEvents([USED, results("https://example.com/a")])];
		const old = model({ api: "anthropic-messages", reasoning: true });
		await serverSearch(call("claude", { model: old, thinking: "low" }), "q");
		expect(seen[0].body.thinking).toMatchObject({ type: "enabled" });
		await serverSearch(call("claude", { model: old, thinking: "off" }), "q");
		expect(seen[1].body.thinking).toBeUndefined();
		expect(seen[1].body.output_config).toBeUndefined();
	});
});

describe("serverSearch, codex", () => {
	it("returns the text, the consulted sources and the citations, with the tool Codex sends", async () => {
		answers = [
			() =>
				codexEvents([
					{
						type: "web_search_call",
						id: "ws_1",
						status: "completed",
						action: { type: "search", query: "q", sources: [{ type: "url", url: "https://example.com/a" }] },
					},
					codexMessage("Found it.", [
						{ type: "url_citation", url: "https://example.com/a", title: "A", start_index: 0, end_index: 1 },
						{ type: "url_citation", url: "https://example.com/b", title: "B", start_index: 0, end_index: 1 },
					]),
				]),
		];
		const out = await serverSearch(call("codex"), "some query");
		expect(out.text).toBe("Found it.");
		expect(out.sources.map((s) => [s.url, s.title])).toEqual([
			["https://example.com/a", "A"],
			["https://example.com/b", "B"],
		]);
		expect(seen[0].path).toBe("/v1/responses");
		expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
		expect(seen[0].body.tools).toEqual([{ type: "web_search", external_web_access: true }]);
		expect(seen[0].body.include).toEqual(["web_search_call.action.sources"]);
		expect(seen[0].body.store).toBe(false);
		expect(seen[0].body.stream).toBe(true);
	});

	it("refuses a reply when the upstream never searched", async () => {
		answers = [() => codexEvents([codexMessage("From memory.")])];
		await expect(serverSearch(call("codex"), "q")).rejects.toMatchObject({ code: "no_search" });
	});

	it("follows the conversation's effort", async () => {
		const reasoning = model({ api: "openai-responses", reasoning: true });
		const used = { type: "web_search_call", id: "w", status: "completed", action: { type: "search", query: "q" } };
		answers = [() => codexEvents([used])];
		await serverSearch(call("codex", { model: reasoning, thinking: "medium" }), "q");
		expect(seen[0].body.reasoning).toEqual({ effort: "medium" });
		await serverSearch(call("codex", { thinking: "medium" }), "q");
		expect(seen[1].body.reasoning).toBeUndefined();
	});

	it("never sends an effort hosted search refuses", async () => {
		const used = { type: "web_search_call", id: "w", status: "completed", action: { type: "search", query: "q" } };
		answers = [() => codexEvents([used])];
		const reasoning = model({ api: "openai-responses", reasoning: true });
		await serverSearch(call("codex", { model: reasoning, thinking: "off" }), "q");
		expect(seen[0].body.reasoning).toBeUndefined();
		await serverSearch(call("codex", { model: reasoning, thinking: "minimal" }), "q");
		expect(seen[1].body.reasoning).toEqual({ effort: "low" });
		const claudeModel = model({ api: "anthropic-messages", reasoning: true });
		await serverSearch(call("codex", { model: claudeModel, thinking: "high" }), "q");
		expect(seen[2].body.reasoning).toBeUndefined();
		await serverSearch(call("codex", { model: reasoning, thinking: "max" }), "q");
		expect(seen[3].body.reasoning).not.toEqual({ effort: "max" });
	});
});

describe("serverSearch, codex streams", () => {
	const used = {
		type: "web_search_call",
		id: "w",
		status: "completed",
		action: { type: "search", query: "q", sources: [{ type: "url", url: "https://example.com/a" }] },
	};
	const created = { type: "response.created", sequence_number: 0, response: { id: "r", output: [] } };

	it("skips events the SDK does not know", async () => {
		const done = { type: "response.completed", response: { id: "r", output: [used, codexMessage("结果")] } };
		answers = [
			() => ({ events: [created, { type: "response.something_new", value: 1 }, { type: "keepalive" }, done] }),
		];
		const out = await serverSearch(call("codex"), "q");
		expect(out.text).toBe("结果");
		expect(out.sources).toHaveLength(1);
	});

	it("takes the items as they arrive when the final output is empty", async () => {
		const item = (i: Record<string, unknown>) => ({ type: "response.output_item.done", output_index: 0, item: i });
		const done = { type: "response.completed", response: { id: "r", output: [] } };
		answers = [() => ({ events: [created, item(used), item(codexMessage("逐条到达")), done] })];
		const out = await serverSearch(call("codex"), "q");
		expect(out.text).toBe("逐条到达");
	});

	it("takes the items when no final event comes at all", async () => {
		answers = [() => ({ events: [{ type: "response.output_item.done", item: used }] })];
		expect((await serverSearch(call("codex"), "q")).sources).toHaveLength(1);
	});

	it("reports a failed response and an error event by their message", async () => {
		const failed = { type: "response.failed", response: { error: { message: "model overloaded" } } };
		answers = [() => ({ events: [failed] })];
		await expect(serverSearch(call("codex"), "q")).rejects.toMatchObject({
			code: "upstream",
			message: "model overloaded",
		});
	});

	it("does not leak the key from a failed response", async () => {
		const failed = { type: "response.failed", response: { error: { message: `bad ${KEY}` } } };
		answers = [() => ({ events: [failed] })];
		const error = await serverSearch(call("codex"), "q").catch((e: Error) => e);
		expect((error as Error).message).not.toContain(KEY);
	});

	it("reports an upstream that finished without searching", async () => {
		answers = [() => ({ events: [{ type: "response.completed", response: { id: "r", output: [] } }] })];
		await expect(serverSearch(call("codex"), "q")).rejects.toMatchObject({ code: "no_search" });
	});
});

describe("the record of a call", () => {
	const used = { type: "web_search_call", id: "w", status: "completed", action: { type: "search", query: "q" } };

	it("shows the failed SDK error, the unknown event and the tool that ran, without the key", async () => {
		const lines: string[] = [];
		const log = (line: string) => lines.push(line);
		const failed = { type: "response.failed", response: { error: { message: `bad ${KEY}` } } };
		answers = [() => ({ events: [{ type: "response.something_new" }, failed] })];
		await expect(serverSearch(call("codex", { log }), "查询")).rejects.toMatchObject({ code: "upstream" });
		await vi.waitFor(() => expect(lines.join("\n")).toContain('"kind":"stream"'));
		const text = lines.join("\n");
		expect(text).toContain('"kind":"start"');
		expect(text).toContain("查询");
		expect(text).toContain("response.something_new");
		expect(text).toContain('"kind":"attempt-failed"');
		expect(text).toContain('"kind":"failed"');
		expect(text).not.toContain(KEY);
	});

	it("shows how many sources a finished search had", async () => {
		const lines: string[] = [];
		answers = [() => codexEvents([used])];
		await serverSearch(call("codex", { log: (line) => lines.push(line) }), "q");
		await vi.waitFor(() => expect(lines.join("\n")).toContain("response.completed"));
		expect(lines.join("\n")).toContain('"kind":"done"');
	});

	it("records the plain and the OAuth try of a call that needed both, for claude", async () => {
		const lines: string[] = [];
		answers = [
			() => ({ status: 401, json: { error: { type: "authentication_error", message: "no" } } }),
			() => claudeEvents([USED, results("https://example.com/a")]),
		];
		await serverSearch(call("claude", { log: (line) => lines.push(line) }), "q");
		await vi.waitFor(() => expect(lines.join("\n")).toContain("content_block_start:server_tool_use"));
		const text = lines.join("\n");
		expect(text).toContain('"style":"plain"');
		expect(text).toContain("authentication_error");
		expect(text).toContain('"kind":"done"');
		expect(text).not.toContain(KEY);
	});

	it("works the same with no log", async () => {
		answers = [() => codexEvents([used])];
		await expect(serverSearch(call("codex"), "q")).resolves.toBeDefined();
	});
});

describe("serverFetch", () => {
	it("claude: returns the page as fetched, not the model's words", async () => {
		const url = "https://example.com/a";
		answers = [
			() =>
				claudeEvents([
					{ type: "server_tool_use", id: "srv_2", name: "web_fetch", input: {} },
					fetched({ type: "text", media_type: "text/plain", data: "The whole page." }, url),
					{ type: "text", text: "I read it." },
				]),
		];
		const page = await serverFetch(call("claude"), url);
		expect(page).toEqual({ url, title: "Page", content: "The whole page." });
		expect(seen[0].body.tools).toEqual([{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 1 }]);
	});

	it("sends any address exactly as given, in the user message", async () => {
		const addresses = [
			`https://example.com/${"x".repeat(400)}`,
			"https://example.com/路径?q=中文&a=1#frag",
			"ftp://example.com/file",
			"not even a url",
		];
		answers = [() => claudeEvents([fetched({ type: "text", media_type: "text/plain", data: "x" })])];
		for (const address of addresses) await serverFetch(call("claude"), address);
		addresses.forEach((address, i) => {
			const messages = seen[i].body.messages as { role: string; content: string }[];
			expect(messages[0].role).toBe("user");
			expect(messages[0].content).toContain(address);
		});
	});

	it("claude: a redirect to another address still counts", async () => {
		answers = [() => claudeEvents([fetched({ type: "text", data: "x" }, "https://example.com/moved")])];
		expect((await serverFetch(call("claude"), "https://example.com/a")).url).toBe("https://example.com/moved");
	});

	it("claude: reports a tool error, a PDF and a fetch that never ran", async () => {
		const failed = {
			type: "web_fetch_tool_result",
			tool_use_id: "srv_2",
			content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" },
		};
		answers = [
			() => claudeEvents([failed]),
			() => claudeEvents([fetched({ type: "base64", media_type: "application/pdf", data: "JVBERi0=" })]),
			() => claudeEvents([{ type: "text", text: "I cannot." }]),
		];
		await expect(serverFetch(call("claude"), "https://example.com/a")).rejects.toMatchObject({
			code: "tool_error",
			message: "url_not_accessible",
		});
		await expect(serverFetch(call("claude"), "https://example.com/a")).rejects.toMatchObject({ code: "pdf" });
		await expect(serverFetch(call("claude"), "https://example.com/a")).rejects.toMatchObject({ code: "no_open" });
	});

	it("codex: returns the written text once a page was opened, whatever its address", async () => {
		answers = [
			() =>
				codexEvents([
					{
						type: "web_search_call",
						id: "w",
						status: "completed",
						action: { type: "open_page", url: "https://example.com/moved" },
					},
					codexMessage("The page text."),
				]),
		];
		const page = await serverFetch(call("codex"), "https://example.com/a");
		expect(page).toEqual({ url: "https://example.com/a", title: "", content: "The page text." });
	});

	it("codex: refuses a reply without an opened page", async () => {
		const searched = {
			type: "web_search_call",
			id: "w",
			status: "completed",
			action: { type: "search", query: "q" },
		};
		answers = [() => codexEvents([searched, codexMessage("From memory.")])];
		await expect(serverFetch(call("codex"), "https://example.com/a")).rejects.toMatchObject({ code: "no_open" });
	});
});

describe("request style", () => {
	/** A JWT carrying an account. */
	const jwt = `h.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }))}.s`;
	const claudeOk = () => claudeEvents([USED, results("https://example.com/a")]);
	const codexOk = () =>
		codexEvents([{ type: "web_search_call", id: "w", status: "completed", action: { type: "search" } }]);
	const denied = (status: number) => () => ({ status, json: { error: { message: "no" } } });

	it("sends one plain request when that works, for any key", async () => {
		answers = [claudeOk];
		await serverSearch(call("claude", { apiKey: "sk-ant-oat-looks-like-oauth" }), "q");
		expect(seen).toHaveLength(1);
		expect(seen[0].headers["x-api-key"]).toBe("sk-ant-oat-looks-like-oauth");
		expect(seen[0].headers.authorization).toBeUndefined();
		expect(seen[0].headers["anthropic-beta"]).toBeUndefined();
	});

	it.each([401, 403, 404])("claude: %i brings one OAuth-style request with the same key", async (status) => {
		answers = [denied(status), claudeOk];
		await serverSearch(call("claude"), "q");
		expect(seen).toHaveLength(2);
		expect(seen[1].path).toBe("/v1/messages");
		expect(seen[1].headers.authorization).toBe(`Bearer ${KEY}`);
		expect(seen[1].headers["x-api-key"]).toBeUndefined();
		expect(seen[1].headers["anthropic-beta"]).toContain("oauth-2025-04-20");
		expect(seen[1].headers["anthropic-beta"]).toContain("claude-code-20250219");
		expect(seen[1].headers["x-app"]).toBe("cli");
		const system = seen[1].body.system as { text: string }[];
		expect(system[0].text).toContain("You are Claude Code");
	});

	it("claude: page reads take the same two steps", async () => {
		const ok = () => claudeEvents([fetched({ type: "text", data: "x" })]);
		answers = [denied(401), ok];
		expect((await serverFetch(call("claude"), "https://example.com/a")).content).toBe("x");
		expect(seen[1].headers["anthropic-beta"]).toContain("oauth-2025-04-20");
	});

	it("codex: 404 brings the Codex path, headers and account", async () => {
		answers = [denied(404), codexOk];
		await serverSearch(call("codex", { apiKey: jwt }), "q");
		expect(seen).toHaveLength(2);
		expect(seen[1].path).toBe("/codex/responses");
		expect(seen[1].headers.authorization).toBe(`Bearer ${jwt}`);
		expect(seen[1].headers["chatgpt-account-id"]).toBe("acct-1");
		expect(seen[1].headers.originator).toBe("pi");
		expect(seen[1].headers["openai-beta"]).toBe("responses=experimental");
		expect(seen[1].body.store).toBe(false);
		expect(seen[1].body.stream).toBe(true);
		expect(seen[1].body.instructions).toBeTruthy();
	});

	it("codex: a key without an account still goes out, without that header", async () => {
		answers = [denied(401), codexOk];
		await serverSearch(call("codex"), "q");
		expect(seen[1].path).toBe("/codex/responses");
		expect(seen[1].headers["chatgpt-account-id"]).toBeUndefined();
	});

	it("uses the style that worked for the rest of the session", async () => {
		const styles = new Map<string, ServerStyle>();
		answers = [denied(401), claudeOk, claudeOk];
		await serverSearch(call("claude", { styles }), "q");
		await serverSearch(call("claude", { styles }), "q");
		expect(seen).toHaveLength(3);
		expect(seen[2].headers["anthropic-beta"]).toContain("oauth-2025-04-20");
	});

	it("keeps styles apart per way and address", async () => {
		const styles = new Map<string, ServerStyle>();
		answers = [denied(401), claudeOk, codexOk];
		await serverSearch(call("claude", { styles }), "q");
		await serverSearch(call("codex", { styles }), "q");
		expect(seen[2].path).toBe("/v1/responses");
	});

	it.each([429, 500])("%i is the answer: no second style", async (status) => {
		answers = [denied(status)];
		await expect(serverSearch(call("claude"), "q")).rejects.toMatchObject({ code: "upstream" });
		expect(seen).toHaveLength(1);
	});

	it("reports both failures, without the key", async () => {
		const echo = () => ({ status: 401, json: { error: { message: `bad key ${KEY}` } } });
		answers = [echo];
		const error = await serverSearch(call("claude"), "q").catch((e: Error) => e);
		expect(seen).toHaveLength(2);
		expect((error as Error).message).toContain("plain:");
		expect((error as Error).message).toContain("oauth:");
		expect((error as Error).message).not.toContain(KEY);
	});

	it("does not leak the key from a single failure either", async () => {
		answers = [() => ({ status: 500, json: { error: { message: `boom ${KEY}` } } })];
		const error = await serverSearch(call("codex"), "q").catch((e: Error) => e);
		expect((error as Error).message).not.toContain(KEY);
	});

	it("a stopped call stays stopped and tries nothing else", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(serverSearch(call("claude", { signal: controller.signal }), "q")).rejects.toBeDefined();
		expect(seen).toHaveLength(0);
	});
});
