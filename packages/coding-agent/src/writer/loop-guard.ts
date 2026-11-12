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
/**
 * A tool that failed this many times in a row, whatever its arguments, is blocked: on 2026-11-12 a run sent
 * material_add 510 times, each with a new number in its items, every one refused, and the same-arguments rule
 * never matched.
 */
export const MAX_TOOL_FAILURES = 6;
/**
 * Tools that change files, the topic, a page or the desktop: after one of them works, an earlier call may answer
 * differently. browser and computer since 2026-11-09: reading a page again after a click is new information, and the
 * package check's fifth page read was blocked.
 */
export const CHANGING_TOOLS: ReadonlySet<string> = new Set([
	"write",
	"edit",
	"draft_section",
	"bash",
	"material_add",
	"topic_open",
	"import_document",
	"export_document",
	"browser",
	"computer",
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
	// Failures in a row of each tool, with any arguments.
	failing: Map<string, number>;
	// Calls blocked so far.
	blocks: number;
}

/** A fresh guard. */
export function newGuard(): LoopGuard {
	return { calls: new Map(), failing: new Map(), blocks: 0 };
}

/** The same value with object keys in order, so that equal arguments give equal text. */
function ordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(ordered);
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return Object.fromEntries(entries.map(([k, v]) => [k, ordered(v)]));
}

/** Free-text fields that say why, not what: they do not make a call another call. */
const WHY_FIELDS: ReadonlySet<string> = new Set(["reason"]);

/** The key of a call: its tool and its arguments, less the reason given for it. */
export function callKey(tool: string, input: unknown): string {
	const what =
		input && typeof input === "object" && !Array.isArray(input)
			? Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([k]) => !WHY_FIELDS.has(k)))
			: input;
	return `${tool}\n${JSON.stringify(ordered(what) ?? null)}`;
}

/**
 * Whether a call may run: "ok", or why not ("failed": it keeps failing; "repeated": it was made enough times;
 * "failing": the tool keeps failing whatever it is given).
 */
export function checkCall(guard: LoopGuard, key: string, tool = ""): "ok" | "failed" | "repeated" | "failing" {
	if (tool && (guard.failing.get(tool) ?? 0) >= MAX_TOOL_FAILURES) return "failing";
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
	// The tool's own run of failures, with any arguments.
	if (tool) guard.failing.set(tool, isError ? (guard.failing.get(tool) ?? 0) + 1 : 0);
}
