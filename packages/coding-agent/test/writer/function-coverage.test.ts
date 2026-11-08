// The rule "every function has a test" as a gate: each function of the files below must be named in a test.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "..", "..");
/** The files under the rule, from their package root. */
const FILES = [
	"packages/coding-agent/src/writer/permission.ts",
	"packages/coding-agent/src/writer/protocol.ts",
	"packages/coding-agent/src/writer/browser/agent.ts",
	"packages/coding-agent/src/writer/vision.ts",
	"packages/coding-agent/src/writer/computer/driver.ts",
	"packages/coding-agent/src/writer/computer/client.ts",
	"packages/coding-agent/src/writer/computer/tool.ts",
	"packages/coding-agent/src/writer/computer/setup.ts",
	"packages/coding-agent/src/extensions/writer-computer/index.ts",
	"packages/coding-agent/src/writer/ocr.ts",
	"packages/coding-agent/src/extensions/writer-vision/index.ts",
	"packages/coding-agent/src/extensions/writer-browser/index.ts",
	"packages/coding-agent/src/writer/websearch/main-search.ts",
	"search_fetch/src/search_fetch/extension/agent.js",
];

/** Function names a source file declares, operations of OPS included. */
function functionNames(source: string): string[] {
	const declared = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map((m) => m[1]);
	const ops = [...source.matchAll(/^ {2}async (page_\w+)\(/gm)].map((m) => m[1]);
	return [...declared, ...ops];
}

describe("every function has a test", () => {
	const tests = ["test/writer", "test"]
		.flatMap((dir) =>
			readdirSync(dir)
				.filter((f) => f.endsWith(".test.ts"))
				.map((f) => join(dir, f)),
		)
		.filter((f) => !f.endsWith("function-coverage.test.ts"))
		.map((f) => readFileSync(f, "utf-8"))
		.join("\n");

	it("finds functions of both kinds", () => {
		expect(functionNames("async function a() {}\nexport function b() {}\n  async page_x(msg) {")).toEqual([
			"a",
			"b",
			"page_x",
		]);
	});

	it.each(FILES)("%s", (file) => {
		const missing = functionNames(readFileSync(join(ROOT, file), "utf-8")).filter((name) => !tests.includes(name));
		expect(missing).toEqual([]);
	});
});
