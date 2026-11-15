// Stamp the Chrome extension's manifest with the release version from scripts/writer-version.txt (the user,
// 2026-11-15: the extension's version stays synchronized with the main application's). Chrome accepts up to four
// dot-separated integers, which 1.4.0.N is.
// Usage: node scripts/writer-extension-version.mjs <manifest.json>
import { readFileSync, writeFileSync } from "node:fs";
import { VERSION_FILE } from "./writer-brand.mjs";

/** The manifest text with the version replaced. */
export function stampManifest(text, version) {
	// Four integers at most, as Chrome requires.
	if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`${version} is not a Chrome extension version`);
	const manifest = JSON.parse(text);
	manifest.version = version;
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
	const [file] = process.argv.slice(2);
	if (!file) throw new Error("usage: writer-extension-version.mjs <manifest.json>");
	const version = readFileSync(VERSION_FILE, "utf-8").split("\n")[0].trim();
	writeFileSync(file, stampManifest(readFileSync(file, "utf-8"), version));
	console.log(`${file}: ${version}`);
}
