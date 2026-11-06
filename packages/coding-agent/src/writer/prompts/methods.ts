/** How to use each search and fetch method: given with the first success of that method. */

/** The browser's rule for a check a person has to clear. */
const HUMAN_CHECK = "If a human check stays open, tell the user, and retry when they are done";

/** The rule both upstream search methods share. */
const UPSTREAM_SOURCES =
	"Only addresses in the results list go into 参考文献, never one found only in the upstream's text";

/** web_search, by method. */
export const SEARCH_METHODS: Readonly<Record<string, readonly string[]>> = {
	browser: [
		"engines: baidu and sogou (also WeChat) for mainland sources, bing and google for international; each takes 1–2 minutes",
		"pages: results pages per engine, 3 to 5, default 3",
		"fresh: day, week or month; year only on google and baidu",
		"site:domain and quoted exact names work",
		HUMAN_CHECK,
	],
	anysearch: [
		"zone: intl with an English query for international cases, cn for Chinese sources",
		"At most 10 results, with no paging, time filter, site: or dates: search other words for more, and fetch a page for its date",
	],
	claude: [
		"query is the only parameter, so ask one thing per call and put any time range in it; the upstream runs up to 8 searches",
		"Results give titles, page ages and cited passages; treat the upstream's answer as a guide",
		UPSTREAM_SOURCES,
	],
	codex: [
		"query is the only parameter, so ask one thing per call and put any time range in it",
		"Results often give bare addresses: fetch a page before relying on it",
		UPSTREAM_SOURCES,
		"An effort error means this search needs a higher level: tell the user or use another method",
	],
};

/** web_fetch, by method. */
export const FETCH_METHODS: Readonly<Record<string, readonly string[]>> = {
	browser: [
		"Best for news sites and JavaScript pages",
		HUMAN_CHECK,
		"If the result says the text may not be the page asked for, use another method",
	],
	anysearch: [
		"Fast for ordinary articles; sites that block crawlers and JavaScript pages give little, so use browser",
	],
	sf: [
		"For PDF, Word and Excel links and video pages; ordinary articles are faster elsewhere",
		"It reads text layers only: tell the user when a document is a scan",
	],
	claude: [
		"Gives the page as the upstream fetched it, possibly cached",
		"JavaScript pages, sites closed to crawlers and addresses over 250 characters need browser; PDFs need sf",
	],
	codex: [
		"The upstream writes the page out, so it can be shortened: check exact wording and figures with another method",
		"An address outside search results may not open: search for it first",
	],
};
