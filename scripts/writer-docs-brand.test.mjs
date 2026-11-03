// Tests for scripts/writer-docs-brand.mjs (node:test, run by `npm run test:scripts`).

// Assertions.
import assert from "node:assert/strict";
// Temporary folder for the folder test.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Paths.
import { join } from "node:path";
// Test runner.
import { test } from "node:test";
// The functions under test.
import { brandCode, brandDocs, brandMarkdown, brandProse } from "./writer-docs-brand.mjs";

test("brandProse renames the product and its folders, nothing else", () => {
	// Name and folders change.
	assert.equal(brandProse("Pi loads skills from ~/.pi/agent/skills and .pi/skills."), "JiaWriter loads skills from ~/.jiawriter/agent/skills and .jiawriter/skills.");
	// Package names, URLs and variables stay.
	const kept = "See @earendil-works/pi-coding-agent, https://pi.dev/docs and PI_CODING_AGENT_DIR.";
	assert.equal(brandProse(kept), kept);
});

test("brandCode renames the command word and folders, not code identifiers", () => {
	// Shell commands.
	assert.equal(brandCode("pi install npm:foo && pi --help"), "jiawriter install npm:foo && jiawriter --help");
	assert.equal(brandCode("$ pi"), "$ jiawriter");
	// TypeScript stays.
	const ts = 'export default function (pi: ExtensionAPI) { pi.registerTool({ name: "x" }); }';
	assert.equal(brandCode(ts), ts);
	// Folders.
	assert.equal(brandCode("cp a ~/.pi/agent/extensions/"), "cp a ~/.jiawriter/agent/extensions/");
});

test("brandMarkdown treats fences and inline code as code", () => {
	// Prose, inline code and a fenced block.
	const md = ["Run `pi install x` to add pi packages.", "```bash", "pi update", "```", "```ts", "pi.on(\"x\", f);", "```"].join("\n");
	const want = ["Run `jiawriter install x` to add JiaWriter packages.", "```bash", "jiawriter update", "```", "```ts", "pi.on(\"x\", f);", "```"].join("\n");
	assert.equal(brandMarkdown(md), want);
});

test("brandDocs rewrites .md files in a folder tree and counts them", () => {
	// Two Markdown files (one nested, one unchanged) and a non-Markdown file.
	const dir = mkdtempSync(join(tmpdir(), "jw-docs-"));
	try {
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "a.md"), "pi docs");
		writeFileSync(join(dir, "sub", "b.md"), "no name here");
		writeFileSync(join(dir, "c.txt"), "pi stays");
		assert.equal(brandDocs(dir), 1);
		assert.equal(readFileSync(join(dir, "a.md"), "utf-8"), "JiaWriter docs");
		assert.equal(readFileSync(join(dir, "c.txt"), "utf-8"), "pi stays");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
