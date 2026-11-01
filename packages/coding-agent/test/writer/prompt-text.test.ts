// Unit tests for src/writer/prompt-text.ts and its use in buildSystemPrompt().

// Test API; stubEnv restores WA_LANG.
import { afterEach, describe, expect, it, vi } from "vitest";
// The prompt builder that uses the texts.
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
// Texts under test.
import {
	WRITER_CHAT_RULE,
	WRITER_PREAMBLE,
	WRITER_RULES,
	WRITER_TOOL_GUIDELINES,
	WRITER_TOOL_SNIPPETS,
	writerDocsSection,
	writerLanguageRule,
} from "../../src/writer/prompt-text.ts";

// The six default writing tools.
const DEFAULT_TOOLS = ["read", "write", "edit", "ls", "find", "grep"];
// Snippets as the real tool definitions provide them (any non-empty text works).
const SNIPPETS = Object.fromEntries([...DEFAULT_TOOLS, "bash"].map((name) => [name, `upstream ${name}`]));
// Openings that would make a rule a prohibition instead of a positive instruction.
const NEGATIVE_START = /^(do not|don't|never|avoid|no )/i;

// Undo WA_LANG changes.
afterEach(() => vi.unstubAllEnvs());

describe("writerLanguageRule", () => {
	it("replies in Chinese by default and for zh, in English for en", () => {
		// Default and zh.
		expect([writerLanguageRule(undefined), writerLanguageRule("zh")]).toEqual([
			"Reply to the user in Simplified Chinese",
			"Reply to the user in Simplified Chinese",
		]);
		// English, also with a region (same rule as the tool output).
		for (const v of [" en ", "en-US"]) expect(writerLanguageRule(v)).toBe("Reply to the user in English");
	});
});

describe("rule texts", () => {
	it("are all positive instructions", () => {
		// Every general rule and every tool guideline.
		const all = [...WRITER_RULES, ...Object.values(WRITER_TOOL_GUIDELINES).flat(), WRITER_CHAT_RULE];
		// None starts with a prohibition.
		for (const rule of all) expect(rule).not.toMatch(NEGATIVE_START);
		// None is empty.
		for (const rule of all) expect(rule.trim().length).toBeGreaterThan(10);
	});

	it("cover the citation, verification-marker, punctuation and positive-argument requirements", () => {
		// All rules as one text.
		const text = WRITER_RULES.join("\n");
		// Cases come from materials or search with date and source.
		expect(text).toContain("reference materials or from web search results");
		// No verification markers.
		expect(text).toContain("free of verification markers");
		// Chinese full-width punctuation.
		expect(text).toContain("full-width Chinese punctuation");
		// Contrast frames kept for genuine prohibitions.
		expect(text).toContain("不是……而是");
	});

	it("give a writing-oriented summary for each default tool", () => {
		// Every default tool has a summary.
		for (const name of DEFAULT_TOOLS) expect(WRITER_TOOL_SNIPPETS[name]?.length ?? 0).toBeGreaterThan(5);
	});

	it("point the docs section at the given paths", () => {
		// Paths appear in the section.
		const docs = writerDocsSection("/opt/wa/README.md", "/opt/wa/docs");
		// Both paths are listed.
		expect([docs.includes("/opt/wa/README.md"), docs.includes("/opt/wa/docs")]).toEqual([true, true]);
	});
});

describe("buildSystemPrompt with the WriterAgent texts", () => {
	/** Default prompt with the six writing tools and bash snippets available. */
	function defaultPrompt(): string {
		// Same call shape as the session uses.
		return buildSystemPrompt({ toolSnippets: SNIPPETS, contextFiles: [], skills: [], cwd: "/tmp/wa" });
	}

	it("starts with the writing preamble and lists the writing rules first", () => {
		// Build the prompt.
		const prompt = defaultPrompt();
		// Preamble first.
		expect(prompt.startsWith(WRITER_PREAMBLE)).toBe(true);
		// The first rule line is the first writing rule.
		expect(prompt).toContain(`<rules>\n- ${WRITER_RULES[0]}`);
	});

	it("uses writing summaries for the default tools and leaves bash out", () => {
		// Build the prompt.
		const prompt = defaultPrompt();
		// Each default tool shows the WriterAgent summary.
		for (const name of DEFAULT_TOOLS) expect(prompt).toContain(`- ${name}: ${WRITER_TOOL_SNIPPETS[name]}`);
		// bash is not a default tool.
		expect(prompt).not.toContain("- bash:");
	});

	it("follows WA_LANG and replaces the upstream concise rule", () => {
		// English interface.
		vi.stubEnv("WA_LANG", "en");
		// Build the prompt.
		const prompt = defaultPrompt();
		// Language rule and chat rule present; upstream rule gone.
		expect([
			prompt.includes("- Reply to the user in English"),
			prompt.includes(`- ${WRITER_CHAT_RULE}`),
			prompt.includes("Be concise in your responses"),
		]).toEqual([true, true, false]);
	});

	it("adds no new section tags and no coding wording", () => {
		// Build the prompt.
		const prompt = defaultPrompt();
		// Every opening tag in the prompt.
		const tags = [...prompt.matchAll(/^<([a-z_]+)>$/gm)].map((m) => m[1]);
		// Only upstream section names.
		for (const tag of tags)
			expect(["tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"]).toContain(tag);
		// The upstream coding phrases are gone (file paths such as packages/coding-agent/README.md may remain).
		expect(prompt).not.toMatch(/coding assistant|coding agent|editing code|executing commands/i);
	});
});
