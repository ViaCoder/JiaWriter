// Unit tests for src/writer/export/profile.ts.

// Files.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Functions under test.
import { DEFAULT_ZH, loadProfile, mergeProfile } from "../../src/writer/export/profile.ts";

// Working folder and agent folder.
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-profile-"));
	vi.stubEnv("JW_LANG", "zh");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("DEFAULT_ZH", () => {
	it("holds the user's fonts, sizes and line spacing and the GB/T 9704 page", () => {
		// Fonts per level.
		const L = DEFAULT_ZH.levels;
		expect([L.title.eastAsia, L.h1.eastAsia, L.h2.eastAsia, L.h3.eastAsia, L.body.eastAsia]).toEqual([
			"方正小标宋简体",
			"黑体",
			"楷体_GB2312",
			"黑体",
			"方正仿宋_GBK",
		]);
		expect(Object.values(L).every((l) => l.latin === "Times New Roman")).toBe(true);
		// 二号 title, 小二 elsewhere, 32 pt.
		expect([L.title.sizePt, L.h1.sizePt, L.body.sizePt, DEFAULT_ZH.lineSpacingPt]).toEqual([22, 18, 18, 32]);
		expect(DEFAULT_ZH.page).toEqual({
			widthMm: 210,
			heightMm: 297,
			topMm: 37,
			bottomMm: 35,
			leftMm: 28,
			rightMm: 26,
		});
	});
});

describe("mergeProfile", () => {
	it("replaces fields of the same type and reports unknown or bad fields", () => {
		// One good and three bad fields.
		const problems: string[] = [];
		const merged = mergeProfile(
			DEFAULT_ZH,
			{ lineSpacingPt: 28, levels: { body: { sizePt: -1, align: "middle", indentChars: 0 } }, extra: 1 },
			"",
			problems,
		) as typeof DEFAULT_ZH;
		expect([
			merged.lineSpacingPt,
			merged.levels.body.sizePt,
			merged.levels.body.align,
			merged.levels.body.indentChars,
		]).toEqual([28, 18, "both", 0]);
		expect(problems.sort()).toEqual(["extra", "levels.body.align", "levels.body.sizePt"]);
		// A non-object where an object belongs.
		const p2: string[] = [];
		mergeProfile(DEFAULT_ZH, { page: 5 }, "", p2);
		expect(p2).toEqual(["page"]);
	});
});

describe("loadProfile", () => {
	it("returns the default, reads JSON by path or by name, and refuses missing or bad files", () => {
		// Default.
		expect(loadProfile(undefined, dir, dir)).toBe(DEFAULT_ZH);
		expect(loadProfile("default-zh", dir, dir)).toBe(DEFAULT_ZH);
		// By path (named after the file) and by name in <agentDir>/profiles.
		writeFileSync(join(dir, "mine.json"), JSON.stringify({ lineSpacingPt: 30 }));
		expect([loadProfile("mine.json", dir, dir).lineSpacingPt, loadProfile("mine.json", dir, dir).name]).toEqual([
			30,
			"mine.json",
		]);
		mkdirSync(join(dir, "profiles"));
		writeFileSync(join(dir, "profiles", "apa.json"), JSON.stringify({ name: "APA", punct: false }));
		expect([loadProfile("apa", dir, dir).name, loadProfile("apa", dir, dir).punct]).toEqual(["APA", false]);
		// Missing, unparsable, bad field.
		expect(() => loadProfile("nope", dir, dir)).toThrow(/找不到排版方案「nope」/);
		writeFileSync(join(dir, "broken.json"), "{");
		expect(() => loadProfile("broken.json", dir, dir)).toThrow(/broken\.json 有误/);
		writeFileSync(join(dir, "bad.json"), JSON.stringify({ lineSpacingPt: "32" }));
		expect(() => loadProfile("bad.json", dir, dir)).toThrow(/有误：lineSpacingPt/);
	});
});
