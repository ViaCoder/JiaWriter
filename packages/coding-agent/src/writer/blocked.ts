/**
 * One form for every call the program stops: why, what the model does next, and what it may still do. The permission
 * gate, the loop guard, the search-method health and plan mode each wrote their own sentence before 2026-11-09, and a
 * run that met a refusal tried eight other ways to make the same change; one form teaches one habit.
 */

// Output messages.
import { t } from "./i18n/index.ts";

/** What the model does next: change the approach, ask the user, or end the round. */
export type BlockNext = "change" | "user" | "stop";

/** One stopped call. */
export interface Blocked {
	// Why it was stopped, as a clause.
	why: string;
	// What comes next.
	next: BlockNext;
	// What the model may still do, as a clause; absent when nothing.
	still?: string;
}

/** The text the model gets for a stopped call. */
export function blockedText(blocked: Blocked): string {
	const parts = [t("blocked.why", { why: blocked.why }), t(`blocked.${blocked.next}`)];
	if (blocked.still) parts.push(t("blocked.still", { still: blocked.still }));
	return parts.join("");
}
