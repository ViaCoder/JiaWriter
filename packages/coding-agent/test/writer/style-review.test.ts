// The semantic review (src/writer/style/review.ts): what is kept of a reviewer's answer, and how it is shown.
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../src/writer/i18n/index.ts";
import {
	formatReview,
	keepAnswerable,
	MAX_ISSUES,
	MAX_REVIEW_MATERIALS,
	parseReview,
	REVIEW_CATEGORIES,
	REVIEW_PROMPT,
	reviewDraft,
	reviewEnabled,
	reviewInput,
} from "../../src/writer/style/review.ts";

const DRAFT = "政策红利像一场春雨，点燃了企业创新的引擎。全年增长7.5%。";

describe("parseReview", () => {
	it("keeps findings whose quote is in the draft, of a known category", () => {
		const answer = `好的：{"issues":[{"category":"bad-metaphor","quote":"像一场春雨，点燃了","why":"混用","fix":"直说"}]}`;
		expect(parseReview(answer, DRAFT)).toEqual([
			{ category: "bad-metaphor", quote: "像一场春雨，点燃了", why: "混用", fix: "直说" },
		]);
	});
	it("drops invented quotes and unknown categories, and gives undefined for an answer that is no JSON", () => {
		const answer = JSON.stringify({
			issues: [
				{ category: "bad-metaphor", quote: "不在原文里的话", why: "", fix: "" },
				{ category: "made-up", quote: "全年增长", why: "", fix: "" },
			],
		});
		expect(parseReview(answer, DRAFT)).toEqual([]);
		expect(parseReview("没有问题", DRAFT)).toBeUndefined();
		expect(parseReview("{坏的}", DRAFT)).toBeUndefined();
	});
	it("keeps at most MAX_ISSUES", () => {
		const issues = Array.from({ length: MAX_ISSUES + 5 }, () => ({ category: "bad-metaphor", quote: "春雨" }));
		expect(parseReview(JSON.stringify({ issues }), DRAFT)?.length).toBe(MAX_ISSUES);
	});
});

describe("keepAnswerable", () => {
	it("drops the findings that ask for facts when there are no materials to take them from", () => {
		const issues = [
			{ category: "vague-no-facts", quote: "有所增加", why: "", fix: "给出数据" },
			{ category: "bad-metaphor", quote: "春雨", why: "", fix: "直说" },
		];
		expect(keepAnswerable(issues, true)).toEqual(issues);
		expect(keepAnswerable(issues, false).map((i) => i.category)).toEqual(["bad-metaphor"]);
	});
});

describe("formatReview", () => {
	it("gives one line per finding", () => {
		expect(formatReview([{ category: "bad-metaphor", quote: "春雨", why: "混用", fix: "直说" }])).toBe(
			"- [bad-metaphor] “春雨”: 混用 → 直说",
		);
	});
});

describe("reviewEnabled", () => {
	afterEach(() => vi.unstubAllEnvs());
	it("is on unless JW_REVIEW=off", () => {
		expect(reviewEnabled({})).toBe(true);
		expect(reviewEnabled({ JW_REVIEW: " OFF " })).toBe(false);
	});
});

describe("reviewDraft", () => {
	it("sends the prompt and the draft, and takes a failure as no review", async () => {
		const seen: string[] = [];
		const found = await reviewDraft(DRAFT, async (instructions, text) => {
			seen.push(instructions, text);
			return '{"issues":[]}';
		});
		expect([found, seen]).toEqual([[], [REVIEW_PROMPT, DRAFT]]);
		expect(await reviewDraft(DRAFT, async () => Promise.reject(new Error("offline")))).toBeUndefined();
	});
});

describe("REVIEW_PROMPT", () => {
	it("leaves sourced statements to their source", () => {
		expect(REVIEW_PROMPT).toContain("A statement given with its source");
	});
	it("explains every category, asks for no new content and for exact quotes", () => {
		for (const category of REVIEW_CATEGORIES) expect(REVIEW_PROMPT).toContain(`- ${category}:`);
		expect(REVIEW_PROMPT).toContain("Never ask for more content");
		expect(REVIEW_PROMPT).toContain("character for character");
	});
});

describe("the reviewer and our own knowledge", () => {
	it("judges no fact by what it knows, and a finding is no reason to search", () => {
		// A 2026-11-08 review called a dated 2026 event "really 2025" and the writer searched the web to check.
		expect(REVIEW_PROMPT).toContain("Judge no fact by what you know");
		expect(REVIEW_PROMPT).toContain("may be later than anything you know");
		expect(t("style.materials", {}, "zh")).toContain("检查意见不是检索的理由");
	});
});

describe("spoken-register", () => {
	it("is a category the prompt explains and the parser keeps", () => {
		// 2026-11-09: drafts kept 随手可承受 and 以快制快 at language score 4; no category named them.
		expect(REVIEW_PROMPT).toContain("- spoken-register:");
		// 2026-11-09: a review suggested 一是/二是, which the numbering rule forbids, and missed an invented research opening.
		expect(REVIEW_PROMPT).not.toContain("一是……二是……");
		expect(REVIEW_PROMPT).toContain("never one that numbers points with 一是/二是");
		expect(REVIEW_PROMPT).toContain("the opening's account of how the research was done");
		const kept = parseReview(
			`{"issues":[{"category":"spoken-register","quote":"以快制快","why":"口号","fix":"写出具体时限"}]}`,
			"要以快制快。",
		);
		expect(kept?.map((i) => i.category)).toEqual(["spoken-register"]);
	});
});

describe("reviewInput and unfounded inference", () => {
	it("puts the materials before the draft, up to MAX_REVIEW_MATERIALS, and the draft alone without them", () => {
		expect(reviewInput("稿件", "")).toBe("稿件");
		expect(reviewInput("稿件", "材料一")).toBe("Materials:\n材料一\n\nDraft:\n稿件");
		const long = "材".repeat(MAX_REVIEW_MATERIALS + 10);
		expect(reviewInput("稿件", long).length).toBe(
			"Materials:\n".length + MAX_REVIEW_MATERIALS + "\n\nDraft:\n稿件".length,
		);
	});

	it("sends the materials to the reviewer and keeps an unfounded inference only when there are materials", async () => {
		const draft = "攻击方再以低廉账号批量投放。";
		let seen = "";
		const ask = async (_: string, text: string) => {
			seen = text;
			return `{"issues":[{"category":"unfounded-inference","quote":"以低廉账号批量投放","why":"材料没有提到账号","fix":"删去"}]}`;
		};
		const found = (await reviewDraft(draft, ask, "1. 深度伪造工具已开源。")) ?? [];
		expect(seen.startsWith("Materials:\n1. 深度伪造工具已开源。")).toBe(true);
		expect(REVIEW_CATEGORIES).toContain("unfounded-inference");
		expect(keepAnswerable(found, true).map((i) => i.category)).toEqual(["unfounded-inference"]);
		expect(keepAnswerable(found, false)).toEqual([]);
	});
});
