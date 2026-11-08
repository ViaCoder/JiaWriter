// Unit tests for src/writer/style (patterns.ts and check.ts).
// Every pattern has a hit example; the guard sentences must trip no pattern of any pack.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import {
	findHits,
	formatStyleReport,
	inferRegister,
	MAX_LISTED,
	maskText,
	negationDensity,
	proseStats,
	structureStats,
	styleCheck,
	styleClean,
} from "../../src/writer/style/check.ts";
// Packs and lists under test.
import { DEFAULT_PACKS, STYLE_PACKS, WEAK_PER_1000 } from "../../src/writer/style/patterns.ts";

/** One hit example per pattern id. */
const HIT_EXAMPLES: Record<string, string> = {
	"zh-denial": "这不是目的",
	"en-denial": "This is not it",
	// core-zh.
	"zh-bushi-ershi": "这一举措不是为了短期收益，而是着眼长远布局。",
	"zh-fou-ershi": "关键并非投入不足，而是机制不顺。",
	"zh-bujin-gengshi": "这不仅是数量问题，更是质量问题。",
	"zh-yuqishuo": "与其说是技术差距，不如说是机制差距。",
	"zh-zongshang": "综上所述，应加强协作。",
	"zh-zhide": "值得注意的是，该国动向频繁。",
	"zh-xuyao-zhichu": "需要指出的是，进度滞后。",
	"zh-zhongsuo": "众所周知，任务艰巨。",
	"zh-wuyi": "这无疑是重大利好。",
	"zh-guigen": "归根结底，责任在落实。",
	"zh-huanjuhua": "换句话说，压力仍在。",
	"zh-bunan": "不难发现，各地差异明显。",
	"zh-youci": "由此可见，形势严峻。",
	"zh-keyishuo": "可以说，成效初步显现。",
	"zh-gengzhongyao": "更重要的是，机制尚未理顺。",
	"zh-mouzhong": "在某种程度上缓解了矛盾。",
	"zh-shuangren": "技术是把双刃剑。",
	"zh-beishou": "该议题备受关注。",
	"zh-bushiwei": "此举不失为稳妥选择。",
	"zh-rangwomen": "让我们共同努力。",
	"zh-zhenzheng": "真正重要的是执行。",
	"zh-placeholder": "[学校名称]于[日期]举办论坛，202X年X月X日在某市召开。临政办发〔2026〕 号",
	// core-en.
	"en-not-just-but": "It is not just a tool but a habit.",
	"en-not-about": "It's not about speed, it's about trust.",
	"en-isnt-just": "This isn't just a policy change, it's a reset.",
	"en-not-but": "The goal was not profit, but access.",
	"en-delve": "We delve into the data.",
	"en-tapestry": "A rich tapestry of voices.",
	"en-testament": "The result is a testament to hard work.",
	"en-worth-noting": "It is worth noting that prices rose.",
	"en-todays-world": "In today's digital world, data matters.",
	"en-landscape": "The ever-evolving landscape of finance.",
	"en-navigate": "We navigate the complexities of trade.",
	"en-embark": "We embark on a journey.",
	"en-in-conclusion": "In conclusion, the plan works.",
	"en-dive-in": "Let's dive in.",
	"en-game-changer": "This is a game-changer.",
	"en-unlock": "It will unlock the full potential of data.",
	"en-crucial-role": "Banks play a crucial role.",
	// gongwen-zh.
	"gw-raner": "然而，进展缓慢。",
	"gw-shouxian": "首先，要健全机制。",
	"gw-cong-dao": "从学习到落实仍需努力。",
	"gw-tongshi": "在发展经济的同时保护环境。",
	"gw-yiweizhe": "这意味着出口将承压。",
	"gw-jargon": "以数据要素赋能实体经济。",
	"gw-yiti": "转向算网一体的基础设施。",
	"gw-tezheng": "率先呈现泛在智联特征。",
};

/** Plain prose that must trip no pattern of any pack (false-positive guards). */
const GUARDS = [
	// Note marks, links and 某些 are no placeholders.
	"据统计[1]，见[报告全文](https://example.com/a)，某些地区仍有困难。",
	// 不 without a contrast frame.
	"该市不动产交易量持续上升。",
	// 而在 is not 而是/而在于.
	"各部门不分先后，而在实际推进中互相配合。",
	// 说到底 followed by 线.
	"坚守安全底线，说到底线管理要求上来。",
	// 与其他 is not 与其说.
	"与其他国家相比，我出口结构更均衡。",
	// 不仅……而且 is the normal register.
	"不仅数量多，而且覆盖面广。",
	// 重视 and 警惕 without the announcement frame.
	"各级要高度重视安全生产，务必警惕次生风险。",
	// 可以说明 is a compound.
	"该方案可以说明资金去向。",
	// 重要 without 更……的是.
	"落实责任尤为重要。",
	// 无疑似 and 并无疑义 compounds.
	"本周无疑似病例报告，各方对该条款并无疑义。",
	// Ordinary 一体.
	"一体推进标准制定与检测认证，各方利益融为一体。",
	// Numeric range.
	"从2020年到2025年持续推进。",
	// Clause break between 从 and 到.
	"从政策层面看，各项工作均已落实到位。",
	// The single — joining two Chinese words.
	"北京—上海高铁运行平稳。",
	// A contrast frame inside a direct quotation.
	"他说：“这不是终点，而是起点。”",
	// 首先 without the comma.
	"首先要明确目标。",
	// English: plain negation and plain role.
	"He did not attend the meeting. He played a role in the film.",
	// English: hyphenated terms, a numeric dash and inline code.
	"Wi-Fi and NB-IoT cover 2020—2025. Run `not x, but y` in the shell.",
	// English: landscape and journey in their literal sense.
	"The landscape painting sold. The journey took two days.",
];

describe("pattern packs", () => {
	it("every pattern has a hit example that it matches", () => {
		// Walk all packs.
		for (const [pack, patterns] of Object.entries(STYLE_PACKS))
			for (const p of patterns) {
				// Example for this id.
				const example = HIT_EXAMPLES[p.id];
				// Missing examples fail with the id.
				expect(example, `${pack}/${p.id} has no example`).toBeDefined();
				// The pattern's own hit is among the reported hits.
				expect(
					findHits(example, patterns).map((h) => h.id),
					`${p.id}: ${example}`,
				).toContain(p.id);
			}
	});
	it("ids are unique and every example belongs to a pattern", () => {
		// All ids.
		const ids = Object.values(STYLE_PACKS).flatMap((ps) => ps.map((p) => p.id));
		// No duplicates.
		expect(new Set(ids).size).toBe(ids.length);
		// No stale examples.
		for (const id of Object.keys(HIT_EXAMPLES)) expect(ids).toContain(id);
	});
	it("guard sentences trip no pattern of any pack", () => {
		// Every pattern.
		const all = Object.values(STYLE_PACKS).flat();
		// Each guard is clean.
		for (const text of GUARDS) expect(findHits(text, all), text).toEqual([]);
	});
	it("defaults are the two general packs", () => {
		// core-zh and core-en.
		expect(DEFAULT_PACKS).toEqual(["core-zh", "core-en"]);
	});
});

describe("maskText", () => {
	it("blanks code, URLs and quotations with the same length and keeps line breaks", () => {
		// Text with each kind.
		const text = "甲“引语”乙`code`丙 https://example.com/a 丁\n```\nx\n```";
		// Masked copy.
		const masked = maskText(text);
		// Same length and line breaks.
		expect(masked.length).toBe(text.length);
		// Same lines.
		expect(masked.split("\n").length).toBe(text.split("\n").length);
		// The prose characters stay.
		expect(masked.replace(/\s/g, "")).toBe("甲乙丙丁");
	});
});

describe("findHits", () => {
	it("reports positions with the original text and drops nested hits", () => {
		// 毫无疑问 contains no separate 无疑 hit because of the anchor; 不是……而是 on line 2.
		const hits = findHits("毫无疑问，任务艰巨。\n这不是终点，而是起点。", STYLE_PACKS["core-zh"]);
		// Two hits.
		expect(hits.map((h) => [h.id, h.line, h.column, h.matched])).toEqual([
			["zh-zhongsuo", 1, 1, "毫无疑问"],
			["zh-bushi-ershi", 2, 2, "不是终点，而是"],
		]);
	});
	it("keeps the outer hit when one pattern's match lies inside another's", () => {
		// 呈现……特征 contains the jargon word 泛在.
		const hits = findHits("率先呈现泛在智联特征。", STYLE_PACKS["gongwen-zh"]);
		// Only the outer frame.
		expect(hits.map((h) => h.id)).toEqual(["gw-tezheng"]);
	});
});

describe("negationDensity", () => {
	it("counts Chinese and English negative assertions per 10 sentences", () => {
		// 4 negations in 5 sentences.
		const n = negationDensity("这并不意味着失败。我们无法确定。难以评估。正常。It cannot work.");
		// Matches, density and the verdict.
		expect([n.count, n.sentences, n.per10, n.over]).toEqual([4, 5, 8, true]);
		// The longest form is matched once.
		expect(n.hits[0].matched).toBe("并不意味着");
	});
	it("leaves prohibitions and quotations out and needs two hits to fail", () => {
		// Prohibitions only.
		expect(negationDensity("不得截留资金。严禁挪用。禁止转借。You must not copy.").count).toBe(0);
		// A quoted negation.
		expect(negationDensity("他说：“我们不能等。”").count).toBe(0);
		// One hit in one sentence is 10 per 10 but not over.
		expect(negationDensity("我们无法确定。").over).toBe(false);
	});
	it("uses the given threshold and handles empty text", () => {
		// 2 in 10 sentences is 2 per 10.
		const text = `无法。不能。${"好。".repeat(8)}`;
		// Over a threshold of 1.
		expect(negationDensity(text, 1).over).toBe(true);
		// Within the default of 3.
		expect(negationDensity(text).over).toBe(false);
		// Empty text.
		expect(negationDensity("").per10).toBe(0);
	});
});

describe("structureStats", () => {
	it("flags list-heavy text and heavy bold", () => {
		// 4 list lines out of 6.
		const s = structureStats("甲\n- 一\n- 二\n1. 三\n2、四\n乙");
		// Counts and flags.
		expect([s.lines, s.listLines, s.listOver]).toEqual([6, 4, true]);
		// 2 bold spans in 8 characters.
		expect(structureStats("**甲**和**乙**").boldOver).toBe(true);
	});
	it("accepts paragraphs with little formatting", () => {
		// Plain paragraphs.
		const s = structureStats("第一段文字。\n\n第二段文字。");
		// Nothing flagged.
		expect([s.lines, s.listLines, s.bold, s.listOver, s.boldOver]).toEqual([2, 0, 0, false, false]);
	});
});

describe("styleCheck and styleClean", () => {
	it("applies the default packs and passes clean text", () => {
		// Plain text.
		const report = styleCheck("今年前三季度，全市工业增加值增长6.2%。");
		// Default packs, clean.
		expect(report.packs).toEqual(["core-zh", "core-en"]);
		// Nothing to fix.
		expect(styleClean(report)).toBe(true);
	});
	it("applies only the requested packs and rejects unknown names", () => {
		// 然而 is only in the 公文 pack.
		expect(styleCheck("然而，进展缓慢。").hits).toEqual([]);
		// With the pack.
		expect(styleCheck("然而，进展缓慢。", { packs: ["gongwen-zh"] }).hits.length).toBe(1);
		// Unknown pack.
		expect(() => styleCheck("甲", { packs: ["nope"] })).toThrow(/nope/);
	});
	it("is not clean when only the negation density is over", () => {
		// No pattern hit, many negations.
		const report = styleCheck("无法。不能。难以。");
		// Not clean.
		expect([report.hits.length, styleClean(report)]).toEqual([0, false]);
	});
});

describe("formatStyleReport", () => {
	it("writes a Chinese report with hits, negation positions and advice", () => {
		// Hits and negations.
		const text = formatStyleReport(styleCheck("综上所述，无法确定。难以评估。"), "zh");
		// Key lines.
		expect(text).toContain("逐处命中 1 处：");
		// Hit line.
		expect(text).toContain("- 第 1 行第 1 列〔套话〕综上所述");
		// Negation over the threshold, with positions.
		expect(text).toContain("超出阈值");
		// Position line.
		expect(text).toContain("- 第 1 行第 6 列：无法");
		// Advice.
		expect(text).toContain("请逐条判断，用 edit 只改需要改的片段");
	});
	it("writes an English report and a clean verdict", () => {
		// Clean English report.
		const text = formatStyleReport(styleCheck("Prices rose."), "en");
		// Heading and verdict.
		expect(text).toContain("AI-style check (packs: core-zh, core-en)");
		// Clean line.
		expect(text).toContain("Check passed: no hits.");
	});
	it("lists at most MAX_LISTED hits", () => {
		// More hits than the listing limit.
		const text = formatStyleReport(styleCheck("让我们。".repeat(MAX_LISTED + 5)), "zh");
		// The remainder line.
		expect(text).toContain("- 另有 5 处未列出");
	});
});

// The measures of the whole text, with limits from official documents of 2011-2021 against generated drafts.
describe("inferRegister", () => {
	it("takes a report by its title, and anything else as general prose", () => {
		expect(inferRegister("# 关于某区课后服务开展情况的调研报告\n正文")).toBe("report");
		expect(inferRegister("\n\n2025年工作总结\n正文")).toBe("report");
		expect(inferRegister("# Survey of reading habits")).toBe("report");
		expect(inferRegister("# 故乡的秋天\n正文")).toBe("general");
		// Official documents by their kind at the end of the title.
		expect(inferRegister("# 临江市人民政府办公室关于做好2026年全市防汛抗洪救灾工作的通知\n正文")).toBe("official");
		expect(inferRegister("《关于推进全域旅游发展的实施方案》")).toBe("official");
		// A kind word inside a title is not the kind of the text.
		expect(inferRegister("# 通知送达以后")).toBe("general");
	});
});

// Sentences of very different lengths, as people write them.
const varied =
	"他走了。调研组走访了3个乡镇、11个行政村，召开座谈会4场，收回问卷286份。老人们说饭是热的。助餐点每月补贴2万元，人手只有2名，都没有护理证书，冬天天黑得早，晚饭多半在家里随便对付。".repeat(
		3,
	);

// proseStats, with per1000 giving its densities.
describe("proseStats", () => {
	it("finds sentences cut to one size, and not sentences of mixed lengths", () => {
		expect(proseStats("今天天气很好。".repeat(12)).spreadLow).toBe(true);
		expect(proseStats(varied).spreadLow).toBe(false);
		// Fewer than 10 sentences are not judged.
		expect(proseStats("今天天气很好。".repeat(5)).spreadLow).toBe(false);
	});

	it("finds vague words standing in for facts", () => {
		const vague = "部分村庄的服务逐步改善，一些设施有所增加，工作不断推进，能力进一步提升，取得一定成效。".repeat(8);
		expect(proseStats(vague).vagueOver).toBe(true);
		expect(proseStats(varied).vagueOver).toBe(false);
	});

	it("asks a report, and only a report, for facts", () => {
		const empty = "这项工作得到了推进，大家都很满意，也提出了意见和建议，下一步还要继续做好。".repeat(20);
		expect(proseStats(empty, "report").factsLow).toBe(true);
		expect(proseStats(empty, "general").factsLow).toBe(false);
		expect(proseStats(varied.repeat(3), "report").factsLow).toBe(false);
	});

	it("counts dashes by density, so a few are fine", () => {
		expect(proseStats(`东部领先——中西部追赶。${"正文内容很长。".repeat(60)}`).dashOver).toBe(false);
		expect(proseStats("甲——乙——丙——丁——戊——己。".repeat(20)).dashOver).toBe(true);
	});

	it("leaves headings and code out", () => {
		const s = proseStats("# 标题——副题\n\n```\n——\n```\n正文。");
		expect([s.dashPer1000, s.sentences]).toEqual([0, 1]);
	});
});

// weakStock marks the packs that zhp and enp build; makeHit builds each hit, and findHits keeps the mark on it.
describe("weak signs", () => {
	it("marks stock phrases and the 公文 pack as weak, and contrast frames as strong", () => {
		const weak = (id: string) =>
			Object.values(STYLE_PACKS)
				.flat()
				.find((p) => p.id === id)?.weak === true;
		expect([
			weak("zh-zongshang"),
			weak("en-delve"),
			weak("gw-raner"),
			weak("zh-bushi-ershi"),
			weak("en-not-but"),
		]).toEqual([true, true, true, false, false]);
	});

	it("allows a reasonable amount and stops a pile of them", () => {
		const long = varied.repeat(4);
		// One in a long text: listed, and clean.
		const one = styleCheck(`综上所述，${long}`);
		expect([one.hits.length, one.hits[0].weak, styleClean(one)]).toEqual([1, true, true]);
		// Over WEAK_PER_1000: not clean.
		const pile = styleCheck("综上所述，值得一提的是，总而言之，让我们努力。不难看出，形势向好。");
		expect(pile.prose.weakPer1000).toBeGreaterThan(WEAK_PER_1000);
		expect(styleClean(pile)).toBe(false);
		// A strong sign counts at once.
		expect(styleClean(styleCheck(`${long}这不是问题，而是机会。`))).toBe(false);
	});
});

describe("zh-denial: 不再是", () => {
	it("finds the no-longer move, and leaves 不再 with other verbs alone", () => {
		const ids = (text: string) => styleCheck(text).hits.map((h) => h.id);
		// The sentence a 2026-11-08 draft passed with.
		expect(ids("技术也不再是挡在普通人面前的障碍。")).toContain("zh-denial");
		expect(ids("该平台不再局限于文字内容。")).toContain("zh-denial");
		expect(ids("该办法自2026年1月1日起不再执行。")).not.toContain("zh-denial");
	});
});

describe("inferRegister: numbered headings", () => {
	it("reads 一、 and （一） headings as a document when the title names no kind", () => {
		expect(inferRegister("# AI发展对舆论引导的风险挑战及对策建议\n\n## 一、主要风险\n\n正文")).toBe("report");
		// One section written alone.
		expect(inferRegister("### （一）伪造内容成本骤降\n\n正文")).toBe("report");
		// An official title still wins, and plain prose stays general.
		expect(inferRegister("# 关于开展安全检查的通知\n\n## 一、检查范围")).toBe("official");
		expect(inferRegister("# 春天的早晨\n\n## 第一章\n\n正文")).toBe("general");
	});
});
