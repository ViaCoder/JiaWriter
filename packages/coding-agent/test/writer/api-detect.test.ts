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
	buildReasoningProbe,
	classifyProbe,
	classifyReasoningProbe,
	detectApi,
	detectCacheKey,
	detectReasoning,
	isTransient,
	loadDetectCache,
	markReasoningUnsupported,
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
		// Bad key; a 403 may also be a route the gateway does not open.
		expect([classifyProbe(401, ""), classifyProbe(403, "")]).toEqual(["auth", "refused"]);
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
		// Matched with one request; the body is kept for comparisons.
		expect([out.status, out.verdict, calls.length, out.body]).toEqual([400, "match", 1, "messages: field required"]);
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
		expect(out).toEqual({ api: "openai-responses", status: 0, verdict: "next", body: "" });
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

	it("goes past routes a relay refuses with 403 to the one it opens", async () => {
		// Calls made.
		const calls: string[] = [];
		// A PassManager relay that allows only Chat Completions.
		const fetchFn = mockFetch(
			{
				"/v1/messages": [403, "not allowed"],
				"/v1/responses": [403, "not allowed"],
				"/v1/chat/completions": [400, "bad"],
			},
			calls,
		);
		// Detect.
		const r = await detectApi("https://h.example.com", "k", "m", fetchFn);
		// Chat found on the third request.
		expect([r.ok && r.api, calls.length]).toEqual(["openai-completions", 3]);
	});

	it("reports auth when every route refuses", async () => {
		// Calls made.
		const calls: string[] = [];
		// Forbidden everywhere.
		const fetchFn = mockFetch(
			{ "/v1/messages": [403, ""], "/v1/responses": [403, ""], "/v1/chat/completions": [403, ""] },
			calls,
		);
		// Detect.
		const r = await detectApi("https://h.example.com", "k", "m", fetchFn);
		// A key problem, after all three probes.
		expect([r.ok, !r.ok && r.reason, calls.length]).toEqual([false, "auth", 3]);
	});

	it("retries a transient failure once, and finds the route behind it", async () => {
		const calls: string[] = [];
		let first = true;
		const fetchFn = (async (url: string) => {
			calls.push(url);
			if (url.endsWith("/v1/chat/completions") && first) {
				first = false;
				return new Response("bad gateway", { status: 502 });
			}
			if (url.endsWith("/v1/chat/completions")) return new Response("bad", { status: 400 });
			return new Response("", { status: 403 });
		}) as typeof fetch;
		const r = await detectApi("https://h.example.com", "k", "m", fetchFn, async () => {});
		expect([r.ok && r.api, calls.length]).toEqual(["openai-completions", 4]);
	});

	it("reports the upstream as down, not the key, when a route keeps failing", async () => {
		const calls: string[] = [];
		const fetchFn = mockFetch(
			{ "/v1/messages": [403, ""], "/v1/responses": [403, ""], "/v1/chat/completions": [502, ""] },
			calls,
		);
		const r = await detectApi("https://h.example.com", "k", "m", fetchFn, async () => {});
		expect([r.ok, !r.ok && r.reason]).toEqual([false, "transient"]);
		expect(isTransient(429) && isTransient(0) && !isTransient(404)).toBe(true);
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
		// It loads back as an entry.
		expect(loadDetectCache(path, "key1")?.api).toBe("openai-responses");
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

/** fetch mock for reasoning probes: levels in `accepted` get the plain validation error, others a reasoning error. */
function reasoningFetch(
	accepted: string[],
	calls: string[],
	opts: { budget?: boolean; status?: number } = {},
): typeof fetch {
	// Implementation.
	return (async (input: string | URL | Request, init?: RequestInit) => {
		// Record the call.
		calls.push(String(input));
		// Fixed status override (for auth tests).
		if (opts.status) return new Response("", { status: opts.status });
		// Parsed request body.
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		// Requested level in any of the three forms.
		const level =
			(body.reasoning as { effort?: string } | undefined)?.effort ??
			(body.output_config as { effort?: string } | undefined)?.effort ??
			(body.reasoning_effort as string | undefined);
		// Anthropic budget form.
		const budget = (body.thinking as { type?: string } | undefined)?.type === "enabled";
		// Supported setting: same answer as the plain probe.
		if ((level && accepted.includes(level)) || (budget && opts.budget))
			return new Response("max_tokens: must be >= 1", { status: 400 });
		// Plain probe without any reasoning field.
		if (!level && !budget) return new Response("max_tokens: must be >= 1", { status: 400 });
		// Rejected setting names the parameter.
		return new Response(`Unsupported value for reasoning effort: ${level ?? "budget"}`, { status: 400 });
	}) as typeof fetch;
}

// Baseline answer of the plain probe.
const BASELINE = { status: 400, body: "max_tokens: must be >= 1" };

describe("buildReasoningProbe", () => {
	it("adds the reasoning field each API expects", () => {
		// Responses: reasoning.effort.
		expect(
			JSON.parse(
				String(buildReasoningProbe("https://h.example.com", "openai-responses", "k", "m", "high").init.body),
			).reasoning,
		).toEqual({ effort: "high" });
		// Chat: reasoning_effort.
		expect(
			JSON.parse(
				String(buildReasoningProbe("https://h.example.com", "openai-completions", "k", "m", "low").init.body),
			).reasoning_effort,
		).toBe("low");
		// Anthropic effort form: adaptive thinking plus output_config.effort.
		const a = JSON.parse(
			String(buildReasoningProbe("https://h.example.com", "anthropic-messages", "k", "m", "max").init.body),
		);
		expect([a.thinking, a.output_config, a.max_tokens]).toEqual([{ type: "adaptive" }, { effort: "max" }, 0]);
		// Anthropic budget form.
		expect(
			JSON.parse(
				String(
					buildReasoningProbe("https://h.example.com", "anthropic-messages", "k", "m", "high", "budget").init.body,
				),
			).thinking,
		).toEqual({ type: "enabled", budget_tokens: 1024 });
	});
});

describe("classifyReasoningProbe", () => {
	it("compares a reasoning probe with the plain probe", () => {
		// Same rejection: the parameter passed validation.
		expect(classifyReasoningProbe(BASELINE, BASELINE)).toBe("supported");
		// Accepted outright.
		expect(classifyReasoningProbe(BASELINE, { status: 200, body: "{}" })).toBe("supported");
		// New error naming the parameter.
		expect(classifyReasoningProbe(BASELINE, { status: 400, body: "Unsupported value for reasoning.effort" })).toBe(
			"unsupported",
		);
		// Different status.
		expect(classifyReasoningProbe(BASELINE, { status: 422, body: "x" })).toBe("unsupported");
		// No response.
		expect(classifyReasoningProbe(BASELINE, { status: 0, body: "" })).toBe("unsupported");
		// Key problem.
		expect(classifyReasoningProbe(BASELINE, { status: 401, body: "" })).toBe("auth");
	});
});

describe("detectReasoning", () => {
	it("lists the accepted levels in effort mode with one probe per level", async () => {
		// Calls made.
		const calls: string[] = [];
		// Only low, medium and high work.
		const r = await detectReasoning(
			"https://h.example.com",
			"openai-responses",
			"k",
			"m",
			reasoningFetch(["low", "medium", "high"], calls),
			BASELINE,
		);
		// Effort mode with three levels after five probes.
		expect([r, calls.length]).toEqual([{ mode: "effort", levels: ["low", "medium", "high"] }, 5]);
	});

	it("falls back to the Anthropic budget form when no effort level works", async () => {
		// Calls made.
		const calls: string[] = [];
		// No effort level, but budgets work.
		const r = await detectReasoning(
			"https://h.example.com",
			"anthropic-messages",
			"k",
			"m",
			reasoningFetch([], calls, { budget: true }),
			BASELINE,
		);
		// Budget mode covers low..high after six probes.
		expect([r, calls.length]).toEqual([{ mode: "budget", levels: ["low", "medium", "high"] }, 6]);
	});

	it("reports none when nothing works and auth on a key problem", async () => {
		// Nothing accepted on Chat Completions (no budget form there).
		expect(
			await detectReasoning(
				"https://h.example.com",
				"openai-completions",
				"k",
				"m",
				reasoningFetch([], []),
				BASELINE,
			),
		).toEqual({ mode: "none", levels: [] });
		// Key rejected.
		expect(
			await detectReasoning(
				"https://h.example.com",
				"openai-responses",
				"k",
				"m",
				reasoningFetch([], [], { status: 401 }),
				BASELINE,
			),
		).toBe("auth");
	});
});

describe("markReasoningUnsupported", () => {
	it("removes one level from the cache and turns reasoning off when none is left", () => {
		// Temp directory.
		const dir = mkdtempSync(join(tmpdir(), "wa-detect-"));
		// Clean up later.
		dirs.push(dir);
		// Cache path.
		const path = join(dir, "api-detect.json");
		// Two levels known.
		saveDetectCache(path, "k", "openai-responses", new Date(), { mode: "effort", levels: ["high", "max"] });
		// Drop max.
		expect(markReasoningUnsupported(path, "k", "max")).toEqual({ mode: "effort", levels: ["high"] });
		// Persisted.
		expect(loadDetectCache(path, "k")?.reasoning).toEqual({ mode: "effort", levels: ["high"] });
		// Drop the last one.
		expect(markReasoningUnsupported(path, "k", "high")).toEqual({ mode: "none", levels: [] });
		// Unknown key: nothing to update.
		expect(markReasoningUnsupported(path, "other", "high")).toBeUndefined();
	});
});
