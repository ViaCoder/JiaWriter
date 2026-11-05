// Unit tests for src/writer/env-config.ts.

// Test API.
import { describe, expect, it } from "vitest";
// Functions and constants under test.
import {
	applyOutputClamp,
	clampMaxTokens,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_OUTPUT,
	estimatePayloadTokens,
	formatSetupHint,
	MIN_OUTPUT_TOKENS,
	normalizeBaseUrl,
	OUTPUT_SAFETY_MARGIN,
	providerBaseUrl,
	readWriterEnv,
} from "../../src/writer/env-config.ts";

// A complete, valid set of variables reused by several tests.
const FULL = { JW_URL: "https://api.example.com/v1/", JW_KEY: "k", JW_MODEL: "m1" };

describe("readWriterEnv", () => {
	it("reports not present when no JW_* model variable is set", () => {
		// Only unrelated variables.
		const r = readWriterEnv({ HOME: "/home/x", JW_LANG: "zh" });
		// The JW_* path is not in use and nothing is missing.
		expect(r).toEqual({ present: false, missing: [], errors: [] });
	});

	it("lists missing required variables in a fixed order", () => {
		// Only the URL is set.
		const r = readWriterEnv({ JW_URL: "https://api.example.com" });
		// Key and model are reported.
		expect(r.missing).toEqual(["JW_KEY", "JW_MODEL"]);
		// No configuration is produced.
		expect(r.config).toBeUndefined();
	});

	it("treats blank values as unset", () => {
		// Whitespace-only key.
		const r = readWriterEnv({ ...FULL, JW_KEY: "   " });
		// The key counts as missing.
		expect(r.missing).toEqual(["JW_KEY"]);
	});

	it("uses 128000 for context and output by default and normalizes the URL", () => {
		// Required variables only.
		const r = readWriterEnv(FULL);
		// Defaults applied; trailing /v1/ removed; no API means "detect".
		expect(r.config).toEqual({
			root: "https://api.example.com",
			model: "m1",
			api: undefined,
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_OUTPUT,
			// pi's default reasoning level.
			reasoning: "medium",
		});
		// The defaults are the requested 128k.
		expect([DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT]).toEqual([128_000, 128_000]);
	});

	it("accepts every JW_EFFORT choice and rejects others", () => {
		// Each documented level.
		for (const level of ["off", "low", "medium", "high", "xhigh", "max"]) {
			// Carried into the configuration.
			expect(readWriterEnv({ ...FULL, JW_EFFORT: level }).config?.reasoning).toBe(level);
		}
		// An unknown level is a format error.
		const bad = readWriterEnv({ ...FULL, JW_EFFORT: "minimal" });
		// Reported with the variable name, no configuration.
		expect([bad.errors.join("").includes("JW_EFFORT"), bad.config]).toEqual([true, undefined]);
	});

	it("accepts JW_API, JW_CTX and JW_OUT", () => {
		// All optional values set.
		const r = readWriterEnv({ ...FULL, JW_API: "openai-responses", JW_CTX: "200000", JW_OUT: "32000" });
		// They are carried into the configuration.
		expect(r.config).toMatchObject({ api: "openai-responses", contextWindow: 200_000, maxTokens: 32_000 });
	});

	it("rejects a bad URL, an unknown API, non-numeric sizes and a bad language, all at once", () => {
		// Every optional check fails.
		const r = readWriterEnv({
			...FULL,
			JW_URL: "api.example.com",
			JW_API: "gemini",
			JW_CTX: "128k",
			JW_OUT: "0",
			JW_LANG: "fr",
		});
		// Five Chinese errors, one per variable.
		expect(r.errors).toHaveLength(5);
		// Each error names its variable.
		for (const name of ["JW_URL", "JW_API", "JW_CTX", "JW_OUT", "JW_LANG"])
			expect(r.errors.join("\n")).toContain(name);
		// No configuration.
		expect(r.config).toBeUndefined();
	});
});

describe("normalizeBaseUrl and providerBaseUrl", () => {
	it("strips trailing slashes and one /v1", () => {
		// Several spellings of the same base.
		for (const url of [
			"https://h.example.com",
			"https://h.example.com/",
			"https://h.example.com/v1",
			"https://h.example.com/V1//",
		]) {
			// All reduce to the root.
			expect(normalizeBaseUrl(url)).toBe("https://h.example.com");
		}
		// A path before /v1 is kept.
		expect(normalizeBaseUrl("https://h.example.com/api/v1")).toBe("https://h.example.com/api");
	});

	it("adds /v1 for OpenAI APIs and not for Anthropic", () => {
		// Anthropic SDKs append /v1/messages themselves.
		expect(providerBaseUrl("https://h.example.com", "anthropic-messages")).toBe("https://h.example.com");
		// OpenAI SDKs expect the /v1 base.
		expect(providerBaseUrl("https://h.example.com", "openai-responses")).toBe("https://h.example.com/v1");
		expect(providerBaseUrl("https://h.example.com", "openai-completions")).toBe("https://h.example.com/v1");
	});
});

describe("estimatePayloadTokens and clampMaxTokens", () => {
	it("counts CJK characters one each and other characters four per token", () => {
		// 4 CJK characters inside a JSON string: quotes add 2 other characters.
		expect(estimatePayloadTokens("中文写作")).toBe(4 + Math.ceil(2 / 4));
		// 40 ASCII letters plus 2 quotes.
		expect(estimatePayloadTokens("a".repeat(40))).toBe(Math.ceil(42 / 4));
	});

	it("keeps the configured limit when it fits", () => {
		// Plenty of room.
		expect(clampMaxTokens(8_000, 128_000, 1_000)).toBe(8_000);
	});

	it("lowers the limit to what is left after input and margin", () => {
		// 128k output next to 100k input in a 128k window.
		expect(clampMaxTokens(128_000, 128_000, 100_000)).toBe(128_000 - 100_000 - OUTPUT_SAFETY_MARGIN);
	});

	it("never goes below the floor", () => {
		// Input already larger than the window.
		expect(clampMaxTokens(128_000, 128_000, 200_000)).toBe(MIN_OUTPUT_TOKENS);
	});
});

describe("JW_EFFORT", () => {
	it("reports the old name instead of ignoring it", () => {
		const base = { JW_URL: "https://a.example", JW_KEY: "k", JW_MODEL: "m" };
		const old = readWriterEnv({ ...base, JW_REASONING: "high" });
		expect(old.config).toBeUndefined();
		expect(old.errors.join("\n")).toContain("JW_EFFORT");
		expect(readWriterEnv({ ...base, JW_EFFORT: "high" }).config?.reasoning).toBe("high");
	});
});

describe("applyOutputClamp", () => {
	it("keeps Anthropic's thinking budget below the clamped output limit", () => {
		// 100000 input tokens leave about 26000 of 128000; a budget of 32000 would be refused.
		const big = {
			messages: [{ content: "字".repeat(100_000) }],
			thinking: { type: "enabled", budget_tokens: 32_000 },
		};
		const out = applyOutputClamp({ ...big, max_tokens: 128_000 }, "anthropic-messages", 128_000, 128_000) as {
			max_tokens: number;
			thinking: { budget_tokens: number };
		};
		expect(out.thinking.budget_tokens).toBeLessThan(out.max_tokens);
		// With almost no room left, thinking goes.
		const tight = {
			messages: [{ content: "字".repeat(126_000) }],
			thinking: { type: "enabled", budget_tokens: 2048 },
		};
		const none = applyOutputClamp({ ...tight, max_tokens: 128_000 }, "anthropic-messages", 128_000, 128_000) as {
			thinking?: unknown;
		};
		expect(none.thinking).toBeUndefined();
		// A budget that fits stays, and other APIs have no such field.
		const fits = { messages: [], thinking: { type: "enabled", budget_tokens: 2048 }, max_tokens: 8000 };
		expect(applyOutputClamp(fits, "anthropic-messages", 128_000, 128_000)).toBeUndefined();
	});

	it("lowers max_tokens for Anthropic", () => {
		// Small window, large requested output.
		const out = applyOutputClamp(
			{ model: "m", max_tokens: 128_000, messages: [] },
			"anthropic-messages",
			4_000,
			128_000,
		) as Record<string, number>;
		// Lowered below the window.
		expect(out.max_tokens).toBeLessThan(4_000);
	});

	it("lowers max_output_tokens for Responses", () => {
		// Same situation for the Responses field.
		const out = applyOutputClamp(
			{ model: "m", max_output_tokens: 128_000 },
			"openai-responses",
			4_000,
			128_000,
		) as Record<string, number>;
		// Lowered.
		expect(out.max_output_tokens).toBeLessThan(4_000);
	});

	it("lowers either Chat Completions field", () => {
		// Both names present.
		const out = applyOutputClamp(
			{ model: "m", max_completion_tokens: 9e4, max_tokens: 9e4 },
			"openai-completions",
			4_000,
			128_000,
		) as Record<string, number>;
		// Both lowered.
		expect([out.max_completion_tokens < 4_000, out.max_tokens < 4_000]).toEqual([true, true]);
	});

	it("returns undefined when nothing changes, and for non-objects", () => {
		// Already small enough.
		expect(applyOutputClamp({ max_tokens: 100 }, "anthropic-messages", 128_000, 128_000)).toBeUndefined();
		// Not an object.
		expect(applyOutputClamp("text", "anthropic-messages", 128_000, 128_000)).toBeUndefined();
		// Arrays are left alone.
		expect(applyOutputClamp([1], "anthropic-messages", 128_000, 128_000)).toBeUndefined();
	});

	it("does not modify the original payload", () => {
		// Original object.
		const payload = { max_tokens: 128_000 };
		// Clamp a copy.
		applyOutputClamp(payload, "anthropic-messages", 4_000, 128_000);
		// The original keeps its value.
		expect(payload.max_tokens).toBe(128_000);
	});
});

describe("formatSetupHint", () => {
	it("gives export commands on Linux and macOS", () => {
		// Missing key and model.
		const hint = formatSetupHint(["JW_KEY", "JW_MODEL"], [], "linux");
		// Chinese headline and the missing list.
		expect(hint).toContain("缺少：JW_KEY、JW_MODEL");
		// bash/zsh commands for exactly the missing variables.
		expect(hint).toContain('export JW_KEY="<你的 API key>"');
		expect(hint).not.toContain("export JW_URL");
	});

	it("gives PowerShell, setx and cmd commands on Windows", () => {
		// Missing URL on Windows.
		const hint = formatSetupHint(["JW_URL"], [], "win32");
		// All three Windows forms.
		expect(hint).toContain('$env:JW_URL="https://api.example.com"');
		expect(hint).toContain('setx JW_URL "https://api.example.com"');
		expect(hint).toContain("set JW_URL=https://api.example.com");
	});

	it("lists format errors and shows all required variables when none is missing", () => {
		// One format error, nothing missing.
		const hint = formatSetupHint([], ["JW_CTX 必须是正整数"], "darwin");
		// The error is shown.
		expect(hint).toContain("格式错误：JW_CTX 必须是正整数");
		// All three required commands are listed.
		for (const name of ["JW_URL", "JW_KEY", "JW_MODEL"]) expect(hint).toContain(`export ${name}=`);
	});
});
