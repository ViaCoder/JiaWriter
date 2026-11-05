// Choosing sources and naming them is the model's work (the user, 2026-11-05): the rules have to reach it.

// Reading the skills.
import { readFileSync } from "node:fs";
// Test API.
import { describe, expect, it, vi } from "vitest";
// Types of the extension API.
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
// Extensions that carry the tool rules.
import writerDocsExtension from "../../src/extensions/writer-docs/index.ts";
import writerSearchExtension from "../../src/extensions/writer-search/index.ts";
import writerTopicExtension from "../../src/extensions/writer-topic/index.ts";
// The rules of every writing run.
import { WRITER_RULES } from "../../src/writer/prompt-text.ts";

/** The tools an extension registers, by name. */
function registered(extension: (pi: ExtensionAPI) => void): Map<string, ToolDefinition> {
	const map = new Map<string, ToolDefinition>();
	const pi = new Proxy(
		{ registerTool: (tool: ToolDefinition) => map.set(tool.name, tool) },
		{ get: (target, key) => (key in target ? target[key as "registerTool"] : vi.fn()) },
	);
	extension(pi as unknown as ExtensionAPI);
	return map;
}

describe("rules of every writing run", () => {
	const rules = WRITER_RULES.join("\n");

	it("asks for the outlet's name in the text, never its address", () => {
		expect(rules).toContain("2026年10月31日《路透社》报道");
		expect(rules).toContain("never its web address such as reuters.com");
	});

	it("asks for cases from major outlets and official sources", () => {
		expect(rules).toMatch(/major international or national news outlets and official sources/);
		expect(rules).toMatch(/forum, blog, Q&A site or repost is a lead/);
	});

	it("asks for specific cases, or authoritative data in their place", () => {
		expect(rules).toMatch(/named company, organisation or person, the date, what it did and the figures/);
		expect(rules).toMatch(/data from an official or authoritative source/);
		expect(rules).toContain("某企业");
	});
});

describe("tool rules", () => {
	it("has the model read the whole result list and choose", () => {
		const guidelines = registered(writerSearchExtension).get("web_search")?.promptGuidelines?.join("\n") ?? "";
		expect(guidelines).toMatch(/Read the whole result list before fetching and choose the pages yourself/);
		expect(guidelines).toMatch(/in English with zone intl/);
		expect(guidelines).toMatch(/as 路透社 for reuters\.com, never the address/);
	});

	it("leaves the decision to search to the user's request", () => {
		const guidelines = registered(writerSearchExtension).get("web_search")?.promptGuidelines ?? [];
		// First, so it is read before how to search.
		expect(guidelines[0]).toMatch(/^Search only when the user's request calls for it/);
		expect(guidelines[0]).toMatch(/work from that without searching/);
		expect(guidelines[0]).toMatch(/never search when the user says not to/);
		const topic = registered(writerTopicExtension).get("topic_open")?.promptGuidelines?.join("\n") ?? "";
		expect(topic).toContain("when the user's request calls for searching");
	});

	it("makes search a condition in the skills that describe gathering facts", () => {
		for (const lang of ["zh", "en"]) {
			for (const name of ["news-feature", "general-article", "report-analysis"]) {
				const text = readFileSync(`skills/writer/${lang}/${name}/SKILL.md`, "utf-8");
				expect(text).toMatch(lang === "zh" ? /用户要求检索/ : /the user asks for a search/);
			}
		}
	});

	it("tells the model to leave arrows and LaTeX out of a draft", () => {
		const guidelines = registered(writerDocsExtension).get("export_document")?.promptGuidelines?.join("\n") ?? "";
		expect(guidelines).toMatch(/join two steps or items with — instead of an arrow/);
		expect(guidelines).toMatch(/without LaTeX/);
		expect(guidelines).not.toContain("→");
	});
});
