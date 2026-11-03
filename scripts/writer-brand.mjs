// JiaWriter branding for release packages.
// The source tree keeps the upstream "pi" name so upstream tests stay unchanged;
// release packages get a package.json with the JiaWriter name and config directory.
// Usage: node scripts/writer-brand.mjs <source package.json> <destination package.json>

// Read and write files synchronously; the script runs once per platform build.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
// Tell whether this module is the entry point (CLI) or was imported (tests).
import { fileURLToPath } from "node:url";

// The command users type and the name shown in the interface.
export const BRAND_NAME = "jiawriter";
// Directory under the home folder that holds config and sessions (~/.jiawriter).
export const BRAND_CONFIG_DIR = ".jiawriter";
// The name shown in titles and text (the command stays lowercase).
export const BRAND_TITLE = "JiaWriter";

/** Return a copy of a package.json object carrying the JiaWriter brand. */
export function brandPackageJson(pkg) {
	// Copy the object so the caller's data is never changed.
	const branded = { ...pkg };
	// config.ts derives APP_NAME and CONFIG_DIR_NAME from piConfig.
	branded.piConfig = { ...(pkg.piConfig ?? {}), name: BRAND_NAME, configDir: BRAND_CONFIG_DIR, title: BRAND_TITLE };
	// Keep the existing entry script but publish it under the new command name.
	const entry = Object.values(pkg.bin ?? {})[0] ?? "dist/bundle/cli.js";
	// The package now exposes only the "jiawriter" command.
	branded.bin = { [BRAND_NAME]: entry };
	// Hand back the branded copy.
	return branded;
}

/** Read a package.json, brand it, and write it atomically to dest. */
export function writeBrandedPackageJson(src, dest) {
	// Parse the source file; a broken package.json should stop the build.
	const pkg = JSON.parse(readFileSync(src, "utf-8"));
	// Build the branded object.
	const branded = brandPackageJson(pkg);
	// Write next to the destination first so a crash never leaves half a file.
	const tmp = `${dest}.tmp-${process.pid}`;
	// Tab indentation and a final newline match the repository's JSON style.
	writeFileSync(tmp, `${JSON.stringify(branded, null, "\t")}\n`);
	// Atomic replace on the same filesystem.
	renameSync(tmp, dest);
	// Return the object for callers that want to inspect it.
	return branded;
}

// Run as a command only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	// Positional arguments: source and destination paths.
	const [src, dest] = process.argv.slice(2);
	// Both paths are required.
	if (!src || !dest) {
		// Explain the expected usage on stderr.
		console.error("usage: node scripts/writer-brand.mjs <source package.json> <destination package.json>");
		// Exit code 2 marks a usage error.
		process.exit(2);
	}
	// Do the work.
	writeBrandedPackageJson(src, dest);
}
