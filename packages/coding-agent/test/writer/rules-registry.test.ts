// The user's rules held in one place (src/writer/rules/registry.ts): every text the model reads agrees with them, and
// the draft checks catch a sentence that breaks each of them (2026-11-09).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { draftCheck } from "../../src/extensions/writer-tools/index.ts";
import { en } from "../../src/writer/i18n/en.ts";
import { zh } from "../../src/writer/i18n/zh.ts";
import * as promptText from "../../src/writer/prompt-text.ts";
import { writerLanguageRule } from "../../src/writer/prompt-text.ts";
import * as compact from "../../src/writer/prompts/compact.ts";
import * as core from "../../src/writer/prompts/core.ts";
import * as manuals from "../../src/writer/prompts/manuals.ts";
import * as methods from "../../src/writer/prompts/methods.ts";
import * as stages from "../../src/writer/prompts/stages.ts";
import { clauses, refusedInClause, shownAsFine, USER_RULES } from "../../src/writer/rules/registry.ts";
import { REVIEW_PROMPT } from "../../src/writer/style/review.ts";

/** Every string inside a value: arrays, records and the rules of stages. */
function strings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) strings(v, out);
	else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
	return out;
}

/** The Markdown files of the built-in skills: guidance the model reads (the .txt samples are human documents). */
function skillTexts(dir = "skills/writer"): [string, string][] {
	const found: [string, string][] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) found.push(...skillTexts(path));
		else if (name.endsWith(".md")) found.push([path, readFileSync(path, "utf-8")]);
	}
	return found;
}

/** Each text the model reads, by where it comes from. */
function modelTexts(): [string, string][] {
	const modules: Record<string, unknown> = { core, manuals, stages, compact, methods, promptText };
	const texts: [string, string][] = [];
	for (const [name, mod] of Object.entries(modules)) for (const s of strings(mod)) texts.push([`prompts:${name}`, s]);
	texts.push(["writerLanguageRule", writerLanguageRule("zh")], ["REVIEW_PROMPT", REVIEW_PROMPT]);
	for (const [key, s] of Object.entries(zh)) texts.push([`zh:${key}`, s]);
	for (const [key, s] of Object.entries(en)) texts.push([`en:${key}`, s]);
	texts.push(...skillTexts());
	return texts;
}

describe("USER_RULES", () => {
	it("each rule says where it comes from, and its breaking draft must be fixed", () => {
		for (const rule of USER_RULES) {
			expect(rule.said.length, rule.id).toBeGreaterThan(10);
			expect([rule.id, draftCheck(rule.breaks).mustFix]).toEqual([rule.id, true]);
		}
	});
	it("no text the model reads shows a forbidden form as fine", () => {
		const texts = modelTexts();
		// The texts are really there: prompts, the review, check messages and skills.
		expect(texts.length).toBeGreaterThan(300);
		const found: string[] = [];
		for (const [from, text] of texts)
			for (const rule of USER_RULES)
				for (const clause of shownAsFine(text, rule)) found.push(`${rule.id} @ ${from}: ${clause}`);
		expect(found).toEqual([]);
	});
});

describe("refusedInClause and shownAsFine", () => {
	const ordinals = USER_RULES.find((r) => r.id === "in-text-ordinals");
	it("passes a form named to forbid it, and catches one given as normal", () => {
		expect(refusedInClause("no 一是 or 一要", "一是")).toBe(true);
		expect(refusedInClause("Fixed forms of official Chinese (一是……二是……, 进一步) are normal", "一是")).toBe(false);
		// The review's old line (2026-11-09) is caught, its new line is not.
		expect(
			ordinals && shownAsFine("Fixed forms of official Chinese (一是……二是……, 进一步) are normal.", ordinals),
		).toHaveLength(1);
		expect(ordinals && shownAsFine("A fix never numbers points with 一是/二是.", ordinals)).toEqual([]);
	});
	it("splits a text into clauses at sentence ends, semicolons and line breaks", () => {
		expect(clauses("甲。乙；丙\nOne. Two")).toEqual(["甲", "乙", "丙", "One", "Two"]);
	});
});
