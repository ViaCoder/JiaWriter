// Unit tests for src/writer/writer-model.ts (fetch is always a mock).

// Temp agent directories.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, describe, expect, it } from "vitest";
// Cache helpers to pre-fill or inspect a detection.
import { detectCacheKey, loadDetectCache, saveDetectCache } from "../../src/writer/api-detect.ts";
// Functions under test.
import {
	buildProviderConfig,
	detectCachePath,
	dropReasoningLevel,
	formatDetectFailure,
	getWriterDefaultModel,
	getWriterModel,
	setupWriterModel,
	setWriterModel,
	type WriterModelReady,
	writerThinkingLevelMap,
} from "../../src/writer/writer-model.ts";

// A key that must never be written or printed.
const SECRET = "sk-test-secret-123";
// Valid variables for most tests.
const ENV = { JW_URL: "https://h.example.com/v1", JW_KEY: SECRET, JW_MODEL: "m1" };
// All levels the probes test.
const ALL = ["low", "medium", "high", "xhigh", "max"];
// Temp directories to clean.
const dirs: string[] = [];
// Reset shared state and files after each test.
afterEach(() => {
	// Back to the initial state.
	setWriterModel({ kind: "none" });
	// Delete temp directories.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fresh agent directory. */
function agentDir(): string {
	// Create it.
	const dir = mkdtempSync(join(tmpdir(), "wa-model-"));
	// Remember for cleanup.
	dirs.push(dir);
	// Return the path.
	return dir;
}

/** fetch mock: answers by path suffix with the same body for every request on a route; counts calls. */
function mockFetch(routes: Record<string, number>, calls: string[]): typeof fetch {
	// Implementation.
	return (async (input: string | URL | Request) => {
		// Record the URL.
		calls.push(String(input));
		// Status by path, 404 otherwise.
		const status = Object.entries(routes).find(([path]) => String(input).endsWith(path))?.[1] ?? 404;
		// Validation-style body for 400s (identical with and without reasoning: every level passes).
		return new Response(status === 400 ? "invalid request" : "", { status });
	}) as typeof fetch;
}

/** Shorthand for setupWriterModel with defaults. */
function setup(env: NodeJS.ProcessEnv, dir: string, fetchFn: typeof fetch, probe = true) {
	// Linux hint, given probe flag.
	return setupWriterModel({ env, agentDir: dir, platform: "linux", probe, fetchFn });
}

describe("setupWriterModel", () => {
	it("returns none when no JW_* variable is set and makes no request", async () => {
		// Calls made.
		const calls: string[] = [];
		// Empty environment.
		const s = await setup({}, agentDir(), mockFetch({}, calls));
		// Nothing configured, nothing sent.
		expect([s.kind, calls.length]).toEqual(["none", 0]);
	});

	it("returns a Chinese setup hint when variables are missing", async () => {
		// Only the URL.
		const s = await setup({ JW_URL: "https://h.example.com" }, agentDir(), fetch);
		// It names what is missing.
		expect(s.kind === "error" && s.message).toContain("缺少：JW_KEY、JW_MODEL");
	});

	it("uses JW_API with reasoning off without any request", async () => {
		// Calls made.
		const calls: string[] = [];
		// Explicit API, reasoning off.
		const s = await setup(
			{ ...ENV, JW_API: "openai-completions", JW_REASONING: "off" },
			agentDir(),
			mockFetch({}, calls),
		);
		// Ready from env, no probe, no reasoning.
		expect([s.kind, s.kind === "ready" && s.source, s.kind === "ready" && s.reasoning.mode, calls.length]).toEqual([
			"ready",
			"env",
			"none",
			0,
		]);
	});

	it("probes reasoning levels for JW_API with one baseline and one probe per level", async () => {
		// Calls made.
		const calls: string[] = [];
		// Explicit Responses API, default reasoning.
		const s = (await setup(
			{ ...ENV, JW_API: "openai-responses" },
			agentDir(),
			mockFetch({ "/v1/responses": 400 }, calls),
		)) as WriterModelReady;
		// Baseline plus five levels; every level passes validation here.
		expect([calls.length, s.reasoning]).toEqual([6, { mode: "effort", levels: ALL }]);
		// The model is registered with reasoning and a full level map.
		expect([s.provider.models[0].reasoning, s.provider.models[0].thinkingLevelMap?.max]).toEqual([true, "max"]);
	});

	it("uses a cached detection with reasoning without any request", async () => {
		// Agent directory with a cached answer.
		const dir = agentDir();
		// Pre-fill API and reasoning for this URL and model.
		saveDetectCache(
			detectCachePath(dir),
			detectCacheKey("https://h.example.com", "m1"),
			"openai-responses",
			new Date(),
			{ mode: "effort", levels: ["low", "high"] },
		);
		// Calls made.
		const calls: string[] = [];
		// Start.
		const s = (await setup(ENV, dir, mockFetch({}, calls))) as WriterModelReady;
		// Everything from the cache.
		expect([s.api, s.source, s.reasoning.levels, calls.length]).toEqual([
			"openai-responses",
			"cache",
			["low", "high"],
			0,
		]);
	});

	it("detects the API and reasoning, caches both and never stores the key", async () => {
		// Agent directory.
		const dir = agentDir();
		// Calls made.
		const calls: string[] = [];
		// Only Responses exists.
		const s = (await setup(ENV, dir, mockFetch({ "/v1/responses": 400 }, calls))) as WriterModelReady;
		// Two detection probes and five reasoning probes.
		expect([s.api, s.source, calls.length]).toEqual(["openai-responses", "detect", 7]);
		// Cached with reasoning.
		expect(
			loadDetectCache(detectCachePath(dir), detectCacheKey("https://h.example.com", "m1"))?.reasoning?.levels,
		).toEqual(ALL);
		// The key is not in the cache.
		expect(readFileSync(detectCachePath(dir), "utf-8")).not.toContain(SECRET);
		// The shared state matches the returned one.
		expect(getWriterModel()).toBe(s);
	});

	it("skips reasoning probes when JW_REASONING is off", async () => {
		// Agent directory.
		const dir = agentDir();
		// Calls made.
		const calls: string[] = [];
		// Detection with reasoning off.
		const s = (await setup(
			{ ...ENV, JW_REASONING: "off" },
			dir,
			mockFetch({ "/v1/responses": 400 }, calls),
		)) as WriterModelReady;
		// Only the two detection probes; no reasoning.
		expect([calls.length, s.reasoning.mode, s.provider.models[0].reasoning]).toEqual([2, "none", false]);
		// The cache keeps no reasoning entry.
		expect(
			loadDetectCache(detectCachePath(dir), detectCacheKey("https://h.example.com", "m1"))?.reasoning,
		).toBeUndefined();
	});

	it("explains a failed detection with status codes and without the key", async () => {
		// Wrong key.
		const s = await setup(ENV, agentDir(), mockFetch({ "/v1/messages": 401 }, []));
		// Error message.
		const message = s.kind === "error" ? s.message : "";
		// Names the problem and the status, not the key.
		expect([message.includes("JW_KEY 无效"), message.includes("HTTP 401"), message.includes(SECRET)]).toEqual([
			true,
			true,
			false,
		]);
	});

	it("skips probing when probe is false", async () => {
		// Calls made.
		const calls: string[] = [];
		// --help path.
		const s = await setup(ENV, agentDir(), mockFetch({}, calls), false);
		// Skipped, nothing sent.
		expect([s.kind, calls.length, existsSync(join(dirs[dirs.length - 1], "api-detect.json"))]).toEqual([
			"skipped",
			0,
			false,
		]);
	});
});

describe("writerThinkingLevelMap and dropReasoningLevel", () => {
	it("maps effort levels to their names and marks the rest null", () => {
		// low and high supported.
		expect(writerThinkingLevelMap({ mode: "effort", levels: ["low", "high"] })).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("leaves budget levels to pi and marks xhigh and max null", () => {
		// Budget mode.
		expect(writerThinkingLevelMap({ mode: "budget", levels: ["low", "medium", "high"] })).toEqual({
			minimal: null,
			xhigh: null,
			max: null,
		});
	});

	it("marks every level null without reasoning", () => {
		// No reasoning.
		expect(Object.values(writerThinkingLevelMap({ mode: "none", levels: [] }))).toEqual([
			null,
			null,
			null,
			null,
			null,
			null,
		]);
	});

	it("drops one level and turns reasoning off with the last one", () => {
		// Two levels.
		expect(dropReasoningLevel({ mode: "effort", levels: ["high", "max"] }, "max")).toEqual({
			mode: "effort",
			levels: ["high"],
		});
		// Last level.
		expect(dropReasoningLevel({ mode: "effort", levels: ["high"] }, "high")).toEqual({ mode: "none", levels: [] });
	});
});

describe("buildProviderConfig, formatDetectFailure, getWriterDefaultModel", () => {
	it("registers the key as an environment reference and no reasoning by default", () => {
		// Anthropic provider without reasoning.
		const p = buildProviderConfig("https://h.example.com", "anthropic-messages", "m1", 128_000, 128_000);
		// $JW_KEY reference, root base URL, limits, reasoning off.
		expect([p.apiKey, p.baseUrl, p.models[0].contextWindow, p.models[0].maxTokens, p.models[0].reasoning]).toEqual([
			"$JW_KEY",
			"https://h.example.com",
			128_000,
			128_000,
			false,
		]);
	});

	it("uses adaptive thinking for Anthropic effort levels", () => {
		// Anthropic with effort support.
		const p = buildProviderConfig("https://h.example.com", "anthropic-messages", "m1", 1, 1, {
			mode: "effort",
			levels: ["high", "max"],
		});
		// Adaptive thinking forced; max mapped.
		expect([p.models[0].compat, p.models[0].thinkingLevelMap?.max]).toEqual([{ forceAdaptiveThinking: true }, "max"]);
	});

	it("writes a 'none' failure with every status, using 无响应 for status 0", () => {
		// Two probes: no response, then 404.
		const text = formatDetectFailure({
			ok: false,
			reason: "none",
			outcomes: [
				{ api: "anthropic-messages", status: 0, verdict: "next", body: "" },
				{ api: "openai-responses", status: 404, verdict: "next", body: "" },
			],
		});
		// Both statuses and the JW_API advice are present.
		expect([text.includes("无响应"), text.includes("HTTP 404"), text.includes("JW_API")]).toEqual([true, true, true]);
	});

	it("selects wa/<model> with the requested level only when ready", async () => {
		// Nothing ready.
		expect(getWriterDefaultModel()).toBeUndefined();
		// Ready via JW_API with reasoning off.
		await setup(
			{ ...ENV, JW_API: "openai-completions", JW_REASONING: "max" },
			agentDir(),
			mockFetch({ "/v1/chat/completions": 400 }, []),
		);
		// Default model is wa/m1 at level max (pi clamps it later).
		expect(getWriterDefaultModel()).toEqual({ provider: "jw", modelId: "m1", thinkingLevel: "max" });
	});
});
