// Unit tests for src/writer/tool-input.ts (loadToolText).

// Temp files.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API; stubEnv fixes the message language.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Function under test.
import { lastDraft, loadToolText, setLastDraft } from "../../src/writer/tool-input.ts";

// Working directory of each test.
let cwd = "";
// Fresh directory and Chinese messages.
beforeEach(() => {
	// Temp directory.
	cwd = mkdtempSync(join(tmpdir(), "wa-input-"));
	// Chinese errors.
	vi.stubEnv("JW_LANG", "zh");
});
// Clean up.
afterEach(() => {
	// Remove the directory.
	rmSync(cwd, { recursive: true, force: true });
	// Restore JW_LANG.
	vi.unstubAllEnvs();
});

describe("loadToolText", () => {
	it("reads a file relative to cwd, without a byte-order mark, and prefers it over text", async () => {
		// File with a BOM.
		writeFileSync(join(cwd, "稿子.md"), "﻿正文");
		// Path wins over text.
		expect(await loadToolText({ path: "稿子.md", text: "别的" }, cwd)).toBe("正文");
	});
	it("returns inline text when no path is given", async () => {
		// Empty path counts as none.
		expect(await loadToolText({ path: " ", text: "内联" }, cwd)).toBe("内联");
	});
	it("rejects binary documents, missing files and empty input with Chinese messages", async () => {
		// docx.
		await expect(loadToolText({ path: "报告.DOCX" }, cwd)).rejects.toThrow("报告.DOCX 是 .docx 文件");
		// Missing file.
		await expect(loadToolText({ path: "无.md" }, cwd)).rejects.toThrow("无法读取 无.md");
		// Neither path nor text.
		await expect(loadToolText({}, cwd)).rejects.toThrow("请提供 path");
	});
});

describe("setLastDraft and lastDraft", () => {
	it("reads the last draft written when a check is called with neither path nor text", async () => {
		const draft = join(cwd, "稿.md");
		writeFileSync(draft, "正文");
		setLastDraft(undefined);
		await expect(loadToolText({}, cwd)).rejects.toThrow();
		setLastDraft(draft);
		expect(lastDraft()).toBe(draft);
		expect(await loadToolText({}, cwd)).toBe("正文");
		expect(await loadToolText({ text: "" }, cwd)).toBe("正文");
		expect(await loadToolText({ text: "给定" }, cwd)).toBe("给定");
		setLastDraft(undefined);
	});
});
