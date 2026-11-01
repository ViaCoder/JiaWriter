// Unit tests for src/writer/writer-model.ts (fetch is always a mock).

// Temp agent directories.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, describe, expect, it } from "vitest";
// Cache helpers to pre-fill a detection.
import { detectCacheKey, saveDetectCache } from "../../src/writer/api-detect.ts";
// Functions under test.
import {
	buildProviderConfig,
	detectCachePath,
	formatDetectFailure,
	getWriterDefaultModel,
	getWriterModel,
	setupWriterModel,
	setWriterModel,
} from "../../src/writer/writer-model.ts";

// A key that must never be written or printed.
const SECRET = "sk-test-secret-123";
// Valid variables for most tests.
const ENV = { WA_URL: "https://h.example.com/v1", WA_KEY: SECRET, WA_MODEL: "m1" };
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

/** fetch mock: answers by path suffix and counts calls. */
function mockFetch(routes: Record<string, number>, calls: string[]): typeof fetch {
	// Implementation.
	return (async (input: string | URL | Request) => {
		// Record the URL.
		calls.push(String(input));
		// Status by path, 404 otherwise.
		const status = Object.entries(routes).find(([path]) => String(input).endsWith(path))?.[1] ?? 404;
		// Validation-style body for 400s.
		return new Response(status === 400 ? "invalid request" : "", { status });
	}) as typeof fetch;
}

describe("setupWriterModel", () => {
	it("returns none when no WA_* variable is set and makes no request", async () => {
		// Calls made.
		const calls: string[] = [];
		// Empty environment.
		const s = await setupWriterModel({
			env: {},
			agentDir: agentDir(),
			platform: "linux",
			probe: true,
			fetchFn: mockFetch({}, calls),
		});
		// Nothing configured, nothing sent.
		expect([s.kind, calls.length]).toEqual(["none", 0]);
	});

	it("returns a Chinese setup hint when variables are missing", async () => {
		// Only the URL.
		const s = await setupWriterModel({
			env: { WA_URL: "https://h.example.com" },
			agentDir: agentDir(),
			platform: "linux",
			probe: true,
			fetchFn: fetch,
		});
		// Error with the hint.
		expect(s.kind).toBe("error");
		// It names what is missing.
		expect(s.kind === "error" && s.message).toContain("缺少：WA_KEY、WA_MODEL");
	});

	it("uses WA_API without any request", async () => {
		// Calls made.
		const calls: string[] = [];
		// Explicit API.
		const s = await setupWriterModel({
			env: { ...ENV, WA_API: "openai-completions" },
			agentDir: agentDir(),
			platform: "linux",
			probe: true,
			fetchFn: mockFetch({}, calls),
		});
		// Ready from env, no probe sent.
		expect([s.kind, s.kind === "ready" && s.source, calls.length]).toEqual(["ready", "env", 0]);
	});

	it("uses a cached detection without any request", async () => {
		// Agent directory with a cached answer.
		const dir = agentDir();
		// Pre-fill the cache for this URL and model.
		saveDetectCache(detectCachePath(dir), detectCacheKey("https://h.example.com", "m1"), "openai-responses");
		// Calls made.
		const calls: string[] = [];
		// Start.
		const s = await setupWriterModel({
			env: ENV,
			agentDir: dir,
			platform: "linux",
			probe: true,
			fetchFn: mockFetch({}, calls),
		});
		// Ready from cache, nothing sent.
		expect([s.kind === "ready" && s.api, s.kind === "ready" && s.source, calls.length]).toEqual([
			"openai-responses",
			"cache",
			0,
		]);
	});

	it("detects, caches the result and never stores the key", async () => {
		// Agent directory.
		const dir = agentDir();
		// Calls made.
		const calls: string[] = [];
		// Only Responses exists.
		const s = await setupWriterModel({
			env: ENV,
			agentDir: dir,
			platform: "linux",
			probe: true,
			fetchFn: mockFetch({ "/v1/responses": 400 }, calls),
		});
		// Detected after two probes.
		expect([s.kind === "ready" && s.api, s.kind === "ready" && s.source, calls.length]).toEqual([
			"openai-responses",
			"detect",
			2,
		]);
		// The cache file exists.
		expect(existsSync(detectCachePath(dir))).toBe(true);
		// The key is not in it.
		expect(readFileSync(detectCachePath(dir), "utf-8")).not.toContain(SECRET);
		// The shared state matches the returned one.
		expect(getWriterModel()).toBe(s);
	});

	it("explains a failed detection with status codes and without the key", async () => {
		// Wrong key.
		const s = await setupWriterModel({
			env: ENV,
			agentDir: agentDir(),
			platform: "linux",
			probe: true,
			fetchFn: mockFetch({ "/v1/messages": 401 }, []),
		});
		// Error message.
		const message = s.kind === "error" ? s.message : "";
		// Names the problem and the status, not the key.
		expect([message.includes("WA_KEY 无效"), message.includes("HTTP 401"), message.includes(SECRET)]).toEqual([
			true,
			true,
			false,
		]);
	});

	it("skips probing when probe is false", async () => {
		// Calls made.
		const calls: string[] = [];
		// --help path.
		const s = await setupWriterModel({
			env: ENV,
			agentDir: agentDir(),
			platform: "linux",
			probe: false,
			fetchFn: mockFetch({}, calls),
		});
		// Skipped, nothing sent.
		expect([s.kind, calls.length]).toEqual(["skipped", 0]);
	});
});

describe("buildProviderConfig, formatDetectFailure, getWriterDefaultModel", () => {
	it("registers the key as an environment reference", () => {
		// Anthropic provider.
		const p = buildProviderConfig("https://h.example.com", "anthropic-messages", "m1", 128_000, 128_000);
		// $WA_KEY reference, root base URL, limits on the model.
		expect([p.apiKey, p.baseUrl, p.models[0].contextWindow, p.models[0].maxTokens]).toEqual([
			"$WA_KEY",
			"https://h.example.com",
			128_000,
			128_000,
		]);
	});

	it("writes a 'none' failure with every status, using 无响应 for status 0", () => {
		// Two probes: no response, then 404.
		const text = formatDetectFailure({
			ok: false,
			reason: "none",
			outcomes: [
				{ api: "anthropic-messages", status: 0, verdict: "next" },
				{ api: "openai-responses", status: 404, verdict: "next" },
			],
		});
		// Both statuses and the WA_API advice are present.
		expect([text.includes("无响应"), text.includes("HTTP 404"), text.includes("WA_API")]).toEqual([true, true, true]);
	});

	it("selects wa/<model> only when ready", () => {
		// Nothing ready.
		expect(getWriterDefaultModel()).toBeUndefined();
		// Ready state.
		setWriterModel({
			kind: "ready",
			api: "openai-completions",
			source: "env",
			model: "m1",
			contextWindow: 1,
			maxTokens: 1,
			provider: buildProviderConfig("https://h.example.com", "openai-completions", "m1", 1, 1),
		});
		// Default model is wa/m1.
		expect(getWriterDefaultModel()).toEqual({ provider: "wa", modelId: "m1" });
	});
});
