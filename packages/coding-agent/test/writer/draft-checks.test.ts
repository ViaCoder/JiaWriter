// The table of draft checks (src/writer/style/draft-checks.ts): which apply where, and failures before notes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DRAFT_CHECKS,
	type DraftCheck,
	frameOpeners,
	openingFormula,
	runDraftChecks,
	selfDescription,
} from "../../src/writer/style/draft-checks.ts";

beforeEach(() => vi.stubEnv("JW_LANG", "zh"));
afterEach(() => vi.unstubAllEnvs());

describe("runDraftChecks", () => {
	it("runs only the checks of the register, failures before notes", () => {
		const ran: string[] = [];
		const probe = (id: string, register: "report" | "general", fail: boolean): DraftCheck => ({
			id,
			when: (r) => r === register,
			run: () => {
				ran.push(id);
				return fail ? { fail: [id], note: [] } : { fail: [], note: [id] };
			},
		});
		const table = [probe("a", "report", false), probe("b", "general", true), probe("c", "report", true)];
		expect(runDraftChecks("正文", "report", table)).toEqual({ fail: ["c"], note: ["a"] });
		expect(ran).toEqual(["a", "c"]);
	});
	it("keeps the built-in checks in their order and applies documents' checks only to documents", () => {
		expect(DRAFT_CHECKS.map((c) => c.id)).toEqual([
			"citation",
			"headings",
			"list-markers",
			"placeholders",
			"ascii-quotes",
			"repeated",
			"numbered-citation",
			"reference-form",
			"evidence-first",
			"frame-openers",
			"self-description",
			"opening-formula",
			"unsupported",
		]);
		const text = "## 1、问题\n\n一是人手不足。二是经费短缺。";
		expect(runDraftChecks(text, "general").fail).toEqual([]);
		expect(runDraftChecks(text, "report").fail.length).toBe(2);
	});
});

// Paragraphs that restate the problem before the measure, and the report-to-a-superior opening (2026-11-12: a run opened
// five measures with 针对, 围绕, 着眼, 鉴于 and 面向 in turn; 38 of 87 drafts opened with 现将有关情况报告如下).
describe("frame-openers and opening-formula", () => {
	const measures = [
		"## 四、对策建议",
		"",
		"针对空域管理机制不完善的问题，民航局要完善分类管理。",
		"围绕基础设施供给不足的问题，发展改革委要加快建设。",
		"民航局健全适航审定体系，缩短认证周期。",
		"",
		"## 参考文献",
		"",
		"1. [标题，来源，2026年1月1日](https://a.example/)",
	].join("\n");
	it("frameOpeners: the paragraphs opening with a problem frame, in the body only", () => {
		expect(frameOpeners(measures)).toEqual([
			"针对空域管理机制不完善的问题，民航局要完善分类管理。",
			"围绕基础设施供给不足的问题，发展改革委要加快建设。",
		]);
		expect(frameOpeners("针对上述问题，下一步建议相关部门做好三方面工作。")).toHaveLength(1);
		expect(frameOpeners("民航局针对审批慢的问题简化了流程。")).toEqual([]);
	});
	it("the check fails only from the second such paragraph, and only in documents", () => {
		expect(runDraftChecks(measures, "report").fail.join("\n")).toContain("有 2 段都用");
		expect(runDraftChecks(measures, "general").fail).toEqual([]);
		// One is ordinary official writing.
		expect(runDraftChecks("针对上述问题，建议做好三方面工作。\n\n监管部门加强日常检查。", "report").fail).toEqual([]);
	});
	it("selfDescription: an opening about the document itself, as a note", () => {
		const text =
			"# 报告\n\n低空经济规模快速增长。本报告以2025年以来的公开报道为基础，梳理发展现状，并提出对策建议。\n\n## 一、现状";
		expect(selfDescription(text)).toBe("本报告以2025年以来的公开报道为基础，梳理发展现状，并提出对策建议");
		expect(selfDescription("规模快速增长。\n\n第二段。\n\n本报告梳理现状。")).toBeUndefined();
		expect(selfDescription("本报告期内，企业营收增长。")).toBeUndefined();
		expect(runDraftChecks(text, "report").note.join("\n")).toContain("在介绍报告自己");
	});
	it("openingFormula: 现将…如下 in the first paragraphs, as a note", () => {
		const text = "# 报告\n\n为全面反映情况，现将有关情况报告如下。\n\n## 一、现状\n\n规模增长。";
		expect(openingFormula(text)).toBe("现将有关情况报告如下");
		expect(openingFormula("规模增长。\n\n现将有关情况报告如下。\n\n第三段。\n\n第四段。")).toBe(
			"现将有关情况报告如下",
		);
		expect(openingFormula("第一段。\n\n第二段。\n\n第三段。\n\n现将有关情况报告如下。")).toBeUndefined();
		const result = runDraftChecks(text, "report");
		expect(result.fail).toEqual([]);
		expect(result.note.join("\n")).toContain("上报用的套语");
	});
});
