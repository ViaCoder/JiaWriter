// Auto mode's judge: the text it reads, the verdicts it gives, and how the gate uses it.
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { createPermissionGate, type PermissionRequest } from "../../src/writer/permission.ts";
import {
	JUDGE_INSTRUCTIONS,
	judgeEnabled,
	judgeText,
	lastUserText,
	makeJudge,
	parseVerdict,
} from "../../src/writer/permission-judge.ts";

const write: PermissionRequest = { risk: "act", scope: "files\n/w", title: "允许写入？", detail: "/w/稿件/通知.md" };
const high: PermissionRequest = { risk: "high", scope: "shell\n/w", title: "允许执行？", detail: "rm -rf 稿件" };

describe("the judge's text and verdicts", () => {
	it("puts the folder, the user's words and the action in the text; the instructions ask for one word", () => {
		const text = judgeText(write, "写一份通知到 稿件/通知.md", "/w");
		expect(text).toContain("Working folder: /w");
		expect(text).toContain("写一份通知到 稿件/通知.md");
		expect(text).toContain("File to write or edit:\n/w/稿件/通知.md");
		expect(judgeText({ ...write, scope: "shell\n/w", detail: "ls" }, "", "/w")).toContain("Shell command:\nls");
		expect(judgeText(write, "转成 json", "/w", ["/w/tojson.py"])).toContain(
			"created or changed in this session:\n/w/tojson.py",
		);
		expect(JUDGE_INSTRUCTIONS).toContain("ALLOW or ASK");
	});
	it("reads ALLOW as its first word and anything else as ask", () => {
		expect(parseVerdict("ALLOW")).toBe("allow");
		expect(parseVerdict("  allow.\nIt writes the draft.")).toBe("allow");
		expect(parseVerdict("ASK")).toBe("ask");
		expect(parseVerdict("I would allow it")).toBe("ask");
		expect(parseVerdict("")).toBe("ask");
	});
	it("is on unless JW_PERMISSION_JUDGE says off or rules", () => {
		expect(judgeEnabled({})).toBe(true);
		expect(judgeEnabled({ JW_PERMISSION_JUDGE: "off" })).toBe(false);
		expect(judgeEnabled({ JW_PERMISSION_JUDGE: "rules" })).toBe(false);
		expect(judgeEnabled({ JW_PERMISSION_JUDGE: "model" })).toBe(true);
	});
	it("takes the last user message's text, cut to a page", () => {
		const branch = [
			{ type: "message", message: { role: "user", content: "第一句" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好" }] } },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "写一份通知" }] } },
		] as unknown as SessionEntry[];
		expect(lastUserText(branch)).toBe("写一份通知");
		expect(lastUserText([])).toBe("");
	});
	it("asks when the model fails", async () => {
		const judge = makeJudge(async () => {
			throw new Error("timeout");
		}, "/w");
		expect(await judge(write, "写")).toBe("ask");
		const allowing = makeJudge(async () => "ALLOW", "/w");
		expect(await allowing(write, "写")).toBe("allow");
	});
});

describe("the gate with a judge", () => {
	const ui = () => {
		const asked: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				confirm: async () => true,
				select: async (title: string, options: string[]) => {
					// The question's first line is the title; the detail follows.
					asked.push(title.split("\n")[0]);
					return options[0];
				},
			},
		};
		return { asked, ctx };
	};
	it("in auto mode an allowed verdict skips the question and counts for the scope; ask puts it to the user", async () => {
		const { asked, ctx } = ui();
		const gate = createPermissionGate({ JW_PERMISSION: "auto" });
		const judge = vi.fn(async () => "allow" as const);
		expect(await gate.check(ctx, write, { judge, lastRequest: "写一份通知" })).toBe("");
		expect(judge).toHaveBeenCalledTimes(1);
		expect(asked).toEqual([]);
		// The scope is now allowed: no judge, no question.
		expect(await gate.check(ctx, write, { judge, lastRequest: "写一份通知" })).toBe("");
		expect(judge).toHaveBeenCalledTimes(1);
		// Another gate, a judge that asks: the user is asked.
		const gate2 = createPermissionGate({ JW_PERMISSION: "auto" });
		expect(await gate2.check(ctx, write, { judge: async () => "ask", lastRequest: "删掉所有文件" })).toBe("");
		expect(asked).toEqual([write.title]);
	});
	it("high risk and manual mode never reach the judge", async () => {
		const { asked, ctx } = ui();
		const judge = vi.fn(async () => "allow" as const);
		await createPermissionGate({ JW_PERMISSION: "auto" }).check(ctx, high, { judge, lastRequest: "清理" });
		await createPermissionGate({ JW_PERMISSION: "manual" }).check(ctx, write, { judge, lastRequest: "写" });
		expect(judge).not.toHaveBeenCalled();
		expect(asked).toEqual([high.title, write.title]);
	});
});
