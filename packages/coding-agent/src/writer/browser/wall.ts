/**
 * Telling a page that stands in the way from the page asked for, by its make-up instead of its wording. Measured
 * on real sites (2026-11-05, 28 sites): every wall had under 100 elements, and either answered 401 or 403 or had
 * sent the browser to a verification or login address, while ordinary pages had 700 elements or more. Word lists
 * cannot keep up with walls; these marks need no words, and reading them costs milliseconds, so ordinary pages
 * never wait.
 */

/** What the page script ops/features.js reports. */
export interface PageFeatures {
	// Final address.
	url: string;
	// HTTP status of the document (0 when unknown).
	status: number;
	// Elements on the page.
	elements: number;
	// Web links on the page.
	links: number;
	// Characters of visible text.
	textLen: number;
}

/** A wall needs a person; a suspect may not be the page but is no reason to stop; the rest is the page. */
export type PageKind = "wall" | "suspect" | "page";

/** Statuses sites answer a blocked visitor with. A 404 is an answer, not a wall. */
const BLOCKED = new Set([401, 403, 429, 503]);
/** Above this many elements a page has real content, whatever its status (the measured gap is 100 to 700). */
const WALL_MAX_ELEMENTS = 300;
/** Below these a page has too little to be sure of. */
const SMALL_ELEMENTS = 150;
const SMALL_LINKS = 10;
const SMALL_TEXT = 500;
/** Addresses that verify or sign in a visitor. */
const GATE_PATH = /captcha|antispider|challenge|verify|verification|sorry|signin|sign-in|login/i;

/** The address's host and path, where a gate shows (a query can name anything). */
function gateText(url: string): string {
	// A malformed address has nothing to show.
	try {
		const u = new URL(url);
		return `${u.hostname}${u.pathname}`;
	} catch {
		return "";
	}
}

/** Sort a page by its make-up. asked is the address opened: being sent elsewhere is itself a sign. */
export function classifyPage(page: PageFeatures, asked: string): PageKind {
	// Too large to be a wall.
	if (page.elements >= WALL_MAX_ELEMENTS) return "page";
	// Refused.
	if (BLOCKED.has(page.status)) return "wall";
	// Sent to a gate, unless the address asked for was that gate.
	if (GATE_PATH.test(gateText(page.url)) && !GATE_PATH.test(gateText(asked))) return "wall";
	// Little here, and no way to tell why.
	const small = page.elements < SMALL_ELEMENTS && page.links <= SMALL_LINKS && page.textLen < SMALL_TEXT;
	return small ? "suspect" : "page";
}
