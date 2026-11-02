// Functional tests for the built-in writer-skills extension (src/extensions/writer-skills/index.ts):
// the shipped skills, resources_discover, and the /skills and /skill-new flows with a scripted UI.

// Files.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Built-in skills folder.
import { getWriterSkillsDir } from "../../src/config.ts";
// Extension API types.
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
// Session entry type.
import type { SessionEntry } from "../../src/core/session-manager.ts";
// Skill loader.
import { loadSkillsFromDir } from "../../src/core/skills.ts";
// Extension under test.
import writerSkillsExtension, { skillLabel } from "../../src/extensions/writer-skills/index.ts";
// Style check for the shipped texts.
import { styleCheck } from "../../src/writer/style/check.ts";

// Agent folder of each test.
let agent = "";
beforeEach(() => {
	agent = mkdtempSync(join(tmpdir(), "wa-skillext-"));
	vi.stubEnv("WA_DIR", agent);
	vi.stubEnv("WA_LANG", "zh");
});
afterEach(() => {
	rmSync(agent, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** Registrations of a fresh extension instance. */
function load() {
	// Collected handlers.
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const handlers = new Map<string, () => { skillPaths: string[] }>();
	const sent: string[] = [];
	const pi = {
		registerCommand: (name: string, o: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, o.handler),
		on: (name: string, h: () => { skillPaths: string[] }) => handlers.set(name, h),
		sendUserMessage: (text: string) => sent.push(text),
	} as unknown as ExtensionAPI;
	writerSkillsExtension(pi);
	return { commands, handlers, sent };
}

/** A UI that answers from a script; select answers are labels or a predicate over the options. */
function scriptedUi(script: (string | boolean | undefined | ((options: string[]) => string))[]) {
	// Recorded notes and dialogs.
	const notes: string[] = [];
	const shown: string[] = [];
	const next = (options?: string[]) => {
		const a = script.shift();
		return typeof a === "function" ? a(options ?? []) : a;
	};
	const ui = {
		select: async (title: string, options: string[]) => {
			shown.push(title);
			return next(options);
		},
		input: async () => next(),
		editor: async (_title: string, prefill: string) => {
			const a = next();
			return a === "=" ? prefill : typeof a === "string" ? a.replace("{prefill}", prefill) : a;
		},
		confirm: async (title: string, body: string) => {
			shown.push(`${title}\n${body}`);
			return next() === true;
		},
		notify: (m: string) => notes.push(m),
	};
	return { ui, notes, shown };
}

/** Command context with a session of user messages. */
function ctx(ui: unknown, messages: string[] = []) {
	// Branch entries.
	const branch = messages.map(
		(content, i) => ({ type: "message", id: `m${i}`, message: { role: "user", content } }) as unknown as SessionEntry,
	);
	return { ui, cwd: agent, hasUI: true, sessionManager: { getBranch: () => branch } };
}

/** Pick the option that starts with or contains the text. */
const pick = (text: string) => (options: string[]) => options.find((o) => o.includes(text)) ?? "";

describe("shipped skills", () => {
	it("has the same nine valid skills in zh and en, each of our own free of style_check hits", () => {
		// Names per language.
		const names = (lang: string) => readdirSync(join(getWriterSkillsDir(), lang)).sort();
		expect(names("zh")).toEqual([
			"academic-writing",
			"business-email",
			"general-article",
			"lieflat-gongwen",
			"marketing-copy",
			"narrative-fiction",
			"news-feature",
			"report-analysis",
			"skill-creator",
		]);
		expect(names("en")).toEqual(names("zh"));
		for (const lang of ["zh", "en"]) {
			// Loader accepts all of them.
			const r = loadSkillsFromDir({ dir: join(getWriterSkillsDir(), lang), source: "path" });
			expect([r.skills.length, r.diagnostics]).toEqual([9, []]);
			// No AI-style hits and no negation over the threshold (lieflat-gongwen is third-party text, kept as written).
			for (const s of r.skills.filter((x) => x.name !== "lieflat-gongwen")) {
				const body = readFileSync(s.filePath, "utf-8").replace(/^---[\s\S]*?---\n/, "");
				const rep = styleCheck(body, { packs: [lang === "zh" ? "core-zh" : "core-en"] });
				expect([s.name, rep.hits.length, rep.negation.over]).toEqual([s.name, 0, false]);
			}
		}
	});
});

describe("resources_discover", () => {
	it("offers the built-ins of WA_LANG that are turned on", () => {
		// All nine in Chinese.
		const { handlers } = load();
		expect(handlers.get("resources_discover")?.().skillPaths).toHaveLength(9);
		expect(handlers.get("resources_discover")?.().skillPaths[0]).toBe(
			join(getWriterSkillsDir(), "zh", "academic-writing"),
		);
		// English folder with WA_LANG=en.
		vi.stubEnv("WA_LANG", "en");
		expect(handlers.get("resources_discover")?.().skillPaths[0]).toBe(
			join(getWriterSkillsDir(), "en", "academic-writing"),
		);
	});
});

describe("/skills", () => {
	it("turns one and all off and on, edits a built-in as the user's copy, and deletes after a backup", async () => {
		const { commands, handlers } = load();
		// Off for one built-in, then leave.
		let s = scriptedUi([pick("报告分析"), pick("停用"), undefined]);
		await commands.get("skills")?.("", ctx(s.ui));
		expect(s.shown[0]).toBe("写作 skill（9 个）：方向键选择，回车确认，Esc 返回");
		expect(s.notes).toEqual(["report-analysis 已停用。运行 /reload 生效。"]);
		expect(handlers.get("resources_discover")?.().skillPaths).toHaveLength(8);
		// All off, all on.
		s = scriptedUi(["全部停用", "全部启用", undefined]);
		await commands.get("skills")?.("", ctx(s.ui));
		expect(s.notes).toEqual(["8 个 skill 已停用。运行 /reload 生效。", "9 个 skill 已启用。运行 /reload 生效。"]);
		// Edit a built-in: unchanged first, then a change.
		s = scriptedUi([
			pick("新闻特稿"),
			pick("编辑"),
			"=",
			pick("新闻特稿"),
			pick("编辑"),
			"{prefill}\n- 新增一条。",
			undefined,
		]);
		await commands.get("skills")?.("", ctx(s.ui));
		expect(s.notes[0]).toBe("内容没有变化，未保存。");
		expect(s.notes[1]).toBe(
			`已保存：${join(agent, "skills", "news-feature", "SKILL.md")}（原文件已备份到 ${join(agent, "skills-backup")}${s.notes[1].split("skills-backup")[1].split("）")[0]}）。运行 /reload 生效。`,
		);
		expect(readFileSync(join(agent, "skills", "news-feature", "SKILL.md"), "utf-8").endsWith("- 新增一条。")).toBe(
			true,
		);
		// Delete the user's copy, which now replaces the built-in and shows as mine (confirmed), then a built-in (turned off instead).
		s = scriptedUi([pick("news-feature，我的"), pick("删除"), true, pick("营销文案"), pick("删除"), undefined]);
		await commands.get("skills")?.("", ctx(s.ui));
		expect(s.notes[0].startsWith("已删除 news-feature，备份在 ")).toBe(true);
		expect(s.notes[1]).toBe("内置 skill 保留在程序中，已改为停用：marketing-copy。");
		expect(existsSync(join(agent, "skills", "news-feature"))).toBe(false);
	});
	it("updates a user skill from this session after showing the diff", async () => {
		const { commands } = load();
		// A user skill from a blank template first (through /skill-new).
		let s = scriptedUi([pick("空白模板"), "my-report", "我的报告", "写报告时用", pick("中文"), "=", true]);
		await commands.get("skill-new")?.("", ctx(s.ui));
		expect(s.notes[0]).toBe(`已保存：${join(agent, "skills", "my-report", "SKILL.md")}。运行 /reload 生效。`);
		// Update it from a session with two font-size requests: the diff keeps only the later one.
		s = scriptedUi([pick("我的报告"), pick("用当前会话更新"), true, undefined]);
		await commands.get("skills")?.("", ctx(s.ui, ["正文用三号字。", "字号改成小二。"]));
		const diffDialog = s.shown.find((x) => x.startsWith("用当前会话更新 my-report")) ?? "";
		expect(diffDialog).toContain("+- 字号改成小二。");
		expect(diffDialog).not.toContain("三号");
		expect(s.notes).toContain("（同一主题以最后一次为准，已略去 1 条较早的要求）");
		expect(readFileSync(join(agent, "skills", "my-report", "SKILL.md"), "utf-8")).toContain(
			"## 排版\n\n- 字号改成小二。",
		);
		// A backup of the blank version exists.
		expect(readdirSync(join(agent, "skills-backup")).some((d) => d.startsWith("my-report-"))).toBe(true);
	});
});

describe("/skill-new", () => {
	it("creates from the session, refuses bad names and empty sessions, and hands the guided way to the model", async () => {
		const { commands, sent } = load();
		// From the session, English.
		let s = scriptedUi([pick("从当前会话生成"), "brief-notes", "Briefs", "Short briefs", pick("English"), "=", true]);
		await commands.get("skill-new")?.("", ctx(s.ui, ["Keep every brief under 300 words.", "ok"]));
		const file = readFileSync(join(agent, "skills", "brief-notes", "SKILL.md"), "utf-8");
		expect(file).toContain("## Structure and length\n\n- Keep every brief under 300 words.");
		// The confirmation shows the start of the draft.
		expect(
			s.shown
				.at(-1)
				?.startsWith(`写入 ${join(agent, "skills", "brief-notes", "SKILL.md")}？\n---\nname: brief-notes`),
		).toBe(true);
		// A bad name, an empty session, a cancelled save.
		s = scriptedUi([pick("空白模板"), "Bad Name"]);
		await commands.get("skill-new")?.("", ctx(s.ui));
		expect(s.notes[0]).toContain("名称「Bad Name」不符合规则");
		s = scriptedUi([pick("从当前会话生成"), "x1", "X", "d", pick("中文")]);
		await commands.get("skill-new")?.("", ctx(s.ui, ["好的"]));
		expect(s.notes).toEqual(["当前会话里没有可以整理的用户要求。"]);
		s = scriptedUi([pick("空白模板"), "x2", "X", "d", pick("中文"), "=", false]);
		await commands.get("skill-new")?.("", ctx(s.ui));
		expect(existsSync(join(agent, "skills", "x2"))).toBe(false);
		// Guided: the request goes to the model through skill-creator.
		s = scriptedUi([pick("skill-creator"), "写区县政府的工作简报"]);
		await commands.get("skill-new")?.("", ctx(s.ui));
		expect(sent).toEqual(["/skill:skill-creator 请新建一个写作 skill：写区县政府的工作简报"]);
	});
});

describe("skillLabel", () => {
	it("marks state and origin", () => {
		// On built-in, off user skill, English.
		expect(skillLabel({ name: "a", title: "甲", description: "", dir: "", origin: "builtin", enabled: true })).toBe(
			"● 甲（a，内置）",
		);
		expect(
			skillLabel({ name: "b", title: "B", description: "", dir: "", origin: "user", enabled: false }, "en"),
		).toBe("○ B (b, mine)");
	});
});
