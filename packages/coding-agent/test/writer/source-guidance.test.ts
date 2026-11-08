// Choosing sources and naming them is the model's work (the user, 2026-11-05): the rules have to reach it.

// Test API.
import { describe, expect, it } from "vitest";
// The rules of a writing run and of research.
import { RESEARCH_MANUAL, WRITING_MANUAL } from "../../src/writer/prompts/manuals.ts";

describe("rules of a document", () => {
	const writing = WRITING_MANUAL.join("\n");
	const research = RESEARCH_MANUAL.join("\n");

	it("asks for the date and the site's Chinese name in the text, never its address", () => {
		// The user, 2026-11-08: "xx年xx月xx日《xx》报道".
		expect(writing).toContain("2026年10月31日《路透社》报道");
		expect(writing).toContain("研究成果摘要");
		expect(writing).toContain("no address");
		expect(research).toContain("as 路透社 for reuters.com");
	});

	it("asks for cases from major outlets and official sources", () => {
		expect(research).toMatch(/major outlets/);
		expect(research).toMatch(/official sources/);
		expect(research).toMatch(/reposts are only leads/);
		expect(research).toMatch(/Read the whole list and choose/);
	});

	it("asks for specific cases, or authoritative data in their place", () => {
		expect(writing).toMatch(/names the body or person, date, act and figures/);
		expect(writing).toMatch(/official data with period, scope and value/);
		expect(writing).toContain("某企业");
		expect(writing).toMatch(/instead of arrows/);
		expect(writing).toMatch(/not LaTeX/);
		expect(writing).not.toContain("→");
	});
});
