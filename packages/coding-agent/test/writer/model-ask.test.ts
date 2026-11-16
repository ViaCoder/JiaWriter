// One clean request to the session's model: the retry after a passing upstream error, and no retry otherwise.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { type Complete, modelAsker, TRANSIENT_ERROR, transientWaitMs } from "../../src/writer/model-ask.ts";

/** A context with a model and credentials. */
const ctx = {
	model: { api: "openai-completions", provider: "openrouter", id: "m", baseUrl: "https://example.com" },
	modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, baseUrl: undefined }) },
} as unknown as ExtensionContext;

/** A stand-in for completeSimple that answers from a script and counts its calls. */
function scripted(
	replies: { stopReason: string; errorMessage?: string; content?: { type: string; text: string }[] }[],
) {
	const calls: number[] = [];
	const complete = (async () => {
		calls.push(1);
		return replies.shift() ?? { stopReason: "stop", content: [] };
	}) as unknown as Complete;
	return { complete, calls };
}

describe("modelAsker", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("knows a passing error from a lasting one", () => {
		for (const m of [
			"429: rate-limited",
			"Provider returned error 502",
			"temporarily rate-limited upstream",
			"overloaded",
		])
			expect(TRANSIENT_ERROR.test(m), m).toBe(true);
		for (const m of ["401 Unauthorized", "400: invalid request", "model not found"])
			expect(TRANSIENT_ERROR.test(m), m).toBe(false);
		expect(transientWaitMs({})).toBe(5000);
		expect(transientWaitMs({ JW_ASK_RETRY_WAIT_MS: "0" })).toBe(0);
		expect(transientWaitMs({ JW_ASK_RETRY_WAIT_MS: "x" })).toBe(5000);
	});

	it("asks once more after a passing error, and only once (2026-11-16: a section failed twice on 429)", async () => {
		vi.stubEnv("JW_ASK_RETRY_WAIT_MS", "0");
		const ok = { stopReason: "stop", content: [{ type: "text", text: "答复" }] };
		const once = scripted([{ stopReason: "error", errorMessage: "429: temporarily rate-limited upstream" }, ok]);
		const ask = modelAsker(ctx, once.complete, { reasoningTokens: 10, timeoutMs: 1000 }, true);
		expect(await ask?.("i", "t")).toBe("答复");
		expect(once.calls).toHaveLength(2);
		const twice = scripted([
			{ stopReason: "error", errorMessage: "503 upstream" },
			{ stopReason: "error", errorMessage: "503 upstream" },
			ok,
		]);
		await expect(
			modelAsker(ctx, twice.complete, { reasoningTokens: 10, timeoutMs: 1000 }, true)?.("i", "t"),
		).rejects.toThrow("503");
		expect(twice.calls).toHaveLength(2);
	});

	it("does not retry a lasting error, and drops the budget field once when it is refused", async () => {
		vi.stubEnv("JW_ASK_RETRY_WAIT_MS", "0");
		const lasting = scripted([{ stopReason: "error", errorMessage: "401 Unauthorized" }]);
		await expect(
			modelAsker(ctx, lasting.complete, { reasoningTokens: 10, timeoutMs: 1000 }, true)?.("i", "t"),
		).rejects.toThrow("401");
		expect(lasting.calls).toHaveLength(1);
		const refused = scripted([
			{ stopReason: "error", errorMessage: "400: unknown field reasoning" },
			{ stopReason: "stop", content: [{ type: "text", text: "没有预算也行" }] },
		]);
		expect(await modelAsker(ctx, refused.complete, { reasoningTokens: 10, timeoutMs: 1000 }, true)?.("i", "t")).toBe(
			"没有预算也行",
		);
		expect(refused.calls).toHaveLength(2);
	});
});
