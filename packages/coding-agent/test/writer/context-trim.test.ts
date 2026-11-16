// Folding old large tool results out of the context (writer/context-trim.ts).
import { describe, expect, it } from "vitest";
import { type ProjectedLike, TRIM_DEFAULTS, trimEnabled, trimPlan } from "../../src/writer/context-trim.ts";

/** An assistant message with the calls given. */
function assistant(id: string, calls: { id: string; name: string; path?: string }[] = []): ProjectedLike {
	return {
		sourceEntry: { id, type: "message" },
		messages: [
			{
				role: "assistant",
				stopReason: calls.length ? "toolUse" : "stop",
				content: calls.map((c) => ({
					type: "toolCall",
					id: c.id,
					name: c.name,
					arguments: c.path ? { path: c.path } : {},
				})),
			},
		],
	};
}

/** A tool result with the text given. */
function result(id: string, callId: string, toolName: string, text: string, isError = false): ProjectedLike {
	return {
		sourceEntry: { id, type: "message" },
		messages: [{ role: "toolResult", toolCallId: callId, toolName, isError, content: [{ type: "text", text }] }],
	};
}

const LONG = "正文".repeat(1000);
const PAGE = `网页正文（deepseek）：标题\n网址：https://a.example/x\n\n${LONG}\n已归档：/work/话题/网页/005-标题.md`;
const LIST = `检索结果（deepseek，10 条）：低空经济\n${LONG}\n已归档：/work/话题/检索/001-低空经济.md`;

describe("trimPlan", () => {
	it("folds search, fetch and read results older than the kept turns, naming their files", () => {
		const entries = [
			assistant("a1", [{ id: "c1", name: "search_web" }]),
			result("r1", "c1", "search_web", LIST),
			assistant("a2", [{ id: "c2", name: "fetch_web" }]),
			result("r2", "c2", "fetch_web", PAGE),
			assistant("a3", [{ id: "c3", name: "read", path: "参考资料/.parsed/报告.pdf.md" }]),
			result("r3", "c3", "read", LONG),
			// The last three turns keep their results.
			assistant("a4", [{ id: "c4", name: "fetch_web" }]),
			result("r4", "c4", "fetch_web", PAGE),
			assistant("a5"),
			assistant("a6"),
		];
		const edits = trimPlan(entries);
		expect(edits.map((e) => e.targetId)).toEqual(["r1", "r2", "r3"]);
		const texts = edits.map((e) => (e.replacement?.content as { text: string }[])[0].text);
		expect(texts[0]).toContain("/work/话题/检索/001-低空经济.md");
		expect(texts[0]).toContain("search_web");
		expect(texts[1]).toContain("/work/话题/网页/005-标题.md");
		expect(texts[2]).toContain("参考资料/.parsed/报告.pdf.md");
		expect(texts[2].length).toBeLessThan(200);
	});

	it("leaves short results, failed results, other tools, results without a file, and the kept turns alone", () => {
		const entries = [
			assistant("a1", [
				{ id: "c1", name: "fetch_web" },
				{ id: "c2", name: "bash" },
				{ id: "c3", name: "read", path: "x.md" },
				{ id: "c4", name: "fetch_web" },
			]),
			result("r1", "c1", "fetch_web", "短结果\n已归档：/w/网页/1.md"),
			result("r2", "c2", "bash", LONG),
			result("r3", "c3", "read", LONG, true),
			// A fetched page that was not archived names no file.
			result("r4", "c4", "fetch_web", `网页正文：\n${LONG}`),
			assistant("a2"),
			assistant("a3"),
			assistant("a4"),
		];
		expect(trimPlan(entries)).toEqual([]);
		// Fewer assistant turns than kept: nothing is old yet.
		expect(
			trimPlan([
				assistant("a1", [{ id: "c1", name: "fetch_web" }]),
				result("r1", "c1", "fetch_web", PAGE),
				assistant("a2"),
			]),
		).toEqual([]);
	});

	it("skips a result already folded, since its line is short, and a result with image blocks", () => {
		const folded: ProjectedLike = {
			sourceEntry: { id: "r1", type: "message" },
			messages: [
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "fetch_web",
					content: [{ type: "text", text: "（已收起）全文在 /w/网页/1.md" }],
				},
			],
		};
		const picture: ProjectedLike = {
			sourceEntry: { id: "r2", type: "message" },
			messages: [
				{
					role: "toolResult",
					toolCallId: "c2",
					toolName: "read",
					content: [
						{ type: "text", text: LONG },
						{ type: "image", data: "", mimeType: "image/png" },
					],
				},
			],
		};
		const entries = [
			assistant("a1", [
				{ id: "c1", name: "fetch_web" },
				{ id: "c2", name: "read", path: "图.png" },
			]),
			folded,
			picture,
			assistant("a2"),
			assistant("a3"),
			assistant("a4"),
		];
		expect(trimPlan(entries)).toEqual([]);
	});

	it("trimEnabled: on unless switched off; the defaults keep three turns and fold from 1,500 characters", () => {
		expect(trimEnabled({})).toBe(true);
		expect(trimEnabled({ JW_CONTEXT_TRIM: "off" })).toBe(false);
		expect(trimEnabled({ JW_CONTEXT_TRIM: "0" })).toBe(false);
		expect(TRIM_DEFAULTS).toEqual({ keepTurns: 3, minChars: 1500 });
	});
});
