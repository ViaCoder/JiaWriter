// Unit tests for src/writer/prompt-text.ts and its use in buildSystemPrompt().

// Test API; stubEnv restores JW_LANG.
import { afterEach, describe, expect, it, vi } from "vitest";
// The prompt builder that uses the texts.
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
// Texts under test.
import {
	WRITER_CHAT_RULE,
	WRITER_PREAMBLE,
	writerDocsSection,
	writerLanguageRule,
} from "../../src/writer/prompt-text.ts";
// The rules of every request.
import { CORE_RULES } from "../../src/writer/prompts/core.ts";

// The six default writing tools.
const DEFAULT_TOOLS = ["read", "write", "edit", "ls", "find", "grep"];
// Snippets as the real tool definitions provide them (any non-empty text works).
const SNIPPETS = Object.fromEntries([...DEFAULT_TOOLS, "bash"].map((name) => [name, `upstream ${name}`]));

// Undo JW_LANG changes.
afterEach(() => vi.unstubAllEnvs());

describe("writerLanguageRule", () => {
	it("replies in Chinese by default and for zh, in English for en", () => {
		// Default and zh.
		expect([writerLanguageRule(undefined), writerLanguageRule("zh")]).toEqual([
			"Write all text the user sees in Simplified Chinese, notes between tool calls included",
			"Write all text the user sees in Simplified Chinese, notes between tool calls included",
		]);
		// English, also with a region (same rule as the tool output).
		for (const v of [" en ", "en-US"])
			expect(writerLanguageRule(v)).toBe(
				"Write all text the user sees in English, notes between tool calls included",
			);
	});
});

describe("rule texts", () => {
	it("point the docs section at the given paths", () => {
		// Paths appear in the section.
		const docs = writerDocsSection("/opt/wa/README.md", "/opt/wa/docs");
		// Both paths are listed.
		expect([docs.includes("/opt/wa/README.md"), docs.includes("/opt/wa/docs")]).toEqual([true, true]);
	});
});

describe("buildSystemPrompt with the JiaWriter texts", () => {
	/** Default prompt with the six writing tools and bash snippets available. */
	function defaultPrompt(): string {
		// Same call shape as the session uses.
		return buildSystemPrompt({ toolSnippets: SNIPPETS, contextFiles: [], skills: [], cwd: "/tmp/wa" });
	}

	it("starts with the writing preamble and lists the writing rules first", () => {
		// Build the prompt.
		const prompt = defaultPrompt();
		// Preamble first.
		expect(prompt.startsWith(`<system_prompt>\n${WRITER_PREAMBLE}\n</system_prompt>\n\n# Rules`)).toBe(true);
		// The language comes first, and the rules of every request follow.
		expect(prompt).toContain(
			"# Rules\n - Write all text the user sees in Simplified Chinese, notes between tool calls included",
		);
		for (const rule of CORE_RULES) expect(prompt).toContain(`- ${rule}`);
	});

	it("leaves the tool list to the tool descriptions", () => {
		expect(defaultPrompt()).not.toContain("# Tools");
	});

	it("follows JW_LANG and replaces the upstream concise rule", () => {
		// English interface.
		vi.stubEnv("JW_LANG", "en");
		// Build the prompt.
		const prompt = defaultPrompt();
		// Language rule and chat rule present; upstream rule gone.
		expect([
			prompt.includes("- Write all text the user sees in English, notes between tool calls included"),
			prompt.includes(`- ${WRITER_CHAT_RULE}`),
			prompt.includes("Be concise in your responses"),
		]).toEqual([true, true, false]);
	});

	it("adds no section tags beyond the persona tag, and no coding wording", () => {
		// Build the prompt.
		const prompt = defaultPrompt();
		// Every opening tag in the prompt.
		const tags = [...prompt.matchAll(/^<([a-z_]+)>$/gm)].map((m) => m[1]);
		// Upstream section names and the persona tag the user asked for (2026-11-05).
		for (const tag of tags)
			expect(["system_prompt", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"]).toContain(
				tag,
			);
		// The upstream coding phrases are gone (file paths such as packages/coding-agent/README.md may remain).
		expect(prompt).not.toMatch(/coding assistant|coding agent|editing code|executing commands/i);
	});
});

// buildRules (src/core/system-prompt.ts), through the prompt it builds: one ordered list of rules, each once.
describe("buildRules", () => {
	afterEach(() => vi.unstubAllEnvs());

	/** The lines of the rules section of a prompt. */
	function rules(prompt: string): string[] {
		const section = prompt.split("# Rules\n")[1]?.split("\n\n")[0] ?? "";
		return section.split("\n").map((line) => line.replace(/^ - /, ""));
	}

	it("puts the language first, then the chat rule and the core rules, then what the tools need", () => {
		vi.stubEnv("JW_LANG", "zh");
		const listed = rules(
			buildSystemPrompt({ selectedTools: ["bash"], contextFiles: [], skills: [], cwd: "/tmp/wa" }),
		);
		expect(listed[0]).toBe(writerLanguageRule("zh"));
		expect(listed[1]).toBe(WRITER_CHAT_RULE);
		expect(listed.slice(2, 2 + CORE_RULES.length)).toEqual([...CORE_RULES]);
		// Without its own file tools, the shell does the listing and searching.
		expect(listed.slice(2 + CORE_RULES.length)).toContain("Use bash for file operations like ls, rg, find");
	});

	it("keeps each rule once, also when an extension repeats one", () => {
		const listed = rules(
			buildSystemPrompt({
				promptGuidelines: [CORE_RULES[0], ` ${CORE_RULES[0]} `, "Own rule"],
				contextFiles: [],
				skills: [],
				cwd: "/tmp/wa",
			}),
		);
		expect(listed.filter((rule) => rule === CORE_RULES[0]).length).toBe(1);
		expect(listed).toContain("Own rule");
	});
});
