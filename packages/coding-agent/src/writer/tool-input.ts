/**
 * Input of the JiaWriter check tools: a text file given by path, or text given inline.
 */

// Read the file.
import { readFile } from "node:fs/promises";
// File extension.
import { extname } from "node:path";
// Upstream path resolution (cwd, ~, @ prefix, macOS name variants).
import { resolveReadPathAsync } from "../core/tools/path-utils.ts";
// Error messages.
import { t } from "./i18n/index.ts";

/** Tool parameters that carry the input. */
export interface TextInput {
	// File path, relative to the working directory or absolute.
	path?: string;
	// Inline text.
	text?: string;
}

/** Binary document formats these tools do not read. */
const BINARY_EXTENSIONS = new Set([".doc", ".docx", ".pdf", ".odt", ".rtf", ".xls", ".xlsx", ".ppt", ".pptx"]);

/** Text to check: the file at path when given, otherwise text; throws a translated error. */
export async function loadToolText(input: TextInput, cwd: string): Promise<string> {
	// A path wins over inline text.
	if (input.path !== undefined && input.path.trim() !== "") {
		// Extension in lower case.
		const ext = extname(input.path).toLowerCase();
		// Binary documents need conversion first.
		if (BINARY_EXTENSIONS.has(ext)) throw new Error(t("input.binary", { path: input.path, ext }));
		// Absolute path.
		const absolute = await resolveReadPathAsync(input.path, cwd);
		// Read as UTF-8; report failures with the reason.
		try {
			// File text without a byte-order mark.
			return (await readFile(absolute, "utf-8")).replace(/^﻿/, "");
		} catch (error) {
			// Reason such as ENOENT.
			const reason = error instanceof Error ? error.message : String(error);
			// Translated error.
			throw new Error(t("input.unreadable", { path: input.path, reason }));
		}
	}
	// Inline text.
	if (input.text !== undefined) return input.text;
	// Neither was given.
	throw new Error(t("input.none"));
}
