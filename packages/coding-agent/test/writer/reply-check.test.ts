// Unit tests for src/writer/reply-check.ts: the text of the model's replies since the user's last message, the hard
// marks in it, and how they are named.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import { MAX_REPLY_ROUNDS, marksList, replyMarks, replyText } from "../../src/writer/reply-check.ts";

describe("replyText", () => {
	it("joins the text blocks of the replies after the user's last message, and nothing before it", () => {
		const messages = [
			{ role: "user", content: "第一问" },
			{ role: "assistant", content: [{ type: "text", text: "旧回复，综上所述。" }] },
			{ role: "user", content: [{ type: "text", text: "第二问" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "先看文件。" },
					{ type: "toolCall", name: "read" },
				],
			},
			{ role: "toolResult", content: [{ type: "text", text: "值得注意的是，工具结果不算。" }] },
			{ role: "assistant", content: "写好了。" },
		];
		expect(replyText(messages)).toBe("先看文件。\n写好了。");
		expect(replyText(undefined)).toBe("");
		expect(replyText([{ role: "user", content: "问" }])).toBe("");
	});
});

describe("replyMarks / marksList", () => {
	it("finds the marks: frames and stock phrases, not single denials, not quoted text", () => {
		const text = "综上所述，方案可行。这不是问题。他说：“值得注意的是，天气。”\n由此可见，俄方代表团到了。";
		const marks = replyMarks(text);
		expect(marks.map((m) => m.id)).toEqual(["zh-zongshang", "zh-youci", "zh-country-fang"]);
		expect(marksList(marks, text)).toBe("“综上所述”（第 1 行）、“由此可见”（第 2 行）、“俄方”（第 2 行）");
		// Plain prose and an empty reply carry none; a stock phrase counts, since a reply is short.
		expect(replyMarks("已写入 稿.md，共 1200 字。")).toEqual([]);
		expect(replyMarks("")).toEqual([]);
		expect(replyMarks("技术是把双刃剑。").map((m) => m.id)).toEqual(["zh-shuangren"]);
		// The same wording is named once, at most five.
		const many = Array.from({ length: 8 }, (_, i) => `由此可见，第${i}点。`).join("\n");
		expect(marksList(replyMarks(many), many)).toBe("“由此可见”（第 1 行）");
		expect(MAX_REPLY_ROUNDS).toBe(1);
	});
});
