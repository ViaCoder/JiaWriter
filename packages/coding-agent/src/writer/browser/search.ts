/**
 * web_search through the user's Chrome, the way a person searches: open the engine's home page,
 * accept a consent dialog by clicking it, click the search box, type the query, press Enter, read
 * each results page (scrolling) and click "Next" for the following page. The model picks the engines
 * (Bing, Google, Baidu, Sogou); each gives 3–5 pages. The merged results are ranked locally (rank.ts).
 * A verification page is handed to the person at the screen for a bounded time (waitForPerson).
 */

// Engine definitions and link decoding.
import { AX, ENGINES, type EngineName, type EngineSpec, resultTarget, withFresh } from "./engines.ts";
// Local ranking.
import { type EngineHit, type RankedHit, rankHits } from "./rank.ts";

/** What the browser driver needs from its surroundings (tests replace every part). */
export interface BrowserDeps {
	// One request to the extension.
	call: (op: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
	// A pause.
	sleep: (ms: number) => Promise<void>;
	// Random number in [0, 1).
	random: () => number;
	// Wait for a pacing key's turn (engine queries, site visits).
	pace: (key: string, gapMs: number) => Promise<void>;
	// A person is at the screen (interactive mode): challenges may be handed to them.
	interactive: boolean;
	// Verification progress for the interface.
	notify?: (event: VerifyEvent) => void;
	// True once the tool call was cancelled (Esc): waits end at once.
	aborted?: () => boolean;
	// Tabs opened for this session carry this tag.
	run: string;
}

/** A verification step shown to the user: started (seconds to wait), seconds left, passed, or given up. */
export interface VerifyEvent {
	// What happened.
	kind: "verify" | "verify_left" | "verify_ok" | "verify_timeout";
	// On which engine, or "page" for a page web_fetch reads.
	engine: EngineName | "page";
	// Seconds (wait length, or seconds left).
	seconds?: number;
}

/** Timing of the browser backend (ms). */
export interface BrowserTiming {
	// Minimum gap between two queries to the same engine.
	engineGapMs: number;
	// Minimum gap between two visits to the same site.
	hostGapMs: number;
	// Page load wait.
	loadMs: number;
	// Longest wait for a person to clear a challenge (JW_VERIFY_WAIT; 0: no wait).
	humanWaitMs: number;
}

/** Default and largest JW_VERIFY_WAIT, in seconds. */
export const VERIFY_WAIT_DEFAULT_S = 90;
export const VERIFY_WAIT_MAX_S = 300;

/** How long an engine is left alone after a verification that was not cleared (ms). */
export const VERIFY_COOLDOWN_MS = 30 * 60_000;

/** JW_VERIFY_WAIT in ms: whole seconds 0–300, else the default. */
export function verifyWaitMs(raw: string | undefined): number {
	// A number of seconds.
	const n = Number((raw ?? "").trim());
	if ((raw ?? "").trim() === "" || !Number.isFinite(n) || n < 0) return VERIFY_WAIT_DEFAULT_S * 1000;
	return Math.round(Math.min(n, VERIFY_WAIT_MAX_S)) * 1000;
}

/** Default timing. */
export const DEFAULT_TIMING: BrowserTiming = {
	engineGapMs: 20_000,
	hostGapMs: 6_000,
	loadMs: 30_000,
	humanWaitMs: 90_000,
};

/** A results page left open so web_fetch can click its links. */
export interface SerpTab {
	// Engine.
	engine: EngineName;
	// Tab id.
	tab: number;
	// Address of the results page shown.
	url: string;
	// Real result address → data-wa-r tag of its link on that page.
	refs: Record<string, number>;
}

/** Search options. */
export interface BrowserSearchOptions {
	// Engines in order.
	engines: readonly EngineName[];
	// Results pages per engine (3–5).
	pages: number;
	// Time filter.
	fresh?: string;
	// Timing.
	timing: BrowserTiming;
	// Engine definitions (tests point them at local pages).
	specs?: Record<EngineName, EngineSpec>;
	// Engines resting after an uncleared verification (skipped this time).
	resting?: ReadonlySet<EngineName>;
	// Clock for the time filters (tests fix it).
	nowMs?: number;
}

/** Outcome of one engine. */
export interface EngineOutcome {
	// Engine.
	engine: EngineName;
	// Results in page order.
	hits: EngineHit[];
	// Pages read.
	pages: number;
	// Why it stopped early ("" when it read every page asked for).
	stopped: string;
	// Its last results page, kept open.
	serp: SerpTab | null;
}

/** The serp.js report. */
interface SerpReport {
	// Results with link tag.
	results: { u: string; t: string; s: string; r: number }[];
	// A next-page link exists.
	next: boolean;
	// A bot check is shown.
	challenge: boolean;
	// A consent dialog is shown.
	consent: boolean;
	// Page address.
	url: string;
}

/** Outcome of an input action. */
interface InputReply {
	// The target was found.
	clicked?: boolean;
	typed?: boolean;
	// The tab started loading.
	navigated?: boolean;
	// A tab opened by the action.
	newTab?: number | null;
}

/** Pages per engine bounded to 3–5. */
export function clampPages(n: number | undefined): number {
	// Default 3.
	const v = Math.round(n ?? 3);
	return Math.max(3, Math.min(5, Number.isFinite(v) ? v : 3));
}

/** Random pause between lo and hi ms. */
function pause(deps: BrowserDeps, lo: number, hi: number): Promise<void> {
	// Uniform.
	return deps.sleep(Math.round(lo + deps.random() * (hi - lo)));
}

/** Read the results page (serp.js). */
async function readSerp(deps: BrowserDeps, tab: number, engine: EngineName): Promise<SerpReport> {
	// Run and parse.
	const raw = await deps.call("run", { tab, script: "serp", args: { engine } }, 30_000);
	const r = JSON.parse(String(raw ?? "{}")) as Partial<SerpReport>;
	// Defaults for missing fields.
	return {
		results: r.results ?? [],
		next: !!r.next,
		challenge: !!r.challenge,
		consent: !!r.consent,
		url: r.url ?? "",
	};
}

/** Poll the results page until results or a challenge appear (results render after load). */
async function awaitResults(deps: BrowserDeps, tab: number, engine: EngineName): Promise<SerpReport> {
	// Up to eight looks about 0.7 s apart.
	let rep = await readSerp(deps, tab, engine);
	for (let i = 0; i < 7 && rep.results.length === 0 && !rep.challenge; i++) {
		await deps.sleep(700);
		rep = await readSerp(deps, tab, engine);
	}
	return rep;
}

/** Poll interval while a person clears a challenge (ms). */
const VERIFY_POLL_MS = 1500;

/**
 * Hand a challenge to the person at the screen and wait until results show. Interactive mode only; the
 * wait is bounded by waitMs, ends at once on Esc, and reports start, 30 s left, success or timeout.
 */
async function waitForPerson(
	deps: BrowserDeps,
	tab: number,
	engine: EngineName,
	waitMs: number,
	// What counts as cleared: results on a results page, or the check gone from the home page.
	until: "results" | "clear" = "results",
): Promise<SerpReport | null> {
	// Nobody to ask in print mode, or waiting switched off.
	if (!deps.interactive || waitMs <= 0) return null;
	// The tab to the front, and a note in the interface.
	await deps.call("activate", { tab }, 10_000).catch(() => {});
	deps.notify?.({ kind: "verify", engine, seconds: Math.round(waitMs / 1000) });
	// Poll until results show, the time is up, or the call is cancelled.
	let warned = waitMs <= 30_000;
	for (let waited = 0; waited < waitMs; waited += VERIFY_POLL_MS) {
		if (deps.aborted?.()) throw new Error("aborted");
		await deps.sleep(VERIFY_POLL_MS);
		if (deps.aborted?.()) throw new Error("aborted");
		const rep = await readSerp(deps, tab, engine).catch(() => null);
		if (rep && (until === "results" ? rep.results.length > 0 : !rep.challenge)) {
			deps.notify?.({ kind: "verify_ok", engine });
			return rep;
		}
		// One reminder when 30 seconds are left.
		if (!warned && waitMs - waited - VERIFY_POLL_MS <= 30_000) {
			warned = true;
			deps.notify?.({ kind: "verify_left", engine, seconds: 30 });
		}
	}
	deps.notify?.({ kind: "verify_timeout", engine });
	return null;
}

/** Search one engine like a person; never throws for page trouble (the reason goes to stopped). */
export async function searchEngine(
	deps: BrowserDeps,
	engine: EngineName,
	query: string,
	opts: BrowserSearchOptions,
): Promise<EngineOutcome> {
	// The engine's controls.
	const spec = (opts.specs ?? ENGINES)[engine];
	// Results so far.
	const hits: EngineHit[] = [];
	// Outcome fields.
	let stopped = "";
	let pages = 0;
	let serp: SerpTab | null = null;
	// Results already counted on a page that loads more in place.
	let seen = 0;
	// Resting after an uncleared verification: skipped, with the reason for the model.
	if (opts.resting?.has(engine)) return { engine, hits, pages, stopped: "verification (resting)", serp: null };
	// Not too soon after the last query to this engine.
	await deps.pace(`engine:${engine}`, opts.timing.engineGapMs);
	// The home page in a new tab.
	const opened = (await deps.call(
		"open",
		{ url: spec.home, run: deps.run, load_ms: opts.timing.loadMs },
		opts.timing.loadMs + 15_000,
	)) as {
		tab: number;
	};
	const tab = opened.tab;
	try {
		// A look at the page before acting.
		await pause(deps, 900, 2200);
		// A verification before anything else: the person first.
		let first = await readSerp(deps, tab, engine);
		if (first.challenge && first.results.length === 0) {
			const cleared = await waitForPerson(deps, tab, engine, opts.timing.humanWaitMs, "clear");
			if (!cleared) {
				await deps.call("close", { tab }, 10_000).catch(() => {});
				return { engine, hits, pages, stopped: "verification", serp: null };
			}
			first = await readSerp(deps, tab, engine);
		}
		// Consent dialog: click accept.
		if (first.consent && spec.consent.length > 0) {
			await deps.call(
				"human_click",
				{ tab, target: { ax: AX.consent, selectors: spec.consent }, load_ms: opts.timing.loadMs },
				opts.timing.loadMs + 20_000,
			);
			await pause(deps, 800, 1600);
		}
		// Click the box, type, Enter.
		const typed = (await deps.call(
			"human_type",
			{ tab, target: { ax: AX.box, selectors: spec.box }, text: query, enter: true, load_ms: opts.timing.loadMs },
			// Load time, plus up to 1.5 s per character typed.
			opts.timing.loadMs + 30_000 + [...query].length * 1500,
		)) as InputReply;
		if (!typed.typed) return { engine, hits, pages, stopped: "no search box", serp: null };
		// Enter did not submit: the search button.
		if (!typed.navigated) {
			const sub = (await deps.call(
				"human_click",
				{ tab, target: { ax: AX.submit, selectors: spec.submit }, load_ms: opts.timing.loadMs },
				opts.timing.loadMs + 20_000,
			)) as InputReply;
			if (!sub.navigated) return { engine, hits, pages, stopped: "search did not start", serp: null };
		}
		// A time filter: the same results address with the engine's filter parameter.
		if (opts.fresh) {
			const now = await readSerp(deps, tab, engine);
			const filtered = withFresh(now.url, engine, opts.fresh, opts.nowMs);
			if (filtered !== now.url)
				await deps.call(
					"navigate",
					{ tab, url: filtered, load_ms: opts.timing.loadMs },
					opts.timing.loadMs + 15_000,
				);
		}
		// Results pages.
		for (let p = 1; p <= opts.pages; p++) {
			// Wait for the results; a challenge goes to the person.
			let rep = await awaitResults(deps, tab, engine);
			// (Result text can mention such words: results on the page mean there is no wall.)
			if (rep.challenge && rep.results.length === 0) {
				const solved = await waitForPerson(deps, tab, engine, opts.timing.humanWaitMs);
				if (!solved) {
					stopped = "verification";
					break;
				}
				rep = solved;
			}
			if (rep.results.length === 0) {
				stopped = p === 1 ? "no results" : "";
				break;
			}
			// Collect this page's results (a page that loads more in place lists the earlier ones again).
			const refs: Record<string, number> = {};
			const fresh = spec.infinite ? rep.results.filter((r) => r.r >= seen) : rep.results;
			seen = rep.results.length;
			if (fresh.length === 0) break;
			for (const r of rep.results) refs[resultTarget(r.u)] = r.r;
			for (const r of fresh) {
				const url = resultTarget(r.u);
				hits.push({ engine, pos: hits.length, url, title: r.t, snippet: r.s });
			}
			pages = p;
			serp = { engine, tab, url: rep.url, refs };
			// Read the page like a person: three to five wheel turns with reading time between them.
			await deps.call("human_scroll", { tab, steps: 3 + Math.floor(deps.random() * 3) }, 60_000);
			// Last page wanted.
			if (p === opts.pages) break;
			// More results in place: read down to the bottom, as a person does, and let them load.
			if (spec.infinite) {
				await deps.call("human_scroll", { tab, steps: 5, px: 900 }, 60_000);
				// Up to about six seconds for the new results to appear.
				for (let i = 0; i < 8; i++) {
					await deps.sleep(700);
					if ((await readSerp(deps, tab, engine)).results.length > seen) break;
				}
				continue;
			}
			// Is there a next page? Looked up on screen (accessibility tree), the page script's answer as a fallback;
			// a pager drawn only near the bottom: read further down, then look again.
			const nextTarget = { ax: AX.next, selectors: spec.next, text: spec.nextText };
			const seesNext = async () =>
				((await deps.call("find", { tab, target: nextTarget }, 30_000)) as { found?: boolean } | null)?.found ===
				true;
			if (!(await seesNext()) && !rep.next) {
				await deps.call("human_scroll", { tab, steps: 3, px: 800 }, 30_000);
				if (!(await seesNext()) && !(await readSerp(deps, tab, engine)).next) break;
			}
			// A moment before reaching for Next.
			await pause(deps, 1500, 4000);
			// Click "Next".
			const nx = (await deps.call(
				"human_click",
				{ tab, target: nextTarget, load_ms: opts.timing.loadMs },
				opts.timing.loadMs + 30_000,
			)) as InputReply;
			if (!nx.navigated) break;
		}
	} catch (e) {
		// Keep what was collected; report the reason.
		stopped = e instanceof Error ? e.message : String(e);
	}
	// A tab without results is closed; the last results page stays for web_fetch.
	if (!serp) await deps.call("close", { tab }, 10_000).catch(() => {});
	return { engine, hits, pages, stopped, serp };
}

/** Search every engine in turn and rank the merged results. */
export async function browserSearch(
	deps: BrowserDeps,
	query: string,
	opts: BrowserSearchOptions,
): Promise<{ ranked: RankedHit[]; outcomes: EngineOutcome[] }> {
	// One engine after another, as a person would.
	const outcomes: EngineOutcome[] = [];
	for (const e of opts.engines) {
		outcomes.push(await searchEngine(deps, e, query, opts));
		// Esc: no further engine.
		if (deps.aborted?.()) break;
	}
	// Ranked merge.
	return {
		ranked: rankHits(
			query,
			outcomes.flatMap((o) => o.hits),
		),
		outcomes,
	};
}
