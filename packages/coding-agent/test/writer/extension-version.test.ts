// The Chrome extension's version stays the main application's (the user, 2026-11-15): the source manifest carries
// the release version of scripts/writer-version.txt, the build stamps the copied manifest from the same file, and the
// program expects the extension of its own version.

// Files.
import { readFileSync } from "node:fs";
// Paths.
import { join } from "node:path";
// Test API.
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/config.ts";
import { EXTENSION_VERSION } from "../../src/writer/browser/bridge.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

describe("extension version", () => {
	it("is the release version in the source manifest, and the program's own version in the program", () => {
		const release = readFileSync(join(ROOT, "scripts", "writer-version.txt"), "utf-8")
			.split("\n")[0]
			.trim();
		const manifest = JSON.parse(
			readFileSync(join(ROOT, "search_fetch", "src", "search_fetch", "extension", "manifest.json"), "utf-8"),
		) as { version: string };
		expect(manifest.version).toBe(release);
		// Chrome's form: up to four integers.
		expect(release).toMatch(/^\d+(\.\d+){0,3}$/);
		expect(EXTENSION_VERSION).toBe(VERSION);
	});
});
