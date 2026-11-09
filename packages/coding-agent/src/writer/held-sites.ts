/**
 * Sites held for the user: a verification page (a captcha, a slider, a robot check) is the user's to pass, never the
 * program's. Once the browser meets one, no tool reaches that site until the user has passed it (2026-11-09: after a
 * slider wall, a run tried to drag it, then probed the site with curl for a way around it).
 */

// The hosts held, for this program.
const held = new Set<string>();

/** Hold a host (as the browser met a verification page there). */
export function holdSite(host: string): void {
	if (host) held.add(host.toLowerCase());
}

/** Let a host go again (the user passed its verification). */
export function releaseSite(host: string): void {
	held.delete(host.toLowerCase());
}

/** The held host a text names (an address or a command line), or "". */
export function heldIn(text: string): string {
	const lower = text.toLowerCase();
	return [...held].find((host) => lower.includes(host)) ?? "";
}

/** Forget every hold: a new message of the user, who may have passed them (as the browser's own holds). */
export function resetHeldSites(): void {
	held.clear();
}
