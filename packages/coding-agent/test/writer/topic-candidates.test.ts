// The addresses a material_add item with no source is offered: the topic's search results, newest first.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { candidatesText, joinFragments, salvageSource, sourceItems } from "../../src/extensions/writer-topic/index.ts";
import { candidateSources } from "../../src/writer/topic/topic.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jw-cand-"));
	vi.stubEnv("JW_LANG", "zh");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("candidateSources", () => {
	it("lists the search results' addresses with their titles and dates, newest search first, without repeats", () => {
		mkdirSync(join(dir, "检索"));
		writeFileSync(
			join(dir, "检索", "001-政策.md"),
			"# 政策\n\n检索结果（deepseek，2 条）：政策\n1. 低空经济飞得稳\n   https://a.example/1（2026-04-22）\n   摘要\n2. 无日期的一条\n   https://a.example/2\n   摘要\n",
		);
		writeFileSync(
			join(dir, "检索", "002-案例.md"),
			"# 案例\n\n1. 云南红河配送\n   https://b.example/9（2026-11-01）\n   摘要\n",
		);
		writeFileSync(
			join(dir, ".index.jsonl"),
			`${JSON.stringify({ n: 1, kind: "search", file: "检索/001-政策.md", title: "政策", urls: ["https://a.example/1", "https://a.example/2"] })}\n` +
				`${JSON.stringify({ n: 2, kind: "search", file: "检索/002-案例.md", title: "案例", urls: ["https://b.example/9", "https://a.example/1"] })}\n`,
		);
		expect(candidateSources(dir)).toEqual([
			{ url: "https://b.example/9", title: "云南红河配送", date: "2026-11-01" },
			{ url: "https://a.example/1", title: "低空经济飞得稳", date: "2026-04-22" },
			{ url: "https://a.example/2", title: "无日期的一条", date: "" },
		]);
		expect(candidateSources(dir, 1)).toHaveLength(1);
		expect(candidateSources(join(dir, "none"))).toEqual([]);
	});
	it("is written as lines the model can copy, or nothing when there are none", () => {
		expect(candidatesText([])).toBe("");
		const text = candidatesText([{ url: "https://b.example/9", title: "云南红河配送", date: "2026-11-01" }]);
		expect(text.startsWith("可选来源")).toBe(true);
		expect(text).toContain("- https://b.example/9 云南红河配送（2026-11-01）");
	});
});

describe("salvageSource", () => {
	it("takes the address from an alias key or out of the focus text, and leaves a sourced item alone", () => {
		expect(salvageSource({ url: "https://a.example/1", focus: "x" })).toEqual({
			url: "https://a.example/1",
			focus: "x",
		});
		expect(salvageSource({ file: "报告.pdf", page: "3" })).toEqual({ file: "报告.pdf", page: "3" });
		expect(salvageSource({ link: "https://a.example/2", focus: "x" } as never)).toMatchObject({
			url: "https://a.example/2",
		});
		expect(salvageSource({ 来源: " https://a.example/3 " } as never)).toMatchObject({ url: "https://a.example/3" });
		expect(salvageSource({ section: "现状", focus: "民航法修订，见 https://a.example/4）：施行日期" })).toEqual({
			section: "现状",
			url: "https://a.example/4",
			focus: "民航法修订，见 ）：施行日期",
		});
		// A candidate line copied whole, date and all (2026-11-16: a run pasted "url（2026-01-07）" into focus).
		expect(salvageSource({ focus: "https://a.example/7（2026-01-07） 我国低空经济的挑战" })).toEqual({
			url: "https://a.example/7",
			focus: "（2026-01-07） 我国低空经济的挑战",
		});
		expect(salvageSource({ focus: "没有地址" })).toEqual({ focus: "没有地址" });
		expect(sourceItems([{ focus: "见 https://a.example/5" }, "https://a.example/6"])).toEqual([
			{ url: "https://a.example/5", focus: "见" },
			{ url: "https://a.example/6" },
		]);
	});
});

describe("joinFragments and the string items", () => {
	it("joins the pieces of one JSON text into items, and reads a key-and-value piece or a bare address on its own", () => {
		// The shape GLM sent fourteen times on 2026-11-16: a list split at its commas, with escaped quotes.
		const pieces = [
			'[{"}',
			'{"focus": "地方做法", "section": "一、发展现状"',
			'\\"url\\": \\"https://a.example/1\\"',
			'\\"section\\": \\"一、发展现状\\"}]',
		];
		expect(sourceItems(pieces)).toEqual([{ focus: "地方做法", section: "一、发展现状", url: "https://a.example/1" }]);
		expect(sourceItems(['"url": "https://a.example/2"'])).toEqual([{ url: "https://a.example/2" }]);
		expect(sourceItems(["见 https://a.example/3（2026-01-01）"])).toEqual([{ url: "https://a.example/3" }]);
		expect(sourceItems(["https://a.example/4", { url: "https://a.example/5" }])).toEqual(
			[{ url: "https://a.example/5" }, { url: "https://a.example/4" }]
				.sort((x, y) => x.url.localeCompare(y.url))
				.sort(() => 0) as never,
		);
		expect(joinFragments(["not json", "either"])).toEqual(["not json", "either"]);
	});
});
