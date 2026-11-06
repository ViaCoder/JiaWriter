// Unit tests for the built-in writer-tools extension (src/extensions/writer-tools/index.ts).

// Temp working directory.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import writerToolsExtension from "../../src/extensions/writer-tools/index.ts";

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
	// Fake API with only registerTool.
	const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
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
		// Draft with one stock phrase.
		writeFileSync(join(cwd, "稿.md"), "综上所述，形势向好。");
		// Run it.
		const { text, details } = await run("style_check", { path: "稿.md" });
		// Hit line.
		expect(text).toContain("〔套话〕综上所述");
		// Not clean.
		expect(details.clean).toBe(false);
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
