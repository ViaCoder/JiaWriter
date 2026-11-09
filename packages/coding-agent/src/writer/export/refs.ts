/**
 * The reference list of a draft (the user, 2026-11-04: every reference has a working, accessible URL and a
 * descriptive title). Finds the 参考文献 / References section, and checks each entry for an http(s) URL, a
 * descriptive title, and that the URL is a page fetch_web opened in this session (it loaded and had text).
 */

/** What one entry lacks. */
export type RefProblem = "url" | "title" | "opened";

/** One entry with its problems. */
export interface RefIssue {
	// The entry's first characters.
	start: string;
	// What it lacks.
	problems: RefProblem[];
	// Its http(s) URLs as written.
	urls: string[];
}

/** Result of checking the reference list. */
export interface RefReport {
	// Entries found in the reference section (0: no section).
	entries: number;
	// Entries with at least one problem.
	issues: RefIssue[];
}

// Names of a reference section.
const REF_NAME =
	"参考文献|参考资料|参考来源|参考链接|资料来源|引用来源|引用文献|信息来源|来源|出处|References|Sources|Bibliography|Works Cited";
// The section as a Markdown heading ("## 参考文献", "## 五、参考资料").
const REF_HEADING = new RegExp(
	`^(#{1,6})\\s+(?:[\\d一二三四五六七八九十]+[.、．]\\s*)?(?:${REF_NAME})\\s*[:：]?\\s*$`,
	"i",
);
// The section as a line of its own ("**参考文献**", "参考资料：").
const REF_LABEL = new RegExp(`^\\s*(?:\\*\\*)?(?:${REF_NAME})(?:\\*\\*)?\\s*[:：]?\\s*(?:\\*\\*)?\\s*$`, "i");
// Markdown links and bare URLs.
const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const BARE = /https?:\/\/[^\s<>()（）　-〿＀-￯]+/g;
// Labels that name no source.
const GENERIC =
	/^(链接|网址|网页|原文|原文链接|来源|出处|点击这里|点此|此处|这里|官网|详见|link|here|source|website|web ?page|url|click here|read more)$/i;

/** A URL in a comparable form: lower-case host without www., no fragment, no trailing slash; "" when not http(s). */
export function normalizeUrl(raw: string): string {
	// Parse; anything that is not an absolute http(s) URL with a dotted host is no URL.
	try {
		const u = new URL(raw.replace(/[.,;:!?'"]+$/, ""));
		if ((u.protocol !== "http:" && u.protocol !== "https:") || !/\.[a-z0-9-]+$/i.test(u.hostname)) return "";
		const host = u.hostname.toLowerCase().replace(/^www\./, "");
		const path = u.pathname.replace(/\/+$/, "");
		return `${host}${path}${u.search}`;
	} catch {
		return "";
	}
}

/** The entry lines of the reference section: list items and paragraph lines up to the next heading of the same or a higher level. */
export function referenceEntries(markdown: string): string[] {
	// All lines.
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	// Entries, and the level of the open section (0: none; 7: a label line, closed by any heading).
	const entries: string[] = [];
	let level = 0;
	let code = false;
	for (const line of lines) {
		// Code fences are no references.
		if (/^\s*```/.test(line)) {
			code = !code;
			continue;
		}
		if (code) continue;
		// A heading opens or closes the section.
		const h = /^(#{1,6})\s/.exec(line);
		const ref = REF_HEADING.exec(line);
		if (ref) {
			level = ref[1].length;
			continue;
		}
		if (h && level > 0 && h[1].length <= level) level = 0;
		if (!h && REF_LABEL.test(line)) {
			level = 7;
			continue;
		}
		// Inside the section: every non-empty line that is not a sub-heading is one entry.
		if (level > 0 && !h && line.trim() !== "" && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) entries.push(line.trim());
	}
	return entries;
}

/** An entry's URLs as written and the text that names it (link labels kept, URLs removed). */
export function splitEntry(entry: string): { urls: string[]; text: string } {
	// URLs collected while they are taken out of the text.
	const urls: string[] = [];
	const text = entry
		.replace(LINK, (_m, label: string, url: string) => {
			urls.push(url);
			return label === url ? " " : ` ${label} `;
		})
		.replace(BARE, (url) => {
			urls.push(url.replace(/[.,;:!?'"]+$/, ""));
			return " ";
		});
	return { urls, text };
}

/** A word that names an outlet: what news agencies, papers, sites and stations end in. */
const OUTLET_WORD =
	/^[\u4e00-\u9fa5A-Za-z]{2,12}?(?:通讯社|电视台|新闻网|新闻社|新闻|周刊|杂志|日报|晚报|时报|财经|报|网|社|台|网站)$/;

/** The outlets and longer titles an entry names, for finding it in the text. */
export function entryNames(entry: string): string[] {
	const words = splitEntry(entry)
		.text.split(/[，,：:（）()《》[\]\s|｜、]+/)
		.map((w) => w.trim())
		.filter(Boolean);
	return words.filter((w) => !/\d/.test(w) && (OUTLET_WORD.test(w) || w.length >= 8));
}

/**
 * The numbers of the entries the body never cites: no [n] marker, and neither its outlet nor its title appears
 * (2026-11-09: a third of 94 entries in ten research reports; the body named only an institution, or another outlet
 * than the entry). An entry that names nothing to look for is left out.
 */
export function uncitedReferences(markdown: string, body: string): { n: number; names: string[] }[] {
	return referenceEntries(markdown).flatMap((entry, i) => {
		const names = entryNames(entry);
		if (names.length === 0) return [];
		const cited = body.includes(`[${i + 1}]`) || names.some((name) => body.includes(name));
		return cited ? [] : [{ n: i + 1, names }];
	});
}

/** The problems of one entry; `opened` (normalized URLs) is undefined when the session is not known. */
export function checkEntry(entry: string, opened?: ReadonlySet<string>): RefProblem[] {
	// URLs of the entry, the usable ones normalized, and the text that names it.
	const { urls, text } = splitEntry(entry);
	const good = urls.map(normalizeUrl).filter((u) => u !== "");
	// The title: the text without list marks, numbers in brackets and punctuation.
	const title = text
		.replace(/^\s*(?:[-*+]|\d{1,3}[.)．、]|\[\d{1,3}\]|［\d{1,3}］)\s*/, "")
		.replace(/[\s\p{P}\p{S}]+/gu, " ")
		.trim();
	const letters = (title.match(/[\p{L}\p{N}]/gu) ?? []).length;
	const problems: RefProblem[] = [];
	if (good.length === 0) problems.push("url");
	if (letters < 4 || GENERIC.test(title)) problems.push("title");
	if (opened && good.length > 0 && !good.some((u) => opened.has(u))) problems.push("opened");
	return problems;
}

/** Check the reference section of a draft. */
export function checkReferences(markdown: string, opened?: readonly string[]): RefReport {
	// Normalized URLs the session opened.
	const set = opened ? new Set(opened.map(normalizeUrl).filter((u) => u !== "")) : undefined;
	// Each entry with its problems.
	const entries = referenceEntries(markdown);
	const issues = entries
		.map((e) => ({
			start: e.slice(0, 40),
			problems: checkEntry(e, set),
			urls: splitEntry(e).urls.filter((u) => normalizeUrl(u) !== ""),
		}))
		.filter((r) => r.problems.length > 0);
	return { entries: entries.length, issues };
}

/** URLs of the reference list that this session has not opened yet, each once (to open and test with fetch_web). */
export function unopenedUrls(report: RefReport): string[] {
	// Entries flagged "opened", their URLs, without repeats.
	const out: string[] = [];
	for (const i of report.issues)
		if (i.problems.includes("opened")) for (const u of i.urls) if (!out.includes(u)) out.push(u);
	return out;
}

/** One message of the session, as far as fetch_web calls and results go. */
interface SessionMessage {
	role?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	details?: { url?: unknown; chars?: unknown };
	content?: unknown;
}

/** URLs of pages fetch_web opened with text in these messages: the requested URL and the final one. */
export function openedUrls(messages: readonly unknown[]): string[] {
	// Requested URLs by tool call id.
	const asked = new Map<string, string>();
	for (const m of messages as SessionMessage[]) {
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content as { type?: string; id?: string; name?: string; arguments?: { url?: unknown } }[]) {
			if (b?.type === "toolCall" && b.name === "fetch_web" && typeof b.arguments?.url === "string" && b.id)
				asked.set(b.id, b.arguments.url);
		}
	}
	// Successful results with text.
	const urls: string[] = [];
	for (const m of messages as SessionMessage[]) {
		if (m?.role !== "toolResult" || m.toolName !== "fetch_web" || m.isError) continue;
		if (typeof m.details?.chars !== "number" || m.details.chars <= 0) continue;
		if (typeof m.details.url === "string") urls.push(m.details.url);
		const a = m.toolCallId ? asked.get(m.toolCallId) : undefined;
		if (a) urls.push(a);
	}
	return urls;
}
