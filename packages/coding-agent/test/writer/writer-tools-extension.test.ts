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
	citesMaterials,
	draftCheck,
	draftFolders,
	finishedChecks,
	gongwenGenre,
	hasMaterials,
	MAX_ROUNDS,
	materialsNameSources,
	modelAsker,
	referenceTitles,
	requestedLength,
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

describe("gongwenGenre and finishedChecks", () => {
	it("names the genre from the title, or none", () => {
		expect(gongwenGenre("# 关于长江流域生态环境保护情况的调研报告")).toBe("调研报告");
		expect(gongwenGenre("# 在全市安全生产工作会议上的讲话")).toBe("领导讲话");
		expect(gongwenGenre("# 低空经济应用场景培育工作方案")).toBe("工作方案");
		expect(gongwenGenre("# 故乡的秋天")).toBe("");
	});
	it("reports long sentences, rare characters and hard conflicts, but never the corpus length", () => {
		const long = `# 关于禁渔情况的调研报告\n\n${"退捕渔民转产就业".repeat(14)}。`;
		expect(finishedChecks(long)[0]).toContain("超过 100 字");
		// Level-3 characters are reported, level-2 ones (饕餮) are common enough.
		expect(finishedChecks("# 故乡\n\n桌上放着一坛鬯酒。")[0]).toContain("鬯");
		expect(finishedChecks("# 故乡\n\n他住在饕餮楼。")).toEqual([]);
		// A short report is not told to reach 1200 characters.
		expect(finishedChecks(FACT_REPORT)).toEqual([]);
		// A speech with a third-level heading is.
		expect(finishedChecks("# 在全市安全生产工作会议上的讲话\n\n#### 1．抓好排查\n\n要抓好排查。").join("")).toContain(
			"三级标题",
		);
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
});

describe("the automatic check of each draft", () => {
	/** The extension with its handlers and the messages it sends; `complete` answers the semantic review. */
	function started(complete?: Complete) {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const sent: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
		const pi = {
			registerTool: () => undefined,
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

	it("asks for sources and the requested length when a report lacks them", async () => {
		const { handlers, sent, wrote } = started();
		mkdirSync(join(cwd, "参考资料", ".parsed"), { recursive: true });
		writeFileSync(join(cwd, "参考资料", ".parsed", "东坡村调查.pdf.md"), "资料");
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

	it("goes on without the review when the model cannot be asked", async () => {
		const { handlers, sent, wrote } = started((async () => {
			throw new Error("offline");
		}) as unknown as Complete);
		wrote("稿.md", FACT_REPORT);
		await handlers.agent_end({}, reviewCtx());
		expect(sent).toEqual([]);
	});
});
