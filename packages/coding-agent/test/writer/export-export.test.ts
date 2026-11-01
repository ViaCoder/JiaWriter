// Unit tests for src/writer/export/export.ts.

// Files.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Functions under test.
import { defaultOutput, exportDraft, formatExport } from "../../src/writer/export/export.ts";

// Working folder.
let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "wa-export-"));
	vi.stubEnv("WA_LANG", "zh");
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
			"## 标题\n\n支持 5G，Wi-Fi。\n\n```\nf(a, b)\n```\n",
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
