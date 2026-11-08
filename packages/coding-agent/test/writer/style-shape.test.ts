// The shape of analysis paragraphs (src/writer/style/shape.ts): general sentences first, then the case or data.
import { describe, expect, it } from "vitest";
import { evidenceFirst, repeatedFigures, unsupportedAnalysis } from "../../src/writer/style/shape.ts";

describe("evidenceFirst", () => {
	it("passes a paragraph that states its point before its evidence", () => {
		const good =
			"禁捕退捕扎实推进，渔民转产就业总体平稳。累计退捕渔船11万艘、渔民22.8万人，拨付中央补助资金130亿元。";
		expect(evidenceFirst(good)).toEqual([]);
	});
	it("finds a paragraph that opens with figures, a dated event or a cited title", () => {
		const text = [
			"2020年，长江流域水质优良断面比例为96.7%。水环境质量持续改善。",
			"2026年11月7日《路透社》报道，俄方代表团将参加谈判。谈判前景仍不明朗。",
		].join("\n\n");
		expect(evidenceFirst(text)).toEqual([
			"2020年，长江流域水质优良断面比例为96.7%。",
			"2026年11月7日《路透社》报道，俄方代表团将参加谈判。",
		]);
	});
	it("leaves headings, lists, single statements and general prose alone", () => {
		const text = [
			"## 一、2020年主要成效",
			"- 退捕渔船11万艘。",
			"退捕渔船11万艘。",
			"保护修复任重道远。水生态问题仍然是流域最主要的问题。",
		].join("\n\n");
		expect(evidenceFirst(text)).toEqual([]);
	});
});

describe("unsupportedAnalysis", () => {
	it("finds problem and risk paragraphs without any case or figure, and only there", () => {
		const text = [
			"## 一、主要成效",
			"机制逐步完善。各部门配合更加顺畅。",
			"## 二、存在的问题",
			"（一）法律实施尚未完全到位。区域联动、联合执法等机制有待完善。",
			"（二）整改任务依然繁重。警示片披露的484个问题中尚有166个未完成整改。",
			"调研梳理的问题集中在四个方面。",
		].join("\n\n");
		expect(unsupportedAnalysis(text)).toEqual(["（一）法律实施尚未完全到位。"]);
	});
});

describe("repeatedFigures", () => {
	it("finds a figure used in two paragraphs, and ignores small counts, one paragraph and headings", () => {
		const text = [
			"## 一、成效",
			"共发现入河排污口60292个，退捕渔船11万艘。",
			"## 二、问题",
			"排查发现的60292个排污口整治难度大。走访了3个乡镇。",
			"另走访了3个乡镇，水质优良比例96.7%，较上年的96.7%持平。",
		].join("\n\n");
		expect(repeatedFigures(text)).toEqual(["60292个"]);
	});
});
