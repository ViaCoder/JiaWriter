// Unit tests for the compaction helpers of JiaWriter: token estimates, the request size guard,
// summary parts, serialization of long arguments, the local summary and overflow errors.

// Message and model types.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
// Test API.
import { describe, expect, it } from "vitest";
// Upstream functions changed for JiaWriter.
import type { CompactionPreparation } from "../../src/core/compaction/compaction.ts";
import { serializeConversation } from "../../src/core/compaction/utils.ts";
import {
	isAuthFailure,
	isInternalAbort,
	isWriterOverflow,
	localCompaction,
	localSummary,
} from "../../src/writer/compact-fallback.ts";
import { CLEAR_SHARE, clearOldResults, fitToolResults, KEEP_TURNS, resultCap } from "../../src/writer/context-fit.ts";
import {
	isSummaryOverflow,
	shortenMessage,
	splitForSummary,
	summarizeInParts,
	summarizeTurnStart,
	summaryLimit,
} from "../../src/writer/summary-parts.ts";
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

describe("fitToolResults counts the whole request", () => {
	it("sees a draft inside a tool call", () => {
		// The call holds 9000 tokens, the result 2000: together over 8000, though the text blocks are not.
		const call = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "1", name: "write", arguments: { path: "a.md", content: "字".repeat(9000) } },
			],
		} as unknown as AgentMessage;
		const page = result("字".repeat(2000));
		const fitted = fitToolResults([call, page], 8000);
		expect(JSON.stringify(fitted[1]).length).toBeLessThan(1500);
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

describe("summaries in smaller parts", () => {
	const model = { provider: "jw", contextWindow: 10_000 } as Model<string>;
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const tooLarge = () => new Error("Summarization failed: prompt is too long: 9 tokens > 1 maximum");
	/** A summarizer that takes at most max characters, and records what it was given. */
	const taking = (max: number) => {
		const seen: { chars: number; previous?: string }[] = [];
		const summarize = async (part: AgentMessage[], previous?: string) => {
			const chars = JSON.stringify(part).length;
			if (chars > max) throw tooLarge();
			seen.push({ chars, previous });
			return { text: `摘要${seen.length}`, usage };
		};
		return { seen, summarize };
	};
	const messages = Array.from({ length: 6 }, (_, i) => user(`${i}${"字".repeat(3000)}`));

	it("sizes a part from the window", () => {
		expect(summaryLimit(model)).toBe(7000);
	});

	it("shortens a message in any content form, and leaves others alone", () => {
		expect(shortenMessage(user("一二三四"), 0.5)).toMatchObject({ content: "一二" });
		const blocks = shortenMessage(result("一二三四"), 0.5) as { content: { text: string }[] };
		expect(blocks.content[0].text).toBe("一二");
		const none = { role: "custom" } as unknown as AgentMessage;
		expect(shortenMessage(none, 0.5)).toBe(none);
	});

	it("shortens one message larger than a part while splitting", () => {
		const parts = splitForSummary([user("字".repeat(9000))], model, 3000);
		expect(parts).toHaveLength(1);
		expect(JSON.stringify(parts[0]).length).toBeLessThan(3500);
	});

	it("tells an overflow of the jw model from other failures", () => {
		expect(isSummaryOverflow(tooLarge(), model)).toBe(true);
		expect(isSummaryOverflow(new Error("Summarization failed: 请求超长"), model)).toBe(true);
		expect(isSummaryOverflow(new Error("Turn prefix summarization failed: prompt is too long"), model)).toBe(true);
		expect(isSummaryOverflow(new Error("Summarization failed: 余额不足"), model)).toBe(false);
		expect(isSummaryOverflow(tooLarge(), { provider: "anthropic", contextWindow: 10 } as Model<string>)).toBe(false);
		expect(isSummaryOverflow("text", model)).toBe(false);
	});

	it("goes smaller after a rejection, passing the summary along and redoing nothing", async () => {
		// Parts of 7000 tokens are too much; 3500 fit one message each.
		const { seen, summarize } = taking(4000);
		const out = await summarizeInParts(messages, model, "旧摘要", summarize);
		expect(seen).toHaveLength(6);
		expect(seen[0].previous).toBe("旧摘要");
		expect(seen[5].previous).toBe("摘要5");
		expect(out.text).toBe("摘要6");
		// Every summary's usage counts.
		expect(out.usage.input).toBe(6);
	});

	it("keeps parts already done when a later part is rejected", async () => {
		// The first part fits; the third message on is rejected once.
		let calls = 0;
		const done: number[] = [];
		const out = await summarizeInParts(messages, model, undefined, async (part) => {
			calls++;
			if (calls === 2) throw tooLarge();
			done.push(part.length);
			return { text: "摘要", usage };
		});
		expect(out.text).toBe("摘要");
		// Two in the first part; the other four again, smaller.
		expect(done.reduce((a, b) => a + b, 0)).toBe(6);
	});

	it("gives up after three smaller tries, and at once on other failures", async () => {
		let calls = 0;
		await expect(
			summarizeInParts(messages, model, undefined, async () => {
				calls++;
				throw tooLarge();
			}),
		).rejects.toThrow("too long");
		expect(calls).toBe(4);
		calls = 0;
		await expect(
			summarizeInParts(messages, model, undefined, async () => {
				calls++;
				throw new Error("Summarization failed: 余额不足");
			}),
		).rejects.toThrow("余额不足");
		expect(calls).toBe(1);
	});

	it("keeps the latest part of a turn start that does not fit", async () => {
		const seen: AgentMessage[][] = [];
		const out = await summarizeTurnStart(messages, model, async (part) => {
			if (part.length > 1) throw tooLarge();
			seen.push(part);
			return { text: "摘要", usage };
		});
		expect(out.text).toBe("摘要");
		expect(seen[0][0]).toEqual(messages[5]);
		let calls = 0;
		await expect(
			summarizeTurnStart(messages, model, async () => {
				calls++;
				throw tooLarge();
			}),
		).rejects.toThrow();
		expect(calls).toBe(4);
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

describe("isAuthFailure", () => {
	it("reads a refused key", () => {
		for (const text of ["401 Unauthorized", "403 forbidden", "invalid api key", "Summarization failed: 认证失败"])
			expect(isAuthFailure(text)).toBe(true);
		for (const text of ["500 server error", "prompt is too long", "4010 tokens"])
			expect(isAuthFailure(text)).toBe(false);
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

describe("isInternalAbort", () => {
	it("reads a failed request cut off by the program's own signal, not the user's abort", () => {
		// 2026-11-14: a research run got this after 314 s of upstream silence and ended with no draft.
		expect(isInternalAbort({ stopReason: "error", errorMessage: "The operation was aborted" })).toBe(true);
		expect(isInternalAbort({ stopReason: "error", errorMessage: "Request aborted." })).toBe(true);
		expect(isInternalAbort({ stopReason: "error", errorMessage: "Provider finish_reason: error" })).toBe(true);
		// The user's abort ends the message as aborted; other errors keep their own retry rule.
		expect(isInternalAbort({ stopReason: "aborted", errorMessage: "The operation was aborted" })).toBe(false);
		expect(isInternalAbort({ stopReason: "error", errorMessage: "aborted by policy: content" })).toBe(false);
		expect(isInternalAbort({ stopReason: "error", errorMessage: "Headers Timeout Error" })).toBe(false);
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

describe("clearOldResults", () => {
	/** A call of a tool and its result. */
	const pair = (id: string, toolName: string, path: string, text: string): AgentMessage[] => [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: toolName, arguments: { path } }],
			timestamp: 0,
		} as unknown as AgentMessage,
		{ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError: false, timestamp: 0 },
	];
	const long = "资料".repeat(4000);
	/** An old read, an old tool that cannot be had again, then KEEP_TURNS turns with a fresh read. */
	const conversation = (): AgentMessage[] => [
		user("第一轮"),
		...pair("a", "read", "参考资料/报告.md", long),
		...pair("b", "write", "稿件/稿.md", long),
		...Array.from({ length: KEEP_TURNS }, (_, n) => [
			user(`第${n + 2}轮`),
			...pair(`c${n}`, "read", `f${n}.md`, long),
		]).flat(),
	];

	it("leaves a request below the share alone", () => {
		const messages = conversation();
		expect(clearOldResults(messages, 10_000_000)).toBe(messages);
		expect(CLEAR_SHARE).toBeLessThan(1);
	});

	it("clears old long results that can be had again, naming where, and keeps the latest turns", () => {
		const out = clearOldResults(conversation(), 1000);
		const text = (m: AgentMessage) => ((m as { content: { text: string }[] }).content[0]?.text ?? "") as string;
		// The old read gives way to a note with its path; the session's own array is untouched.
		expect(text(out[2])).toContain("参考资料/报告.md");
		expect(text(out[2]).length).toBeLessThan(300);
		// write cannot be had again by reading: it stays.
		expect(text(out[4])).toBe(long);
		// The reads of the latest turns stay whole.
		for (let n = 0; n < KEEP_TURNS; n++) expect(text(out[7 + n * 3])).toBe(long);
	});
});
