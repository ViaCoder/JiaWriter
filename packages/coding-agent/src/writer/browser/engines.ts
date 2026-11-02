/**
 * The search engines the browser backend uses, Bing first and Google second: where each one's
 * controls are on the page, so they can be clicked and typed into as a person would.
 */

/** Engine names in the order they are used. */
export type EngineName = "bing" | "google";

/** Default engine order (Bing first). */
export const DEFAULT_ENGINES: readonly EngineName[] = ["bing", "google"];

/** Where an engine's controls are. */
export interface EngineSpec {
	// Name.
	name: EngineName;
	// Home page a person opens.
	home: string;
	// The search box, most specific first.
	box: string[];
	// The search button (used when Enter did not submit).
	submit: string[];
	// The accept button of a cookie consent dialog.
	consent: string[];
	// The next-page link.
	next: string[];
}

/** Bing and Google. */
export const ENGINES: Record<EngineName, EngineSpec> = {
	bing: {
		name: "bing",
		home: "https://www.bing.com/",
		box: ["#sb_form_q", "textarea[name='q']", "input[name='q']"],
		submit: ["#search_icon", "label[for='sb_form_go']", "#sb_form_go"],
		consent: ["#bnp_btn_accept", "button#bnp_btn_accept"],
		next: [
			"a.sb_pagN",
			"a[title='Next page']",
			"a[title='下一页']",
			"a[aria-label='Next page']",
			"a[aria-label='下一页']",
		],
	},
	google: {
		name: "google",
		home: "https://www.google.com/",
		box: ["textarea[name='q']", "input[name='q']"],
		submit: ["button[aria-label='Google Search']", "button[aria-label='Google 搜索']", "input[name='btnK']"],
		consent: [
			"#L2AGLb",
			"button[aria-label*='Accept all']",
			"button[aria-label*='全部接受']",
			"form[action*='consent'] button",
		],
		next: ["#pnnext", "a[aria-label='Next page']", "a[aria-label='下一页']"],
	},
};

/** Engine list from WA_ENGINES ("bing,google"); unknown names are dropped, empty means the default. */
export function parseEngines(raw: string | undefined): EngineName[] {
	// Names in order, without duplicates.
	const names = (raw ?? "")
		.split(/[,\s]+/)
		.map((s) => s.trim().toLowerCase())
		.filter((s): s is EngineName => s === "bing" || s === "google");
	const unique = [...new Set(names)];
	// The default when nothing valid was given.
	return unique.length > 0 ? unique : [...DEFAULT_ENGINES];
}

/** The real address behind a result link (Bing /ck/a?u=a1<base64url>, Google /url?q=…); others unchanged. */
export function resultTarget(href: string): string {
	// Parse.
	let u: URL;
	try {
		u = new URL(href);
	} catch {
		return href;
	}
	const host = u.hostname.toLowerCase();
	// Bing's click wrapper.
	if (/(^|\.)bing\.com$/.test(host) && u.pathname === "/ck/a") {
		const enc = u.searchParams.get("u") ?? "";
		if (enc.startsWith("a1")) {
			try {
				const decoded = Buffer.from(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
				if (/^https?:\/\//.test(decoded)) return decoded;
			} catch {
				// Not decodable: keep the wrapper.
			}
		}
		return href;
	}
	// Google's redirect page (/url?…&q=&…&url=<target>: q is often present but empty).
	if (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname === "/url") {
		const q = u.searchParams.get("q") || u.searchParams.get("url") || "";
		if (/^https?:\/\//.test(q)) return q;
	}
	// A direct link.
	return href;
}

/** The results address with the engine's time filter (the filter menus are several clicks deep). */
export function withFresh(url: string, engine: EngineName, fresh: string | undefined): string {
	// No filter asked for.
	if (!fresh) return url;
	// Parse.
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return url;
	}
	if (engine === "google") {
		// tbs=qdr:d|w|m|y.
		const m = { day: "d", week: "w", month: "m", year: "y" }[fresh];
		if (m) u.searchParams.set("tbs", `qdr:${m}`);
	} else {
		// filters=ex1:"ez1|ez2|ez3" (no year filter).
		const m = { day: "ez1", week: "ez2", month: "ez3" }[fresh];
		if (m) u.searchParams.set("filters", `ex1:"${m}"`);
	}
	// The new address.
	return u.toString();
}
