import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logLines } from "../../src/extensions/writer-ui/index.ts";
import { appendSearchLog, fileSize, SEARCH_LOG_LIMIT, searchLogPath } from "../../src/writer/websearch/log.ts";

/** A throwaway folder for each test. */
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jw-log-"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("appendSearchLog", () => {
	it("creates a private file and adds whole lines", () => {
		const file = join(dir, "logs", "search.log");
		appendSearchLog("one", file);
		appendSearchLog("two", file);
		expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
		// Windows has no such permission bits.
		if (process.platform !== "win32") {
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(statSync(join(dir, "logs")).mode & 0o777).toBe(0o700);
		}
	});

	it("moves a full log aside once, so the disk never fills", () => {
		const file = join(dir, "search.log");
		writeFileSync(file, "x".repeat(SEARCH_LOG_LIMIT));
		appendSearchLog("new", file);
		expect(readFileSync(file, "utf8")).toBe("new\n");
		expect(fileSize(`${file}.1`)).toBe(SEARCH_LOG_LIMIT);
	});

	it("never throws when the file cannot be written", () => {
		// A folder where the file should be.
		mkdirSync(join(dir, "search.log"));
		expect(() => appendSearchLog("x", join(dir, "search.log"))).not.toThrow();
	});
});

describe("fileSize", () => {
	it("gives the size, and 0 for a missing file", () => {
		writeFileSync(join(dir, "a"), "abc");
		expect(fileSize(join(dir, "a"))).toBe(3);
		expect(fileSize(join(dir, "none"))).toBe(0);
	});
});

describe("/jw log", () => {
	it("shows where the file is and what it holds, under the data folder", () => {
		vi.stubEnv("JW_DIR", dir);
		expect(searchLogPath()).toBe(join(dir, "logs", "search.log"));
		appendSearchLog("abc");
		const [path, note] = logLines();
		expect(path).toContain(searchLogPath());
		expect(path).toContain("4");
		expect(note).toMatch(/key/);
	});
});
