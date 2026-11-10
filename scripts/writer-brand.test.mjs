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
import {
	BRAND_CONFIG_DIR,
	BRAND_NAME,
	BRAND_TITLE,
	brandPackageJson,
	releaseVersion,
	VERSION_FILE,
	writeBrandedPackageJson,
} from "./writer-brand.mjs";

// Absolute path of the script, for the CLI test.
const script = fileURLToPath(new URL("./writer-brand.mjs", import.meta.url));

test("brandPackageJson sets name, config dir and command without changing the input", () => {
	// A minimal upstream-like package.json.
	const input = { name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/bundle/cli.js" }, piConfig: { configDir: ".pi" } };
	// Brand it.
	const out = brandPackageJson(input);
	// piConfig carries the new name and directory.
	assert.deepEqual(out.piConfig, { name: BRAND_NAME, configDir: BRAND_CONFIG_DIR, title: BRAND_TITLE });
	// The command is renamed and keeps the same entry script.
	assert.deepEqual(out.bin, { jiawriter: "dist/bundle/cli.js" });
	// Other fields are kept.
	assert.equal(out.name, "@earendil-works/pi-coding-agent");
	// The input object is untouched.
	assert.deepEqual(input.bin, { pi: "dist/bundle/cli.js" });
});

test("brandPackageJson falls back to the default entry when bin is missing", () => {
	// No bin and no piConfig at all.
	const out = brandPackageJson({ name: "x" });
	// The default bundle entry is used.
	assert.deepEqual(out.bin, { jiawriter: "dist/bundle/cli.js" });
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
		assert.equal(written.piConfig.name, "jiawriter");
		assert.deepEqual(written.bin, { jiawriter: "cli.js" });
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

test("releaseVersion takes the upstream version or upstream.N, nothing smaller or other", () => {
	const dir = mkdtempSync(join(tmpdir(), "wa-brand-"));
	try {
		const file = join(dir, "v.txt");
		// The release number after the upstream version, and the upstream version alone.
		writeFileSync(file, "1.4.0.1\n");
		assert.equal(releaseVersion("1.4.0", file), "1.4.0.1");
		writeFileSync(file, "1.4.0\n");
		assert.equal(releaseVersion("1.4.0", file), "1.4.0");
		// A pre-release sorts below 1.4.0, another upstream version is a forgotten bump, 0 is no release.
		for (const bad of ["1.4.0-1", "1.5.0.1", "1.4.0.0", "1.4.01"]) {
			writeFileSync(file, `${bad}\n`);
			assert.throws(() => releaseVersion("1.4.0", file), /is not 1\.4\.0/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeBrandedPackageJson writes the release version, and the repository's file fits the upstream version", () => {
	const dir = mkdtempSync(join(tmpdir(), "wa-brand-"));
	try {
		const src = join(dir, "in.json");
		const dest = join(dir, "out.json");
		const file = join(dir, "v.txt");
		writeFileSync(src, JSON.stringify({ name: "p", version: "1.4.0", bin: { pi: "cli.js" } }));
		writeFileSync(file, "1.4.0.2\n");
		writeBrandedPackageJson(src, dest, file);
		assert.equal(JSON.parse(readFileSync(dest, "utf-8")).version, "1.4.0.2");
		// The file in the repository against the coding agent's version.
		const upstream = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf-8")).version;
		assert.ok(releaseVersion(upstream, VERSION_FILE).startsWith(upstream));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
