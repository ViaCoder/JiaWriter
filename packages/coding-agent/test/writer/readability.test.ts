// Unit tests for src/writer/readability.ts and the generated character table.

// Test API.
import { describe, expect, it } from "vitest";
// Generated table.
import { TGH_LEVEL1, TGH_LEVEL2, TGH_LEVEL3 } from "../../src/writer/data/tgh-chars.ts";
// Functions under test.
import {
	charLevel,
	countSyllables,
	englishReadability,
	formatReadability,
	longSentences,
	rareChars,
	readabilityCheck,
} from "../../src/writer/readability.ts";

describe("character table", () => {
	it("has 3500, 3000 and 1605 distinct characters in table order", () => {
		// Sizes of the three levels.
		expect([[...TGH_LEVEL1].length, [...TGH_LEVEL2].length, [...TGH_LEVEL3].length]).toEqual([3500, 3000, 1605]);
		// No character appears twice.
		expect(new Set([...TGH_LEVEL1, ...TGH_LEVEL2, ...TGH_LEVEL3]).size).toBe(8105);
		// The table starts with 一乙二十丁.
		expect(TGH_LEVEL1.slice(0, 5)).toBe("一乙二十丁");
	});
});

describe("charLevel", () => {
	it("returns the level of a character, 0 outside the table", () => {
		// Common, level 2, level 3 and a traditional form outside the table.
		expect(["的", "耄", "镕", "國"].map(charLevel)).toEqual([1, 2, 3, 0]);
	});
});

describe("rareChars", () => {
	it("lists characters outside level 1 with counts and first lines", () => {
		// 饕 twice, 镕 once on line 2.
		const rare = rareChars("饕餮之徒\n朱镕基与饕客");
		// Most frequent first.
		expect(rare.map((r) => [r.char, r.level, r.count, r.line])).toEqual([
			["饕", 2, 2, 1],
			["餮", 2, 1, 1],
			["镕", 3, 1, 2],
		]);
	});
	it("returns nothing for common text", () => {
		// Only level-1 characters.
		expect(rareChars("今天天气很好。")).toEqual([]);
	});
});

describe("longSentences", () => {
	it("reports sentences over the limit with their line and head", () => {
		// One short and one 25-character sentence.
		const long = longSentences(`短句。\n${"长".repeat(25)}。`, 20);
		// One result.
		expect(long).toEqual([{ line: 2, length: 25, head: "长".repeat(20) }]);
	});
});

describe("countSyllables", () => {
	it("estimates syllables of common words", () => {
		// Expected counts.
		const cases: [string, number][] = [
			["the", 1],
			["make", 1],
			["table", 2],
			["needed", 2],
			["used", 1],
			["reading", 2],
			["information", 4],
			["", 0],
		];
		// Each word.
		for (const [word, n] of cases) expect(countSyllables(word), word).toBe(n);
	});
});

describe("englishReadability", () => {
	it("computes Flesch reading ease and long words", () => {
		// Two short sentences.
		const e = englishReadability("The cat sat on the mat. The dog ran.");
		// 9 words, 2 sentences, 9 syllables: 206.835 - 1.015*4.5 - 84.6*1 = 117.7.
		expect(e).toEqual({ words: 9, sentences: 2, syllables: 9, flesch: 117.7, longWords: 0 });
	});
	it("returns undefined without English words", () => {
		// Chinese only.
		expect(englishReadability("中文。")).toBeUndefined();
	});
});

describe("readabilityCheck and formatReadability", () => {
	it("skips code and quotations and reports the findings in Chinese", () => {
		// A rare character in prose, one in a quotation and one in code.
		const report = readabilityCheck("耄耋老人。“饕餮”\n`镕`", 60);
		// Only the prose ones.
		expect(report.rare.map((r) => r.char)).toEqual(["耄", "耋"]);
		// Chinese text.
		const text = formatReadability(report, "zh");
		// Summary and item lines.
		expect(text).toContain("一级字以外的 2 个（2 种）");
		// Item.
		expect(text).toContain("- 「耄」二级字，出现 1 次，首次在第 1 行");
		// Advice.
		expect(text).toContain("长句拆成短句");
	});
	it("reports a clean English result", () => {
		// Plain English.
		const text = formatReadability(readabilityCheck("The cat sat on the mat."), "en");
		// English summary and verdict.
		expect(text).toContain("6 English words in 1 sentences");
		// Verdict.
		expect(text).toContain("Check passed: no rare characters or long sentences.");
	});
});
