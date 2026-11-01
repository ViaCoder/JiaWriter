// Tests for scripts/writer-gen-tgh.mjs (node:test, run by `npm run test:scripts`).

// Assertions.
import assert from "node:assert/strict";
// Run the CLI as a child process.
import { spawnSync } from "node:child_process";
// Temp files for the CLI test.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test runner.
import { test } from "node:test";
// Resolve the script path from this file.
import { fileURLToPath } from "node:url";
// Functions under test.
import { LEVEL1_END, LEVEL2_END, parseTgh, renderTghModule, sourceDateOf, TGH_TOTAL } from "./writer-gen-tgh.mjs";

// Absolute path of the script, for the CLI test.
const script = fileURLToPath(new URL("./writer-gen-tgh.mjs", import.meta.url));

/** A synthetic Unihan_OtherMappings.txt with all 8105 positions, in reverse line order. */
function fakeUnihan() {
	// Header like the real file.
	const lines = ["# Unihan_OtherMappings.txt", "# Date: 2026-07-31 00:00:00 GMT [KL]"];
	// One kTGH record per position, starting at U+4E00, plus an unrelated field.
	for (let p = TGH_TOTAL; p >= 1; p--) {
		// Code point for this position.
		const code = `U+${(0x4e00 + p - 1).toString(16).toUpperCase()}`;
		// The record, with an older edition listed first.
		lines.push(`${code}\tkTGH\t1988:${p} 2013:${p}`);
		// Noise that must be ignored.
		lines.push(`${code}\tkGB0\t0000`);
	}
	// File text.
	return `${lines.join("\n")}\n`;
}

test("parseTgh orders the characters by their 2013 position", () => {
	// Parse the synthetic file.
	const chars = parseTgh(fakeUnihan());
	// All positions.
	assert.equal(chars.length, TGH_TOTAL);
	// Position 1 is U+4E00, the last one U+4E00+8104.
	assert.equal(chars[0], "一");
	// Last.
	assert.equal(chars[TGH_TOTAL - 1], String.fromCodePoint(0x4e00 + TGH_TOTAL - 1));
});

test("parseTgh rejects a file with missing positions", () => {
	// Drop one record.
	const broken = fakeUnihan().replace(/\nU\+4E00\tkTGH\t[^\n]*/, "");
	// The size check fails.
	assert.throws(() => parseTgh(broken), /expected 8105 kTGH entries, found 8104/);
});

test("renderTghModule splits the levels and names the source", () => {
	// Ordered characters.
	const chars = parseTgh(fakeUnihan());
	// Module text.
	const text = renderTghModule(chars, "2026-07-31");
	// The three exported strings.
	const strings = [...text.matchAll(/export const TGH_LEVEL\d =\n\t"([^"]*)";/g)].map((m) => [...m[1]].length);
	// 3500, 3000, 1605.
	assert.deepEqual(strings, [LEVEL1_END, LEVEL2_END - LEVEL1_END, TGH_TOTAL - LEVEL2_END]);
	// Source and licence lines.
	assert.match(text, /Unihan_OtherMappings\.txt, 2026-07-31/);
	// Licence.
	assert.match(text, /Unicode License v3/);
});

test("sourceDateOf reads the date line", () => {
	// With a date.
	assert.equal(sourceDateOf("# Date: 2026-07-31 00:00:00 GMT"), "2026-07-31");
	// Without one.
	assert.equal(sourceDateOf("no header"), "unknown date");
});

test("the CLI writes the module and reports usage errors", () => {
	// Temp directory.
	const dir = mkdtempSync(join(tmpdir(), "wa-tgh-"));
	// Input and output paths.
	const src = join(dir, "Unihan_OtherMappings.txt");
	// Output.
	const dest = join(dir, "tgh-chars.ts");
	// Write the input.
	writeFileSync(src, fakeUnihan());
	// Run it.
	const ok = spawnSync(process.execPath, [script, src, dest]);
	// Success and a module.
	assert.equal(ok.status, 0);
	// The file starts with the comment block.
	assert.match(readFileSync(dest, "utf-8"), /^\/\*\*\n \* 通用规范汉字表/);
	// Missing arguments.
	const usage = spawnSync(process.execPath, [script]);
	// Usage error.
	assert.equal(usage.status, 2);
	// Clean up.
	rmSync(dir, { recursive: true, force: true });
});
