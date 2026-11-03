/**
 * The search engines the browser backend can use (Bing, Google, Baidu, Sogou; the model picks them per
 * search): where each one's controls are on the page, so they can be clicked and typed into as a person would.
 */

/** Engine names in the order they are used. */
export type EngineName = "bing" | "google" | "baidu" | "sogou";

/** Every engine, in the order they are listed to the model. */
export const ALL_ENGINES: readonly EngineName[] = ["bing", "google", "baidu", "sogou"];

/** Default engine order when neither the model nor JW_ENGINES picks (Bing first). */
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
	// Label the next-page link must show (pagers whose links share one selector).
	nextText?: string;
	// More results load when the page is scrolled to the bottom, in place of a pager (Sogou, 2026-11-03).
	infinite?: boolean;
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
	baidu: {
		name: "baidu",
		home: "https://www.baidu.com/",
		// The 2025 home page has a chat-style text area; the classic input remains on some pages.
		box: ["#chat-textarea", "#kw", "textarea[name='wd']", "input[name='wd']"],
		submit: ["#chat-submit-button", "#su"],
		consent: [],
		next: ["#page a.n", "#page a"],
		nextText: "^\\s*下一页",
	},
	sogou: {
		name: "sogou",
		home: "https://www.sogou.com/",
		box: ["#query", "#upquery", "input[name='query']"],
		submit: ["#stb", "#searchBtn"],
		consent: [],
		next: ["#sogou_next", "#pagebar_container a", ".p a"],
		nextText: "^\\s*下一页",
		infinite: true,
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

/** Engine list from JW_ENGINES or the model ("bing,google"); unknown names are dropped, empty means the default. */
export function parseEngines(raw: string | readonly string[] | undefined): EngineName[] {
	// Names in order, without duplicates.
	const names = (Array.isArray(raw) ? raw.join(",") : ((raw as string | undefined) ?? ""))
		.split(/[,\s]+/)
		.map((s) => s.trim().toLowerCase())
		.filter((s): s is EngineName => (ALL_ENGINES as readonly string[]).includes(s));
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
	// Google's AMP viewer: /amp/s/<host/path> is https, /amp/<host/path> is http.
	if (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname.startsWith("/amp/")) {
		const rest = u.pathname.slice(5);
		return rest.startsWith("s/") ? `https://${rest.slice(2)}` : `http://${rest}`;
	}
	// A direct link.
	return href;
}

/** The results address with the engine's time filter (the filter menus are several clicks deep). */
export function withFresh(
	url: string,
	engine: EngineName,
	fresh: string | undefined,
	nowMs: number = Date.now(),
): string {
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
	} else if (engine === "baidu") {
		// gpc=stf=<start>,<end>|stftype=1 in Unix seconds.
		const days = { day: 1, week: 7, month: 31, year: 366 }[fresh];
		if (days) {
			const end = Math.floor(nowMs / 1000);
			u.searchParams.set("gpc", `stf=${end - days * 86400},${end}|stftype=1`);
		}
	} else if (engine === "sogou") {
		// tsn=1|2|3 (day, week, month; no year filter).
		const m = { day: "1", week: "2", month: "3" }[fresh];
		if (m) u.searchParams.set("tsn", m);
	} else {
		// filters=ex1:"ez1|ez2|ez3" (no year filter).
		const m = { day: "ez1", week: "ez2", month: "ez3" }[fresh];
		if (m) u.searchParams.set("filters", `ex1:"${m}"`);
	}
	// The new address.
	return u.toString();
}
