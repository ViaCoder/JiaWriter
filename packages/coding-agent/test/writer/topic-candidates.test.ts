// The addresses a material_add item with no source is offered: the topic's search results, newest first.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { candidatesText } from "../../src/extensions/writer-topic/index.ts";
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
