// The edit tool's `all` flag: a string that repeats is replaced everywhere (2026-11-17, l11: five identical citations
// could not be changed one by one, and the sed -i the model fell back to was stopped by the permission gate).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-all-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit all", () => {
	it("replaces every occurrence when all is set, and the other edits once", () => {
		const text = "甲（《中国电子报》报道）。\n乙（《中国电子报》报道）。\n丙（《中国电子报》报道）。\n丁。\n";
		const { newContent } = applyEditsToNormalizedContent(
			text,
			[
				{ oldText: "（《中国电子报》报道）", newText: "（2026年8月14日《中国电子报》报道）", all: true },
				{ oldText: "丁。", newText: "戊。" },
			],
			"稿.md",
		);
		expect(newContent).toBe(
			"甲（2026年8月14日《中国电子报》报道）。\n乙（2026年8月14日《中国电子报》报道）。\n丙（2026年8月14日《中国电子报》报道）。\n戊。\n",
		);
	});

	it("still refuses a repeated string without all, and says how", () => {
		expect(() => applyEditsToNormalizedContent("a b a\n", [{ oldText: "a", newText: "c" }], "f.txt")).toThrow(
			/Found 2 occurrences .* set all: true/,
		);
	});

	it("a single occurrence with all behaves as a plain edit", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"one two\n",
			[{ oldText: "two", newText: "2", all: true }],
			"f.txt",
		);
		expect(newContent).toBe("one 2\n");
	});

	it("works through the tool with a fuzzy match (curly quotes in the file, straight ones in the edit)", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "notes.txt");
		await writeFile(filePath, "say “hi”\nsay “hi”\n", "utf8");
		const definition = createEditToolDefinition(dir);
		await definition.execute(
			"tool-1",
			{ path: "notes.txt", edits: [{ oldText: 'say "hi"', newText: "say bye", all: true }] },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		expect(await readFile(filePath, "utf8")).toBe("say bye\nsay bye\n");
	});
});
