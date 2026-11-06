// Tests for the 公文 self-check port (src/writer/gongwen/check.ts), the writer-gongwen extension and the
// bundled lieflat-gongwen skill. fixtures/gongwen-python.json holds what the original check_params.py
// (lieflat-gongwen commit 24147448) measured on the skill's 29 sample files.

// Files.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { dirname, join, resolve } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Built-in skills folder.
import { getWriterSkillsDir } from "../../src/config.ts";
// Extension API types.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
// Extension under test.
import writerGongwenExtension from "../../src/extensions/writer-gongwen/index.ts";
// Functions under test.
import {
	analyze,
	formatMatch,
	formatReport,
	hardFails,
	looseColons,
	type Metrics,
	matchGenre,
	measuredLine,
	pyRound,
	sectionWeights,
} from "../../src/writer/gongwen/check.ts";
// Skill listing.
import { listSkills, readSkillInfo } from "../../src/writer/skills/manage.ts";

/** The bundled Chinese skill. */
const SKILL = join(getWriterSkillsDir(), "zh", "lieflat-gongwen");

/** One row of the Python parity data. */
type PyRow = Omit<Metrics, "plain"> & { match: [string, number][]; fails?: number; genre?: string };

/** Python measurements by sample path. */
const PY = JSON.parse(readFileSync(join(__dirname, "fixtures", "gongwen-python.json"), "utf-8")) as Record<
	string,
	PyRow
>;

/** Metrics of a text that must parse. */
function metrics(text: string): Metrics {
	// analyze returns null only for empty text.
	const a = analyze(text);
	if (!a) throw new Error("no text");
	return a;
}

/** A 公文族 body of about n characters made of one repeated sentence. */
function filler(n: number): string {
	// 25 characters per sentence.
	const s = "全市各部门围绕重点任务推进各项工作并取得进展。";
	return s.repeat(Math.ceil(n / s.length));
}

describe("pyRound", () => {
	it("rounds like Python round, ties to even only on exact halves", () => {
		// Exact halves of the binary value.
		expect(pyRound(12.25, 1)).toBe(12.2);
		expect(pyRound(12.75, 1)).toBe(12.8);
		expect(pyRound(2.5)).toBe(2);
		expect(pyRound(3.5)).toBe(4);
		// 0.35 is stored just below the half, so it rounds down as in Python.
		expect(pyRound(0.35, 1)).toBe(0.3);
		// Ordinary values.
		expect(pyRound(45.04, 1)).toBe(45);
		expect(pyRound(155.6)).toBe(156);
	});
});

describe("sectionWeights", () => {
	it("splits at level-1 headings and counts each heading in its own section", () => {
		// Lead 4 characters, then two sections.
		const s = sectionWeights(["导语四字", "一、第一部分", "正文正文", "**二、第二部分", "正文"]);
		expect(s.map(([name]) => name)).toEqual(["导语", "一、第一部分", "二、第二部分"]);
		expect(s.map(([, n]) => n)).toEqual([4, 10, 10]);
		expect(s.map(([, , pct]) => pct)).toEqual([16.7, 41.7, 41.7]);
	});
});

describe("analyze", () => {
	it("returns null for empty text", () => {
		// Only blank lines and a table row.
		expect(analyze("\n  \n| a | b |\n")).toBeNull();
	});

	it("counts headings, 一是, 顿号, force words, percentages, quotes and dashes", () => {
		// A small draft with one of everything.
		const a = metrics(
			[
				"# 关于某项工作的报告",
				"## 一、基本情况",
				"（一）进展。一是推进甲、乙、丙；二是必须确保落实，不得不说要切实做好。",
				"1．完成 15% 的任务，【待补：20%】不计。",
				"群众说“这个办法好用”，干部讲“我们把服务送到了家门口这件事做实了”——效果明显。",
				"> 引用块不计",
			].join("\n"),
		);
		expect(a.h1).toBe(1);
		expect(a.h1_titles).toEqual(["基本情况"]);
		expect(a.h2).toBe(1);
		expect(a.h3).toBe(1);
		expect(a.yishi).toBe(2);
		// 必须 counts; 不得不 does not.
		expect(a.qz).toBe(1);
		// 确保, 要, 切实.
		expect(a.yq).toBe(3);
		expect(a.pct).toBe(1);
		expect(a.quote).toBe(1);
		expect(a.dash).toBe(1);
		expect(a.ascii_quote).toBe(0);
		expect(a.plain).not.toContain("引用块");
	});

	it("matches check_params.py on all 29 sample files", () => {
		// Every sample measured by Python.
		expect(Object.keys(PY)).toHaveLength(29);
		for (const [rel, py] of Object.entries(PY)) {
			const a = metrics(readFileSync(join(SKILL, rel), "utf-8"));
			const { match, fails, genre, ...pyMetrics } = py;
			// Same measurements (plain is not in the Python data; toEqual skips undefined fields).
			expect({ ...a, plain: undefined }, rel).toEqual(pyMetrics);
			// Same genre ranking and distances.
			const ranked = matchGenre(a);
			expect(
				ranked.map(([g]) => g),
				rel,
			).toEqual(match.map(([g]) => g));
			for (const [i, [, d]] of ranked.entries()) expect(d, rel).toBeCloseTo(match[i][1], 6);
			// Same hard-conflict count for the genre in the file name.
			if (genre) expect(hardFails(a, genre).length, rel).toBe(fails);
		}
	});
});

describe("hardFails", () => {
	it("flags a wrong genre and passes a fitting one", () => {
		// Speech with a level-3 heading.
		const speech = metrics(`${filler(3000)}\n1．第一点\n`);
		expect(hardFails(speech, "领导讲话").map((r) => r.key)).toEqual(["h3"]);
		// The same text as a plan has no hard conflict.
		expect(hardFails(speech, "工作方案")).toEqual([]);
		// 经验总结 never uses percentages.
		expect(hardFails(metrics(`${filler(2500)}增长 5%。`), "经验总结").map((r) => r.key)).toEqual(["pct"]);
		// Too short for the 公文族.
		expect(hardFails(metrics(filler(600)), "调研报告").map((r) => r.key)).toEqual(["chars"]);
		// Short piece with two level-1 headings.
		const short = metrics(`一、做法之一\n${filler(500)}\n二、做法之二\n${filler(500)}`);
		expect(hardFails(short, "短经验材料").map((r) => r.key)).toEqual(["h1"]);
	});
});

describe("matchGenre", () => {
	it("ranks a thousand-character piece without headings as 短经验材料", () => {
		// About 1100 characters, no headings.
		expect(matchGenre(metrics(filler(1100)))[0][0]).toBe("短经验材料");
	});
});

describe("looseColons", () => {
	it("keeps colons after speech, addressees and headings and reports the others", () => {
		// One loose colon among allowed ones.
		const found = looseColons("他说：好。各县人民政府：现将有关事项通知如下。一、目标：明确。办法是：先试点。");
		expect(found).toHaveLength(1);
		expect(found[0]).toContain("办法是：");
	});
});

describe("measuredLine and formatMatch", () => {
	it("prints the measurements and the ranking with the nearest genre marked", () => {
		// A short piece.
		const a = metrics(filler(1100));
		expect(measuredLine(a)).toMatch(/^实测：\d+字 句长[\d.]+ 一级0/);
		const text = formatMatch(a);
		expect(text).toContain("★ 短经验材料");
		expect(text.split("\n").filter((l) => /距离 \d/.test(l))).toHaveLength(7);
	});
});

describe("formatReport", () => {
	it("reports hard conflicts, punctuation, words to avoid, the quota and the family", () => {
		// A short text declared as a speech, with every kind of problem.
		const text = `一、总体要求\n他指出，必须、必须、必须、应当做好——这项——工作。办法是：先试点。说到底，我认为要尽快办，"效果"很好。\n1．第一点\n${filler(600)}`;
		const { text: report, fails } = formatReport(metrics(text), "领导讲话");
		expect(fails).toBe(2);
		expect(report).toContain("✗ 领导讲话不用三级标题");
		expect(report).toContain("✗ 公文族篇幅不应低于 1200 字");
		expect(report).toContain("正文破折号 2 个");
		expect(report).toContain("非引语冒号 1 处");
		expect(report).toContain("元评论词 1 处（说到底）");
		expect(report).toContain("“我认为”");
		expect(report).toContain("“尽快”");
		expect(report).toContain("强制词超配额（4 > 3）");
		expect(report).toContain("ASCII 直角引号");
		expect(report).toContain("【结构习惯提示】");
		expect(report).toContain("【重心分布】");
	});

	it("flags a draft whose parameters belong to the other family", () => {
		// A thousand characters without headings declared as a research report.
		const { text } = formatReport(metrics(filler(1100)), "调研报告");
		expect(text).toContain("【文体族检查】");
		expect(text).toContain("但参数上更像「短经验材料」（党建族）");
	});

	it("passes a sample of the declared genre", () => {
		// A bundled sample speech.
		const a = metrics(readFileSync(join(SKILL, "示例", "领导讲话_全市安全生产工作会议上的讲话.md"), "utf-8"));
		const { text, fails } = formatReport(a, "领导讲话");
		expect(fails).toBe(0);
		expect(text).toContain("✓ 通过（2 项）");
		expect(text).toContain("平均句长 |");
	});
});

describe("writer-gongwen extension", () => {
	// Working directory of each test.
	let cwd = "";
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "wa-gongwen-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	/** The registered tool. */
	function tool(): ToolDefinition {
		// Fake API with only registerTool.
		let found: ToolDefinition | undefined;
		writerGongwenExtension({
			registerTool: (t: ToolDefinition) => {
				found = t;
			},
		} as unknown as ExtensionAPI);
		if (!found) throw new Error("not registered");
		return found;
	}

	/** Text of a tool run. */
	async function run(params: Record<string, unknown>): Promise<string> {
		// Minimal context: only cwd is used.
		const result = await tool().execute("call-1", params, undefined, undefined, { cwd } as ExtensionToolContext);
		const first = result.content[0];
		return first?.type === "text" ? first.text : "";
	}

	it("registers gongwen_check with a guideline", () => {
		// Name and rule.
		const t = tool();
		expect(t.name).toBe("gongwen_check");
		expect(t.description).toContain("公文");
	});

	it("checks a draft file for a genre and ranks the genres without one", async () => {
		// A draft in the working directory.
		writeFileSync(join(cwd, "稿件.md"), filler(1100));
		expect(await run({ path: "稿件.md", genre: "短经验材料" })).toContain("✓ 通过");
		expect(await run({ path: "稿件.md" })).toContain("★ 短经验材料");
		expect(await run({ text: filler(1100), genre: " " })).toContain("参数向量匹配结果");
	});

	it("explains statutory genres and rejects unknown genres and empty text", async () => {
		// Errors are thrown with Chinese messages.
		await expect(run({ text: filler(800), genre: "通知" })).rejects.toThrow("属法定公文");
		await expect(run({ text: filler(800), genre: "网评" })).rejects.toThrow("未知文体：网评");
		await expect(run({ text: "\n\n" })).rejects.toThrow("文件为空");
	});
});

describe("bundled lieflat-gongwen skill", () => {
	it("ships with its license and the JiaWriter adaptation", () => {
		// Name and license.
		expect(readSkillInfo(SKILL).name).toBe("lieflat-gongwen");
		expect(readFileSync(join(SKILL, "LICENSE"), "utf-8")).toContain("PolyForm Noncommercial License 1.0.0");
		const md = readFileSync(join(SKILL, "SKILL.md"), "utf-8");
		// The adaptation section, the tool instead of Python, no placeholder rule.
		expect(md).toContain("## 在 JiaWriter 里使用");
		expect(md).toContain("调用 `gongwen_check` 工具");
		expect(md).not.toContain("python3 scripts/check_params.py");
		expect(md).not.toContain("宁可占位");
		// Every file the reference table names exists.
		for (const f of [
			"参数卡.md",
			"标题技法库.md",
			"句子对照库.md",
			"公文语料/文章结构模板.md",
			"党建语料/党建DNA.md",
		]) {
			expect(existsSync(join(SKILL, f)), f).toBe(true);
		}
	});

	it("is listed in both languages and the English entry points to the Chinese folder", () => {
		// Both built-in folders list it.
		const agentDir = mkdtempSync(join(tmpdir(), "wa-gongwen-agent-"));
		for (const lang of ["zh", "en"]) {
			expect(listSkills(agentDir, join(getWriterSkillsDir(), lang)).map((s) => s.name)).toContain("lieflat-gongwen");
		}
		rmSync(agentDir, { recursive: true, force: true });
		// The relative path in the English entry resolves to the Chinese SKILL.md.
		const en = join(getWriterSkillsDir(), "en", "lieflat-gongwen", "SKILL.md");
		const rel = readFileSync(en, "utf-8").match(/`(\.\.\/\.\.\/zh\/lieflat-gongwen\/SKILL\.md)`/)?.[1] ?? "";
		expect(resolve(dirname(en), rel)).toBe(join(SKILL, "SKILL.md"));
	});
});
