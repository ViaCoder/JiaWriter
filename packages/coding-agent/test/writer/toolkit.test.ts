// The toolkits: the table, the detection of a request's toolkit, the text a toolkit brings, opening through a
// stand-in pi, and the extension (tool, command, before_agent_start, resend after compaction).

// Test API.
import { afterEach, describe, expect, it, vi } from "vitest";
// Extension API types.
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
// The extension.
import writerToolkitExtension, { TOOLKIT_MESSAGE } from "../../src/extensions/writer-toolkit/index.ts";
// The stage-0 rules, which must name no toolkit tool.
import { CORE_RULES } from "../../src/writer/prompts/core.ts";
// The stages given so far.
import { givenStages } from "../../src/writer/prompts/stages.ts";
import { openToolkit } from "../../src/writer/toolkit/open.ts";
import {
	DEFAULT_SKILL,
	defaultSkillRule,
	detectToolkits,
	openToolkits,
	TOOLKIT_IDS,
	TOOLKIT_RULE,
	TOOLKITS,
	toolkitLines,
	toolkitText,
	toolkitTools,
	USER_TURNS_NOTE,
} from "../../src/writer/toolkit/toolkits.ts";

/** The skills as offered in tests. */
const SKILLS = [
	{ name: "gongwen-writing", description: "公文", path: "/s/gongwen-writing/SKILL.md" },
	{ name: "academic-writing", description: "Papers", path: "/s/academic-writing/SKILL.md" },
	{ name: "deep-research", description: "Research", path: "/s/deep-research/SKILL.md" },
];

/** A stand-in pi that keeps an active tool set. */
function fakePi(active: string[] = ["read", "write", "bash"]) {
	return {
		active,
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active.length = 0;
			active.push(...names);
		},
	};
}

afterEach(() => {
	givenStages().clear();
	vi.unstubAllEnvs();
});

describe("the table", () => {
	it("names five toolkits, each with tools, and the core rule names each of them", () => {
		expect(TOOLKIT_IDS).toEqual(["writing", "research", "office", "browser", "computer"]);
		for (const id of TOOLKIT_IDS) {
			expect(TOOLKITS[id].tools.length).toBeGreaterThan(0);
			expect(TOOLKIT_RULE).toContain(`(${id})`);
		}
		// Stage 0 names no toolkit tool: the core rules are for any request; the toolkit rule names the toolkits only.
		const core = CORE_RULES.filter((r) => r !== TOOLKIT_RULE).join("\n");
		for (const tool of toolkitTools()) expect(core).not.toContain(tool);
		expect(CORE_RULES).toContain(TOOLKIT_RULE);
	});

	it("lists the toolkits for /jw prompts with their state and size", () => {
		const lines = toolkitLines(["read", ...TOOLKITS.research.tools]);
		expect(lines).toHaveLength(TOOLKIT_IDS.length);
		expect(lines[0]).toMatch(/^· Toolkit writing: topic_open, .*, \d+ chars$/);
		expect(lines[1]).toMatch(/^✓ Toolkit research: search_web, fetch_web, topic_open, material_add, \d+ chars$/);
	});

	it("knows which toolkits are open from the active tools", () => {
		expect(openToolkits(["read", "write"])).toEqual([]);
		expect(openToolkits(["read", ...TOOLKITS.research.tools])).toEqual(["research"]);
		// The office tools are part of writing: both count as open.
		expect(openToolkits(["read", ...TOOLKITS.writing.tools])).toEqual(["writing", "office"]);
	});
});

describe("detectToolkits", () => {
	it.each([
		["写一份关于安全生产的通知", ["writing"]],
		["帮我起草一个工作方案", ["writing"]],
		["写一篇文章", ["writing"]],
		["查一下低空经济的最新政策", ["research"]],
		["搜索最近关于芯片出口的报道", ["research"]],
		["深度研究一下氢能产业", ["research"]],
		["把 报告.md 导出成 docx", ["office"]],
		["打开公司官网看看最新公告", ["browser"]],
		["打开记事本应用输入一行字", ["computer"]],
		["查一下最新报道再写一份简报", ["writing", "research"]],
	])("%s → %j", (prompt, ids) => {
		expect(detectToolkits(prompt)).toEqual(ids);
	});

	it.each([
		"你好",
		"什么是低空经济？两三句话说明。",
		"把这个文件夹里的文件按类型分到子文件夹里",
		"看看 说明.md 写了什么",
		"今天星期几",
		// Code and chores are not documents (2026-11-15).
		"帮我写一个 Python 脚本，把 CSV 转成 JSON",
		"写个函数算平均数",
		"把下面三句话整理成一段话写进 说明.md",
	])("opens nothing for %s", (prompt) => {
		expect(detectToolkits(prompt)).toEqual([]);
	});
});

describe("toolkitText", () => {
	it("gives the writing toolkit its tools, rules, the writing stage, its skills, the default skill and the turns note", () => {
		const text = toolkitText("writing", { skills: SKILLS, hasUI: true });
		expect(text).toContain("Toolkit writing is open");
		expect(text).toContain("draft_section");
		expect(text).toContain("Writing rules:");
		expect(text).toContain("Cite only where the type expects it");
		expect(text).toContain("- gongwen-writing: 公文 (/s/gongwen-writing/SKILL.md)");
		expect(text).toContain("- academic-writing");
		expect(text).not.toContain("deep-research");
		expect(text).toContain(defaultSkillRule([{ name: DEFAULT_SKILL }])[0]);
		expect(text).toContain(USER_TURNS_NOTE);
		// Without an interface there are no turns.
		expect(toolkitText("writing", { skills: SKILLS, hasUI: false })).not.toContain(USER_TURNS_NOTE);
		// The default skill turned off: no default rule.
		expect(toolkitText("writing", { skills: SKILLS.slice(1), hasUI: false })).not.toContain("read the gongwen");
	});

	it("gives the research toolkit the research stage, one call at a time, and the verification rule", () => {
		const text = toolkitText("research", { skills: SKILLS, hasUI: true });
		expect(text).toContain("Research rules:");
		expect(text).toContain("one search_web or fetch_web at a time");
		expect(text).toContain("captcha, slider, robot test");
		expect(text).toContain("- deep-research");
		expect(text).not.toContain(USER_TURNS_NOTE);
	});

	it("keeps every toolkit text short", () => {
		for (const id of TOOLKIT_IDS)
			expect(toolkitText(id, { skills: SKILLS, hasUI: true }).length).toBeLessThan(id === "writing" ? 5200 : 2000);
	});
});

describe("openToolkit", () => {
	it("adds the tools once, marks the stage given, and says whether it was closed", () => {
		const pi = fakePi();
		const first = openToolkit(pi, "research", { hasUI: false, skills: SKILLS });
		expect(first.opened).toBe(true);
		expect(pi.active).toEqual(["read", "write", "bash", ...TOOLKITS.research.tools]);
		expect(givenStages().has("research")).toBe(true);
		const again = openToolkit(pi, "research", { hasUI: false, skills: SKILLS });
		expect(again.opened).toBe(false);
		expect(pi.active).toHaveLength(3 + TOOLKITS.research.tools.length);
	});
});

describe("the extension", () => {
	/** The extension on a stand-in pi: its tool, commands, handlers and the messages it sent. */
	function load(active: string[] = ["read", "write", "bash"]) {
		const pi = fakePi(active);
		const tools = new Map<string, ToolDefinition>();
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
		const sent: string[] = [];
		const api = {
			...pi,
			registerTool: (t: ToolDefinition) => tools.set(t.name, t),
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, options),
			on: (name: string, handler: (event?: unknown, ctx?: unknown) => unknown) => handlers.set(name, handler),
			sendUserMessage: (text: string) => sent.push(text),
		} as unknown as ExtensionAPI;
		writerToolkitExtension(api);
		return { pi, tools, commands, handlers, sent };
	}
	const notices: string[] = [];
	const ctx = { hasUI: true, cwd: "/tmp", ui: { notify: (text: string) => notices.push(text) } };

	it("opens a toolkit with the tool and returns its text; a second call says it was open", async () => {
		const { pi, tools } = load();
		const run = (name: string) =>
			tools.get("toolkit")?.execute("c", { name }, undefined, undefined, ctx as never) as Promise<{
				content: { text: string }[];
				details: { opened: boolean };
			}>;
		const r = await run("research");
		expect(r.details.opened).toBe(true);
		expect(r.content[0].text).toContain("Toolkit research is open");
		expect(openToolkits(pi.active)).toEqual(["research"]);
		expect((await run("research")).details.opened).toBe(false);
	});

	it("opens the toolkit a request plainly asks for, before the run, in a hidden message, once", () => {
		const { pi, handlers } = load();
		const start = (prompt: string) =>
			handlers.get("before_agent_start")?.({ messageType: "user", prompt }, ctx) as
				| { message: { customType: string; content: string; display: boolean } }
				| undefined;
		expect(start("你好")).toBeUndefined();
		const out = start("写一份关于安全生产的通知");
		expect(out?.message).toMatchObject({ customType: TOOLKIT_MESSAGE, display: false });
		expect(out?.message.content).toContain("Toolkit writing is open");
		expect(openToolkits(pi.active)).toEqual(["writing", "office"]);
		// Open already: nothing more.
		expect(start("再写一份通知")).toBeUndefined();
	});

	it("gives a toolkit's text once even when an allowlist keeps one of its tools out", () => {
		// A pi that registers no style_check: the writing toolkit can never have every tool of its active.
		const { pi, handlers } = load(["read"]);
		const setAll = pi.setActiveTools;
		pi.setActiveTools = (names: string[]) => setAll(names.filter((n) => n !== "style_check"));
		const start = () =>
			handlers.get("before_agent_start")?.({ messageType: "user", prompt: "写一份通知" }, ctx) as
				| { message: { content: string } }
				| undefined;
		expect(start()?.message.content).toContain("Toolkit writing is open");
		expect(pi.active).toContain("draft_section");
		expect(start()).toBeUndefined();
	});

	it("gives the open toolkits' texts again after compaction", () => {
		const { handlers } = load(["read", ...TOOLKITS.research.tools]);
		expect(handlers.get("before_agent_start")?.({ messageType: "user", prompt: "继续" }, ctx)).toBeUndefined();
		handlers.get("session_compact")?.();
		const out = handlers.get("before_agent_start")?.({ messageType: "user", prompt: "继续" }, ctx) as {
			message: { content: string };
		};
		expect(out.message.content).toContain("Toolkit research is open");
		expect(handlers.get("before_agent_start")?.({ messageType: "user", prompt: "继续" }, ctx)).toBeUndefined();
	});

	it("/write and /research send the argument as the request; /search asks for sources only; no argument gives a hint", async () => {
		const { pi, commands, sent } = load();
		notices.length = 0;
		await commands.get("write")?.handler("写一份会议纪要", ctx);
		expect(openToolkits(pi.active)).toContain("writing");
		expect(sent).toEqual(["写一份会议纪要"]);
		await commands.get("search")?.handler("低空经济 政策", ctx);
		expect(sent[1]).toContain("低空经济 政策");
		expect(openToolkits(pi.active)).toContain("research");
		await commands.get("computer")?.handler("", ctx);
		expect(openToolkits(pi.active)).toContain("computer");
		expect(notices.some((n) => n.includes("桌面"))).toBe(true);
	});
});
