/**
 * Which search and fetch methods work in this session. A method that failed for a reason that will not pass on its
 * own (a refused or wrong request, a missing key, an extension that is not connected) is down for the rest of the
 * session, so the model is told at once instead of trying it again for another page (2026-11-09: a research brief
 * spent 36 calls after firecrawl failed with HTTP 400 for search and was then tried again for fetch).
 * Busy servers and timeouts (429, 5xx) are left alone: they may pass.
 */

/** Failures that will not pass by trying again in this session. */
const LASTING =
	/HTTP (?:400|401|402|403)\b|没有连接|not connected|需要\s*[A-Z_]*KEY|needs\s*[A-Z_]*KEY|拒绝了 key|refused the key|积分不足|credits/i;

/** The session's record: the methods that worked and the ones that are down, with why. */
export interface MethodHealth {
	worked: Set<string>;
	down: Map<string, string>;
}

/** An empty record. */
export function newMethodHealth(): MethodHealth {
	return { worked: new Set(), down: new Map() };
}

/** True when a failure's text says it will not pass in this session. */
export function lastingFailure(text: string): boolean {
	return LASTING.test(text);
}

/** Record one call's outcome for its method. */
export function recordMethod(health: MethodHealth, method: string, failed: boolean, text: string): void {
	if (!method) return;
	if (!failed) {
		health.worked.add(method);
		health.down.delete(method);
		return;
	}
	// The first line names the reason well enough.
	if (lastingFailure(text)) health.down.set(method, text.split("\n")[0].slice(0, 160));
}
