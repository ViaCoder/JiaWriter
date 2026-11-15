/**
 * Toolkits (2026-11-15, the user: writing tasks and their tools "should not clutter the initial context—they should
 * only appear when actually invoked", with "/xxx" commands where detection is unsure). The general tools (read,
 * write, edit, bash, grep, find, ls, todo_write, ask_user, delegate) are always there. The tools of writing, web
 * research, Office files, the browser, the desktop and scheduled tasks are registered deferred and reach the model
 * only when their toolkit is opened: by the model with the `toolkit` tool, by the user with a command, or by the
 * program when the request names the work plainly (detectToolkits). A toolkit brings its rules once, with the
 * opening; stage 0 (prompts/core.ts) carries none of them.
 */

// The texts a toolkit brings: its stage of the prompt table, rendered as the model reads it.
import { PROMPT_STAGES, stageText } from "../prompts/stages.ts";

/** The toolkits, in the order the model is told of them. */
export const TOOLKIT_IDS = ["writing", "research", "office", "browser", "computer", "schedule"] as const;
export type ToolkitId = (typeof TOOLKIT_IDS)[number];

/** One toolkit. */
export interface Toolkit {
	id: ToolkitId;
	// The tools it declares to the model.
	tools: readonly string[];
	// Stages of the prompt table given with the opening (their text comes along, and counts as given).
	stages: readonly string[];
	// Rules of its own, one sentence each.
	rules: readonly string[];
	// Built-in skills it offers, by name.
	skills: readonly string[];
}

/** The skill read for a document with no genre named (the user, 2026-11-05). */
export const DEFAULT_SKILL = "gongwen-writing";

/** The rule that makes that skill the default, when it is offered. */
export function defaultSkillRule(skills: readonly { name: string }[]): string[] {
	// Turned off in /skills: the rule goes with it.
	if (!skills.some((s) => s.name === DEFAULT_SKILL)) return [];
	return [`When asked to write a document and no genre is named, read the ${DEFAULT_SKILL} skill first and follow it`];
}

/**
 * With a user who answers between turns (2026-11-09: the rule reached a run only with its first write, after it had
 * written the whole report in the turn meant for the outline). Short documents are written at once (2026-11-09: a
 * notice of a few hundred characters came as its opening only, and the user's later changes went to the outline).
 */
export const USER_TURNS_NOTE =
	"The user answers between turns. Write a long document (a report of some thousands of characters) over turns, unless they ask for it at once: show the outline and stop for their word; then one section per turn, ending with one line on what it covered and what comes next, and stop: their reply decides whether to revise it or go on. A short one (a notice, a letter, a brief) is written whole in one turn";

/**
 * A verification check is the user's to pass (the user, 2026-11-09: "add prompt request model not repeatedly attempt
 * to bypass verification mechanisms"; three of three runs at a slider wall dragged, clicked, ran page scripts and
 * probed the site with curl). fetch_web is named as usable, since its sf method passes some checks itself (the user's
 * compatibility handling, 59f66f31b).
 */
export const VERIFICATION_RULE =
	"A verification check (captcha, slider, robot test) is the user's to pass: do not try to solve or get around it (dragging, clicking, page scripts, shell requests to the site); say once what the user must do and stop. fetch_web's methods stay usable as they are";

/** The toolkits. */
export const TOOLKITS: Readonly<Record<ToolkitId, Toolkit>> = {
	writing: {
		id: "writing",
		tools: [
			"topic_open",
			"material_add",
			"draft_section",
			"style_check",
			"word_count",
			"readability_check",
			"draft_restore",
			"import_document",
			"export_document",
		],
		stages: ["writing"],
		rules: [
			"Before a topic's first document, use topic_open with 1–3 key words; the same words continue",
			"Keep a document in a Markdown file, the document alone with no notes about it",
			// What was done counts as a fact too (2026-11-09: two reports opened with surveys and checks nobody made).
			"In a document, take every case, figure and account of work done (surveys, visits) from the reference materials or search results",
		],
		skills: [DEFAULT_SKILL, "academic-writing"],
	},
	research: {
		id: "research",
		tools: ["search_web", "fetch_web", "topic_open", "material_add"],
		stages: ["research"],
		rules: [
			"Before a topic's first search, use topic_open with 1–3 key words; the same words continue",
			// The user, 2026-11-08: no search unless asked, "since now do not have good enough search engine".
			"Search for what the user asked and stop there: results and sources are the answer; a document comes only when they ask for one",
			"Run one search_web or fetch_web at a time and name its method: none is the default. If it fails, let the user choose the next",
			"Use methods claude and codex only when the user's prompt says the upstream supports them: claude for Claude models, codex for Codex and GPT models",
			VERIFICATION_RULE,
		],
		skills: ["deep-research"],
	},
	office: {
		id: "office",
		tools: ["import_document", "export_document"],
		stages: [],
		rules: ["An import or export leaves the source file as it is; name the file it produced in the reply"],
		skills: [],
	},
	browser: {
		id: "browser",
		tools: ["browser"],
		stages: [],
		rules: [VERIFICATION_RULE],
		skills: [],
	},
	computer: { id: "computer", tools: ["computer"], stages: [], rules: [], skills: [] },
	schedule: { id: "schedule", tools: ["schedule_task"], stages: [], rules: [], skills: [] },
};

/** The core rule that tells the model of the toolkits (stage 0). */
export const TOOLKIT_RULE =
	"Tools for documents (writing), web research (research), Word, Excel, PowerPoint and PDF files (office), web pages in Chrome (browser), desktop applications (computer) and tasks run at set times (schedule) come in toolkits: open the one the request needs with the toolkit tool before the first such step; chat, questions and file work need none";

/** Every tool some toolkit declares. */
export function toolkitTools(): string[] {
	return [...new Set(TOOLKIT_IDS.flatMap((id) => TOOLKITS[id].tools))];
}

/** The toolkits whose tools are all active: what is open, derived from the active tool set pi keeps and restores. */
export function openToolkits(active: readonly string[]): ToolkitId[] {
	return TOOLKIT_IDS.filter((id) => TOOLKITS[id].tools.every((tool) => active.includes(tool)));
}

/** A built-in skill as the toolkit text offers it. */
export interface OfferedSkill {
	name: string;
	description: string;
	// The SKILL.md file.
	path: string;
}

/** The text the model reads when a toolkit opens: its tools, its rules, its stage, its skills, and the turns note. */
export function toolkitText(id: ToolkitId, opts: { skills: readonly OfferedSkill[]; hasUI: boolean }): string {
	const kit = TOOLKITS[id];
	const lines = [`Toolkit ${id} is open; these tools are available now: ${kit.tools.join(", ")}.`];
	if (kit.rules.length > 0) lines.push(...kit.rules.map((rule) => `- ${rule}`));
	for (const stageId of kit.stages) {
		const stage = PROMPT_STAGES.find((s) => s.id === stageId);
		if (stage) lines.push("", stageText(stage));
	}
	// The skills of this toolkit that are offered (turned on), with the file to read.
	const offered = opts.skills.filter((s) => kit.skills.includes(s.name));
	if (offered.length > 0) {
		lines.push("", "Skills (read the file with read when the task matches, and follow it):");
		for (const s of offered) lines.push(`- ${s.name}: ${s.description} (${s.path})`);
		if (id === "writing") lines.push(...defaultSkillRule(offered).map((rule) => `- ${rule}`));
	}
	if (id === "writing" && opts.hasUI) lines.push("", USER_TURNS_NOTE);
	return lines.join("\n");
}

/** Genres a request names when it asks for a document. */
const GENRES =
	"通知|报告|讲话|发言|致辞|演讲|方案|总结|简报|请示|批复|函|纪要|汇报|文章|论文|综述|摘要|稿|公文|意见|计划|规划|新闻|通报|决定|公告|启事|倡议|贺信|感谢信|申请|解读|评论|社论|序言|前言|后记|教案|课件|标书|合同|协议|章程|细则|办法|规定|条例";

/**
 * The toolkits a request plainly asks for, by its words alone, in priority order: writing when it asks to write a
 * named kind of document; research when it asks to search or look something up; office for a named file format;
 * schedule for a repeated time; browser and computer for a page or an application to act on. Unsure wording opens
 * nothing: the model's toolkit call and the user's commands cover it (the user, 2026-11-15).
 */
export function detectToolkits(prompt: string): ToolkitId[] {
	const text = prompt.replace(/\s+/g, " ");
	const found: ToolkitId[] = [];
	if (
		new RegExp(`(写|撰写|起草|拟|草拟|改写|润色|扩写|缩写|续写|修改|完善)[^。！？\\n]{0,14}(${GENRES})`).test(text) ||
		/写一(篇|份|段|个|则|封|版|稿)/.test(text) ||
		/(帮我|请|给我)(写|起草|拟)/.test(text) ||
		/\b(write|draft) (a|an|the|me)\b/i.test(text)
	)
		found.push("writing");
	if (
		/(检索|搜索|搜一下|搜一搜|搜搜|查一下|查查|查找|找一下|找找|上网查|网上查|查阅|查询|搜集|收集|了解一下)[^。！？\n]{0,24}(最新|资料|新闻|报道|信息|情况|数据|文献|进展|动态|来源|消息|政策|案例|网页|网上|互联网)/.test(
			text,
		) ||
		/(最新|近期|最近|今年|本月)[^。！？\n]{0,12}(报道|新闻|进展|动态|消息|数据)/.test(text) ||
		/深度(研究|调研|检索)|做一个?(调研|研究)|研究一下/.test(text) ||
		/\b(search|research|look up)\b/i.test(text)
	)
		found.push("research");
	if (
		/(导出|转成|转为|另存为|生成|做成|输出|保存为)[^。！？\n]{0,12}(word|docx|excel|xlsx|ppt|pptx|幻灯片|表格文件)/i.test(
			text,
		) ||
		/(导入|读取|解析|打开|看看|提取)[^。！？\n]{0,12}(pdf|docx|word|excel|xlsx|pptx|ppt)/i.test(text)
	)
		found.push("office");
	if (
		/(每天|每日|每周|每月|工作日|定时|定期|到点|每隔|每小时)[^。！？\n]{0,16}(运行|执行|提醒|跑|做|生成|发|整理|检查|汇总|更新)|定时任务/.test(
			text,
		)
	)
		found.push("schedule");
	if (/(打开|登录|访问|浏览|进入)[^。！？\n]{0,14}(网站|网页|页面|后台|官网|系统)|用浏览器|在浏览器里/.test(text))
		found.push("browser");
	if (/(打开|操作|控制|点击)[^。！？\n]{0,10}(应用|软件|窗口|桌面|程序)|桌面应用|桌面软件/.test(text))
		found.push("computer");
	return found;
}
