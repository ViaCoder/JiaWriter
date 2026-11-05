// Unit tests for src/writer/export/export.ts.

// Files.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Functions under test.
import { defaultOutput, exportDraft, formatExport } from "../../src/writer/export/export.ts";

// Working folder.
let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "wa-export-"));
	vi.stubEnv("JW_LANG", "zh");
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

// A draft with ASCII punctuation, an unpaired quote and a 待核实 mark.
const DRAFT = '# 报告\n\n## 一、背景\n\n支持 5G, Wi-Fi 和 NB-IoT.\n\n他说"开始\n\n数据待核实.\n';

describe("defaultOutput", () => {
	it("names the output after the draft", () => {
		// .docx and .export.md.
		const draft = join("/w", "稿件.md");
		expect([defaultOutput(draft, "docx"), defaultOutput(draft, "md")]).toEqual([
			join("/w", "稿件.docx"),
			join("/w", "稿件.export.md"),
		]);
	});
});

describe("exportDraft / formatExport", () => {
	it("writes a checked .docx and reports punctuation, the unpaired quote and 待核实", async () => {
		// Export.
		const draft = join(cwd, "稿件.md");
		writeFileSync(draft, DRAFT);
		const r = await exportDraft(draft, cwd, cwd);
		expect([r.out, r.format, r.profile, r.punct, r.unpaired, r.pendingMarks, r.asciiNextToHan]).toEqual([
			"稿件.docx",
			"docx",
			"default-zh",
			true,
			["他说“开始"],
			1,
			0,
		]);
		expect([r.audit?.missingHint, r.audit?.unpairedQuotes, existsSync(join(cwd, "稿件.docx"))]).toEqual([0, 1, true]);
		// Report lines.
		expect(formatExport(r).split("\n")).toEqual([
			"已导出：稿件.docx（docx，排版方案 default-zh）",
			`检查：含中文的文字段 ${r.audit?.chineseRuns} 个，缺 eastAsia 提示 0 个，缺中文字体 0 个；字号 18/22 磅；固定行距 32 磅。`,
			"标点：已统一为中文标点；紧邻汉字的英文标点 0 处，引号未配对的段落 1 个。",
			"- 引号未配对：他说“开始……",
			"空格：只保留英文单词之间的空格，汉字与英文、数字之间不留空格；不合规的空格 0 处。",
			"稿件中有 1 处“待核实”，成稿里应删去或补上来源。",
		]);
	});
	it("writes Markdown with Chinese punctuation to a chosen path, and can skip the pass", async () => {
		// Markdown export to out/定稿.md.
		const draft = join(cwd, "a.md");
		writeFileSync(draft, "## 标题\n\n支持 5G, Wi-Fi.\n\n```\nf(a, b)\n```\n");
		const r = await exportDraft(draft, cwd, cwd, { format: "md", output: "out/定稿.md" });
		expect(r.out).toBe(join("out", "定稿.md"));
		expect(readFileSync(join(cwd, "out", "定稿.md"), "utf-8")).toBe(
			"## 标题\n\n支持5G，Wi-Fi。\n\n```\nf(a, b)\n```\n",
		);
		// A profile without the pass keeps the ASCII marks and says so.
		writeFileSync(join(cwd, "raw.json"), JSON.stringify({ punct: false }));
		const raw = await exportDraft(draft, cwd, cwd, { format: "md", profile: "raw.json" });
		expect([raw.asciiNextToHan, formatExport(raw).split("\n")[1]]).toEqual([
			0,
			"标点：排版方案关闭了标点处理；紧邻汉字的英文标点 0 处。",
		]);
		expect(readFileSync(join(cwd, "a.export.md"), "utf-8")).toContain("支持 5G, Wi-Fi.");
	});
});

describe("exportDraft: symbols, spaces and references", () => {
	it("turns LaTeX and entities into symbols, removes spaces next to Chinese and checks every reference", async () => {
		// A draft with math, an entity, an unknown command, loose spaces and three references.
		const draft = join(cwd, "稿件.md");
		writeFileSync(
			draft,
			"# 标题\n\n温度 $\\rightarrow$ 升高，面积 $x^2$，A &rarr; B，使用 GPT-5 模型，见 New York Times 报道，未知 $\\foo$。\n\n## 参考文献\n\n1. [链接](https://example.com/a)\n2. 某机构年度报告\n3. [新华社：某项报道，2026年11月1日](https://example.com/b)\n",
		);
		const r = await exportDraft(draft, cwd, cwd, { opened: ["https://www.example.com/b/"] });
		// The text Word shows.
		const xml = strFromU8(unzipSync(readFileSync(join(cwd, "稿件.docx")))["word/document.xml"]);
		const text = (xml.match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("");
		expect(text).toContain("温度—升高，面积x²，A—B，使用GPT-5模型，见New York Times报道");
		expect([r.symbols, r.unknownSymbols, r.looseSpaces]).toEqual([4, ["\\foo"], 0]);
		// References: a generic label not opened, one without a URL, one fine (www. and the trailing slash do not matter).
		expect(r.refs).toEqual({
			entries: 3,
			issues: [
				{
					start: "1. [链接](https://example.com/a)",
					problems: ["title", "opened"],
					urls: ["https://example.com/a"],
				},
				{ start: "2. 某机构年度报告", problems: ["url"], urls: [] },
			],
		});
		// Report lines for them.
		const lines = formatExport(r).split("\n");
		expect(lines).toContain(
			"参考文献：3 条；缺可用网址 1 条，缺描述性标题 1 条，网址不是本次会话中打开过的网页 1 条。",
		);
		expect(lines).toContain(
			"- 1. [链接](https://example.com/a)……：缺描述性标题（写明网页标题、发布机构和日期）；本次会话没有用 web_fetch 打开过这个网址",
		);
		expect(lines).toContain("有 1 个 LaTeX 命令没有对应的字符，原样保留：\\foo。请在稿件里改成文字或 Unicode 符号。");
		expect(lines).toContain("超链接：2 个，打不开的 0 个。");
	});

	it("leaves no arrow or LaTeX in any kind of block of the document (the user, 2026-11-05)", async () => {
		const draft = join(cwd, "箭头.md");
		const arrow = "$\\to$";
		writeFileSync(
			draft,
			[
				`# 标题${arrow}甲`,
				`## 二级$\\rightarrow$乙`,
				`段落${arrow}乙，**加粗${arrow}丙**，*斜${arrow}丁*，$A \\to B$，甲→乙，甲 -> 乙，甲=>乙。`,
				`- 列表${arrow}戊`,
				`1. 编号${arrow}己`,
				`> 引用${arrow}庚`,
				`| 表头${arrow} | 乙 |\n| --- | --- |\n| 单元格${arrow}辛 | 壬 |`,
			].join("\n\n"),
		);
		await exportDraft(draft, cwd, cwd);
		const xml = strFromU8(unzipSync(readFileSync(join(cwd, "箭头.docx")))["word/document.xml"]);
		const text = xml.replace(/<[^>]+>/g, "");
		expect(text).not.toMatch(/[→⇒$]|\\to|-&gt;|=&gt;/);
		for (const piece of [
			"标题—甲",
			"二级—乙",
			"段落—乙",
			"加粗—丙",
			"A—B",
			"列表—戊",
			"编号—己",
			"引用—庚",
			"单元格—辛",
		])
			expect(text).toContain(piece);
	});
});
