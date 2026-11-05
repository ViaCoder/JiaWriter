// Unit tests for the compaction helpers of JiaWriter: token estimates, the request size guard,
// summary parts, serialization of long arguments, the local summary and overflow errors.

// Message and model types.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
// Test API.
import { describe, expect, it } from "vitest";
// Upstream functions changed for JiaWriter.
import { type CompactionPreparation, splitForSummary } from "../../src/core/compaction/compaction.ts";
import { serializeConversation } from "../../src/core/compaction/utils.ts";
import { isWriterOverflow, localCompaction, localSummary } from "../../src/writer/compact-fallback.ts";
import { fitToolResults, resultCap } from "../../src/writer/context-fit.ts";
import { estimateTextTokens, weightedChars, wideCount } from "../../src/writer/token-estimate.ts";
// Functions under test.
import { compactionErrorText } from "../../src/writer/ui-text.ts";

/** A tool result with text. */
function result(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "1",
		toolName: "x",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

/** A user message. */
function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

/** A preparation with the given messages. */
function preparation(messages: AgentMessage[], previousSummary?: string): CompactionPreparation {
	return {
		firstKeptEntryId: "e1",
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 99,
		previousSummary,
		fileOps: { read: new Set(["a.md"]), written: new Set(), edited: new Set(["b.md"]) },
		settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
	};
}

describe("token estimates", () => {
	it("counts wide characters one each and other text four per token", () => {
		expect(wideCount("中文，abc")).toBe(3);
		expect(estimateTextTokens("中文，abcd")).toBe(4);
		expect(estimateTextTokens("abcde")).toBe(2);
		expect(estimateTextTokens("")).toBe(0);
		expect(weightedChars("中a")).toBe(5);
	});
});

describe("resultCap", () => {
	it("leaves small results their size and shares the rest", () => {
		// Two small ones keep theirs; the large one takes what is left.
		expect(resultCap([100, 100, 10_000], 1100)).toBe(900);
		// Equal results share evenly.
		expect(resultCap([1000, 1000], 1000)).toBe(500);
		// Everything fits.
		expect(resultCap([100, 100], 1000)).toBe(Number.POSITIVE_INFINITY);
		// Never below the floor.
		expect(resultCap([10_000], 0)).toBe(500);
	});
});

describe("fitToolResults", () => {
	it("returns the same array when the request fits", () => {
		const messages = [user("你好"), result("资料")];
		expect(fitToolResults(messages, 1000)).toBe(messages);
	});

	it("clips the large results to fit, keeps their beginning and says so, and leaves the input alone", () => {
		const page = `开头${"字".repeat(10_000)}`;
		const messages = [user("问题"), result("短结果"), result(page), result(page)];
		const fitted = fitToolResults(messages, 4000);
		const texts = fitted.map((m) => JSON.stringify(m));
		// The short result and the user message are untouched objects.
		expect([fitted[0], fitted[1]]).toEqual([messages[0], messages[1]]);
		// Both pages shrink, keep their beginning and carry the note.
		expect(texts[2].length).toBeLessThan(page.length / 2);
		expect(texts[2]).toContain("开头");
		expect(texts[3]).toContain("10002");
		// The session's own messages keep the full text.
		expect(JSON.stringify(messages[2])).toContain("字".repeat(10_000));
	});
});

describe("splitForSummary", () => {
	const model = { provider: "jw", contextWindow: 10_000 } as Model<string>;

	it("splits at message boundaries so each part fits, in order", () => {
		// Six messages of 3000 tokens with 7000 per part: two per part.
		const messages = Array.from({ length: 6 }, (_, i) => user(`${i}${"字".repeat(3000)}`));
		const parts = splitForSummary(messages, model);
		expect(parts.map((p) => p.length)).toEqual([2, 2, 2]);
		expect(parts.flat()).toEqual(messages);
	});

	it("keeps one part for other providers, and sizes long tool output as the summary will see it", () => {
		const messages = [user("字".repeat(9000)), user("字".repeat(9000))];
		expect(splitForSummary(messages, { provider: "anthropic", contextWindow: 10_000 } as Model<string>)).toEqual([
			messages,
		]);
		// Tool results are cut to 2000 characters by serialization, so these fit one part.
		expect(splitForSummary([result("字".repeat(90_000)), result("字".repeat(90_000))], model)).toHaveLength(1);
	});
});

describe("serializeConversation", () => {
	it("cuts a whole draft in a tool call, which is on disk anyway", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "1", name: "write", arguments: { path: "a.md", content: "字".repeat(9000) } },
				],
			},
		] as unknown as Message[];
		const text = serializeConversation(messages);
		expect(text.length).toBeLessThan(3000);
		expect(text).toContain("a.md");
		expect(text).toContain("more characters truncated");
	});
});

describe("localSummary and localCompaction", () => {
	it("keeps the earlier summary, the user's words and the last reply, within limits", () => {
		const reply = { role: "assistant", content: [{ type: "text", text: "最后的回复" }] } as unknown as AgentMessage;
		const text = localSummary(preparation([user("写城市绿化报告"), user("改成3000字"), reply], "旧摘要"), "500 错误");
		for (const part of ["500 错误", "旧摘要", "写城市绿化报告", "改成3000字", "最后的回复"])
			expect(text).toContain(part);
		// One long message is cut.
		expect(localSummary(preparation([user("字".repeat(9000))]), "x").length).toBeLessThan(2500);
	});

	it("has the shape of a compaction result and marks itself", () => {
		const out = localCompaction(preparation([user("要求")]), "原因");
		expect([out.firstKeptEntryId, out.tokensBefore]).toEqual(["e1", 99]);
		expect(out.details).toMatchObject({ localFallback: true, modifiedFiles: ["b.md"] });
		expect(out.summary).toContain("b.md");
	});
});

describe("isWriterOverflow", () => {
	it("reads Chinese and combined-limit errors of the jw model only", () => {
		const failed = (errorMessage: string, provider = "jw") => ({ provider, stopReason: "error", errorMessage });
		expect(isWriterOverflow(failed("请求内容超长"))).toBe(true);
		expect(isWriterOverflow(failed("输入超出模型上下文长度限制"))).toBe(true);
		expect(isWriterOverflow(failed("input length and `max_tokens` exceed context limit: 1 + 2 > 3"))).toBe(true);
		// Other failures, other providers and finished replies are not overflows.
		expect(isWriterOverflow(failed("余额不足"))).toBe(false);
		expect(isWriterOverflow(failed("请求内容超长", "anthropic"))).toBe(false);
		expect(isWriterOverflow({ provider: "jw", stopReason: "stop", errorMessage: "超长" })).toBe(false);
	});
});

describe("compactionErrorText", () => {
	it("puts upstream's failure messages into Chinese and keeps the reason", () => {
		process.env.JW_LANG = "zh";
		expect(compactionErrorText("Auto-compaction failed: boom")).toBe("自动压缩失败：boom");
		expect(compactionErrorText("Context overflow recovery failed: boom")).toBe("超出上下文后的压缩失败：boom");
		expect(
			compactionErrorText("Context overflow recovery failed after one compact-and-retry attempt. Try x."),
		).toContain("请重新发送");
		// Anything else stays.
		expect(compactionErrorText("other")).toBe("other");
		// English interface: unchanged.
		process.env.JW_LANG = "en";
		expect(compactionErrorText("Auto-compaction failed: boom")).toBe("Auto-compaction failed: boom");
		delete process.env.JW_LANG;
	});
});
