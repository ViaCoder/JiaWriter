/**
 * Errors of the upstream that pass by themselves: too many requests, a gateway down for the moment, a request that
 * stalled until its time ran out. A call that failed this way was never answered, so the same call made again later
 * is not the same call failing again (2026-11-17, l13: draft_section failed on a 429 and then on the 240 s wait, the
 * loop guard blocked the third try as a repeat, and the conversation's own requests went through minutes later).
 */

/** An upstream error that passes by itself: too many requests, or a gateway that is down for the moment. */
export const TRANSIENT_ERROR = /\b(?:429|502|503|504)\b|rate.?limit|temporarily|overloaded/i;

/** A request cut off on the way, in the words of the program (AbortSignal.timeout) or of the relay and the network. */
const CUT_OFF = /request was aborted|idle timeout|timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up/i;

/** True when an error text names a passing failure of the upstream, not a fault of the request itself. */
export function isTransientText(text: string): boolean {
	return TRANSIENT_ERROR.test(text) || CUT_OFF.test(text);
}
