// Unit tests for src/writer/draft/section.ts: a section's outline part and materials, the clean request, and how the
// text goes into the draft and the outline.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import {
	cleanSectionText,
	headingOf,
	MAX_PREVIOUS,
	markOutline,
	outlinePart,
	outlineTitle,
	SECTION_REASONING_TOKENS,
	sectionInstructions,
	sectionMaterials,
	sectionRequest,
	spliceSection,
} from "../../src/writer/draft/section.ts";

/** An outline as a research run writes it. */
const OUTLINE = [
	"# 大纲：低空经济发展研究报告",
	"",
	"报告对象：2025年以来的公开报道；约1500字。",
	"",
	"- [x] 引言：低空经济规模快速增长",
	"- [ ] 一、发展现状：市场规模迈向1.5万亿元",
	"  - 民航局预测：2025年1.5万亿元（新华社2025-12-22）",
	"  - 注册无人机328.7万架（中国网2026-05-26）",
	"- [ ] 二、突出问题：法规供给滞后",
	"  - 空域分类规则待完善",
	"",
	"假设与说明：",
	"- 预测值按预测口径表述。",
].join("\n");

/** Materials, two of them tagged for the first part. */
const MATERIALS = [
	"# 素材",
	"",
	"- 【发展现状】数据｜时间：2025年12月22日｜原文：“2025年市场规模将达1.5万亿元。”｜来源：https://a.example/1",
	"- 【发展现状】数据｜时间：2026年5月26日｜原文：“注册无人机328.7万架。”｜来源：https://a.example/2",
	"- 【突出问题】案例｜主体：某市｜原文：“空域分类规则待完善。”｜来源：https://a.example/3",
].join("\n");

describe("outlinePart / headingOf / outlineTitle", () => {
	it("finds a section by its line or its heading, with the head and the items under it", () => {
		const part = outlinePart(OUTLINE, "一、发展现状：市场规模迈向1.5万亿元");
		expect(part).toMatchObject({ line: "一、发展现状：市场规模迈向1.5万亿元", open: true });
		expect(part?.brief).toBe("报告对象：2025年以来的公开报道；约1500字。");
		expect(part?.items).toEqual([
			"民航局预测：2025年1.5万亿元（新华社2025-12-22）",
			"注册无人机328.7万架（中国网2026-05-26）",
		]);
		// The heading alone, and spaces and punctuation aside.
		expect(outlinePart(OUTLINE, "一、发展现状")?.line).toBe("一、发展现状：市场规模迈向1.5万亿元");
		expect(outlinePart(OUTLINE, "二 突出问题")?.items).toEqual(["空域分类规则待完善"]);
		// A ticked line is found too, and says so.
		expect(outlinePart(OUTLINE, "引言")).toMatchObject({ open: false, items: [] });
		expect(outlinePart(OUTLINE, "没有的节")).toBeUndefined();
		expect(outlinePart(OUTLINE, " ")).toBeUndefined();
	});

	it("headingOf: the line up to its colon, none for an opening or closing part, the model's without # marks; outlineTitle: the document's name", () => {
		expect(headingOf("一、发展现状：市场规模迈向1.5万亿元")).toBe("一、发展现状");
		expect(headingOf("引言：低空经济规模快速增长")).toBe("");
		expect(headingOf("开篇")).toBe("");
		expect(headingOf("五、参考文献")).toBe("");
		expect(headingOf("一、发展现状", "## 一、发展现状与主要进展")).toBe("一、发展现状与主要进展");
		expect(headingOf("引言", "")).toBe("");
		expect(outlineTitle(OUTLINE)).toBe("低空经济发展研究报告");
		expect(outlineTitle("# 报告\n")).toBe("报告");
		expect(outlineTitle("没有标题")).toBe("");
	});
});

describe("sectionMaterials", () => {
	it("takes the items tagged for the section, else all of them", () => {
		expect(sectionMaterials(MATERIALS, "一、发展现状：市场规模迈向1.5万亿元")).toHaveLength(2);
		expect(sectionMaterials(MATERIALS, "二、突出问题：法规供给滞后")[0]).toContain("空域分类");
		// No tag names the section: every item, for the model to choose from.
		expect(sectionMaterials(MATERIALS, "三、对策建议")).toHaveLength(3);
		expect(sectionMaterials("# 素材\n", "一、发展现状")).toEqual([]);
	});
});

describe("sectionInstructions / sectionRequest", () => {
	it("gives the writing rules without the order of work, the rule on quoted people, and a small budget", () => {
		const text = sectionInstructions();
		expect(text).toContain("Wording comes first");
		expect(text).not.toContain("Order:");
		expect(text).toContain("A person quoted in the materials");
		expect(text).toContain("Return the section's text only");
		expect(text).toContain("Paragraphs open differently");
		expect(text).toContain("never a bare Latin surname");
		expect(SECTION_REASONING_TOKENS).toBeLessThanOrEqual(2048);
	});

	it("puts the brief, the outline, the section, its items, its materials and the latest text in the request", () => {
		const request = sectionRequest({
			brief: "报告对象：公开报道",
			outline: OUTLINE,
			line: "一、发展现状：市场规模迈向1.5万亿元",
			items: ["民航局预测"],
			heading: "一、发展现状",
			materials: ["- 【发展现状】数据｜原文：“1.5万亿元。”"],
			previous: `${"前文。".repeat(10)}\n${"末段。".repeat(MAX_PREVIOUS)}`,
			chars: 400,
			notes: "每节开头一句话概括",
		});
		for (const part of [
			"文件要求：\n报告对象：公开报道",
			"本节：一、发展现状",
			"本节标题行：一、发展现状",
			"- 民航局预测",
			"1.5万亿元",
			"约 400 字",
			"每节开头一句话概括",
		])
			expect(request).toContain(part);
		// Only the latest text goes, from a line start.
		expect(request).not.toContain("前文。");
		expect(request.length).toBeLessThan(MAX_PREVIOUS + 2000);
		// No heading, no materials, no text yet.
		const bare = sectionRequest({
			brief: "",
			outline: OUTLINE,
			line: "引言",
			items: [],
			heading: "",
			materials: [],
			previous: "",
		});
		expect(bare).toContain("本节不设标题");
		expect(bare).toContain("（无）");
		expect(bare).toContain("这是第一节");
	});
});

describe("cleanSectionText / spliceSection / markOutline", () => {
	it("cleanSectionText: no fence, the heading once as asked", () => {
		expect(cleanSectionText("```markdown\n## 一、发展现状\n\n正文。\n```", "一、发展现状")).toBe(
			"## 一、发展现状\n\n正文。",
		);
		expect(cleanSectionText("正文。", "一、发展现状")).toBe("## 一、发展现状\n\n正文。");
		// A heading the model wrote at another level is the one asked.
		expect(cleanSectionText("### 一、发展现状\n正文。", "一、发展现状")).toBe("## 一、发展现状\n正文。");
		expect(cleanSectionText("  正文。  ", "")).toBe("正文。");
	});

	it("spliceSection: a new section before the references, a rewritten one in place, the title first", () => {
		const first = spliceSection("", "引言", "引言正文。", "报告");
		expect(first).toBe("# 报告\n\n引言正文。\n");
		const second = spliceSection(first, "一、发展现状", "## 一、发展现状\n\n现状正文。");
		expect(second).toBe("# 报告\n\n引言正文。\n\n## 一、发展现状\n\n现状正文。\n");
		const withRefs = `${second}\n## 参考文献\n\n1. 来源\n`;
		const third = spliceSection(withRefs, "二、突出问题", "## 二、突出问题\n\n问题正文。");
		expect(third.indexOf("问题正文")).toBeLessThan(third.indexOf("参考文献"));
		// The same section again replaces the old one and nothing else.
		const again = spliceSection(third, "一、发展现状", "## 一、发展现状\n\n改写的现状。");
		expect(again).not.toContain("现状正文");
		expect(again).toContain("改写的现状。\n\n## 二、突出问题");
		expect(again).toContain("参考文献");
	});

	it("markOutline: ticks the section's line only", () => {
		const marked = markOutline(OUTLINE, "一、发展现状：市场规模迈向1.5万亿元");
		expect(marked).toContain("- [x] 一、发展现状");
		expect(marked).toContain("- [ ] 二、突出问题");
		expect(markOutline(OUTLINE, "没有的节")).toBe(OUTLINE);
	});
});
