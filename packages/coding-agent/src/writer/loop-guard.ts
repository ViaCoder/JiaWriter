/**
 * The guard against loops: a model that repeats a call the same way gets the same answer, so the program stops it.
 * On 2026-11-08 a run sent gongwen_check without a path 89 times and used up the day's request limit.
 * A call is its tool name and its arguments; counts start again with each message of the user.
 */

/** A third call that already failed twice in a row with these arguments is blocked. */
export const MAX_SAME_FAILURES = 2;
/** A fifth call with the same arguments is blocked, even when the earlier ones worked. */
export const MAX_SAME_CALLS = 4;
/** At the third blocked call the run stops. */
export const MAX_BLOCKS = 3;
/** Tools that change files or the topic: after one of them works, an earlier call may answer differently. */
export const CHANGING_TOOLS: ReadonlySet<string> = new Set([
	"write",
	"edit",
	"bash",
	"material_add",
	"topic_open",
	"import_document",
	"export_document",
]);

/** What the guard knows of one call. */
interface CallRecord {
	// Calls made.
	count: number;
	// Failures since its last success.
	failures: number;
}

/** The guard's state for one message of the user. */
export interface LoopGuard {
	// Every call by its key.
	calls: Map<string, CallRecord>;
	// Calls blocked so far.
	blocks: number;
}

/** A fresh guard. */
export function newGuard(): LoopGuard {
	return { calls: new Map(), blocks: 0 };
}

/** The same value with object keys in order, so that equal arguments give equal text. */
function ordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(ordered);
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return Object.fromEntries(entries.map(([k, v]) => [k, ordered(v)]));
}

/** The key of a call: its tool and its arguments. */
export function callKey(tool: string, input: unknown): string {
	return `${tool}\n${JSON.stringify(ordered(input) ?? null)}`;
}

/** Whether a call may run: "ok", or why not ("failed": it keeps failing; "repeated": it was made enough times). */
export function checkCall(guard: LoopGuard, key: string): "ok" | "failed" | "repeated" {
	const record = guard.calls.get(key);
	if (!record) return "ok";
	if (record.failures >= MAX_SAME_FAILURES) return "failed";
	if (record.count >= MAX_SAME_CALLS) return "repeated";
	return "ok";
}

/** Count a call's outcome; a change that worked starts every count again (a check after an edit reads a new text). */
export function recordResult(guard: LoopGuard, key: string, isError: boolean, tool = ""): void {
	const record = guard.calls.get(key) ?? { count: 0, failures: 0 };
	// The other calls start again; this one keeps its count, so the same change made over and over is still a loop.
	if (!isError && CHANGING_TOOLS.has(tool)) guard.calls.clear();
	record.count++;
	// Failures in a row: a success in between starts them again.
	record.failures = isError ? record.failures + 1 : 0;
	guard.calls.set(key, record);
}
