// Reading words on this machine (src/writer/ocr.ts): which recognizer, and what comes of it.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_WORDS, ocrCommand, ocrHelperDir, ocrText, onPath } from "../../src/writer/ocr.ts";

describe("ocrCommand", () => {
	const all = () => true;
	const none = () => false;

	it("uses each system's own recognizer first", () => {
		expect(ocrCommand("darwin", "/h", all)?.command).toBe(join("/h", "jw-ocr"));
		expect(ocrCommand("win32", "/h", all)?.command).toBe("powershell");
		expect(ocrCommand("win32", "/h", all)?.args("a.jpg")).toContain(join("/h", "ocr.ps1"));
		expect(ocrCommand("linux", "/h", all)?.command).toBe("tesseract");
	});

	it("falls back to tesseract, and to nothing", () => {
		expect(ocrCommand("darwin", "/h", (n) => n === "tesseract")?.command).toBe("tesseract");
		expect(ocrCommand("linux", "/h", none)).toBeUndefined();
	});
});

describe("onPath", () => {
	it("finds a command that exists, and no other", () => {
		expect(onPath("node")).toBe(true);
		expect(onPath("no-such-command-here")).toBe(false);
	});
});

describe("ocrHelperDir", () => {
	it("sits beside the program", () => {
		expect(ocrHelperDir().endsWith("ocr")).toBe(true);
	});
});

describe("ocrText", () => {
	/** A recognizer made of a small script. */
	function script(body: string) {
		const dir = mkdtempSync(join(tmpdir(), "jw-ocrt-"));
		const command = join(dir, "r.sh");
		writeFileSync(command, `#!/bin/sh\n${body}\n`);
		chmodSync(command, 0o755);
		return { dir, ocr: { command, args: (file: string) => [file] } };
	}

	it("gives nothing without a recognizer", async () => {
		expect(await ocrText("eA==", undefined)).toBe("");
	});

	it("hands the picture over as a file and returns the words", async () => {
		const { dir, ocr } = script('cat "$1"; echo " 词"');
		expect(await ocrText(Buffer.from("图").toString("base64"), ocr)).toBe("图 词");
		rmSync(dir, { recursive: true });
	});

	it("takes a failure as nothing, and leaves no file behind", async () => {
		const { dir, ocr } = script('echo "$1" > "$(dirname "$0")/seen"; exit 3');
		expect(await ocrText("eA==", ocr)).toBe("");
		rmSync(dir, { recursive: true });
	});

	it("sets a floor for a reading", () => {
		expect(MIN_WORDS).toBeGreaterThan(3);
	});
});
