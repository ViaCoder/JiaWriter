// Functional tests for the built-in writer-docs extension (src/extensions/writer-docs/index.ts):
// both tools and both commands end to end on temp folders, and the startup scan. No network.

// Files.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Extension API types.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
// Extension under test.
import writerDocsExtension, { parseExportArgs } from "../../src/extensions/writer-docs/index.ts";
// Automatic export helpers.
import { autoExportEnabled, editedDrafts, isDraftPath } from "../../src/writer/docs/auto.ts";
// Fixtures.
import { makePdf } from "./doc-fixtures.ts";

// Working folder.
let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "wa-docs-"));
	vi.stubEnv("JW_LANG", "zh");
	vi.stubEnv("HOME", cwd);
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** What the extension registered on a fake API. */
function load() {
	// Collected registrations.
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	// Messages the extension sent to the session, with their options.
	const sent: { message: { content: string }; options: unknown }[] = [];
	// Fake API with the methods the extension uses.
	const pi = {
		registerTool: (t: ToolDefinition) => tools.set(t.name, t),
		registerCommand: (name: string, o: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, o),
		on: (name: string, h: (event: unknown, ctx: unknown) => void) => handlers.set(name, h),
		sendMessage: (message: { content: string }, options: unknown) => sent.push({ message, options }),
	} as unknown as ExtensionAPI;
	writerDocsExtension(pi);
	return { tools, commands, handlers, sent };
}

/** Context with a notify recorder and a session branch of the given messages. */
function ctx(notes: string[], branch: unknown[] = [], hasUI = true) {
	// Only what the extension reads.
	return {
		cwd,
		hasUI,
		ui: { notify: (m: string) => notes.push(m) },
		sessionManager: { getBranch: () => branch.map((message) => ({ type: "message", message })) },
	} as unknown as ExtensionToolContext;
}

/** Text of a tool result. */
function text(r: { content: { type: string; text?: string }[] }): string {
	// First text block.
	return r.content[0]?.text ?? "";
}

describe("parseExportArgs", () => {
	it("parses /export-doc arguments", () => {
		// Arguments.
		expect(parseExportArgs(" 稿件.md md --profile=apa --out=x/y.md extra ")).toEqual({
			path: "稿件.md",
			format: "md",
			profile: "apa",
			output: "x/y.md",
		});
		expect(parseExportArgs("--docx a.md")).toEqual({
			path: "a.md",
			format: "docx",
			profile: undefined,
			output: undefined,
		});
		expect(parseExportArgs("")).toEqual({ path: "", format: undefined, profile: undefined, output: undefined });
	});
});

describe("import_document and export_document", () => {
	it("imports the reference folder, reports a scan, and exports a draft to .docx", async () => {
		// A text file and a scan in 参考资料.
		mkdirSync(join(cwd, "参考资料"));
		writeFileSync(join(cwd, "参考资料", "a.txt"), "资料正文");
		writeFileSync(join(cwd, "参考资料", "scan.pdf"), makePdf([""]));
		const { tools } = load();
		// runImport (src/extensions/writer-docs/index.ts) behind import_document: every new file, then one by path.
		const imp = await tools.get("import_document")?.execute("1", {}, undefined, undefined, ctx([]));
		expect(
			text(imp as never)
				.split("\n")
				.slice(0, 3),
		).toEqual([
			"参考资料导入：2 个文件",
			`- ${join("参考资料", "a.txt")} → ${join("参考资料", ".parsed", "a.txt.md")}（1 页，4 字）`,
			`- ${join("参考资料", "scan.pdf")}：扫描件，没有文字层，JiaWriter 不做文字识别。请换成带文字层的 PDF 或 Word 文件。`,
		]);
		// One file by path.
		const one = await tools
			.get("import_document")
			?.execute("2", { path: "参考资料/a.txt" }, undefined, undefined, ctx([]));
		expect(text(one as never)).toContain("（1 页，4 字）");
		// Export.
		writeFileSync(join(cwd, "稿件.md"), "# 标题\n\n正文, 结束.\n");
		const exp = await tools.get("export_document")?.execute("3", { path: "稿件.md" }, undefined, undefined, ctx([]));
		expect(text(exp as never).split("\n")[0]).toBe("已导出：稿件.docx（docx，排版方案 default-zh）");
		expect(existsSync(join(cwd, "稿件.docx"))).toBe(true);
		await expect(
			tools.get("export_document")?.execute("4", { path: " " }, undefined, undefined, ctx([])),
		).rejects.toThrow("请用 path 指定");
	});
});

describe("/import-doc, /export-doc and the startup scan", () => {
	it("runs both commands, reports errors as notes, and imports new references at startup only", async () => {
		// Files.
		mkdirSync(join(cwd, "参考资料"));
		writeFileSync(join(cwd, "参考资料", "a.md"), "资料");
		writeFileSync(join(cwd, "d.md"), "# 题\n\n文字.\n");
		const { commands, handlers } = load();
		const notes: string[] = [];
		// /import and /export.
		await commands.get("import-doc")?.handler("", ctx(notes));
		await commands.get("export-doc")?.handler("d.md md", ctx(notes));
		await commands.get("export-doc")?.handler("", ctx(notes));
		expect(notes[0].startsWith("参考资料导入：1 个文件")).toBe(true);
		expect(notes[1].startsWith(`已导出：d.export.md（md`)).toBe(true);
		expect(readFileSync(join(cwd, "d.export.md"), "utf-8")).toBe("# 题\n\n文字。\n");
		expect(notes[2]).toBe("请用 path 指定要导出的 Markdown 稿件。");
		// Startup: a new file is announced; a reload does nothing.
		writeFileSync(join(cwd, "参考资料", "b.txt"), "新资料");
		const startNotes: string[] = [];
		handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx(startNotes));
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx(startNotes));
		await vi.waitFor(() => expect(startNotes.length).toBe(1));
		expect(startNotes[0].split("\n")[0]).toBe("参考资料导入：1 个文件");
	});
});

describe("automatic import before each run and export after it", () => {
	/** An assistant message calling one tool on a path. */
	const call = (id: string, name: string, path: string) => ({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { path } }],
	});

	it("imports files added during the session before the run, and exports the drafts the run changed", async () => {
		mkdirSync(join(cwd, "参考资料"));
		const { handlers } = load();
		const notes: string[] = [];
		// A file added mid-session is imported before the model starts.
		writeFileSync(join(cwd, "参考资料", "新.txt"), "新资料");
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx(notes));
		expect(notes[0].split("\n")[0]).toBe("参考资料导入：1 个文件");
		expect(readFileSync(join(cwd, "参考资料", ".parsed", "新.txt.md"), "utf-8")).toContain("新资料");
		// The run wrote a draft and notes, and one edit failed.
		writeFileSync(join(cwd, "稿件.md"), "# 题\n\n文字.\n");
		writeFileSync(join(cwd, "素材笔记.md"), "笔记");
		writeFileSync(join(cwd, "坏.md"), "x");
		const messages = [
			call("1", "write", "稿件.md"),
			call("2", "write", "素材笔记.md"),
			call("3", "edit", "坏.md"),
			{ role: "toolResult", toolCallId: "3", isError: true },
		];
		await handlers.get("agent_end")?.({ type: "agent_end", messages }, ctx(notes));
		expect(notes[1].split("\n").slice(0, 2)).toEqual([
			"本轮修改的稿件已自动导出：",
			"已导出：稿件.docx（docx，排版方案 default-zh）",
		]);
		expect(existsSync(join(cwd, "稿件.docx"))).toBe(true);
		expect(existsSync(join(cwd, "素材笔记.docx"))).toBe(false);
		expect(existsSync(join(cwd, "坏.docx"))).toBe(false);
		// Switched off: nothing more.
		vi.stubEnv("JW_AUTO_EXPORT", "off");
		await handlers.get("agent_end")?.({ type: "agent_end", messages }, ctx(notes));
		expect(notes).toHaveLength(2);
	});

	it("hands reference URLs the session has not opened to the model once, in interactive sessions only", async () => {
		const { handlers, sent } = load();
		const notes: string[] = [];
		// A draft citing two pages; the session opened only the second one.
		writeFileSync(
			join(cwd, "稿件.md"),
			"# 题\n\n正文。\n\n## 参考文献\n\n1. [新华社：某项报道，2026年11月1日](https://example.com/a)\n2. [某机构年度报告，2026年](https://example.com/b)\n",
		);
		const branch = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "f1", name: "fetch_web", arguments: { url: "https://example.com/b" } }],
			},
			{
				role: "toolResult",
				toolCallId: "f1",
				toolName: "fetch_web",
				isError: false,
				details: { url: "https://example.com/b", chars: 900 },
			},
		];
		const messages = [call("1", "write", "稿件.md")];
		// Print mode: the report only.
		await handlers.get("agent_end")?.({ type: "agent_end", messages }, ctx(notes, branch, false));
		expect(sent).toHaveLength(0);
		// Interactive: one message for the model with the unopened URL, starting a turn.
		await handlers.get("agent_end")?.({ type: "agent_end", messages }, ctx(notes, branch));
		expect(notes.at(-1)).toContain(
			"参考文献：2 条；缺可用网址 0 条，缺描述性标题 0 条，网址不是本次会话中打开过的网页 1 条。",
		);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content).toContain("- https://example.com/a");
		expect(sent[0].message.content).not.toContain("example.com/b");
		expect(sent[0].options).toEqual({ triggerTurn: true });
		// The same URL is not handed over again.
		await handlers.get("agent_end")?.({ type: "agent_end", messages }, ctx(notes, branch));
		expect(sent).toHaveLength(1);
	});
});

describe("editedDrafts / isDraftPath / autoExportEnabled", () => {
	const call = (id: string, name: string, path: string) => ({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { path } }],
	});
	it("keeps drafts changed after their last export, in first-change order", () => {
		const msgs = [
			call("1", "write", "b.md"),
			call("2", "edit", "a.md"),
			call("3", "export_document", "b.md"),
			call("4", "edit", "a.md"),
			call("5", "read", "c.md"),
		];
		expect(editedDrafts(msgs, cwd)).toEqual([join(cwd, "a.md")]);
		expect(editedDrafts([...msgs, call("6", "edit", "b.md")], cwd)).toEqual([join(cwd, "b.md"), join(cwd, "a.md")]);
	});
	it("accepts Markdown drafts in the working folder only", () => {
		expect(isDraftPath(join(cwd, "报告.md"), cwd)).toBe(true);
		expect(isDraftPath(join(cwd, "章节", "第一章.markdown"), cwd)).toBe(true);
		for (const p of [
			"报告.txt",
			"报告.export.md",
			"大纲.md",
			"notes.md",
			join("参考资料", "a.md"),
			join(".parsed", "a.md"),
			join(".hidden", "a.md"),
		])
			expect(isDraftPath(join(cwd, p), cwd), p).toBe(false);
		expect(isDraftPath(join(tmpdir(), "elsewhere.md"), cwd)).toBe(false);
	});
	it("is on unless switched off", () => {
		expect(autoExportEnabled({})).toBe(true);
		for (const v of ["off", "0", "FALSE", "no"]) expect(autoExportEnabled({ JW_AUTO_EXPORT: v })).toBe(false);
	});
});
