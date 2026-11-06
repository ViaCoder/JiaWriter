import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanLog,
	eventName,
	failureEntry,
	safeUrl,
	secretsOf,
	serverLog,
	tracedFetch,
} from "../src/api/server-trace.ts";

/** A key that must never reach a line. */
const KEY = "dummy-key-value-for-tests";

/** Lines written so far. */
let lines: string[];
/** What the fake upstream answers. */
let answer: { status: number; type: string; body: string };
/** The fake upstream and its address. */
let server: Server;
let base: string;

beforeEach(async () => {
	lines = [];
	answer = { status: 200, type: "application/json", body: "{}" };
	// One answer for every request.
	server = createServer((_req, res) => {
		res.writeHead(answer.status, { "content-type": answer.type, "x-request-id": "req_1", "x-secret-thing": KEY });
		res.end(answer.body);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise((done) => server.close(done));
});

/** The fetch under test, logging into lines. */
const traced = () => tracedFetch(serverLog((line) => lines.push(line), [KEY]));
/** The entries of a kind. */
const entries = (kind: string) => lines.map((l) => JSON.parse(l)).filter((e) => e.kind === kind);

describe("secretsOf", () => {
	it("takes the key and every header value, and leaves out what is too short to cut safely", () => {
		expect(secretsOf(KEY, { "x-a": "header-secret", "x-b": "no", "x-c": null }, undefined)).toEqual([
			KEY,
			"header-secret",
		]);
		expect(secretsOf(undefined)).toEqual([]);
	});
});

describe("cleanLog", () => {
	it.each([
		[`plain ${KEY} text`, KEY],
		["authorization: Bearer abc.def-ghi", "abc.def-ghi"],
		['{"x-api-key":"abcdefgh"}', "abcdefgh"],
		['{\\"api_key\\":\\"abcdefgh\\"}', "abcdefgh"],
		["cookie: session=abcdefgh", "abcdefgh"],
		["token Bearer zzzyyyxxx end", "zzzyyyxxx"],
		["used sk-abcdefgh12345678 here", "sk-abcdefgh12345678"],
		["jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOjF9.c2ln here", "eyJhbGciOiJSUzI1NiJ9"],
	])("removes the secret from %s", (text, secret) => {
		expect(cleanLog(text, [KEY])).not.toContain(secret);
	});

	it("leaves ordinary text alone", () => {
		expect(cleanLog("basic search, no cookies here", [KEY])).toBe("basic search, no cookies here");
	});
});

describe("safeUrl", () => {
	it("drops the login, the query and the fragment", () => {
		expect(safeUrl("https://u:p@example.com:8443/v1/responses?key=abc#x")).toBe(
			"https://example.com:8443/v1/responses",
		);
		expect(safeUrl("not a url")).toBe("<bad url>");
	});
});

describe("eventName", () => {
	it("names an event with its kind, which shows whether a tool was called", () => {
		const item = { type: "response.output_item.done", item: { type: "web_search_call" } };
		expect(eventName(item, "")).toBe("response.output_item.done:web_search_call");
		const block = { type: "content_block_start", content_block: { type: "server_tool_use" } };
		expect(eventName(block, "")).toBe("content_block_start:server_tool_use");
		expect(eventName({ type: "ping" }, "")).toBe("ping");
		expect(eventName({}, "from-event-line")).toBe("from-event-line");
	});
});

describe("serverLog", () => {
	it("stamps and cleans every field, and survives a write that fails", () => {
		serverLog((line) => lines.push(line), [KEY])({ kind: "x", nested: { value: KEY } });
		expect(JSON.parse(lines[0]).time).toMatch(/^\d{4}-/);
		expect(lines[0]).not.toContain(KEY);
		const broken = serverLog(() => {
			throw new Error("disk full");
		}, []);
		expect(() => broken({ kind: "x" })).not.toThrow();
	});
});

describe("failureEntry", () => {
	it("keeps the class, status, code and message of an error", () => {
		class ApiError extends Error {
			status = 429;
			code = "rate_limit";
		}
		expect(failureEntry(new ApiError("slow down"), 12)).toMatchObject({
			kind: "failed",
			ms: 12,
			name: "ApiError",
			status: 429,
			code: "rate_limit",
			message: "slow down",
		});
		expect(failureEntry("text", 1)).toMatchObject({ name: "string", message: "text" });
	});
});

describe("tracedFetch", () => {
	it("records the request by header names only and the reply's harmless headers", async () => {
		const headers = { authorization: `Bearer ${KEY}`, "x-custom": KEY };
		await traced()(`${base}/v1/responses?key=${KEY}`, { method: "POST", headers, body: '{"model":"m"}' });
		const sent = entries("request")[0];
		expect(sent.url).toBe(`${base}/v1/responses`);
		expect(sent.headers).toEqual(expect.arrayContaining(["authorization", "x-custom"]));
		expect(sent.body).toBe('{"model":"m"}');
		const got = entries("response")[0];
		expect(got.status).toBe(200);
		expect(got.headers).toEqual({ "content-type": "application/json", "x-request-id": "req_1" });
		expect(lines.join("\n")).not.toContain(KEY);
	});

	it("keeps an error body, without a key it echoes", async () => {
		answer = { status: 400, type: "application/json", body: `{"error":"bad key ${KEY}"}` };
		const reply = await traced()(`${base}/x`);
		// The caller still reads the whole reply.
		expect(await reply.text()).toContain("bad key");
		await vi.waitFor(() => expect(entries("body")).toHaveLength(1));
		expect(entries("body")[0]).toMatchObject({ status: 400 });
		expect(lines.join("\n")).not.toContain(KEY);
	});

	it("keeps what a relay sends instead of a stream", async () => {
		answer = { status: 200, type: "text/html", body: "<html>gateway page</html>" };
		await traced()(`${base}/x`);
		await vi.waitFor(() => expect(entries("body")[0]?.text).toBe("<html>gateway page</html>"));
	});

	it("counts stream events by kind, samples each once, and keeps the last", async () => {
		const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
		answer = {
			status: 200,
			type: "text/event-stream",
			body:
				event({ type: "response.something_new" }) +
				event({ type: "response.output_item.done", item: { type: "web_search_call" } }) +
				event({ type: "response.output_item.done", item: { type: "web_search_call" } }) +
				"data: not json\n\n" +
				event({ type: "response.completed", response: { output: [] } }) +
				"data: [DONE]\n\n",
		};
		const reply = await traced()(`${base}/x`);
		await reply.text();
		await vi.waitFor(() => expect(entries("stream")).toHaveLength(1));
		const stream = entries("stream")[0];
		expect(stream.ended).toBe("closed");
		expect(stream.counts).toEqual({
			"response.something_new": 1,
			"response.output_item.done:web_search_call": 2,
			unparsed: 1,
			"response.completed": 1,
			"[DONE]": 1,
		});
		expect(stream.last).toBe("[DONE]");
		expect(entries("event")).toHaveLength(5);
	});

	it("takes the name from the event line when the data has none", async () => {
		answer = { status: 200, type: "text/event-stream", body: 'event: ping\ndata: {"n":1}\n\n' };
		await (await traced()(`${base}/x`)).text();
		await vi.waitFor(() => expect(entries("stream")[0]?.counts).toEqual({ ping: 1 }));
	});

	it("records a request that got no reply, with the system's reason, and rethrows it", async () => {
		const dead = Object.assign(new TypeError("fetch failed"), {
			cause: { code: "ECONNREFUSED", message: "refused" },
		});
		const log = serverLog((line) => lines.push(line), [KEY]);
		await expect(tracedFetch(log, () => Promise.reject(dead))(`${base}/x`)).rejects.toBe(dead);
		expect(entries("network")[0]).toMatchObject({ name: "TypeError", code: "ECONNREFUSED", cause: "refused" });
	});
});
