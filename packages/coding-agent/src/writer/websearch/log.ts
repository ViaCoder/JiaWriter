/**
 * The search log: one JSON line per step of a search, so a failure can be explained afterwards.
 * The lines arrive cleaned (ai/api/server-trace.ts); this file only keeps them, private and bounded.
 */

// File operations.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
// Paths.
import { dirname, join } from "node:path";
// The program's data folder.
import { getAgentDir } from "../../config.ts";

/** Size at which the log moves aside, so it never fills a disk. */
export const SEARCH_LOG_LIMIT = 5 * 1024 * 1024;

/** Where the log is. */
export function searchLogPath(): string {
	return join(getAgentDir(), "logs", "search.log");
}

/** Size of a file in bytes, 0 when there is none. */
export function fileSize(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		// Nothing there yet.
		return 0;
	}
}

/** Add one line; a failure is dropped, because a log never stops a search. */
export function appendSearchLog(line: string, file: string = searchLogPath()): void {
	try {
		// Only the user can read it: it holds their queries.
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		// The older half is kept once.
		if (fileSize(file) >= SEARCH_LOG_LIMIT) renameSync(file, `${file}.1`);
		// Whole lines, so several searches never mix.
		appendFileSync(file, `${line}\n`, { mode: 0o600 });
	} catch {
		// A full disk or a read-only folder is no reason to fail.
	}
}
