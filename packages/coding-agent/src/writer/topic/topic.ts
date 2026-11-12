/**
 * Topic folders: one folder per writing topic holds everything the work on it produced, so research
 * survives the session and compaction. Pure file work; the extensions decide when to call it.
 *   <topic>/稿件/      drafts and exports
 *   <topic>/参考资料/  the user's files
 *   <topic>/检索/      every search, one file each
 *   <topic>/网页/      every fetched page in full
 *   <topic>/素材.md    the cases and data chosen for the draft, as excerpts of their sources
 *   <topic>/.index.jsonl  what was archived, one JSON line each
 */

// Files.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
// Paths.
import { basename, dirname, join } from "node:path";
// The parsed copies of the user's files, where a file's excerpts are checked.
import { parsedFiles } from "../docs/import.ts";
// URL comparison shared with the reference check.
import { normalizeUrl } from "../export/refs.ts";
// Output messages.
import { t } from "../i18n/index.ts";
// Outlets, as opposed to documents, in citations.
import { isOutletName } from "../style/citation.ts";
// The body of a draft, without its reference list.
import { bodyBeforeReferences } from "../text-stats.ts";
// The date in an address.
import { urlDate } from "../websearch/core.ts";

/** Subfolders of a topic. */
export const TOPIC_DIRS = { drafts: "稿件", refs: "参考资料", search: "检索", web: "网页" } as const;
/** The materials file. */
export const MATERIAL_FILE = "素材.md";
/** The archive index. */
const INDEX_FILE = ".index.jsonl";
/** Longest topic name and file name part (characters). */
const MAX_NAME = 40;
/** Most words of a topic in a folder name (the user, 2026-11-06: "20261106+topic word(1-3 words)"). */
const MAX_WORDS = 3;
/** Longest topic part of a folder name. */
const MAX_TOPIC = 24;
/** Marks a folder named by the program, until topic_open names it. */
const AUTO_MARK = ".auto-name";
/** Name of a topic with no words to take from anywhere. */
const AUTO_WORD = "资料";
/** Words that say when or link others, in a query's words. */
const NOT_TOPIC =
	/^(?:the|a|an|of|for|to|in|on|at|by|and|or|with|from|about|january|february|march|april|may|june|july|august|september|october|november|december)$/i;

/** One line of the archive index. */
export interface IndexEntry {
	// Running number within the topic.
	n: number;
	// A search or a page.
	kind: "search" | "page";
	// Path inside the topic folder.
	file: string;
	// Query or page title.
	title: string;
	// Page address (pages only), and the address asked for when it redirected.
	url?: string;
	requested?: string;
	// Addresses in a search's results (searches only).
	urls?: string[];
}

/**
 * A case or a data point for the draft, kept as the source's own words: an excerpt, never the model's summary (the
 * user, 2026-11-11: "everything is saved as a direct excerpt rather than being paraphrased by AI. This avoids wasting
 * tokens and prevents the introduction of an "AI-like" tone").
 */
export interface Material {
	// A case: time, reporter, subject, passage. Data: time, passage.
	kind: "case" | "data";
	// As the source states it; none when it states none (the user, 2026-11-10: "if there's no date, don't write it down").
	time?: string;
	reporter?: string;
	// The named company, body or person of a case.
	subject?: string;
	// The model names the passage by its first words and, when it runs beyond that sentence, its last words.
	start?: string;
	end?: string;
	// The passage itself, as the program took it from the source.
	quote?: string;
	// Where it comes from: a URL archived in this topic, or a reference file and page.
	url?: string;
	file?: string;
	page?: string;
	// The outline part it belongs to.
	section?: string;
}

/** text as a file or folder name: no path marks or control characters, no dots at the ends, bounded. */
export function safeName(text: string): string {
	// Path and shell marks become spaces, which then collapse.
	return text
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
		.replace(/\s+/g, " ")
		.slice(0, MAX_NAME)
		.replace(/^[\s.]+|[\s.]+$/g, "");
}

/** text without web addresses: a file name is shown wherever its path is, also in the search log. */
function withoutAddresses(text: string): string {
	return text.replace(/\S*:\/\/\S*|\b(?:www\.|site:)\S*/gi, " ");
}

/** The day in local time, YYYYMMDD: every topic folder starts with it. */
function dayStamp(now: Date): string {
	// Two digits for month and day.
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/** The words of a topic: the first three, within the length of a folder name. */
function firstWords(name: string): string {
	return name.split(" ").slice(0, MAX_WORDS).join("-").slice(0, MAX_TOPIC);
}

/** Up to three words that name a topic, from a query or a title; "" when it has none. */
export function topicWords(text: string): string {
	// Words end at spaces and punctuation; a site: filter, an address or a quoted number names nothing.
	const words = text
		.split(/[\s,，。、;；:：|()（）"“”'‘’[\]《》]+/)
		.filter((word) => word && !/^(?:site|https?)$|[/.]/i.test(word))
		// Dates and numbers say when, and short linking words say nothing.
		.filter((word) => !/^\d+(?:[年月日号]\d*)*[年月日号]?$/.test(word) && !NOT_TOPIC.test(word));
	return safeName(words.slice(0, MAX_WORDS).join(" ")).replace(/ /g, "-").slice(0, MAX_TOPIC);
}

/** Folder of a topic name: a folder already holding it, on any day, else a new one dated today. */
export function topicPath(cwd: string, name: string, now: Date = new Date()): string {
	// A name that already carries its date is the folder's own name.
	if (/^\d{8}-/.test(name)) return basename(cwd) === name ? cwd : join(cwd, name);
	// The words as the folder would hold them.
	const words = firstWords(name);
	/** True for a folder of this topic, dated or from before dates. */
	const same = (folder: string) => folder === name || folder.replace(/^\d{8}-/, "") === words;
	// A user who started JiaWriter inside the topic folder gets no folder within a folder.
	if (same(basename(cwd))) return cwd;
	// The latest folder of this topic, so the same words continue it on another day.
	const found = existsSync(cwd) ? readdirSync(cwd).filter(same).sort().at(-1) : undefined;
	return join(cwd, found ?? `${dayStamp(now)}-${words}`);
}

/** Create or reuse a topic's folders; returns the folder and whether it was there already. */
export function openTopic(cwd: string, name: string, now: Date = new Date()): { dir: string; existed: boolean } {
	// A name left empty by cleaning is refused.
	const clean = safeName(name);
	if (!clean) throw new Error(t("topic.badName", { name }));
	const dir = topicPath(cwd, clean, now);
	const existed = existsSync(join(dir, INDEX_FILE)) || existsSync(join(dir, TOPIC_DIRS.drafts));
	for (const sub of Object.values(TOPIC_DIRS)) mkdirSync(join(dir, sub), { recursive: true });
	return { dir, existed };
}

/** Open a topic the model did not name, called after what it is doing; topic_open may still rename it. */
export function openAutoTopic(cwd: string, hint: string, now: Date = new Date()): string {
	// Words of the search or page, or a plain word when there are none.
	const { dir, existed } = openTopic(cwd, topicWords(hint) || AUTO_WORD, now);
	// Only a new folder is marked: one with this name from before keeps it.
	if (!existed) writeFileSync(join(dir, AUTO_MARK), "");
	return dir;
}

/** True for a folder the program named itself. */
export function isUnnamedTopic(dir: string): boolean {
	return existsSync(join(dir, AUTO_MARK));
}

/** Give an unnamed folder its topic's name, so research done first stays with the draft; false when that
 * name is taken, in which case the old folder stays where it is. */
export function adoptUnnamedTopic(unnamed: string, cwd: string, name: string, now: Date = new Date()): boolean {
	const clean = safeName(name);
	if (!clean || !isUnnamedTopic(unnamed) || !existsSync(unnamed)) return false;
	// The folder this name belongs in.
	const target = topicPath(cwd, clean, now);
	// The same folder needs no move, only to stop counting as unnamed.
	if (target === unnamed) {
		rmSync(join(unnamed, AUTO_MARK));
		return true;
	}
	if (existsSync(target)) return false;
	renameSync(unnamed, target);
	rmSync(join(target, AUTO_MARK));
	return true;
}

/** The archive index of a topic (lines that cannot be read are skipped). */
export function readIndex(dir: string): IndexEntry[] {
	// A missing file is an empty index.
	const file = join(dir, INDEX_FILE);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf-8")
		.split("\n")
		.flatMap((line) => {
			try {
				return line.trim() ? [JSON.parse(line) as IndexEntry] : [];
			} catch {
				return [];
			}
		});
}

/** Write one archived file and add it to the index; returns its path inside the topic folder. */
function archive(
	dir: string,
	kind: IndexEntry["kind"],
	sub: string,
	title: string,
	text: string,
	url?: string,
	requested?: string,
	urls?: readonly string[],
): string {
	// Running number over both kinds, then a readable name.
	const n = readIndex(dir).reduce((most, e) => Math.max(most, e.n), 0) + 1;
	const file = join(sub, `${String(n).padStart(3, "0")}-${safeName(withoutAddresses(title)) || kind}.md`);
	mkdirSync(join(dir, sub), { recursive: true });
	writeFileSync(join(dir, file), text);
	appendFileSync(
		join(dir, INDEX_FILE),
		`${JSON.stringify({ n, kind, file, title, url, requested, urls: urls && [...urls] } satisfies IndexEntry)}\n`,
	);
	return file;
}

/** Keep one search's report, and the addresses it listed as sources for material_add. */
export function archiveSearch(
	dir: string,
	query: string,
	report: string,
	at: string,
	urls: readonly string[] = [],
): string {
	// The report as the model read it, with the time.
	const text = `# ${query}\n\n检索时间：${at}\n\n${report}\n`;
	return archive(dir, "search", TOPIC_DIRS.search, query, text, undefined, undefined, urls);
}

/** Keep one fetched page in full, under the address it was asked for and the one it ended at. */
export function archivePage(
	dir: string,
	page: { url: string; title: string; date: string; content: string },
	requested: string,
	method: string,
	at: string,
): string {
	// A page fetched again keeps its file; only new text is worth a second copy.
	const known = readIndex(dir).find((e) => e.kind === "page" && e.url === page.url);
	const head = [
		`# ${page.title || page.url}`,
		"",
		`网址：${page.url}`,
		...(requested !== page.url ? [`请求网址：${requested}`] : []),
		`发布日期：${page.date || "未知"}`,
		`抓取方式：${method}`,
		`抓取时间：${at}`,
		"",
		"---",
		"",
	].join("\n");
	if (known) {
		writeFileSync(join(dir, known.file), `${head}${page.content}\n`);
		// A new way to the same page counts as archived too.
		if (requested !== page.url && requested !== known.requested)
			appendFileSync(join(dir, INDEX_FILE), `${JSON.stringify({ ...known, requested })}\n`);
		return known.file;
	}
	const asked = requested !== page.url ? requested : undefined;
	// Without a title, the text's first words name the file.
	const name = page.title || page.content.slice(0, 200).replace(/^[#>*\s-]+/, "");
	return archive(dir, "page", TOPIC_DIRS.web, name, `${head}${page.content}\n`, page.url, asked);
}

/** Keep the text left out of a page beside its archive file, so a misjudged passage is never lost. */
export function archiveFiltered(dir: string, pageFile: string, filtered: readonly string[]): string {
	// A hidden folder: searches through the archive do not pick it up by accident.
	const file = join(TOPIC_DIRS.web, ".过滤", basename(pageFile));
	mkdirSync(join(dir, TOPIC_DIRS.web, ".过滤"), { recursive: true });
	writeFileSync(join(dir, file), `${filtered.join("\n\n")}\n`);
	return file;
}

/** Addresses archived in a topic, normalized for comparison: where each page ended and what was asked for. */
export function archivedUrls(dir: string): string[] {
	// The pages of the index.
	return readIndex(dir).flatMap((e) =>
		e.kind === "page" ? [e.url, e.requested].flatMap((u) => (u ? [normalizeUrl(u)] : [])) : [],
	);
}

/** An address as compared for materials: normalized when it is a web address, else as it stands. */
function materialKey(url: string): string {
	return normalizeUrl(url) || url.trim();
}

/** Addresses a material may cite: pages kept in the topic and every search result. */
export function materialUrls(dir: string): string[] {
	// Search results count here, and only here: the export check asks what was really opened.
	return [...archivedUrls(dir), ...readIndex(dir).flatMap((e) => (e.urls ?? []).map(materialKey))];
}

/** Fields a material must have, by kind. */
const REQUIRED: Readonly<Record<Material["kind"], readonly (keyof Material)[]>> = {
	// The acting subject and where its passage starts; the reporter too when the case is from the web (below). The
	// time only when the source gives one, so it is never required (2026-11-10: a page said 近期 and the material said
	// 2025年10月).
	case: ["subject", "start"],
	// Where the passage with the figure starts.
	data: ["start"],
};

/** Longest passage (characters): the sentences that hold the fact, not the page. */
export const MAX_QUOTE = 300;
/** Longest start or end (characters) before the model is reminded that a few words name the passage. */
export const MAX_ANCHOR = 20;

/**
 * Whether a model wrote out whole sentences as start or end (2026-11-11: GLM gave 2,311 characters of start and end
 * for 1,589 characters of passages): the program then reminds it, without sending the items back for it.
 */
export function longAnchors(items: readonly Material[]): boolean {
	return items.some((i) => (i.start?.trim().length ?? 0) > MAX_ANCHOR || (i.end?.trim().length ?? 0) > MAX_ANCHOR);
}

/** Reference files with no pages to cite (text, Markdown, HTML, as imported or as they stand). */
const PAGELESS = /\.(txt|md|html?)(\.md)?$/i;

/** The material with a local path given as its url taken as its file (a model on 2026-11-08 did that three times). */
export function asFileSource(item: Material): Material {
	const url = item.url?.trim() ?? "";
	if (item.file?.trim() || !url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return item;
	return { ...item, file: url, url: undefined };
}

/** What is wrong with one material, as a sentence; empty when it is complete. */
export function materialProblem(item: Material, archived: readonly string[]): string {
	// Missing fields first.
	const missing = REQUIRED[item.kind].filter((f) => !String(item[f] ?? "").trim());
	// A case from the user's own file has no outlet: the file is its source (2026-11-09: a speech run asked a reporter of
	// the user's material, failed five times and ended with no draft).
	// Only a web case needs one: a case with no source at all is told to give its source (2026-11-10: a case from the
	// user's material with no file was asked for a reporter "only web sources need", retried the same call and the turn
	// ended with no outline).
	if (item.kind === "case" && item.url?.trim() && !item.file?.trim() && !item.reporter?.trim())
		missing.push("reporter");
	if (missing.length > 0)
		return t("topic.missingFields", {
			fields: missing.join("、"),
			meaning: t(item.kind === "case" ? "topic.caseFields" : "topic.dataFields"),
		});
	// A reference file needs its page, unless it has none.
	if (item.file?.trim())
		return item.page?.trim() || PAGELESS.test(item.file.trim()) ? "" : t("topic.missingPage", { file: item.file });
	// A web source must be a page or a search result of this topic.
	if (!item.url?.trim()) return t("topic.missingSource");
	return archived.includes(materialKey(item.url)) ? "" : t("topic.notArchived", { url: item.url });
}

/**
 * One material as a Markdown list item; `published` (YYYY-MM-DD) is its web source's date, written as 报道日期 for the
 * citation, since the time of the fact may be another (2026-11-10: a 2025年3月 report cited from a 2025-12-27 page).
 */
export function renderMaterial(item: Material, published = ""): string {
	// The source line ends every item.
	// A number or a range is a page (第3页); anything else is written as given (第1条, not 第第1条页).
	const at = item.page?.trim() ?? "";
	const page = /^\d+(?:\s*[-–—~～]\s*\d+)?$/.test(at) ? `第${at}页` : at;
	const source = item.file?.trim() ? `《${item.file}》${page}` : (item.url ?? "");
	// No time field when the source gives none.
	const time = item.time?.trim() ? `时间：${item.time.trim()}｜` : "";
	// The excerpt on one line, so that the item stays one list item.
	const quote = `原文：“${(item.quote ?? "").trim().replace(/\s*\n\s*/g, " ")}”`;
	const body =
		item.kind === "case"
			? `案例｜${time}${item.reporter?.trim() ? `报道方：${item.reporter}｜` : ""}主体：${item.subject}｜${quote}`
			: `数据｜${time}${quote}`;
	const [y, m, d] = published.split("-").map(Number);
	const dated = published ? `｜报道日期：${y}年${m}月${d}日` : "";
	return `- ${item.section?.trim() ? `【${item.section.trim()}】` : ""}${body}${dated}｜来源：${source}`;
}

/**
 * The outlet a fetched page names for itself: its "来源：" line, else the site at the end of its title (… - 新华网).
 * Empty when the page was not fetched or names none.
 */
export function pageReporter(dir: string, url: string): string {
	const key = materialKey(url);
	const entry = readIndex(dir).find(
		(e) => e.kind === "page" && [e.url, e.requested].some((u) => u && materialKey(u) === key),
	);
	if (!entry || !existsSync(join(dir, entry.file))) return "";
	// The page as archived: the head, then the text.
	const text = readFileSync(join(dir, entry.file), "utf-8").slice(0, 4000);
	// Letters and digits too: 来源：C114 2026-04-20 (2026-11-09: a research run stopped at it).
	const stated = text.match(/(?:^|[\s　|｜])来源[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,20}?)(?=$|[\s　|｜，,。])/m);
	if (stated) return stated[1];
	// The title's last part, when it names a site: 新华网, 人民日报, 央视新闻.
	const site =
		entry.title
			.split(/\s[-–—|｜]\s|_/)
			.at(-1)
			?.trim() ?? "";
	return /^[\u4e00-\u9fa5A-Za-z]{2,12}(?:网|报|社|台|新闻|日报|在线)$/.test(site) ? site : "";
}

/**
 * Cases from the web with their outlet filled from the page when the model left it out (2026-11-09: a research run
 * gave the url of a fetched 新华网 page nine times without reporter, and ended with no draft). The outlet is the one
 * the page names; nothing is guessed.
 */
export function withPageReporters(dir: string, items: readonly Material[]): Material[] {
	return items.map((item) => {
		if (item.kind !== "case" || item.reporter?.trim() || item.file?.trim() || !item.url?.trim()) return item;
		// The page's own name for its outlet, else the site it is on: a run never stops for want of one (2026-11-09:
		// twice a research run ended with no draft over this field).
		const reporter = pageReporter(dir, item.url) || siteName(item.url);
		return reporter ? { ...item, reporter } : item;
	});
}

/** The site of an address, without www.: c114.net.cn. Empty when it is not one. */
export function siteName(url: string): string {
	return URL.canParse(url) ? new URL(url).hostname.replace(/^www\./, "") : "";
}

/**
 * The archived text of a web source and its own date (YYYY-MM-DD, or empty): the fetched page, else its entry in a
 * search report (from its address to the next numbered result). Undefined when the topic holds neither.
 */
export function sourceOf(dir: string, url: string): { text: string; date: string } | undefined {
	const key = materialKey(url);
	// The same address with empty parameters left out: a result listed …html?referFrom= for the page …html.
	const loose = (u: string) =>
		materialKey(u)
			.replace(/([?&])[^=&]+=(?=&|$)/g, "$1")
			.replace(/[?&]+$/, "");
	const index = readIndex(dir);
	// A fetched page first: the fuller record, with 发布日期 in its head.
	const page = index.find((e) => e.kind === "page" && [e.url, e.requested].some((u) => u && materialKey(u) === key));
	const pageText = page && existsSync(join(dir, page.file)) ? readFileSync(join(dir, page.file), "utf-8") : "";
	const pageDate = /^发布日期：(\d{4}-\d{2}-\d{2})/m.exec(pageText)?.[1] ?? "";
	if (pageDate) return { text: pageText, date: pageDate };
	// Else the search that listed it, also for a page that shows no date (2026-11-10: a 163.com page had none, its
	// search result said 2025-12-03): its address as written there, without the #1 the result numbers add.
	const bare = url.trim().replace(/#\d+$/, "");
	for (const e of index) {
		if (e.kind !== "search" || !(e.urls ?? []).some((u) => loose(u) === loose(url))) continue;
		if (!existsSync(join(dir, e.file))) continue;
		const report = readFileSync(join(dir, e.file), "utf-8");
		const at = report.indexOf(bare);
		if (at < 0) continue;
		// The entry ends where the next numbered result starts.
		const rest = report.slice(at);
		const next = rest.slice(1).search(/\n\d+\. /);
		const text = next < 0 ? rest : rest.slice(0, next + 1);
		// The date the result gives, in brackets after the address: …（2025-12-27）; the page's text joins it.
		return {
			text: pageText ? `${pageText}\n${text}` : text,
			date: /^\S*（(\d{4}-\d{2}-\d{2})）/.exec(text)?.[1] ?? "",
		};
	}
	return pageText ? { text: pageText, date: "" } : undefined;
}

/**
 * Whether a material's time is in its source: written there, as 2025年12月27日, 2025-12-27 or 12月27日 in a text of that
 * year, or the source's own date (2026-11-10: a page said 近期 and the material said 2025年10月). A time with no year
 * (近期, 截至目前) names no date and passes.
 */
export function timeInSource(time: string, text: string, date: string): boolean {
	// 2025年12月27日, or the same as numbers: 2026-01-29, 2026/1/29, 2026.01.29 (2026-11-10: a time written 2026-01-29
	// passed unchecked, and it was another page's date).
	const m =
		/(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?/.exec(time) ??
		/(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?!\d)/.exec(time);
	if (!m) return true;
	const [y, mo, d] = [m[1], m[2] ? Number(m[2]) : 0, m[3] ? Number(m[3]) : 0];
	// The source's own date, as numbers.
	const [sy, sm, sd] = date ? date.split("-").map(Number) : [0, 0, 0];
	// A number as written: 3 or 03.
	const n = (v: number) => `0?${v}`;
	const has = (re: string) => new RegExp(re).test(text);
	// The year: in the text, or the source's own.
	const year = has(`${y}(?:年|[-/.]\\d)`) || sy === Number(y);
	if (!mo) return year;
	// The month and the day as the text writes them, with the year or in a text of that year (今年3月).
	const day = d ? `${n(d)}日` : "";
	const numeric = d ? `${y}[-/.]${n(mo)}[-/.]${n(d)}(?!\\d)` : `${y}[-/.]${n(mo)}(?!\\d)`;
	if (has(numeric) || has(`${y}年${n(mo)}月${day}`)) return true;
	if (year && has(`(?<!\\d)${n(mo)}月${day}`)) return true;
	// Or the source's own date: the same month, or the same day.
	return sy === Number(y) && sm === mo && (!d || sd === d);
}

/**
 * Web materials with no time given take their source's own date (the user, 2026-11-10: "data pulled from a webpage
 * should typically contain such time information"); with no date in the source they stay without one.
 */
export function withSourceTimes(dir: string, items: readonly Material[]): Material[] {
	return items.map((item) => {
		if (item.time?.trim() || item.file?.trim() || !item.url?.trim()) return item;
		const date = sourceOf(dir, item.url)?.date ?? "";
		const [y, m, d] = date.split("-").map(Number);
		return date ? { ...item, time: `${y}年${m}月${d}日` } : item;
	});
}

/** Traditional forms of the units, as a BIG5 page writes them: 449個 is 449个 (2026-11-10, a people.com.cn page). */
const UNIT_FORMS: Readonly<Record<string, string>> = { 個: "个", 萬: "万", 億: "亿", 條: "条", 戶: "户", 項: "项" };

/** A figure with its unit as a draft writes it: 30个, 1.5万亿元, 6702.5亿, 15%. */
const FIGURE = /\d+(?:\.\d+)?(?:[%％]|[万亿千百]+[元人户家个架座条起部项次]?|[元人户家个架座条起部项次倍])/g;

/**
 * Sentences of a draft that cite a dated source (2026年1月29日《证券时报网》) and give figures that no archived source
 * of that date holds: the figure came from another source (2026-11-10: 30个省市 from a C114 page of 2026-02-03 cited as
 * 2026年1月29日《证券时报网》, the second such case in research runs). A source of that date is one whose own date it is,
 * or whose text names it. Each sentence as its first 60 characters.
 */
export function misattributedFigures(text: string, dir: string): string[] {
	const index = readIndex(dir);
	if (index.length === 0) return [];
	// Every archived source on its own: each fetched page, and each result of each search, with the dates it bears (its
	// own, and the one in its address: an older archive has result dates a day early).
	const sources: { text: string; dates: string[] }[] = [];
	for (const e of index) {
		if (!existsSync(join(dir, e.file))) continue;
		const file = readFileSync(join(dir, e.file), "utf-8").replace(/[個萬億條戶項]/g, (c) => UNIT_FORMS[c] ?? c);
		if (e.kind === "page") {
			const own = /^发布日期：(\d{4}-\d{2}-\d{2})/m.exec(file)?.[1] ?? "";
			sources.push({ text: file, dates: [own, urlDate(e.url ?? "")] });
			continue;
		}
		for (const url of e.urls ?? []) {
			const bare = url.replace(/#\d+$/, "");
			const at = file.indexOf(bare);
			if (at < 0) continue;
			const rest = file.slice(at);
			const next = rest.slice(1).search(/\n\d+\. /);
			const entry = next < 0 ? rest : rest.slice(0, next + 1);
			sources.push({ text: entry, dates: [/^\S*（(\d{4}-\d{2}-\d{2})）/.exec(entry)?.[1] ?? "", urlDate(bare)] });
		}
	}
	const out: string[] = [];
	for (const sentence of bodyBeforeReferences(text).split(/(?<=[。！？；\n])/)) {
		const cite = /(\d{4})年(\d{1,2})月(\d{1,2})日《([^》\n]+)》/.exec(sentence);
		// A report, by an outlet; a document's date is its own, not a report's.
		if (!cite || !isOutletName(cite[4])) continue;
		// The figures the sentence gives, beside its citation.
		const figures = sentence.replace(cite[0], "").match(FIGURE) ?? [];
		if (figures.length === 0) continue;
		const [y, m, d] = [cite[1], Number(cite[2]), Number(cite[3])];
		const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
		const named = [`${y}年${m}月${d}日`, day];
		const ofDay = sources.filter((src) => src.dates.includes(day) || named.some((n) => src.text.includes(n)));
		// One figure found in a source of that date is enough: the others may be worked out from it.
		// A figure of three digits or with decimals counts without its unit too: 328万 is in 328.7万架.
		const forms = (f: string) => {
			const bare = f.match(/^\d+(?:\.\d+)?/)?.[0] ?? f;
			return bare.replace(".", "").length >= 3 || bare.includes(".") ? [f, bare] : [f];
		};
		if (!figures.some((f) => ofDay.some((src) => forms(f).some((x) => src.text.includes(x)))))
			out.push(sentence.trim().slice(0, 60));
	}
	return out;
}

/**
 * text as the program compares a model's words with a source: compatibility forms folded (，to , and ：to :), case
 * dropped, and spaces, quotation marks and Markdown marks left out, which a model drops or changes when it copies.
 */
function comparable(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[\s*_#>|`[\]"'“”‘’「」『』]/g, "")
		.toLowerCase();
}

/** text in comparable form, with the offsets in text where each compared character's own character starts and ends. */
function comparableWithOffsets(text: string): { flat: string; from: number[]; to: number[] } {
	let flat = "";
	const from: number[] = [];
	const to: number[] = [];
	let i = 0;
	// Character by character, so that each compared character knows where it came from.
	for (const ch of text) {
		const c = comparable(ch);
		for (let k = 0; k < c.length; k++) {
			from.push(i);
			to.push(i + ch.length);
		}
		flat += c;
		i += ch.length;
	}
	return { flat, from, to };
}

/**
 * The passage of text that runs from the words start through the words end, cut out of the text as the source writes
 * it and put on one line; without end, through the end of start's sentence. Empty when start, or end after it, is not
 * there. The model names the passage and the program copies it, so the material is the source's words, never a
 * summary, and the model spends no tokens writing them out (the user, 2026-11-11: "Not a verbatim transcription, but
 * rather an extraction and output generated by an AI-powered program").
 */
export function excerptOf(text: string, start: string, end = ""): string {
	const { flat, from, to } = comparableWithOffsets(text);
	const s = comparable(start);
	const e = comparable(end);
	const at = s ? flat.indexOf(s) : -1;
	if (at < 0) return "";
	// Where start's words end in the text.
	const startEnd = to[at + s.length - 1];
	let stop = startEnd;
	if (e) {
		// The first end that finishes at or after start's last word.
		const found = flat.indexOf(e, Math.max(at, at + s.length - e.length));
		if (found < 0) return "";
		stop = to[found + e.length - 1];
	} else if (!/[。！？!?；;.]$/.test(text.slice(0, startEnd))) {
		// Through the end of the sentence: its mark, or the end of the line.
		const m = /[。！？!?；;]|\.(?=\s|$)|\n/.exec(text.slice(startEnd));
		stop = m ? startEnd + m.index + (m[0] === "\n" ? 0 : m[0].length) : text.length;
	}
	// A passage that ends inside a link's text runs on to the end of the link, which then becomes its text.
	const cut = text.slice(from[at], stop);
	const link = /^[^[\]\n]*\]\([^)]*\)/.exec(text.slice(stop));
	if (link && cut.lastIndexOf("[") > cut.lastIndexOf("]")) stop += link[0].length;
	return text
		.slice(from[at], stop)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*|__|`/g, "")
		.replace(/\s*\n\s*/g, " ")
		.trim();
}

/**
 * Every archived text of a web source, where its excerpt is looked for: the fetched page and each search entry that
 * listed it (a model may copy the snippet of the result before it opens the page).
 */
export function webSourceTexts(dir: string, url: string): string[] {
	const key = materialKey(url);
	// The same address with empty parameters left out, as in sourceOf.
	const loose = (u: string) =>
		materialKey(u)
			.replace(/([?&])[^=&]+=(?=&|$)/g, "$1")
			.replace(/[?&]+$/, "");
	const bare = url.trim().replace(/#\d+$/, "");
	const texts: string[] = [];
	for (const e of readIndex(dir)) {
		if (!existsSync(join(dir, e.file))) continue;
		const page = e.kind === "page" && [e.url, e.requested].some((u) => u && materialKey(u) === key);
		const listed = e.kind === "search" && (e.urls ?? []).some((u) => loose(u) === loose(url));
		if (!page && !listed) continue;
		const text = readFileSync(join(dir, e.file), "utf-8");
		// A search report holds other results too: only this one's entry, from its numbered title line up to the next
		// result; the whole report when the address is written there in another form. An upstream's own answer above
		// the list is its summary, not the source's words.
		const at = page ? -1 : text.indexOf(bare);
		if (at < 0) {
			texts.push(text);
			continue;
		}
		const line = text.lastIndexOf("\n", at) + 1;
		const title = text.lastIndexOf("\n", line - 2) + 1;
		const rest = text.slice(line > 0 && /^\d+\. /.test(text.slice(title, line)) ? title : line);
		const next = rest.slice(1).search(/\n\d+\. /);
		texts.push(next < 0 ? rest : rest.slice(0, next + 1));
	}
	return texts;
}

/**
 * The text of a reference file, where its excerpt is looked for: its parsed copy (材料.docx as .parsed/材料.docx.md),
 * in the topic or the working folder, else a text file as it stands; undefined when there is none to read.
 */
export function fileSourceText(dir: string, file: string): string | undefined {
	const given = file.trim();
	const name = basename(given);
	const parsed = [...parsedFiles(dir), ...parsedFiles(dirname(dir))].find((p) =>
		[name, `${name}.md`].includes(basename(p)),
	);
	if (parsed) return readFileSync(parsed, "utf-8");
	for (const at of [join(dir, given), join(dirname(dir), given)])
		if (/\.(txt|md)$/i.test(at) && existsSync(at) && statSync(at).isFile()) return readFileSync(at, "utf-8");
	return undefined;
}

/** A material's passage as its source writes it, or what kept the program from taking it, as a sentence. */
export function materialExcerpt(dir: string, item: Material): { quote: string; problem: string } {
	const start = item.start?.trim() ?? "";
	const end = item.end?.trim() ?? "";
	const file = item.file?.trim() ?? "";
	const read = file ? fileSourceText(dir, file) : undefined;
	if (file && read === undefined) return { quote: "", problem: t("topic.sourceUnreadable", { file }) };
	const texts = file && read !== undefined ? [read] : webSourceTexts(dir, item.url ?? "");
	// The first source that holds the passage: the page, else the search entry.
	const quote = texts.map((text) => excerptOf(text, start, end)).find(Boolean) ?? "";
	if (!quote) return { quote, problem: t("topic.passageNotFound", { words: end ? `${start}……${end}` : start }) };
	if (quote.length > MAX_QUOTE)
		return { quote: "", problem: t("topic.passageTooLong", { max: MAX_QUOTE, length: quote.length }) };
	return { quote, problem: "" };
}

/** Add materials to 素材.md, all or none; returns how many it holds now. */
/** What one material_add call did: how many 素材.md holds, which items (1-based) went in, and why the others did not. */
export interface AddResult {
	total: number;
	written: number[];
	problems: string[];
}

/**
 * Add materials to 素材.md: the complete ones are written, the others sent back with their reasons, so that the next
 * call carries only those (2026-11-11: all-or-none made GLM resend 18 items for 2 wrong ones, and resent batches
 * often came back stripped of their fields).
 */
export function addMaterials(dir: string, given: readonly Material[]): AddResult {
	// Local paths in url are files; a case's outlet comes from its fetched page when it was left out.
	// A web material with no time takes its source's date.
	// Items that came with neither a source nor a passage: the call lost its content on the way, and one short line
	// says so instead of a list of missing fields for each (2026-11-11: GLM sent kind, reporter and section only, in
	// 4 of 9 calls, and was told every field each item lacked).
	if (given.length > 0 && given.every((i) => !i.url?.trim() && !i.file?.trim() && !i.start?.trim()))
		return { total: materialCount(dir), written: [], problems: [t("topic.itemsEmpty", { count: given.length })] };
	const checked = withSourceTimes(dir, withPageReporters(dir, given.map(asFileSource)));
	// Every item is checked; the complete ones go in.
	const archived = materialUrls(dir);
	const problems: string[] = [];
	const written: number[] = [];
	const items = checked.flatMap((item, i) => {
		// The fields and the source first; then the program takes the passage out of the source.
		const missing = materialProblem(item, archived);
		const taken = missing ? { quote: "", problem: missing } : materialExcerpt(dir, item);
		// A time the web source does not give is sent back: the time as the source gives it, or none.
		const source = !item.file?.trim() && item.url?.trim() && item.time?.trim() ? sourceOf(dir, item.url) : undefined;
		const problem =
			taken.problem ||
			(source && !timeInSource(item.time ?? "", source.text, source.date)
				? t("topic.timeNotInSource", { time: item.time ?? "" })
				: "");
		if (problem) {
			problems.push(t("topic.itemProblem", { n: i + 1, problem }));
			return [];
		}
		written.push(i + 1);
		return [{ ...item, quote: taken.quote }];
	});
	// Whole sentences as start or end: the next call needs only a few words of each.
	if (problems.length > 0 && longAnchors(given)) problems.push(t("topic.anchorsLong", { max: MAX_ANCHOR }));
	if (items.length === 0) return { total: materialCount(dir), written, problems };
	const file = join(dir, MATERIAL_FILE);
	const before = existsSync(file) ? readFileSync(file, "utf-8") : "# 素材\n\n";
	// A web material with its source's date.
	const lines = items.map((item) =>
		renderMaterial(item, !item.file?.trim() && item.url?.trim() ? (sourceOf(dir, item.url)?.date ?? "") : ""),
	);
	writeFileSync(file, `${before}${lines.join("\n")}\n`);
	return { total: materialCount(dir), written, problems };
}

/** How many items 素材.md holds. */
export function materialCount(dir: string): number {
	const file = join(dir, MATERIAL_FILE);
	if (!existsSync(file)) return 0;
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter((l) => l.startsWith("- ")).length;
}
