// Tests for scripts/writer-brand.mjs (node:test, run by `npm run test:scripts`).

// Assertions with deep equality.
import assert from "node:assert/strict";
// Run the CLI as a child process.
import { spawnSync } from "node:child_process";
// Temporary files for the write test.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// Locate the OS temp directory.
import { tmpdir } from "node:os";
// Build paths portably.
import { join } from "node:path";
// Test runner.
import { test } from "node:test";
// Resolve the script path from this file.
import { fileURLToPath } from "node:url";
// The functions under test.
import { BRAND_CONFIG_DIR, BRAND_NAME, brandPackageJson, writeBrandedPackageJson } from "./writer-brand.mjs";

// Absolute path of the script, for the CLI test.
const script = fileURLToPath(new URL("./writer-brand.mjs", import.meta.url));

test("brandPackageJson sets name, config dir and command without changing the input", () => {
	// A minimal upstream-like package.json.
	const input = { name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/bundle/cli.js" }, piConfig: { configDir: ".pi" } };
	// Brand it.
	const out = brandPackageJson(input);
	// piConfig carries the new name and directory.
	assert.deepEqual(out.piConfig, { name: BRAND_NAME, configDir: BRAND_CONFIG_DIR });
	// The command is renamed and keeps the same entry script.
	assert.deepEqual(out.bin, { writeragent: "dist/bundle/cli.js" });
	// Other fields are kept.
	assert.equal(out.name, "@earendil-works/pi-coding-agent");
	// The input object is untouched.
	assert.deepEqual(input.bin, { pi: "dist/bundle/cli.js" });
});

test("brandPackageJson falls back to the default entry when bin is missing", () => {
	// No bin and no piConfig at all.
	const out = brandPackageJson({ name: "x" });
	// The default bundle entry is used.
	assert.deepEqual(out.bin, { writeragent: "dist/bundle/cli.js" });
});

test("writeBrandedPackageJson writes a branded file and leaves no temp file", () => {
	// Fresh temp directory for this test.
	const dir = mkdtempSync(join(tmpdir(), "wa-brand-"));
	try {
		// Source and destination paths.
		const src = join(dir, "in.json");
		const dest = join(dir, "out.json");
		// Write an upstream-like source file.
		writeFileSync(src, JSON.stringify({ name: "p", bin: { pi: "cli.js" } }));
		// Run the function.
		writeBrandedPackageJson(src, dest);
		// Read back the result.
		const written = JSON.parse(readFileSync(dest, "utf-8"));
		// The branded fields are on disk.
		assert.equal(written.piConfig.name, "writeragent");
		assert.deepEqual(written.bin, { writeragent: "cli.js" });
		// The file ends with a newline.
		assert.ok(readFileSync(dest, "utf-8").endsWith("\n"));
	} finally {
		// Clean up the temp directory.
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI exits with code 2 and a usage line when arguments are missing", () => {
	// Run the script with no arguments.
	const r = spawnSync(process.execPath, [script], { encoding: "utf-8" });
	// Usage errors use exit code 2.
	assert.equal(r.status, 2);
	// The usage line is printed on stderr.
	assert.match(r.stderr, /usage: node scripts\/writer-brand\.mjs/);
});
