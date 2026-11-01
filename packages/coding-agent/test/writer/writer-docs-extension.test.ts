// Functional tests for the built-in writer-docs extension (src/extensions/writer-docs/index.ts):
// both tools and both commands end to end on temp folders, and the startup scan. No network.

// Files.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Extension API types.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
// Extension under test.
import writerDocsExtension, { findSfOcr, parseExportArgs } from "../../src/extensions/writer-docs/index.ts";
// Fixtures.
import { makePdf } from "./doc-fixtures.ts";

// Working folder.
let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "wa-docs-"));
	vi.stubEnv("WA_LANG", "zh");
	vi.stubEnv("WA_SF", "");
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
	// Fake API with the three methods the extension uses.
	const pi = {
		registerTool: (t: ToolDefinition) => tools.set(t.name, t),
		registerCommand: (name: string, o: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, o),
		on: (name: string, h: (event: unknown, ctx: unknown) => void) => handlers.set(name, h),
	} as unknown as ExtensionAPI;
	writerDocsExtension(pi);
	return { tools, commands, handlers };
}

/** Context with a notify recorder. */
function ctx(notes: string[]) {
	// Only what the extension reads.
	return { cwd, hasUI: true, ui: { notify: (m: string) => notes.push(m) } } as unknown as ExtensionToolContext;
}

/** Text of a tool result. */
function text(r: { content: { type: string; text?: string }[] }): string {
	// First text block.
	return r.content[0]?.text ?? "";
}

describe("findSfOcr / parseExportArgs", () => {
	it("finds sf only where it exists, and parses /export arguments", () => {
		// No sf anywhere.
		expect(findSfOcr({ HOME: cwd, WA_SF: join(cwd, "none") })).toBeUndefined();
		// A WA_SF that exists.
		const sf = join(cwd, "sf");
		writeFileSync(sf, "#!/bin/sh\n");
		chmodSync(sf, 0o755);
		expect(findSfOcr({ HOME: cwd, WA_SF: sf, WA_SEARCH_TIMEOUT: "60" })).toMatchObject({
			bin: sf,
			timeoutMs: 60_000,
		});
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
		const imp = await tools.get("import_document")?.execute("1", {}, undefined, undefined, ctx([]));
		expect(
			text(imp as never)
				.split("\n")
				.slice(0, 3),
		).toEqual([
			"参考资料导入：2 个文件",
			`- ${join("参考资料", "a.txt")} → ${join("参考资料", ".parsed", "a.txt.md")}（1 页，4 字）`,
			`- ${join("参考资料", "scan.pdf")}：扫描件，没有文字层，需要 OCR。可用 WA_SF 指定 search_fetch，由它识别（页面图片会上传到公开的 Hugging Face Space）。`,
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

describe("/import, /export and the startup scan", () => {
	it("runs both commands, reports errors as notes, and imports new references at startup only", async () => {
		// Files.
		mkdirSync(join(cwd, "参考资料"));
		writeFileSync(join(cwd, "参考资料", "a.md"), "资料");
		writeFileSync(join(cwd, "d.md"), "# 题\n\n文字.\n");
		const { commands, handlers } = load();
		const notes: string[] = [];
		// /import and /export.
		await commands.get("import")?.handler("", ctx(notes));
		await commands.get("export")?.handler("d.md md", ctx(notes));
		await commands.get("export")?.handler("", ctx(notes));
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
