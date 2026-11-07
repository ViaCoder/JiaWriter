import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model, ThinkingContent } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/** A model of an API at an address. */
function model<A extends "openai-responses" | "anthropic-messages">(api: A, baseUrl: string): Model<A> {
	return {
		id: "test-model",
		name: "test-model",
		api,
		provider: "jw",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1000,
	};
}

/** An empty reply of a model. */
function reply(m: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: m.api,
		provider: m.provider,
		model: m.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** A stream of Responses events. */
async function* events(list: Record<string, unknown>[]): AsyncGenerator<ResponseStreamEvent> {
	for (const event of list) yield event as unknown as ResponseStreamEvent;
}

/** The records kept in a reply. */
const records = (message: AssistantMessage) =>
	message.content.filter((b): b is ThinkingContent => b.type === "thinking" && b.serverItem === true);

describe("the upstream's search on the Responses API", () => {
	const search = {
		type: "web_search_call",
		id: "ws_1",
		status: "completed",
		encrypted_content: "ENC",
		action: { type: "search", query: "绿化" },
	};

	it("keeps the record in place and sends it back as it came", async () => {
		const m = model("openai-responses", "https://example.invalid");
		const output = reply(m);
		const text = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] };
		await processResponsesStream(
			events([
				{ type: "response.output_item.done", output_index: 0, item: search },
				{ type: "response.output_item.added", output_index: 1, item: text },
				{ type: "response.completed", response: { id: "r", status: "completed", output: [] } },
			]),
			output,
			new AssistantMessageEventStream(),
			m,
		);
		expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "Web search: 绿化", serverItem: true });
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				output,
				{ role: "user", content: "next", timestamp: 2 },
			],
		});
		const input = convertResponsesMessages(m, context, new Set(["jw"]));
		expect(input.filter((i) => i.type === "web_search_call")).toEqual([search]);
	});

	it("takes the final list's copy of a record", async () => {
		const m = model("openai-responses", "https://example.invalid");
		const output = reply(m);
		const { encrypted_content: _none, ...early } = search;
		await processResponsesStream(
			events([
				{ type: "response.output_item.done", output_index: 0, item: early },
				{ type: "response.completed", response: { id: "r", status: "completed", output: [search] } },
			]),
			output,
			new AssistantMessageEventStream(),
			m,
		);
		expect(JSON.parse(records(output)[0].thinkingSignature ?? "{}")).toEqual(search);
	});
});

describe("the upstream's tools on the Messages API", () => {
	let server: Server;
	let bodies: { messages: { role: string; content: { type: string; id?: string; tool_use_id?: string }[] }[] }[];
	let answer: Record<string, unknown>[];
	let baseUrl: string;

	beforeEach(async () => {
		bodies = [];
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
				res.writeHead(200, { "content-type": "text/event-stream" });
				for (const e of answer) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
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

	/** A stream of these blocks, ending for this reason. */
	const stream = (blocks: Record<string, unknown>[], stop: string) => [
		{
			type: "message_start",
			message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } },
		},
		...blocks,
		{ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	/** The call of a search, with its input in pieces. */
	const call = (index: number) => [
		{
			type: "content_block_start",
			index,
			content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} },
		},
		{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"query":' } },
		{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '"绿化"}' } },
		{ type: "content_block_stop", index },
	];
	/** Its result. */
	const result = (index: number) => [
		{
			type: "content_block_start",
			index,
			content_block: {
				type: "web_search_tool_result",
				tool_use_id: "s1",
				content: [{ type: "web_search_result", url: "https://a.example/x", title: "A", encrypted_content: "ENC" }],
			},
		},
		{ type: "content_block_stop", index },
	];
	/** A context with this earlier reply and a next question. */
	const next = (earlier: AssistantMessage): Context => ({
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			earlier,
			{ role: "user", content: "next", timestamp: 2 },
		],
	});

	it("keeps a call with its whole input and its result, and sends both back", async () => {
		answer = stream([...call(0), ...result(1)], "end_turn");
		const m = model("anthropic-messages", baseUrl);
		const first = await streamAnthropic(
			m,
			normalizeContext({ messages: [{ role: "user", content: "q", timestamp: 0 }] }),
			{ apiKey: "k" },
		).result();
		expect(first.errorMessage).toBeUndefined();
		expect(records(first).map((b) => b.thinking)).toEqual(["web_search: 绿化", "web_search_tool_result"]);
		await streamAnthropic(m, normalizeContext(next(first)), { apiKey: "k" }).result();
		const sent = bodies[1].messages[1].content;
		expect(sent.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result"]);
		expect(JSON.stringify(sent)).toContain("ENC");
		expect(JSON.stringify(sent)).toContain('"input":{"query":"绿化"}');
	});

	it("marks a paused reply and leaves out a call left without its result", async () => {
		answer = stream([...call(0)], "pause_turn");
		const m = model("anthropic-messages", baseUrl);
		const first = await streamAnthropic(
			m,
			normalizeContext({ messages: [{ role: "user", content: "q", timestamp: 0 }] }),
			{ apiKey: "k" },
		).result();
		expect(first.rawStopReason).toBe("pause_turn");
		await streamAnthropic(m, normalizeContext(next(first)), { apiKey: "k" }).result();
		expect(JSON.stringify(bodies[1].messages)).not.toContain("server_tool_use");
	});
});
