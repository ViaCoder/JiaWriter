// Tests for PROMPT_ADD (src/writer/prompt-add.ts): the added text joins the persona inside <system_prompt>.

// Temp files.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory and home folder.
import { homedir, tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The prompt builder.
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
// The rows of /jw.
import { otherRows } from "../../src/writer/config-view.ts";
// The startup check.
import { readWriterEnv } from "../../src/writer/env-config.ts";
// Functions under test.
import { personaBlock, promptAddPath, promptAddProblem, promptAddText } from "../../src/writer/prompt-add.ts";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jw-add-"));
	vi.stubEnv("JW_LANG", "zh");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

/** A file with text, and an environment pointing at it. */
function added(text: string, name = "add.txt"): NodeJS.ProcessEnv {
	const path = join(dir, name);
	writeFileSync(path, text);
	return { PROMPT_ADD: path };
}

describe("PROMPT_ADD", () => {
	it("expands a quoted ~ and treats blank as unset", () => {
		expect(promptAddPath({ PROMPT_ADD: "~/Downloads/glm.txt" })).toBe(join(homedir(), "Downloads", "glm.txt"));
		expect(promptAddPath({ PROMPT_ADD: "  " })).toBeUndefined();
		expect(promptAddPath({})).toBeUndefined();
	});

	it("reads the text once and trims it", () => {
		const env = added("  你是一位老编辑。\n", "once.txt");
		expect(promptAddText(env)).toBe("你是一位老编辑。");
		// A change during the run does not move the prompt.
		writeFileSync(env.PROMPT_ADD as string, "改了");
		expect(promptAddText(env)).toBe("你是一位老编辑。");
		expect(promptAddText({})).toBe("");
		expect(promptAddText({ PROMPT_ADD: join(dir, "none.txt") })).toBe("");
	});

	it("reports a missing or empty file", () => {
		expect(promptAddProblem({})).toBe("");
		expect(promptAddProblem(added("文字", "ok.txt"))).toBe("");
		expect(promptAddProblem({ PROMPT_ADD: join(dir, "none.txt") })).toContain("读不了");
		expect(promptAddProblem(added("  \n", "blank.txt"))).toContain("是空的");
	});

	it("wraps the persona, with the addition in the same tag", () => {
		expect(personaBlock("人设", "")).toBe("<system_prompt>\n人设\n</system_prompt>");
		expect(personaBlock("人设", "追加")).toBe("<system_prompt>\n人设\n追加\n</system_prompt>");
	});

	it("stands right after the persona, before the tools, without a tag of its own", () => {
		vi.stubEnv("PROMPT_ADD", added("回答时先想读者是谁。", "prompt.txt").PROMPT_ADD as string);
		const prompt = buildSystemPrompt({ cwd: "/w", selectedTools: [], skills: [], contextFiles: [] });
		expect(prompt).toMatch(
			/^<system_prompt>\nYou are an expert[^\n]*\n回答时先想读者是谁。\n<\/system_prompt>\n\n<tools>/,
		);
	});

	it("stops the start when the file is missing, and shows only path and size in /jw", () => {
		const base = { JW_URL: "https://a.example", JW_KEY: "k", JW_MODEL: "m" };
		const bad = readWriterEnv({ ...base, PROMPT_ADD: join(dir, "none.txt") });
		expect(bad.config).toBeUndefined();
		expect(bad.errors.join("\n")).toContain("PROMPT_ADD");
		const env = added("保密的人设内容", "jw.txt");
		expect(readWriterEnv({ ...base, ...env }).config).toBeDefined();
		const row = otherRows(env, "zh").find((r) => r.name === "PROMPT_ADD");
		expect(row?.value).toContain("jw.txt");
		expect(row?.value).toContain("7 字");
		expect(row?.value).not.toContain("保密");
	});
});
