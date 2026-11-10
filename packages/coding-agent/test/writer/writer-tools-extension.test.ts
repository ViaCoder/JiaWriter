// Unit tests for the built-in writer-tools extension (src/extensions/writer-tools/index.ts).

// Temp working directory.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API; stubEnv fixes the output language.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Extension API types.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
// The prompt builder that shows snippets and guidelines.
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
// Extension under test.
import writerToolsExtension, {
	type Complete,
	changedParagraphs,
	citesMaterials,
	cutOffWithoutCalls,
	draftCheck,
	draftFolders,
	finishedChecks,
	freshLines,
	hasMaterials,
	inChanged,
	inventedMethods,
	itemMarks,
	lacksReferences,
	MAX_CUT_RESUMES,
	MAX_ROUNDS,
	materialsNameSources,
	materialText,
	modelAsker,
	outlineOpen,
	ownFindings,
	REVIEW_REASONING_TOKENS,
	REVIEW_TIMEOUT_MS,
	referenceTitles,
	requestedLength,
	reviewMaterialText,
	shownRound,
	unusedMaterials,
	withReviewBudget,
} from "../../src/extensions/writer-tools/index.ts";
// The semantic review line the automatic check ends with.
import { STYLE_REVIEW } from "../../src/writer/prompts/manuals.ts";

// Working directory of each test.
let cwd = "";
// Fresh directory and Chinese output.
beforeEach(() => {
	// Temp directory.
	cwd = mkdtempSync(join(tmpdir(), "wa-tools-"));
	// Chinese output.
	vi.stubEnv("JW_LANG", "zh");
});
// Clean up.
afterEach(() => {
	// Remove the directory.
	rmSync(cwd, { recursive: true, force: true });
	// Restore JW_LANG.
	vi.unstubAllEnvs();
});

/** Tools registered by the extension, by name. */
function registeredTools(): Map<string, ToolDefinition> {
	// Collected tools.
	const tools = new Map<string, ToolDefinition>();
	// Fake API: the tools are kept, the event handlers are not used here.
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerMessageRenderer: () => undefined,
		on: () => undefined,
	} as unknown as ExtensionAPI;
	// Run the factory.
	writerToolsExtension(pi);
	// The tools.
	return tools;
}

/** Run a tool with params in the test directory. */
async function run(name: string, params: Record<string, unknown>) {
	// The tool.
	const tool = registeredTools().get(name);
	// It must exist.
	if (!tool) throw new Error(`missing tool ${name}`);
	// Minimal context: only cwd is used.
	const ctx = { cwd } as ExtensionToolContext;
	// Execute it.
	const result = await tool.execute("call-1", params, undefined, undefined, ctx);
	// Text of the first content block.
	const first = result.content[0];
	// The text and the details.
	return { text: first?.type === "text" ? first.text : "", details: result.details as Record<string, unknown> };
}

describe("writer-tools registration", () => {
	it("registers three read-only tools with snippets and positive guidelines", () => {
		// The tools.
		const tools = registeredTools();
		// Names.
		expect([...tools.keys()]).toEqual(["style_check", "word_count", "readability_check"]);
		// Each tool.
		for (const tool of tools.values()) {
			// Shown in the tools section.
			// Positive guidelines only.
			// Read-only hint.
			expect(tool.annotations?.readOnlyHint).toBe(true);
		}
	});
	it("adds no list or rules of these tools to the system prompt", () => {
		// The tools.
		const tools = [...registeredTools().values()];
		// Prompt with the three tools selected.
		const prompt = buildSystemPrompt({
			cwd,
			selectedTools: tools.map((t) => t.name),
			toolSnippets: Object.fromEntries(tools.map((t) => [t.name, t.promptSnippet ?? ""])),
			promptGuidelines: tools.flatMap((t) => t.promptGuidelines ?? []),
		});
		// Their use is in the tool descriptions, not repeated in the prompt.
		expect(prompt).not.toContain("- style_check:");
	});
});

describe("writer-tools execution", () => {
	it("style_check reads a file and reports hits in Chinese", async () => {
		// Draft with one stock phrase: listed, and a reasonable amount is fine (the user, 2026-11-08).
		writeFileSync(join(cwd, "稿.md"), "综上所述，形势向好。");
		const one = await run("style_check", { path: "稿.md" });
		expect(one.text).toContain("〔套话〕综上所述");
		expect(one.details.clean).toBe(true);
		// Piled up, they count.
		writeFileSync(join(cwd, "稿.md"), "综上所述，形势向好。值得一提的是，总而言之，让我们继续努力。");
		const many = await run("style_check", { path: "稿.md" });
		expect(many.details.clean).toBe(false);
		// The semantic review follows the rules' findings.
		expect(many.text.endsWith(STYLE_REVIEW)).toBe(true);
	});
	it("style_check applies the requested packs and rejects unknown ones", async () => {
		// 公文 pack.
		const { text } = await run("style_check", { text: "然而，进展缓慢。", packs: ["gongwen-zh"] });
		// 然而 is reported.
		expect(text).toContain("然而");
		// Unknown pack.
		await expect(run("style_check", { text: "甲", packs: ["x"] })).rejects.toThrow("没有名为「x」的词表");
	});
	it("word_count counts inline text against a target", async () => {
		// Ten characters, target 20.
		const { text } = await run("word_count", { text: "一二三四五六七八九十", target: 20 });
		// Target line.
		expect(text).toContain("目标 20 字，相差 -10 字（-50%），偏短。");
	});
	it("readability_check lists rare characters", async () => {
		// One level-2 character.
		const { text } = await run("readability_check", { text: "耄耋老人。" });
		// Item line.
		expect(text).toContain("- 「耄」二级字");
	});
});

// A generated report: no facts, vague words everywhere (the kind a model writes without material).
const VAGUE_REPORT = `# 关于某县农村养老服务情况的调研报告

${"近年来，部分村庄的养老服务逐步改善，一些设施有所增加，相关工作不断推进，服务能力进一步提升，取得一定成效。".repeat(12)}`;
// A report with its facts.
const FACT_REPORT = `# 关于东坡村养老服务情况的调研报告

调研组于3月12日至15日走访了3个乡镇、11个行政村。东坡村现有60岁以上老人412人，其中失能半失能老人37人，子女常年在外务工的占六成以上。村幸福院每周开放3天。日均就餐23人次，比去年多9人次。王大爷说：“饭是热的，就是离得远，下雨天我就不去了。”他家离幸福院有1.2公里，要走一段没有路灯的土路，冬天天黑得早，老人们大多吃完午饭就回家，晚饭在家里随便对付。村医每月上门一次，主要量血压。

助餐点的经费来自县里每人每餐3元的补贴和村集体的2万元。人手只有2名，都是本村妇女，没有护理证书。座谈中，有4位老人提出想要送餐上门。乡里算过一笔账：按每天送30份计算，每月要多花5400元。这笔钱从哪里来，目前还没有着落。`;

/** A model call that answers with `text`, recording what it was given. */
function fakeComplete(text: string, seen: unknown[] = []): Complete {
	return (async (model: unknown, context: unknown, options: unknown) => {
		seen.push({ model, context, options });
		return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
	}) as unknown as Complete;
}

/** A context with a model and its credentials. */
function reviewCtx() {
	return {
		cwd,
		model: { id: "m1", baseUrl: "https://llm.example.com", api: "openai-completions", provider: "jw" },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test-review", headers: { "x-a": "1" } }),
		},
	};
}

describe("modelAsker", () => {
	it("asks the session's model with its own credentials", async () => {
		const seen: unknown[] = [];
		const ask = modelAsker(reviewCtx() as never, fakeComplete("答复", seen));
		expect(await ask?.("说明", "正文")).toBe("答复");
		expect(seen[0]).toMatchObject({
			model: { id: "m1" },
			context: { systemPrompt: "说明", messages: [{ role: "user", content: "正文" }] },
			options: { apiKey: "sk-test-review", headers: { "x-a": "1" } },
		});
	});
	it("caps the review's reasoning, with a time limit, and drops the cap when the upstream refuses it", async () => {
		// 2026-11-10: one review of a short brief waited 607 s; with the cap the median was 23 s.
		const seen: { options: { onPayload?: (p: unknown) => unknown; signal?: AbortSignal } }[] = [];
		let calls = 0;
		const refusing = (async (_model: unknown, _context: unknown, options: never) => {
			seen.push({ options });
			calls++;
			return calls === 1
				? { role: "assistant", content: [], stopReason: "error", errorMessage: "400 unknown field reasoning" }
				: { role: "assistant", content: [{ type: "text", text: "答复" }], stopReason: "stop" };
		}) as unknown as Complete;
		const ask = modelAsker(reviewCtx() as never, refusing);
		expect(await ask?.("说明", "正文")).toBe("答复");
		// The first request carried the budget, the second did not; both had the time limit.
		expect(seen[0].options.onPayload?.({ model: "m1" })).toEqual({
			model: "m1",
			reasoning: { max_tokens: REVIEW_REASONING_TOKENS },
		});
		expect(seen[1].options.onPayload).toBeUndefined();
		expect(seen.every((x) => x.options.signal instanceof AbortSignal)).toBe(true);
		// Later reviews in the run go without it.
		await ask?.("说明", "正文");
		expect(seen[2].options.onPayload).toBeUndefined();
		// Another error is not retried.
		const once: unknown[] = [];
		const failing = (async (_m: unknown, _c: unknown, options: never) => {
			once.push(options);
			return { role: "assistant", content: [], stopReason: "error", errorMessage: "network down" };
		}) as unknown as Complete;
		await expect(modelAsker(reviewCtx() as never, failing)?.("说明", "正文")).rejects.toThrow("network down");
		expect(once).toHaveLength(1);
		expect(withReviewBudget("x")).toBe("x");
		expect(REVIEW_TIMEOUT_MS).toBe(180_000);
	});
	it("is not there without a model, or with JW_REVIEW=off", () => {
		expect(modelAsker({ cwd } as never)).toBeUndefined();
		vi.stubEnv("JW_REVIEW", "off");
		expect(modelAsker(reviewCtx() as never)).toBeUndefined();
	});
});

describe("draftCheck", () => {
	it("flags a report without facts, and always ends with the semantic review", () => {
		const vague = draftCheck(VAGUE_REPORT);
		expect(vague.clean).toBe(false);
		// Facts come from the materials at hand; nothing asks for more (the user, 2026-11-08).
		expect(vague.text).toContain("参考资料/.parsed/");
		expect(vague.text).not.toContain("需补充");
		// The reread instruction is added by the callers, once per draft.
		expect(vague.text).not.toContain(STYLE_REVIEW);
	});
	it("passes a report that carries its facts", () => {
		expect(draftCheck(FACT_REPORT).clean).toBe(true);
	});
	it("lists citations in another form than the user's, and is not clean with them", () => {
		const check = draftCheck(`${FACT_REPORT}\n\n11月7日，路透社称谈判将继续。`);
		expect(check.clean).toBe(false);
		expect(check.text).toContain("“11月7日，路透社” → YYYY年11月7日《路透社》报道");
		expect(draftCheck(FACT_REPORT).text).not.toContain("引用格式不符");
	});
	it("notes report paragraphs that open with their evidence, without failing the draft for it", () => {
		const report = "# 关于禁渔情况的调研报告\n\n2020年，退捕渔船11万艘、渔民22.8万人。禁捕退捕总体平稳。";
		expect(draftCheck(report).text).toContain("“2020年，退捕渔船11万艘、渔民22.8万人。”");
		// A note only: a method paragraph may open with specifics too.
		expect(draftCheck(FACT_REPORT).clean).toBe(true);
		expect(draftCheck("# 关于做好防汛工作的通知\n\n2026年5月6日起执行。各单位要落实责任。").text).not.toContain(
			"开头就是",
		);
	});
	it("lists heading numbers and in-text ordinals of documents, and not of general prose", () => {
		const report = `${FACT_REPORT}\n\n## 1、存在问题\n\n一是人手不足。二是经费短缺。`;
		const check = draftCheck(report);
		expect(check.clean).toBe(false);
		expect(check.text).toContain("“## 1、存在问题” → ## 一、存在问题");
		expect(check.text).toContain("一是、二是");
		expect(draftCheck("# 故乡的秋天\n\n## 1、秋天\n\n一是风大。").text).not.toContain("标题编号不符");
	});
	it("asks to use each figure once", () => {
		const check = draftCheck(`${FACT_REPORT}\n\n东坡村现有60岁以上老人412人。`);
		expect(check.clean).toBe(false);
		expect(check.text).toContain("同一素材用了不止一处：412人");
	});
	it("asks for Chinese quotes around Chinese words", () => {
		const check = draftCheck(`${FACT_REPORT}\n\n攻击者发布"A股交易时间调整"的消息。`);
		expect(check.clean).toBe(false);
		expect(check.text).toContain("1 处中文用了英文引号");
		expect(draftCheck(`${FACT_REPORT}\n\n他说 "OK" 就走了。`).text).not.toContain("英文引号");
	});
	it("checks an official document against official-document habits, and says only that a clean draft passed", () => {
		const flagged = "这不是一个技术问题，而是一个管理问题。";
		expect(draftCheck(`# 临江市人民政府办公室关于做好防汛工作的通知\n\n${flagged}`).text).toContain("gongwen-zh");
		expect(draftCheck(`# 故乡的秋天\n\n${flagged}`).text).not.toContain("gongwen-zh");
		expect(draftCheck("# 故乡的秋天\n\n秋天来了。").text).toBe("AI 腔检查通过。");
	});
});

describe("finishedChecks", () => {
	it("reports long sentences and rare characters", () => {
		const long = `# 关于禁渔情况的调研报告\n\n${"退捕渔民转产就业".repeat(14)}。`;
		expect(finishedChecks(long)[0]).toContain("超过 100 字");
		// Level-3 characters are reported, level-2 ones (饕餮) are common enough.
		expect(finishedChecks("# 故乡\n\n桌上放着一坛鬯酒。")[0]).toContain("鬯");
		expect(finishedChecks("# 故乡\n\n他住在饕餮楼。")).toEqual([]);
		// A short report is not told to reach a length.
		expect(finishedChecks(FACT_REPORT)).toEqual([]);
	});
});

describe("requestedLength", () => {
	it("reads the length a message asks for", () => {
		expect(requestedLength("写一篇约1500字的调研报告")).toBe(1500);
		expect(requestedLength("3000字左右")).toBe(3000);
		expect(requestedLength("写一篇调研报告")).toBeUndefined();
	});
});

describe("citesMaterials and referenceTitles", () => {
	it("knows a cited text from one that names no source", () => {
		const titles = ["国务院关于长江流域生态环境保护工作情况的报告"];
		expect(citesMaterials("据《国务院关于长江流域生态环境保护工作情况的报告》，退捕渔船11万艘。", titles)).toBe(true);
		expect(citesMaterials("2026年10月31日《新华网》报道，……", [])).toBe(true);
		expect(citesMaterials("正文。\n\n## 参考文献\n1. ……", [])).toBe(true);
		// A law's name is not a source of the facts.
		expect(citesMaterials("依托《长江保护法》，退捕渔船11万艘。", titles)).toBe(false);
	});
	it("takes the titles of the references beside a draft", () => {
		mkdirSync(join(cwd, "参考资料", ".parsed"), { recursive: true });
		writeFileSync(join(cwd, "参考资料", ".parsed", "长江报告.pdf.md"), "x");
		mkdirSync(join(cwd, "主题", "稿件"), { recursive: true });
		expect(referenceTitles(join(cwd, "主题", "稿件", "稿.md"), cwd)).toEqual(["长江报告"]);
	});
});

describe("draftFolders", () => {
	it("goes from the draft's folder up to the writing folder, and stops at once outside it", () => {
		expect(draftFolders(join(cwd, "主题", "稿件", "稿.md"), cwd)).toEqual([
			join(cwd, "主题", "稿件"),
			join(cwd, "主题"),
			cwd,
		]);
		expect(draftFolders("/elsewhere/稿.md", cwd)).toEqual(["/elsewhere"]);
	});
});

describe("hasMaterials", () => {
	it("finds materials in the draft's folder or above it, up to the writing folder", () => {
		const topic = join(cwd, "20261108-防汛");
		mkdirSync(join(topic, "稿件"), { recursive: true });
		const draft = join(topic, "稿件", "通知.md");
		// Empty folders and the archive index are no materials.
		mkdirSync(join(topic, "检索"));
		writeFileSync(join(topic, "检索", ".index.jsonl"), "{}");
		writeFileSync(join(topic, "素材.md"), "");
		expect(hasMaterials(draft, cwd)).toBe(false);
		// Imported references in the writing folder count.
		mkdirSync(join(cwd, "参考资料", ".parsed"), { recursive: true });
		writeFileSync(join(cwd, "参考资料", ".parsed", "报告.txt.md"), "资料");
		expect(hasMaterials(draft, cwd)).toBe(true);
		rmSync(join(cwd, "参考资料"), { recursive: true });
		// So do the topic's saved searches and its materials file.
		writeFileSync(join(topic, "检索", "001-防汛.md"), "结果");
		expect(hasMaterials(draft, cwd)).toBe(true);
		rmSync(join(topic, "检索"), { recursive: true });
		writeFileSync(join(topic, "素材.md"), "- 案例");
		expect(hasMaterials(draft, cwd)).toBe(true);
	});
});

describe("unusedMaterials", () => {
	it("names the items of a short fact list whose marks the draft lacks", () => {
		expect(itemMarks("2026年3月26日，FakeAgent技术侦测发现，“跨模态对齐”。")).toEqual(["FakeAgent", "跨模态对齐"]);
		const topic = join(cwd, "20261109-材料");
		mkdirSync(join(topic, "稿件"), { recursive: true });
		const draft = join(topic, "稿件", "段.md");
		const parsed = join(cwd, "参考资料", ".parsed");
		mkdirSync(parsed, { recursive: true });
		writeFileSync(
			join(parsed, "材料.md.md"),
			"# 材料\n\n1. FakeAgent技术侦测发现，伪造已能跨模态对齐。\n\n2. 伯克利大学教授Hany Farid表示，伪造技术正向全球普及。\n",
		);
		expect(unusedMaterials("Hany Farid表示，伪造技术正向全球普及。", draft, cwd)).toEqual([
			"FakeAgent技术侦测发现，伪造已能跨模态对齐。",
		]);
		expect(unusedMaterials("FakeAgent侦测……Hany Farid表示……", draft, cwd)).toEqual([]);
		rmSync(join(cwd, "参考资料"), { recursive: true });
	});
});

describe("lacksReferences", () => {
	it("asks for a reference list when a draft cites searched reports without one", () => {
		const topic = join(cwd, "20261109-油价");
		mkdirSync(join(topic, "稿件"), { recursive: true });
		const draft = join(topic, "稿件", "简报.md");
		const cited = "2026年11月6日《路透社》报道，油价下跌。";
		// No searches in the topic: nothing to list.
		expect(lacksReferences(cited, draft, cwd)).toBe(false);
		mkdirSync(join(topic, "检索"));
		writeFileSync(join(topic, "检索", "001-油价.md"), "结果");
		expect(lacksReferences(cited, draft, cwd)).toBe(true);
		// With a list, or with no citation at all, nothing to ask.
		expect(
			lacksReferences(`${cited}\n\n## 参考文献\n\n1. [油价, 路透社, 2026-11-06](https://example.com/a)`, draft, cwd),
		).toBe(false);
		expect(lacksReferences("油价下跌。", draft, cwd)).toBe(false);
	});
});

describe("materialText", () => {
	it("joins 素材.md, the imported references and the saved searches and pages beside a draft", () => {
		const topic = join(cwd, "20261109-材料");
		mkdirSync(join(topic, "稿件"), { recursive: true });
		mkdirSync(join(topic, "检索"), { recursive: true });
		writeFileSync(join(topic, "素材.md"), "素材一条");
		writeFileSync(join(topic, "检索", "001-结果.md"), "检索一页");
		const text = materialText(join(topic, "稿件", "稿.md"), cwd);
		expect([text.includes("素材一条"), text.includes("检索一页")]).toEqual([true, true]);
		expect(materialText(join(cwd, "别处", "稿.md"), cwd)).toBe("");
	});
});

describe("reviewMaterialText", () => {
	it("gives the review 素材.md and the references, not the saved searches and pages", () => {
		// 2026-11-10: with the whole archive one review of a research brief took 498 s.
		const topic = join(cwd, "20261110-材料");
		mkdirSync(join(topic, "稿件"), { recursive: true });
		mkdirSync(join(topic, "检索"), { recursive: true });
		writeFileSync(join(topic, "素材.md"), "素材一条");
		writeFileSync(join(topic, "检索", "001-结果.md"), "检索一页");
		const text = reviewMaterialText(join(topic, "稿件", "稿.md"), cwd);
		expect([text.includes("素材一条"), text.includes("检索一页")]).toEqual([true, false]);
		expect(reviewMaterialText(join(cwd, "别处", "稿.md"), cwd)).toBe("");
	});
});

describe("inventedMethods", () => {
	it("names research steps the draft reports and no material mentions, and none when the materials do", () => {
		// 2026-11-09: report runs opened with a survey team the materials never named.
		const draft = join(cwd, "稿.md");
		const report = "# 调研报告\n\n为掌握情况，调研组开展座谈，现将有关情况报告如下。";
		mkdirSync(join(cwd, "参考资料", ".parsed"), { recursive: true });
		writeFileSync(join(cwd, "参考资料", ".parsed", "材料.md.md"), "1. 全市老旧小区共412个。");
		expect(inventedMethods(report, draft, cwd)).toEqual(["调研组", "座谈"]);
		// The other ways reports say it (2026-11-09: "市住建局……进行了调研").
		expect(inventedMethods("# 报告\n\n市住建局对全市情况进行了调研，并赴东湖街道调研。", draft, cwd)).toEqual([
			"进行了调研",
			"赴东湖街道调研",
		]);
		writeFileSync(join(cwd, "参考资料", ".parsed", "材料.md.md"), "1. 市住建局组织座谈，了解到全市老旧小区共412个。");
		expect(inventedMethods(report, draft, cwd)).toEqual([]);
		rmSync(join(cwd, "参考资料"), { recursive: true });
	});
});

describe("outlineOpen", () => {
	it("is true while the outline beside a draft has a section to write", () => {
		const draft = join(cwd, "稿.md");
		expect(outlineOpen(draft)).toBe(false);
		writeFileSync(join(cwd, "大纲.md"), "- [x] 一、基本情况\n- [ ] 二、问题\n");
		expect([outlineOpen(draft), outlineOpen(join(cwd, "大纲.md"))]).toEqual([true, false]);
		writeFileSync(join(cwd, "大纲.md"), "- [x] 一、基本情况\n- [x] 二、问题\n");
		expect(outlineOpen(draft)).toBe(false);
	});
});

describe("materialsNameSources", () => {
	it("counts published files, searches and notes that name a source; a bare fact list names none", () => {
		const topic = join(cwd, "20261108-来源");
		mkdirSync(join(topic, "稿件"), { recursive: true });
		const draft = join(topic, "稿件", "报告.md");
		const parsed = join(cwd, "参考资料", ".parsed");
		mkdirSync(parsed, { recursive: true });
		// The user's facts with no outlet or title.
		writeFileSync(join(parsed, "材料.md.md"), "1. Seedance 2.0 生成每秒视频成本约1元。");
		expect([hasMaterials(draft, cwd), materialsNameSources(draft, cwd)]).toEqual([true, false]);
		// Notes that name their source.
		writeFileSync(join(parsed, "材料.md.md"), "1. 2026年4月15日《南方日报》报道：……");
		expect(materialsNameSources(draft, cwd)).toBe(true);
		// A published document.
		writeFileSync(join(parsed, "材料.md.md"), "1. 事实");
		writeFileSync(join(parsed, "白皮书.pdf.md"), "正文");
		expect(materialsNameSources(draft, cwd)).toBe(true);
		rmSync(join(cwd, "参考资料"), { recursive: true });
	});
	it("does not count a material item whose source is the user's own file in 参考资料", () => {
		// 2026-11-09: material_add gave the notes file as the source, and the brief was told to cite it.
		const topic = join(cwd, "20261109-简报");
		mkdirSync(join(topic, "稿件"), { recursive: true });
		const draft = join(topic, "稿件", "简报.md");
		writeFileSync(
			join(topic, "素材.md"),
			"# 素材\n\n- 数据｜时间：2025年｜数值：5.2万人｜来源：《参考资料/材料.md》第1条\n",
		);
		expect(materialsNameSources(draft, cwd)).toBe(false);
		writeFileSync(
			join(topic, "素材.md"),
			"# 素材\n\n- 案例｜时间：2026年4月15日｜报道方：《南方日报》｜来源：https://a.example/x\n",
		);
		expect(materialsNameSources(draft, cwd)).toBe(true);
	});
});

describe("the automatic check of each draft", () => {
	/** The extension with its handlers and the messages it sends; `complete` answers the semantic review. */
	function started(complete?: Complete) {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const sent: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
		const pi = {
			registerTool: () => undefined,
			registerMessageRenderer: () => undefined,
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
				handlers[name] = fn;
			},
			sendMessage: (message: never, options: unknown) => sent.push({ message, options }),
		} as unknown as ExtensionAPI;
		writerToolsExtension(pi, complete);
		/** A write of a file, as its result arrives. */
		const wrote = (path: string, text: string, isError = false) => {
			writeFileSync(join(cwd, path), text);
			return handlers.tool_result(
				{ toolName: "write", input: { path }, content: [{ type: "text", text: "ok" }], isError },
				{ cwd },
			) as { content: { text: string }[] } | undefined;
		};
		return { handlers, sent, wrote };
	}

	it("adds the check to the result of a draft's write, and leaves other files and failures alone", () => {
		const { wrote } = started();
		const result = wrote("稿.md", VAGUE_REPORT);
		expect(result?.content.map((c) => c.text)).toEqual(["ok", expect.stringContaining(STYLE_REVIEW)]);
		// The next write of the same draft gets the check without the reread instruction.
		expect(wrote("稿.md", VAGUE_REPORT)?.content[1]?.text).not.toContain(STYLE_REVIEW);
		expect(wrote("notes.txt", VAGUE_REPORT)).toBeUndefined();
		expect(wrote("稿2.md", VAGUE_REPORT, true)).toBeUndefined();
	});

	it("gives the length against the request and the sentence checks with each write", () => {
		// 2026-11-09: a report run called word_count ten times and readability_check three times.
		const { handlers, wrote } = started();
		handlers.input({ text: "写一篇约3000字的调研报告" }, { cwd });
		const text = wrote("稿.md", FACT_REPORT)?.content[1]?.text ?? "";
		expect(text).toMatch(/篇幅：正文 \d+ 字，要求约 3000 字（相差 20% 以内即可）/);
	});

	it("asks for another round while a draft is flagged, at most MAX_ROUNDS, and starts again with the user", async () => {
		const { handlers, sent, wrote } = started();
		wrote("稿.md", VAGUE_REPORT);
		for (let i = 0; i < MAX_ROUNDS + 2; i++) await handlers.agent_end({}, { cwd });
		expect(sent.length).toBe(MAX_ROUNDS);
		expect(sent[0].message).toMatchObject({ customType: "jiawriter-style-round", display: true });
		expect(sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		// A new message from the user: the draft is no longer watched until it is written again.
		handlers.input({}, { cwd });
		await handlers.agent_end({}, { cwd });
		expect(sent.length).toBe(MAX_ROUNDS);
		// A clean draft asks for nothing.
		wrote("稿.md", FACT_REPORT);
		await handlers.agent_end({}, { cwd });
		expect(sent.length).toBe(MAX_ROUNDS);
	});

	it("asks for a round when only the semantic review finds something, and says where facts come from", async () => {
		const answer = JSON.stringify({
			issues: [{ category: "sentimental-closure", quote: "王大爷说", why: "x", fix: "y" }],
		});
		const { handlers, sent, wrote } = started(fakeComplete(answer));
		wrote("稿.md", FACT_REPORT);
		await handlers.agent_end({}, reviewCtx());
		expect(sent.length).toBe(1);
		expect(sent[0].message.content).toContain("[sentimental-closure] “王大爷说”");
		expect(sent[0].message.content).toContain("素材.md");
	});

	it("drops findings that ask for facts when the draft has no materials, and keeps them when it has", async () => {
		const answer = JSON.stringify({
			issues: [{ category: "vague-no-facts", quote: "王大爷说", why: "x", fix: "给出数据" }],
		});
		const { handlers, sent, wrote } = started(fakeComplete(answer));
		wrote("稿.md", FACT_REPORT);
		await handlers.agent_end({}, reviewCtx());
		expect(sent).toEqual([]);
		writeFileSync(join(cwd, "素材.md"), "- 案例");
		await handlers.agent_end({}, reviewCtx());
		expect(sent[0]?.message.content).toContain("[vague-no-facts]");
	});

	// 2026-11-09: asked to change a date, a run also cut a phrase of the notice the user had kept, because the review
	// read the whole notice again.
	it("in a revision, asks only about what the run changed", async () => {
		const answer = (quote: string) =>
			JSON.stringify({ issues: [{ category: "stock-phrase", quote, why: "x", fix: "y" }] });
		const lines = FACT_REPORT.split("\n");
		const kept = lines.find((l) => l.includes("王大爷说")) ?? "";
		/** The draft there before the message, then one edit of another line, as the tools see it. */
		const revise = (handlers: Record<string, (event: unknown, ctx: unknown) => unknown>) => {
			writeFileSync(join(cwd, "稿.md"), FACT_REPORT);
			handlers.input({ text: "截止时间改成12月5日" }, { cwd });
			handlers.tool_call({ toolName: "edit", input: { path: "稿.md" } }, { cwd });
			const changed = FACT_REPORT.replace(kept, `${kept}（12月5日前报送）`);
			writeFileSync(join(cwd, "稿.md"), changed);
			handlers.tool_result(
				{ toolName: "edit", input: { path: "稿.md" }, content: [{ type: "text", text: "ok" }], isError: false },
				{ cwd },
			);
		};
		// A finding on a line the user kept: no round.
		const untouched = started(
			fakeComplete(answer(lines.find((l) => l.trim() && l !== kept && !l.startsWith("#"))?.slice(0, 8) ?? "x")),
		);
		revise(untouched.handlers);
		await untouched.handlers.agent_end({}, reviewCtx());
		expect(untouched.sent).toEqual([]);
		// A finding on the line the run wrote: a round.
		const touched = started(fakeComplete(answer("12月5日前报送")));
		revise(touched.handlers);
		await touched.handlers.agent_end({}, reviewCtx());
		expect(touched.sent[0]?.message.content).toContain("12月5日前报送");
	});

	it("asks for sources and the requested length when a report lacks them", async () => {
		const { handlers, sent, wrote } = started();
		mkdirSync(join(cwd, "参考资料", ".parsed"), { recursive: true });
		// The material records the survey the report tells of, so only sources and length are asked for.
		writeFileSync(join(cwd, "参考资料", ".parsed", "东坡村调查.pdf.md"), "调研组走访记录");
		handlers.input({ text: "写一篇约3000字的调研报告" }, { cwd });
		wrote("稿.md", FACT_REPORT);
		await handlers.agent_end({}, { cwd });
		expect(sent[0]?.message.content).toContain("没有注明出处");
		expect(sent[0]?.message.content).toContain("要求约 3000 字");
		// Cited and of the asked length: nothing to say.
		handlers.input({ text: "写一篇调研报告" }, { cwd });
		wrote("稿.md", `${FACT_REPORT}\n\n资料来源：《东坡村调查》。`);
		await handlers.agent_end({}, { cwd });
		expect(sent.length).toBe(1);
	});

	it("judges length and unused materials only once the outline has no section left, keeping the length asked", async () => {
		// A long document written one section per turn with the user (2026-11-09).
		const { handlers, sent, wrote } = started();
		writeFileSync(join(cwd, "大纲.md"), "# 大纲\n\n- [x] 一、基本情况\n- [ ] 二、存在的问题\n");
		handlers.input({ text: "写一篇约3000字的调研报告" }, { cwd });
		wrote("稿.md", FACT_REPORT);
		await handlers.agent_end({}, { cwd });
		expect(sent.map((s) => s.message.content).join("")).not.toContain("要求约 3000 字");
		// The last section done: the length asked in the first turn is the target.
		writeFileSync(join(cwd, "大纲.md"), "# 大纲\n\n- [x] 一、基本情况\n- [x] 二、存在的问题\n");
		handlers.input({ text: "继续" }, { cwd });
		wrote("稿.md", FACT_REPORT);
		await handlers.agent_end({}, { cwd });
		expect(sent.at(-1)?.message.content).toContain("要求约 3000 字");
	});

	it("goes on without the review when the model cannot be asked", async () => {
		const { handlers, sent, wrote } = started((async () => {
			throw new Error("offline");
		}) as unknown as Complete);
		wrote("稿.md", FACT_REPORT);
		await handlers.agent_end({}, reviewCtx());
		expect(sent).toEqual([]);
	});
});

// 2026-11-09: each reference entry cited where its fact is used.
describe("finishedChecks and the references", () => {
	it("names the reference entries the text never cites", () => {
		const draft =
			"# 报告\n\n2025年12月30日《上海证券报》报道，航线增加。\n\n## 参考文献\n\n1. [向天空要生产力，上海证券报，2025-12-30](https://a.example/1)\n2. [大事记，现代物流报，2025-12-31](https://a.example/2)\n";
		expect(finishedChecks(draft).join("\n")).toContain("第 2 条（找的是：现代物流报）");
		expect(
			finishedChecks(
				draft.replace("航线增加。", "航线增加。2025年12月31日《现代物流报》报道，订单超300亿元。"),
			).join("\n"),
		).not.toContain("没有引用");
	});
});

describe("changedParagraphs / freshLines / inChanged / ownFindings", () => {
	it("changedParagraphs: the lines the run wrote", () => {
		expect(changedParagraphs("# 通知\n\n甲。\n\n乙。", "# 通知\n\n甲。\n\n乙改。\n\n丙。")).toEqual([
			"乙改。",
			"丙。",
		]);
		expect(changedParagraphs("", "甲。")).toEqual(["甲。"]);
	});
	it("freshLines: the report lines that are new", () => {
		expect(freshLines(["A", "B"], ["B", "C"])).toEqual(["C"]);
	});
	it("inChanged: the findings that quote a changed line", () => {
		const issue = (quote: string) => ({ category: "stock-phrase", quote, why: "", fix: "" });
		expect(
			inChanged([issue("形成工作闭环"), issue("12月5日")], ["于2026年12月5日前报送"]).map((i) => i.quote),
		).toEqual(["12月5日"]);
	});
	it("ownFindings: the program's findings; materials left out only on the first write", () => {
		const dir = mkdtempSync(join(tmpdir(), "jw-own-"));
		mkdirSync(join(dir, "参考资料"), { recursive: true });
		const file = join(dir, "稿件", "通知.md");
		mkdirSync(join(dir, "稿件"), { recursive: true });
		writeFileSync(file, "# 通知\n\n各单位于12月5日前报送。\n");
		expect(ownFindings("# 通知\n\n各单位于12月5日前报送。\n", file, dir, { firstWrite: true })).toEqual([]);
		expect(ownFindings("# 通知\n\n短。\n", file, dir, { target: 3000, firstWrite: false }).join("")).toContain(
			"3000",
		);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("shownRound", () => {
	it("shows the report without the editor's English instructions to the model", () => {
		const content = [
			"自动检查：草稿还有问题（第 1/2 轮）。",
			"",
			"稿件/报告.md",
			"篇幅 759 字，要求约 1200 字",
			STYLE_REVIEW,
		].join("\n");
		expect(shownRound(content)).toBe(
			"自动检查：草稿还有问题（第 1/2 轮）。\n\n稿件/报告.md\n篇幅 759 字，要求约 1200 字",
		);
	});

	it("is how the automatic check is drawn: the report, no English instructions", () => {
		// The renderer the extension registers, with a theme that leaves text as it is.
		let render:
			| ((message: unknown, options: unknown, theme: unknown) => { render(width: number): string[] })
			| undefined;
		const pi = {
			registerTool: () => undefined,
			registerMessageRenderer: (_type: string, fn: typeof render) => {
				render = fn;
			},
			on: () => undefined,
		} as unknown as ExtensionAPI;
		writerToolsExtension(pi);
		const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text };
		const message = {
			customType: "jiawriter-style-round",
			content: `自动检查：第 1/2 轮。\n稿件/报告.md\n${STYLE_REVIEW}`,
			display: true,
		};
		const lines = render?.(message, { expanded: false, outputPad: 1 }, theme).render(120).join("\n") ?? "";
		expect(lines).toContain("自动检查：第 1/2 轮。");
		expect(lines).toContain("稿件/报告.md");
		expect(lines).not.toContain("reread the draft");
	});
});

describe("cutOffWithoutCalls", () => {
	it("finds a reply cut at the output limit before any tool call, and nothing else", () => {
		const cut = {
			role: "assistant",
			stopReason: "length",
			content: [{ type: "text", text: "先登记素材，再拟大纲。" }],
		};
		expect(cutOffWithoutCalls([{ role: "user" }, cut])).toBe(true);
		// A cut reply with a call: the loop fails the call and goes on by itself.
		expect(cutOffWithoutCalls([{ ...cut, content: [{ type: "toolCall" }] }])).toBe(false);
		// A finished reply, none, and no messages at all.
		expect(cutOffWithoutCalls([{ ...cut, stopReason: "stop" }])).toBe(false);
		expect(cutOffWithoutCalls([])).toBe(false);
		expect(cutOffWithoutCalls(undefined)).toBe(false);
	});

	it("is resumed at most MAX_CUT_RESUMES times until the user writes again", async () => {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const sent: { customType: string }[] = [];
		const pi = {
			registerTool: () => undefined,
			registerMessageRenderer: () => undefined,
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
				handlers[name] = fn;
			},
			sendMessage: (message: { customType: string }) => sent.push(message),
		} as unknown as ExtensionAPI;
		writerToolsExtension(pi);
		const ended = { messages: [{ role: "assistant", stopReason: "length", content: [] }] };
		for (let i = 0; i < 4; i++) await handlers.agent_end(ended, { cwd: process.cwd() });
		expect(sent.filter((m) => m.customType === "jiawriter-cut-resume").length).toBe(MAX_CUT_RESUMES);
		handlers.input({ text: "继续" }, {});
		await handlers.agent_end(ended, { cwd: process.cwd() });
		expect(sent.filter((m) => m.customType === "jiawriter-cut-resume").length).toBe(MAX_CUT_RESUMES + 1);
	});
});
