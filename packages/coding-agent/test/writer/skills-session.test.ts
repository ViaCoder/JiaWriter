// Unit tests for src/writer/skills/session-skill.ts, with the plan's simulated session:
// contradicting requests, a refused tool call with a comment, a fake key, and model replies.

// Test API.
import { describe, expect, it } from "vitest";
// Session entry type.
import type { SessionEntry } from "../../src/core/session-manager.ts";
// Functions under test.
import {
	collectUserRequests,
	diffSkill,
	renderSkillDraft,
	resolveLatest,
	skillNameProblems,
	splitRequests,
	topicsOf,
} from "../../src/writer/skills/session-skill.ts";

/** A message entry. */
function entry(i: number, message: Record<string, unknown>): SessionEntry {
	// Minimal fields the collector reads.
	return { type: "message", id: `e${i}`, parentId: null, timestamp: "", message } as unknown as SessionEntry;
}

// The simulated session.
const SESSION: SessionEntry[] = [
	entry(1, { role: "user", content: "写一篇调研报告。正文用三号字。案例要标注待核实。" }),
	entry(2, { role: "assistant", content: [{ type: "text", text: "好的，我会用三号字并标注待核实。" }] }),
	entry(3, {
		role: "toolResult",
		isError: true,
		content: [{ type: "text", text: "Blocked by user: 先给我看大纲，读者是区领导" }],
	}),
	entry(4, { role: "toolResult", isError: true, content: [{ type: "text", text: "ENOENT: no such file" }] }),
	entry(5, { role: "user", content: [{ type: "text", text: "继续" }] }),
	entry(6, {
		role: "user",
		content: "字号改成小二；不要标注待核实，案例写明日期和来源。我的 key 是 sk-test-0123456789abcdefABCD",
	}),
	{ type: "custom", id: "c", parentId: null, timestamp: "" } as unknown as SessionEntry,
];

describe("splitRequests / topicsOf", () => {
	it("splits at line and sentence ends, drops acknowledgements, and finds topics", () => {
		// Clauses keep their end marks.
		expect(splitRequests("好的\n第一条要求。第二条要求；ok\n继续")).toEqual(["第一条要求。", "第二条要求；"]);
		// Topics in Chinese and English.
		expect(topicsOf("正文用三号字，行距 32 磅")).toEqual(["size", "spacing"]);
		expect(topicsOf("Cite the source of every case")).toEqual(["citation"]);
		expect(topicsOf("写得再长一点吧")).toEqual([]);
	});
});

describe("collectUserRequests / resolveLatest", () => {
	it("collects the user's words and refusal reasons only, and keeps the latest request per topic", () => {
		// No model replies, no plain tool errors, no acknowledgements.
		const all = collectUserRequests(SESSION);
		expect(all.map((r) => r.text)).toEqual([
			"写一篇调研报告。",
			"正文用三号字。",
			"案例要标注待核实。",
			"先给我看大纲，读者是区领导",
			"字号改成小二；",
			"不要标注待核实，案例写明日期和来源。",
			"我的 key 是 sk-test-0123456789abcdefABCD",
		]);
		// 三号 and the 待核实 marking are superseded.
		const { kept, dropped } = resolveLatest(all);
		expect(dropped.map((r) => r.text)).toEqual(["正文用三号字。", "案例要标注待核实。"]);
		expect(kept.map((r) => r.order)).toEqual([0, 3, 4, 5, 6]);
	});
});

describe("renderSkillDraft", () => {
	it("writes standard frontmatter and grouped requests without the key or model text", () => {
		// The kept requests of the session.
		const { kept } = resolveLatest(collectUserRequests(SESSION));
		const draft = renderSkillDraft({
			name: "district-report",
			title: "区级调研报告",
			description: "写给区领导的调研报告。",
			lang: "zh",
			requests: kept,
			date: "2026-11-01",
		});
		expect(draft).toBe(
			[
				"---",
				"name: district-report",
				'description: "写给区领导的调研报告。"',
				"metadata:",
				'  title: "区级调研报告"',
				"  source: session",
				"  created: 2026-11-01",
				"---",
				"",
				"# 区级调研报告",
				"",
				"按以下要求完成写作任务。这些要求整理自用户在会话中的原话，同一主题以最后一次为准。",
				"",
				"## 文风",
				"",
				"- 先给我看大纲，读者是区领导",
				"",
				"## 排版",
				"",
				"- 字号改成小二；",
				"",
				"## 引用与来源",
				"",
				"- 不要标注待核实，案例写明日期和来源。",
				"",
				"## 其他要求",
				"",
				"- 写一篇调研报告。",
				"- 我的 key 是 <redacted>",
				"",
			].join("\n"),
		);
		expect(draft).not.toContain("sk-test");
		expect(draft).not.toContain("我会用三号字");
	});
	it("uses the blank template without requests, in English too", () => {
		// English blank.
		const blank = renderSkillDraft({
			name: "x",
			title: "X",
			description: "d",
			lang: "en",
			requests: [],
			date: "2026-11-01",
		});
		expect(
			blank.endsWith(
				"# X\n\n## Before writing\n\n- \n\n## Structure\n\n- \n\n## Style\n\n- \n\n## Final checks\n\n- Run style_check on the finished draft.\n",
			),
		).toBe(true);
	});
});

describe("skillNameProblems / diffSkill", () => {
	it("checks names and diffs drafts", () => {
		// Valid and invalid names.
		expect(skillNameProblems("district-report")).toEqual([]);
		expect(skillNameProblems("区级")).toEqual(["a-z 0-9 -"]);
		expect(skillNameProblems("-a--b")).toEqual(["hyphens"]);
		expect(skillNameProblems("a".repeat(65))).toEqual(["1–64"]);
		// Equal drafts have no diff; a change shows both lines.
		expect(diffSkill("a/SKILL.md", "x\n", "x\n")).toBe("");
		const d = diffSkill("a/SKILL.md", "- 三号\n", "- 小二\n");
		expect(d).toContain("-- 三号");
		expect(d).toContain("+- 小二");
	});
});
