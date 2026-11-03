/**
 * Request pacing shared by every JiaWriter process of this user: the same search engine is
 * queried, and the same site visited, no faster than a person would. The last visit per key is
 * kept in <agentDir>/browser/pacing.json.
 */

// The state file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// Its folder.
import { dirname } from "node:path";

/** Milliseconds to wait before key may be visited again: the gap times a jitter of 1–1.5, minus the time passed. */
export function paceDelay(last: number | undefined, gapMs: number, now: number, random: number): number {
	// Never visited.
	if (last === undefined) return 0;
	// Jittered gap so visits do not follow a fixed beat.
	const gap = gapMs * (1 + 0.5 * random);
	// Remaining wait.
	return Math.max(0, Math.round(last + gap - now));
}

/** Read the pacing state ({} when missing or unreadable). */
export function readPacing(file: string): Record<string, number> {
	// Parse.
	try {
		const data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
		// Numbers only.
		return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === "number")) as Record<
			string,
			number
		>;
	} catch {
		return {};
	}
}

/** Record a visit to key at time now (entries older than a day are dropped). */
export function recordVisit(file: string, key: string, now: number): void {
	// Current state without stale entries.
	const state = Object.fromEntries(Object.entries(readPacing(file)).filter(([, t]) => now - t < 86_400_000));
	state[key] = now;
	// Atomic write.
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(state));
	renameSync(tmp, file);
}

/** Wait for key's turn, then record the visit. */
export async function pace(
	file: string,
	key: string,
	gapMs: number,
	sleep: (ms: number) => Promise<void>,
	random: () => number = Math.random,
): Promise<number> {
	// How long to wait.
	const wait = paceDelay(readPacing(file)[key], gapMs, Date.now(), random());
	if (wait > 0) await sleep(wait);
	// This visit.
	recordVisit(file, key, Date.now());
	// The wait, for the log.
	return wait;
}
