// The semantic review (src/writer/style/review.ts): what is kept of a reviewer's answer, and how it is shown.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatReview,
	MAX_ISSUES,
	parseReview,
	REVIEW_CATEGORIES,
	REVIEW_PROMPT,
	reviewDraft,
	reviewEnabled,
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
	it("explains every category, asks for no new content and for exact quotes", () => {
		for (const category of REVIEW_CATEGORIES) expect(REVIEW_PROMPT).toContain(`- ${category}:`);
		expect(REVIEW_PROMPT).toContain("Never ask for more content");
		expect(REVIEW_PROMPT).toContain("character for character");
	});
});
