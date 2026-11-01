// Unit tests for src/writer/api-detect.ts (fetch is always a mock).

// Temp files for the cache tests.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, describe, expect, it } from "vitest";
// Functions under test.
import {
	buildProbe,
	classifyProbe,
	detectApi,
	detectCacheKey,
	loadDetectCache,
	probeEndpoint,
	saveDetectCache,
} from "../../src/writer/api-detect.ts";

// Temp directories to clean.
const dirs: string[] = [];
// Remove them after each test.
afterEach(() => {
	// Delete every temp directory.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fetch mock answering each path with a fixed status and body; records called URLs. */
function mockFetch(routes: Record<string, [number, string]>, calls: string[]): typeof fetch {
	// The mock implementation.
	return (async (input: string | URL | Request) => {
		// The URL as a string.
		const url = String(input);
		// Record the call.
		calls.push(url);
		// Find the route by path suffix.
		const hit = Object.entries(routes).find(([path]) => url.endsWith(path));
		// Unknown paths answer 404.
		const [status, body] = hit ? hit[1] : [404, "not found"];
		// A real Response object.
		return new Response(body, { status });
	}) as typeof fetch;
}

describe("buildProbe", () => {
	it("uses x-api-key and anthropic-version for Anthropic, with an invalid body", () => {
		// Anthropic probe.
		const p = buildProbe("https://h.example.com", "anthropic-messages", "k1", "m1");
		// Endpoint path.
		expect(p.url).toBe("https://h.example.com/v1/messages");
		// Anthropic headers.
		expect(p.init.headers).toMatchObject({ "x-api-key": "k1", "anthropic-version": "2023-06-01" });
		// max_tokens 0 and no messages: rejected before generation.
		expect(JSON.parse(String(p.init.body))).toEqual({ model: "m1", max_tokens: 0, messages: [] });
	});

	it("uses a bearer token for OpenAI APIs", () => {
		// Responses probe.
		const r = buildProbe("https://h.example.com", "openai-responses", "k1", "m1");
		// Path and header.
		expect([r.url, (r.init.headers as Record<string, string>).authorization]).toEqual([
			"https://h.example.com/v1/responses",
			"Bearer k1",
		]);
		// max_output_tokens 0 is below the API minimum.
		expect(JSON.parse(String(r.init.body))).toMatchObject({ max_output_tokens: 0 });
		// Chat probe path.
		expect(buildProbe("https://h.example.com", "openai-completions", "k1", "m1").url).toBe(
			"https://h.example.com/v1/chat/completions",
		);
	});
});

describe("classifyProbe", () => {
	it("maps status codes and bodies to verdicts", () => {
		// Validation error on an existing route.
		expect(classifyProbe(400, '{"error":{"message":"max_tokens: must be >= 1"}}')).toBe("match");
		// FastAPI-style validation error.
		expect(classifyProbe(422, "field required")).toBe("match");
		// Success also proves the route.
		expect(classifyProbe(200, "{}")).toBe("match");
		// Unknown model on this route.
		expect(classifyProbe(400, '{"error":{"code":"model_not_found"}}')).toBe("next");
		// Gateway that answers 400 for an unknown route.
		expect(classifyProbe(400, "Unrecognized request URL")).toBe("next");
		// Missing route or method.
		expect([classifyProbe(404, ""), classifyProbe(405, "")]).toEqual(["next", "next"]);
		// Bad key.
		expect([classifyProbe(401, ""), classifyProbe(403, "")]).toEqual(["auth", "auth"]);
		// Rate limit and server errors prove nothing.
		expect([classifyProbe(429, ""), classifyProbe(500, "")]).toEqual(["next", "next"]);
	});
});

describe("probeEndpoint", () => {
	it("returns the status and verdict of one request", async () => {
		// Calls made.
		const calls: string[] = [];
		// Route answering with a validation error.
		const fetchFn = mockFetch({ "/v1/messages": [400, "messages: field required"] }, calls);
		// Send the probe.
		const out = await probeEndpoint(fetchFn, buildProbe("https://h.example.com", "anthropic-messages", "k", "m"));
		// Matched with one request.
		expect([out.status, out.verdict, calls.length]).toEqual([400, "match", 1]);
	});

	it("turns a network failure into status 0 and next", async () => {
		// fetch that throws like a refused connection.
		const failing = (async () => {
			// Simulated network error.
			throw new TypeError("fetch failed");
		}) as typeof fetch;
		// Send the probe.
		const out = await probeEndpoint(failing, buildProbe("https://h.example.com", "openai-responses", "k", "m"));
		// No response.
		expect(out).toEqual({ api: "openai-responses", status: 0, verdict: "next" });
	});
});

describe("detectApi", () => {
	it("tries Anthropic, then Responses, then Chat and stops at the first match", async () => {
		// Calls made.
		const calls: string[] = [];
		// Only Chat Completions exists.
		const fetchFn = mockFetch({ "/v1/chat/completions": [400, "messages must be non-empty"] }, calls);
		// Detect.
		const r = await detectApi("https://h.example.com", "k", "m", fetchFn);
		// Chat found after two misses.
		expect(r).toMatchObject({ ok: true, api: "openai-completions" });
		// Exactly three requests in order.
		expect(calls.map((u) => u.replace("https://h.example.com", ""))).toEqual([
			"/v1/messages",
			"/v1/responses",
			"/v1/chat/completions",
		]);
	});

	it("picks the first API on a gateway that supports all three", async () => {
		// Calls made.
		const calls: string[] = [];
		// Every route validates.
		const fetchFn = mockFetch(
			{ "/v1/messages": [400, "bad"], "/v1/responses": [400, "bad"], "/v1/chat/completions": [400, "bad"] },
			calls,
		);
		// Detect.
		const r = await detectApi("https://h.example.com", "k", "m", fetchFn);
		// Anthropic first, one request only.
		expect([r.ok && r.api, calls.length]).toEqual(["anthropic-messages", 1]);
	});

	it("stops after an auth error", async () => {
		// Calls made.
		const calls: string[] = [];
		// Wrong key everywhere.
		const fetchFn = mockFetch(
			{ "/v1/messages": [401, ""], "/v1/responses": [401, ""], "/v1/chat/completions": [401, ""] },
			calls,
		);
		// Detect.
		const r = await detectApi("https://h.example.com", "k", "m", fetchFn);
		// Auth failure after a single request.
		expect([r.ok, !r.ok && r.reason, calls.length]).toEqual([false, "auth", 1]);
	});

	it("reports none when no route matches", async () => {
		// Calls made.
		const calls: string[] = [];
		// Everything 404.
		const r = await detectApi("https://h.example.com", "k", "m", mockFetch({}, calls));
		// Three probes, no match.
		expect([r.ok, !r.ok && r.reason, r.outcomes.map((o) => o.status)]).toEqual([false, "none", [404, 404, 404]]);
	});
});

describe("detection cache", () => {
	it("hashes URL and model into a stable key without the API key", () => {
		// Same inputs, same key.
		expect(detectCacheKey("https://h.example.com", "m")).toBe(detectCacheKey("https://h.example.com", "m"));
		// Different model, different key.
		expect(detectCacheKey("https://h.example.com", "m")).not.toBe(detectCacheKey("https://h.example.com", "m2"));
		// A sha256 hex digest.
		expect(detectCacheKey("u", "m")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("saves atomically and loads the stored API", () => {
		// Temp directory.
		const dir = mkdtempSync(join(tmpdir(), "wa-detect-"));
		// Clean up later.
		dirs.push(dir);
		// Cache path inside a not-yet-existing subdirectory.
		const path = join(dir, "agent", "api-detect.json");
		// Save one entry.
		saveDetectCache(path, "key1", "openai-responses", new Date("2026-11-01T00:00:00Z"));
		// It loads back.
		expect(loadDetectCache(path, "key1")).toBe("openai-responses");
		// Unknown keys miss.
		expect(loadDetectCache(path, "other")).toBeUndefined();
		// No temp file is left behind.
		expect(readdirSync(join(dir, "agent"))).toEqual(["api-detect.json"]);
		// The file holds no secrets: only version, key hash, API and timestamp.
		expect(readFileSync(path, "utf-8")).toContain('"detectedAt": "2026-11-01T00:00:00.000Z"');
	});

	it("treats a missing, broken or foreign file as an empty cache", () => {
		// Temp directory.
		const dir = mkdtempSync(join(tmpdir(), "wa-detect-"));
		// Clean up later.
		dirs.push(dir);
		// Missing file.
		expect(loadDetectCache(join(dir, "none.json"), "k")).toBeUndefined();
		// Broken JSON.
		writeFileSync(join(dir, "bad.json"), "{");
		expect(loadDetectCache(join(dir, "bad.json"), "k")).toBeUndefined();
		// Unknown API name in an otherwise valid file.
		writeFileSync(join(dir, "foreign.json"), JSON.stringify({ version: 1, entries: { k: { api: "gemini" } } }));
		expect(loadDetectCache(join(dir, "foreign.json"), "k")).toBeUndefined();
	});
});
