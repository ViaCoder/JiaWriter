// The draft checks against human writing (2026-11-09): a check that asks for another round must not ask it of a
// careful human document. The human documents are the test fixtures and the State Council samples of the gongwen skill.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { draftCheck } from "../../src/extensions/writer-tools/index.ts";
import { inferRegister, styleCheck, styleMustFix } from "../../src/writer/style/check.ts";

/** The human documents, as text; anonymisation marks in the fixtures (【待补：公司名】, 某区) stand for real names. */
function humanDocuments(): [string, string][] {
	const found: [string, string][] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(md|txt)$/.test(name) && name !== "README.md") {
				const text = readFileSync(path, "utf-8")
					.replace(/【待[^】]*】/g, "甲")
					.replace(/某(?=[区县市镇村企])/g, "甲")
					// One fixture lost its Chinese quotes in conversion.
					.replace(/"([^"\n]*)"/g, "“$1”");
				found.push([name, text]);
			}
		}
	};
	walk("test/writer/fixtures/gongwen-samples");
	walk("skills/writer/lieflat-gongwen/参考/法定公文样例");
	return found;
}

describe("the checks on human documents", () => {
	it("ask no human document for another round", () => {
		const docs = humanDocuments();
		expect(docs.length).toBeGreaterThanOrEqual(25);
		const asked = docs.filter(([, text]) => draftCheck(text).mustFix).map(([name]) => name);
		// At most one in twenty-five: the vague-word limit stands where human writing ends (1 of 29 above it).
		expect(asked.length, asked.join("\n")).toBeLessThanOrEqual(1);
	});
	it("still list single denials for the model to judge, without asking for a round", () => {
		const text = "# 关于加强林木采伐管理的复函\n\n采伐限额不是任务指标，各地要严格执行。\n";
		const report = styleCheck(text, { register: inferRegister(text), packs: ["core-zh", "core-en", "gongwen-zh"] });
		expect(report.hits.some((hit) => hit.id === "zh-denial")).toBe(true);
		expect(styleMustFix(report)).toBe(false);
		// Two in two sentences are a density, and that asks for a round.
		expect(draftCheck("# 简报\n\n这不是技术问题，而是治理问题。这并不意味着放松监管。\n").mustFix).toBe(true);
	});
});
