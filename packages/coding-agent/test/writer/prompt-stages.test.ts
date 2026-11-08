// What reaches the model and when: the stage table, its size budgets, and that every rule lives in one place.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerPromptsExtension from "../../src/extensions/writer-prompts/index.ts";
import { t } from "../../src/writer/i18n/index.ts";
import { WRITER_PREAMBLE } from "../../src/writer/prompt-text.ts";
import { SUMMARY_PROMPT, SUMMARY_TURN_PROMPT, SUMMARY_UPDATE_PROMPT } from "../../src/writer/prompts/compact.ts";
import { CORE_RULES, DEFAULT_SKILL, defaultSkillRule } from "../../src/writer/prompts/core.ts";
import {
	BROWSER_MANUAL,
	CHECK_MANUALS,
	COMPUTER_MANUAL,
	EXPORT_MANUAL,
	MATERIAL_MANUAL,
	RESEARCH_MANUAL,
	RESTORE_MANUAL,
	WRITING_MANUAL,
} from "../../src/writer/prompts/manuals.ts";
import { FETCH_METHODS, SEARCH_METHODS } from "../../src/writer/prompts/methods.ts";
import {
	dueStages,
	givenStages,
	PROMPT_STAGES,
	stageLines,
	stageText,
	WRITING_STAGE,
} from "../../src/writer/prompts/stages.ts";
import { styleCheck, styleClean } from "../../src/writer/style/check.ts";
import { setCurrentTopic } from "../../src/writer/topic/current.ts";

/** Total characters of some rules. */
const size = (rules: readonly string[]) => rules.join("\n").length;

/** Handlers of a fresh extension. */
function handlers(): Map<string, (event?: unknown) => unknown> {
	givenStages().clear();
	const map = new Map<string, (event?: unknown) => unknown>();
	writerPromptsExtension({
		on: (name: string, handler: (event?: unknown) => unknown) => map.set(name, handler),
	} as unknown as ExtensionAPI);
	return map;
}

/** A successful tool result as the hook gets it. */
const result = (toolName: string, method?: string) => ({
	toolName,
	input: { method },
	content: [{ type: "text", text: "结果" }],
	isError: false,
});

afterEach(() => {
	givenStages().clear();
	setCurrentTopic(undefined);
	vi.unstubAllEnvs();
});

describe("budgets", () => {
	it("keeps every text short", () => {
		expect(size(CORE_RULES)).toBeLessThanOrEqual(1000);
		expect(size(WRITING_MANUAL)).toBeLessThanOrEqual(1500);
		expect(size(RESEARCH_MANUAL)).toBeLessThanOrEqual(800);
		expect(size(BROWSER_MANUAL)).toBeLessThanOrEqual(800);
		expect(size(COMPUTER_MANUAL)).toBeLessThanOrEqual(800);
		for (const rules of [MATERIAL_MANUAL, EXPORT_MANUAL, RESTORE_MANUAL, ...Object.values(CHECK_MANUALS)])
			expect(size(rules)).toBeLessThanOrEqual(300);
		for (const rules of [...Object.values(SEARCH_METHODS), ...Object.values(FETCH_METHODS)])
			expect(size(rules)).toBeLessThanOrEqual(350);
		for (const prompt of [SUMMARY_PROMPT, SUMMARY_UPDATE_PROMPT, SUMMARY_TURN_PROMPT])
			expect(prompt.length).toBeLessThanOrEqual(400);
	});

	it("keeps the short skills short", () => {
		for (const name of [
			"academic-writing",
			"business-email",
			"general-article",
			"marketing-copy",
			"narrative-fiction",
			"news-feature",
			"report-analysis",
		]) {
			expect(readFileSync(`skills/writer/zh/${name}/SKILL.md`, "utf-8").length).toBeLessThanOrEqual(600);
		}
	});
});

describe("one place for each rule", () => {
	it("repeats no rule across the stages, apart from the human check of browser", () => {
		const shared = /human check|Only addresses in the results list/;
		const rules = [...CORE_RULES, ...PROMPT_STAGES.flatMap((s) => s.rules)].filter((r) => !shared.test(r));
		expect(new Set(rules).size).toBe(rules.length);
	});

	it("has a unique name for every stage, and covers every method", () => {
		const ids = PROMPT_STAGES.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const m of ["browser", "anysearch", "claude", "codex"]) expect(ids).toContain(`search_web:${m}`);
		for (const m of ["browser", "anysearch", "sf", "claude", "codex"]) expect(ids).toContain(`fetch_web:${m}`);
	});
});

describe("the user's requirements", () => {
	const writing = WRITING_MANUAL.join("\n");

	it.each([
		["the citation form", "2026年10月31日《路透社》报道"],
		["reference files", "《文件名》第3页"],
		["the reference list", "参考文献"],
		["a list entry", "[page title, publisher, date](full URL)"],
		["asking once about cases", "ask once which parts need cases or data"],
		["running the checks", "run style_check, word_count and readability_check, and gongwen_check on 公文"],
		["recording materials", "record what you will use with material_add"],
		["the paragraph form", "each paragraph opens with a summary"],
		["case fields", "time, reporter, subject, action"],
		["data fields", "time, region, industry, indicator, value"],
		["other parts", "Other parts are plain prose"],
		["no generic cases", "某企业"],
		["punctuation", "full-width punctuation"],
		["spaces", "only between English words"],
		["no remarks on reliability", "no remarks on reliability"],
		["the mechanism behind claims", "the mechanism behind each claim"],
		["attributed opinions", "attribute opinions"],
		["no verification markers", "no verification markers"],
		["positive argument", "不是……而是"],
		["no closing summary", "no summary or uplifting close"],
		["headings", "## to ####"],
		["arrows", "instead of arrows"],
	])("keeps %s", (_name, words) => {
		expect(writing).toContain(words);
	});

	it("keeps search on the user's request, one call at a time, with no default", () => {
		const core = CORE_RULES.join("\n");
		expect(core).toContain("never when told not to");
		expect(core).toContain("a draft comes only when the user asks for one");
		expect(core).toContain("one search_web or fetch_web at a time");
		expect(core).toContain("none is the default");
		expect(core).toContain("only when the user's prompt says the upstream supports them");
	});

	it("tells the time filter of each engine apart, and what pages means", () => {
		const browser = SEARCH_METHODS.browser.join("\n");
		expect(browser).toContain("year only on google and baidu");
		expect(browser).toContain("results pages per engine, 3 to 5");
	});

	it("makes the gongwen skill the default while it is on", () => {
		expect(defaultSkillRule([{ name: DEFAULT_SKILL }])[0]).toContain(DEFAULT_SKILL);
		expect(defaultSkillRule([{ name: DEFAULT_SKILL, disableModelInvocation: true }])).toEqual([]);
		expect(defaultSkillRule([])).toEqual([]);
	});
});

describe("denials", () => {
	const flagged = (text: string) => styleCheck(text).hits.length > 0;

	it.each([
		"这并不意味着市场已经饱和。",
		"增长不等于发展。",
		"效率不是目的。",
		"这不代表企业没有责任。",
		"这并非技术问题。",
		"这不只是成本问题。",
		"这不仅仅是政策问题。",
		"问题不在于资金。",
		"关键不是规模，而是质量。",
		"This does not mean the market is saturated.",
		"Growth is not development.",
		"It is not a technical problem.",
		"This isn't about cost.",
		"That doesn't mean we should stop.",
		"It's not just cost.",
		"This is not to say that it failed.",
	])("marks %s", (text) => {
		expect(flagged(text)).toBe(true);
		expect(styleClean(styleCheck(text))).toBe(false);
	});

	it.each(["这是不是真的？", "要不是下雨，活动就办了。", "市场已经饱和。", "Growth needs investment."])(
		"leaves %s alone",
		(text) => {
			expect(flagged(text)).toBe(false);
		},
	);

	it("asks the same question in chat and in documents", () => {
		const core = CORE_RULES.join("\n");
		expect(core).toContain("in chat and in documents");
		expect(core).toContain("ask who claimed Y");
		expect(core).toContain("if nobody did, drop the sentence");
		const rules = CHECK_MANUALS.style_check.join("\n");
		expect(rules).toContain("delete it if it denies what nobody claimed");
		expect(rules).toContain("keep a denial that answers a real claim");
		expect(rules).not.toContain("until it passes");
	});
});

describe("nothing assumes a writing task", () => {
	it("asks a compaction summary about any session", () => {
		for (const prompt of [SUMMARY_PROMPT, SUMMARY_TURN_PROMPT, SUMMARY_UPDATE_PROMPT]) {
			expect(prompt).not.toMatch(/writing session|drafts|cases/);
		}
	});

	it("keeps a style report from demanding a clean pass", () => {
		expect(t("style.advice", {}, "en")).not.toContain("again");
		expect(t("style.advice", {}, "zh")).not.toContain("再运行");
	});
});

describe("a general-purpose agent", () => {
	it("says so, and limits the document rules to documents", () => {
		expect(WRITER_PREAMBLE).toContain("general-purpose agent");
		expect(WRITER_PREAMBLE).not.toMatch(/writing|research/i);
		expect(CORE_RULES.join("\n")).toContain("In a document, take every case");
		expect(CORE_RULES.join("\n")).toContain("When writing a document, keep it");
	});
});

describe("dueStages", () => {
	it("picks by tool and method, and leaves out what was given", () => {
		const first = dueStages("search_web", { method: "codex" }, new Set()).map((s) => s.id);
		expect(first).toEqual(["research", "search_web:codex"]);
		expect(dueStages("search_web", { method: "browser" }, new Set(first)).map((s) => s.id)).toEqual([
			"search_web:browser",
		]);
		expect(dueStages("ls", {}, new Set())).toEqual([]);
	});

	it("gives the writing rules when writing starts, and never for research alone", () => {
		const ids = (tool: string, input: Record<string, unknown>) => dueStages(tool, input, new Set()).map((s) => s.id);
		expect(ids("topic_open", {})).toEqual([]);
		expect(ids("search_web", { method: "codex" })).not.toContain(WRITING_STAGE);
		expect(ids("fetch_web", { method: "sf" })).not.toContain(WRITING_STAGE);
		expect(ids("read", { path: "notes.md" })).toEqual([]);
		expect(ids("read", { path: "/skills/report-analysis/SKILL.md" })).toEqual([WRITING_STAGE]);
		expect(ids("write", { path: "稿.md" })).toEqual([WRITING_STAGE]);
		expect(ids("edit", { path: "稿.md" })).toEqual([WRITING_STAGE]);
	});

	it("shows the table with what was given", () => {
		givenStages().add(WRITING_STAGE);
		const lines = stageLines();
		expect(lines).toHaveLength(PROMPT_STAGES.length);
		expect(lines[0]).toMatch(/^✓ Writing rules: write, edit, SKILL\.md, \d+ chars$/);
		expect(lines[1]).toMatch(/^· Research rules/);
	});
});

describe("the extension", () => {
	it("appends a stage to the first success only, after the tool's own text", () => {
		const on = handlers().get("tool_result");
		const first = on?.(result("write")) as { content: { text: string }[] };
		expect(first.content[0].text).toBe("结果");
		expect(first.content[1].text).toContain("Writing rules:");
		expect(on?.(result("write"))).toBeUndefined();
	});

	it("adds nothing to opening a topic", () => {
		expect(handlers().get("tool_result")?.(result("topic_open"))).toBeUndefined();
	});

	it("gives nothing for a failed call", () => {
		const on = handlers().get("tool_result");
		expect(on?.({ ...result("write"), isError: true })).toBeUndefined();
		expect(givenStages().size).toBe(0);
	});

	it("gives the writing rules to a draft written without a topic", () => {
		const out = handlers().get("tool_result")?.(result("write")) as { content: { text: string }[] };
		expect(out.content[1].text).toContain("Writing rules:");
	});

	it("gives research rules once, and each method's rules once", () => {
		const on = handlers().get("tool_result");
		const a = on?.(result("search_web", "codex")) as { content: { text: string }[] };
		expect(a.content[1].text).toContain("Research rules:");
		expect(a.content[1].text).toContain("Method codex of search_web:");
		const b = on?.(result("search_web", "browser")) as { content: { text: string }[] };
		expect(b.content[1].text).not.toContain("Research rules:");
		expect(b.content[1].text).toContain("Method browser of search_web:");
		expect(on?.(result("search_web", "codex"))).toBeUndefined();
	});

	it("forgets what was given after compaction", () => {
		const map = handlers();
		map.get("tool_result")?.(result("write"));
		map.get("session_compact")?.();
		expect(givenStages().size).toBe(0);
		expect(map.get("tool_result")?.(result("write"))).toBeDefined();
	});

	it("adds nothing to a run in a topic where only research happened, also after compaction", () => {
		const map = handlers();
		setCurrentTopic("/tmp/主题");
		map.get("tool_result")?.(result("search_web", "codex"));
		expect(map.get("before_agent_start")?.()).toBeUndefined();
		map.get("session_compact")?.();
		expect(map.get("before_agent_start")?.()).toBeUndefined();
	});

	it("gives the writing rules back after compaction when a document is under way, once", () => {
		const map = handlers();
		map.get("tool_result")?.(result("write"));
		map.get("session_compact")?.();
		const out = map.get("before_agent_start")?.() as { message: { content: string; display: boolean } };
		expect(out.message.content).toBe(stageText(PROMPT_STAGES[0]));
		expect(out.message.display).toBe(false);
		expect(map.get("before_agent_start")?.()).toBeUndefined();
	});
});
