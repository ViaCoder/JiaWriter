/**
 * Reading words from a picture on this machine, at no cost in tokens: Apple's Vision through a small helper on macOS,
 * Windows.Media.Ocr through a script on Windows, tesseract where it is installed. Without any of them this is skipped.
 */

// Running the tool.
import { execFile, spawnSync } from "node:child_process";
// The picture on disk for a moment.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// A private place for it.
import { tmpdir } from "node:os";
// Paths.
import { dirname, join } from "node:path";

/** One way to run a recognizer. */
export interface OcrCommand {
	command: string;
	args: (file: string) => string[];
}

/** Longest a recognizer may take (ms). */
const OCR_MS = 15_000;
/** Words below this are noise, not a reading (characters). */
export const MIN_WORDS = 8;

/** The recognizer for a platform; `has` says whether a file or command is there. */
export function ocrCommand(
	platform: NodeJS.Platform,
	helperDir: string,
	has: (nameOrPath: string) => boolean,
): OcrCommand | undefined {
	if (platform === "darwin" && has(join(helperDir, "jw-ocr")))
		return { command: join(helperDir, "jw-ocr"), args: (file) => [file] };
	if (platform === "win32" && has(join(helperDir, "ocr.ps1")))
		return {
			command: "powershell",
			args: (file) => ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(helperDir, "ocr.ps1"), file],
		};
	if (has("tesseract")) return { command: "tesseract", args: (file) => [file, "stdout", "-l", "chi_sim+eng"] };
	return undefined;
}

/** Whether a command is on the PATH. */
export function onPath(name: string): boolean {
	return spawnSync(name, ["--version"], { stdio: "ignore", timeout: 3000 }).error === undefined;
}

/** The words in a picture, or "" when there is no recognizer or it fails. */
export function ocrText(data: string, ocr: OcrCommand | undefined): Promise<string> {
	if (!ocr) return Promise.resolve("");
	const dir = mkdtempSync(join(tmpdir(), "jw-ocr-"));
	const file = join(dir, "page.jpg");
	writeFileSync(file, Buffer.from(data, "base64"), { mode: 0o600 });
	return new Promise((done) => {
		execFile(ocr.command, ocr.args(file), { timeout: OCR_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			rmSync(dir, { recursive: true, force: true });
			done(error ? "" : stdout.trim());
		});
	});
}

/** The folder of the program's helpers. */
export function ocrHelperDir(): string {
	return join(dirname(process.execPath), "ocr");
}
