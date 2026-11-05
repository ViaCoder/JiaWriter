// Regression tests for compaction on Chinese writing sessions (the user, 2026-11-05: a failed compaction
// made the rest of the conversation fail). The fake model counts tokens as a real server does and rejects
// a request that does not fit its window.

// Faux provider helpers.
import { type AssistantMessage, type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
// Test API.
import { afterEach, describe, expect, it } from "vitest";
// Function under test.
import { estimateTokens } from "../../src/core/compaction/compaction.ts";
// The extension with the request size guard.
import writerEnvExtension from "../../src/extensions/writer-env/index.ts";
// Harness with the faux provider.
import { createHarness, type Harness } from "../suite/harness.ts";

/** Context window of every test. */
const WINDOW = 128_000;
/** One fetched page of Chinese text, the size web_fetch returns at most. */
const PAGE = "城市绿化研究资料".repeat(3000);

/** Tokens as a server counts them: a Chinese character is about one token, other text about four characters. */
function serverTokens(text: string): number {
	const cjk = text.match(/[　-鿿＀-￯]/g)?.length ?? 0;
	return cjk + Math.ceil((text.length - cjk) / 4);
}

/** All text of a request. */
function requestText(context: Context): string {
	return (context.systemPrompt ?? "") + JSON.stringify(context.messages);
}

/** True for a compaction summary request. */
function isSummary(context: Context): boolean {
	return requestText(context).includes("context summarization assistant");
}

/** What the fake model saw. */
interface Log {
	rejected: number;
	summaries: number;
	summaryReasoning: unknown[];
	// Input tokens of the latest conversation request, reported as usage the way a real server does.
	input: number;
	// Tool batches of the current round.
	batches: number;
}

/** A fresh log. */
function newLog(): Log {
	return { rejected: 0, summaries: 0, summaryReasoning: [], input: 0, batches: 0 };
}

/** Fake model: rejects oversized requests, summarizes, calls web_fetch five times per user turn, then answers. */
function brain(
	log: Log,
	summary: () => AssistantMessage = () => fauxAssistantMessage("摘要：已完成资料收集。"),
	plan: { batch: number; steps: number } = { batch: 5, steps: 1 },
) {
	return (context: Context, options?: { reasoning?: unknown }): AssistantMessage => {
		const tokens = serverTokens(requestText(context));
		if (tokens > WINDOW) {
			log.rejected++;
			return fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: `prompt is too long: ${tokens} tokens > ${WINDOW} maximum`,
			});
		}
		if (!isSummary(context)) log.input = tokens;
		if (isSummary(context)) {
			log.summaries++;
			log.summaryReasoning.push(options?.reasoning);
			return summary();
		}
		// A round asks for its batches once, also across a compaction, as a model that remembers its plan does.
		if (log.batches < plan.steps) {
			log.batches++;
			return fauxAssistantMessage(
				Array.from({ length: plan.batch }, (_, n) => fauxToolCall("fake_fetch", { n })),
				{ stopReason: "toolUse" },
			);
		}
		log.batches = 0;
		return fauxAssistantMessage("本轮资料已读完。");
	};
}

/** A harness with the fake fetch tool and many copies of the fake model. */
async function setup(
	log: Log,
	summary?: () => AssistantMessage,
	settings = {},
	plan?: { batch: number; steps: number },
): Promise<Harness> {
	const harness = await createHarness({
		provider: "jw",
		extensionFactories: [writerEnvExtension],
		models: [{ id: "faux-1", contextWindow: WINDOW, maxTokens: WINDOW, reasoning: true }],
		settings,
		tools: [
			{
				name: "fake_fetch",
				label: "fetch",
				description: "fetch",
				parameters: { type: "object", properties: {} } as never,
				execute: async () => ({ content: [{ type: "text", text: PAGE }], details: {} }),
			},
		],
		initialActiveToolNames: ["fake_fetch"],
	});
	harness.setResponses(Array.from({ length: 80 }, () => brain(log, summary, plan)));
	// A real server reports exact usage; the faux provider's own figure is chars/4.
	harness.session.subscribe((event) => {
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		const usage = (event.message as AssistantMessage).usage;
		usage.input = log.input;
		usage.cacheRead = 0;
		usage.cacheWrite = 0;
		usage.totalTokens = log.input + usage.output;
	});
	return harness;
}

describe("compaction on Chinese sessions", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("counts a Chinese character as about one token", () => {
		// 24000 characters are about 24000 tokens, not 6000.
		const tokens = estimateTokens({ role: "user", content: PAGE, timestamp: 0 });
		expect(tokens).toBeGreaterThanOrEqual(24_000);
		// English keeps four characters per token.
		expect(estimateTokens({ role: "user", content: "a".repeat(400), timestamp: 0 })).toBe(100);
	});

	it("keeps three rounds of long Chinese pages inside the window", async () => {
		const log = newLog();
		harness = await setup(log);
		for (let round = 0; round < 3; round++) await harness.session.prompt(`第${round + 1}轮：读资料`);
		const errors = harness.eventsOfType("compaction_end").filter((e) => e.errorMessage);
		expect([log.rejected, errors.length]).toEqual([0, 0]);
		const last = harness.session.messages.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe("stop");
	});

	it("survives three steps of pages inside one user turn", async () => {
		const log = newLog();
		harness = await setup(log, undefined, {}, { batch: 3, steps: 3 });
		await harness.session.prompt("读资料");
		const errors = harness.eventsOfType("compaction_end").filter((e) => e.errorMessage);
		expect(errors.length).toBe(0);
		expect((harness.session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
	});

	it("survives one message of pages larger than the window, and the next message works", async () => {
		const log = newLog();
		harness = await setup(log, undefined, {}, { batch: 7, steps: 1 });
		await harness.session.prompt("读资料");
		const errors = harness.eventsOfType("compaction_end").filter((e) => e.errorMessage);
		expect([log.rejected, errors.length]).toEqual([0, 0]);
		expect((harness.session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
		// The next message works.
		await harness.session.prompt("继续");
		expect(log.rejected).toBe(0);
		expect((harness.session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
	});

	it("summarizes a session larger than the window in several parts", async () => {
		const log = newLog();
		harness = await setup(log);
		// Earlier turns hold 360000 real tokens: more than one summary request can take.
		const now = Date.now();
		for (let i = 0; i < 15; i++) {
			harness.sessionManager.appendMessage({ role: "user", content: `问题${i}`, timestamp: now - 1000 + i });
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage(PAGE, { timestamp: now - 900 + i }),
				api: harness.getModel().api,
				provider: harness.getModel().provider,
				model: harness.getModel().id,
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await harness.session.prompt("继续");
		const compactions = harness.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactions.length).toBeGreaterThan(0);
		expect(log.summaries).toBeGreaterThan(1);
		// Only the first oversized request is rejected: every summary request fits.
		expect(log.rejected).toBeLessThanOrEqual(1);
		expect(serverTokens(JSON.stringify(harness.session.messages))).toBeLessThan(WINDOW);
	});

	it("sends summary requests without reasoning", async () => {
		const log = newLog();
		harness = await setup(log);
		harness.session.setThinkingLevel("high");
		await harness.session.prompt("第1轮");
		await harness.session.prompt("第2轮");
		expect(log.summaries).toBeGreaterThan(0);
		expect(log.summaryReasoning.every((r) => r === undefined)).toBe(true);
	});

	it("treats a Chinese overflow error of the jw model as an overflow", async () => {
		const log = newLog();
		harness = await setup(log);
		harness.setResponses([
			() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 请求内容超长，超出上下文长度限制" }),
			...Array.from({ length: 20 }, () => brain(log)),
		]);
		// Enough history to compact.
		const now = Date.now();
		for (let i = 0; i < 4; i++) {
			harness.sessionManager.appendMessage({ role: "user", content: `问题${i}`, timestamp: now - 1000 + i });
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage(PAGE.slice(0, 6000), { timestamp: now - 900 + i }),
				api: harness.getModel().api,
				provider: harness.getModel().provider,
				model: harness.getModel().id,
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await harness.session.prompt("继续");
		expect(harness.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(true);
		expect((harness.session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
	});

	it("goes on with a local summary when the model cannot summarize", async () => {
		const log = newLog();
		const failing = () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request: summary refused" });
		harness = await setup(log, failing, { retry: { enabled: false } });
		await harness.session.prompt("第1轮：写城市绿化报告");
		await harness.session.prompt("第2轮");
		await harness.session.prompt("第3轮");
		const compactions = harness.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactions.length).toBeGreaterThan(0);
		// The user's request survives in the local summary.
		expect(compactions.some((e) => e.type === "compaction" && e.summary.includes("写城市绿化报告"))).toBe(true);
		const last = harness.session.messages.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe("stop");
		expect(log.rejected).toBe(0);
	});
});
