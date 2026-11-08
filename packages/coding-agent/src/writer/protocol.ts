/**
 * The protocol between the program and the model for tools that act on pages and the desktop. Every result has the
 * same shape, and `next` says who goes on, so the model never has to work that out from words. The program handles
 * setup, waits, stale references and limits by itself; the model only judges; the user decides what is theirs.
 */

/** What an action did. */
export type Effect = "confirmed" | "unverifiable" | "refused" | "failed";

/** Who goes on from here. */
export type Next = "none" | "model" | "user";

/** The result of one action. */
export interface Outcome {
	// What happened, as far as the program could see.
	effect: Effect;
	// How it was done.
	route: string;
	// Who goes on.
	next: Next;
	// Why, in one code word ("" when there is nothing to say).
	reason: string;
	// What the action gives back.
	data?: Record<string, unknown>;
}

/** An outcome from its parts. */
export function outcome(
	effect: Effect,
	route: string,
	next: Next,
	reason = "",
	data?: Record<string, unknown>,
): Outcome {
	return { effect, route, next, reason, ...(data ? { data } : {}) };
}

/** The outcome as the model reads it; long page text follows the JSON line, outside it. */
export function outcomeText(result: Outcome, body = ""): string {
	return body ? `${JSON.stringify(result)}\n${body}` : JSON.stringify(result);
}

/** Tries on one target before the program stops the model. */
export const FAILURE_LIMIT = 2;

/** Failures per target, ended by a new message from the user. */
export interface Breaker {
	// True while the target may be tried.
	allows(key: string): boolean;
	// Count a failure; true when that was the last allowed one.
	failed(key: string): boolean;
	// A success clears the count.
	passed(key: string): void;
	// Clear every count.
	reset(): void;
}

/** A breaker with nothing counted. */
export function createBreaker(limit = FAILURE_LIMIT): Breaker {
	const counts = new Map<string, number>();
	return {
		allows: (key) => (counts.get(key) ?? 0) < limit,
		failed(key) {
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			return count >= limit;
		},
		passed: (key) => void counts.delete(key),
		reset: () => counts.clear(),
	};
}
