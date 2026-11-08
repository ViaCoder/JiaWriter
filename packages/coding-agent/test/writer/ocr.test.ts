// Reading words on this machine (src/writer/ocr.ts): which recognizer, and what comes of it.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	/** A recognizer made of a small Node script, so it runs on every system, Windows too. */
	function script(body: string) {
		const dir = mkdtempSync(join(tmpdir(), "jw-ocrt-"));
		const file = join(dir, "r.mjs");
		// argv[2] is the picture's file, as a real recognizer gets it.
		writeFileSync(file, `import { readFileSync, writeFileSync } from "node:fs";\n${body}\n`);
		return { dir, ocr: { command: process.execPath, args: (picture: string) => [file, picture] } };
	}

	it("gives nothing without a recognizer", async () => {
		expect(await ocrText("eA==", undefined)).toBe("");
	});

	it("hands the picture over as a file and returns the words", async () => {
		const { dir, ocr } = script('process.stdout.write(readFileSync(process.argv[2], "utf8") + " 词\\n");');
		expect(await ocrText(Buffer.from("图").toString("base64"), ocr)).toBe("图 词");
		rmSync(dir, { recursive: true });
	});

	it("takes a failure as nothing, and leaves no file behind", async () => {
		const { dir, ocr } = script('writeFileSync(new URL("seen", import.meta.url), process.argv[2]); process.exit(3);');
		expect(await ocrText("eA==", ocr)).toBe("");
		// The picture's file was handed over, and is gone afterwards.
		const seen = readFileSync(join(dir, "seen"), "utf8");
		expect(seen.length).toBeGreaterThan(0);
		expect(existsSync(seen)).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("sets a floor for a reading", () => {
		expect(MIN_WORDS).toBeGreaterThan(3);
	});
});
