/** How to use each search and fetch method: given with the first success of that method. */

/** The browser's rule for a check a person has to clear. */
const HUMAN_CHECK = "If a human check stays open, tell the user, and retry when they are done";

/** The rule both upstream search methods share. */
const UPSTREAM_SOURCES =
	"Only addresses in the results list go into 参考文献, never one found only in the upstream's text";

/** search_web, by method. */
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
		"tag academic.paper finds papers with abstracts",
	],
	deepseek: [
		"Query: a topic, not just news, at most 128 characters",
		"Operators in the query: site:a.com site:b.com, lang:en; dates go in after and before",
	],
	firecrawl: [
		"news: true for news hours old from major outlets; after, before and fresh filter web results only",
		"site:domain in the query limits the outlets",
	],
	claude: [
		"query is the only parameter: ask one full question and put any time range in it. The upstream researches it in up to 8 searches and reports",
		"Results give titles, page ages and cited passages; treat the upstream's answer as a guide",
		UPSTREAM_SOURCES,
	],
	codex: [
		"fresh: day, week, month or year. Search again with what you found",
		"Fetch a page before relying on it; ids like turn0search3 work as its url",
		UPSTREAM_SOURCES,
		"An effort error needs a higher level: tell the user",
	],
};

/** fetch_web, by method. */
export const FETCH_METHODS: Readonly<Record<string, readonly string[]>> = {
	browser: [
		"Best for news sites and JavaScript pages",
		HUMAN_CHECK,
		"If the result says the text may not be the page asked for, tell the user",
	],
	anysearch: ["Fast for ordinary articles; sites that block crawlers and JavaScript pages give little"],
	deepseek: ["Clean text of ordinary articles; paywalled pages give only a summary"],
	firecrawl: ["Main text of news pages, Reuters included"],
	sf: [
		"For PDF, Word and Excel links and video pages; ordinary articles are faster elsewhere",
		"It reads text layers only: tell the user when a document is a scan",
	],
	claude: [
		"Gives the page as the upstream fetched it, possibly cached",
		"JavaScript pages, sites closed to crawlers and addresses over 250 characters need browser; PDFs need sf",
	],
	codex: [
		"lineno reads on in a long page, find gives the passages with some words",
		"The text may be the upstream's own report: check exact wording and figures",
		"When it cannot give a page you get an error: tell the user",
		"An address outside search results may not open: search for it first",
	],
};
