// Unit tests for getBundledToolPath() in src/utils/tools-manager.ts.

// Create and remove the fake package directory.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API; stubEnv restores PI_PACKAGE_DIR afterwards.
import { afterEach, describe, expect, it, vi } from "vitest";
// Functions under test.
import { getBundledToolPath, getToolPath } from "../../src/utils/tools-manager.ts";

// Temp directories to clean up.
const dirs: string[] = [];
// Restore env and delete temp directories after each test.
afterEach(() => {
	// Undo PI_PACKAGE_DIR.
	vi.unstubAllEnvs();
	// Remove every temp directory.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Make a fake package directory, optionally with bin/<files>. */
function fakePackage(files: string[]): string {
	// Fresh directory.
	const dir = mkdtempSync(join(tmpdir(), "wa-bundled-"));
	// Remember it for cleanup.
	dirs.push(dir);
	// bin/ holds the shipped tools.
	mkdirSync(join(dir, "bin"));
	// Create each requested file (content is irrelevant for the lookup).
	for (const file of files) writeFileSync(join(dir, "bin", file), "");
	// getPackageDir() reads PI_PACKAGE_DIR before anything else.
	vi.stubEnv("PI_PACKAGE_DIR", dir);
	// Return the directory.
	return dir;
}

describe("getBundledToolPath", () => {
	it("returns bin/fd when the package ships it", () => {
		// Package with a bundled fd.
		const dir = fakePackage(["fd"]);
		// The bundled path is found.
		expect(getBundledToolPath("fd", "linux")).toBe(join(dir, "bin", "fd"));
	});

	it("returns null when the package has no bundled copy", () => {
		// Package with an empty bin/.
		fakePackage([]);
		// Nothing bundled.
		expect(getBundledToolPath("rg", "linux")).toBeNull();
	});

	it("adds .exe on Windows", () => {
		// Package with Windows binaries.
		const dir = fakePackage(["rg.exe"]);
		// The .exe name is used.
		expect(getBundledToolPath("rg", "win32")).toBe(join(dir, "bin", "rg.exe"));
	});

	it("makes getToolPath prefer the bundled copy", () => {
		// The current platform's file name.
		const name = process.platform === "win32" ? "fd.exe" : "fd";
		// Package with a bundled fd.
		const dir = fakePackage([name]);
		// getToolPath returns it before looking at PATH.
		expect(getToolPath("fd")).toBe(join(dir, "bin", name));
	});
});
