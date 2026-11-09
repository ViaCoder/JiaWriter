/**
 * Topic folders: one folder per writing topic holds everything the work on it produced, so research
 * survives the session and compaction. Pure file work; the extensions decide when to call it.
 *   <topic>/稿件/      drafts and exports
 *   <topic>/参考资料/  the user's files
 *   <topic>/检索/      every search, one file each
 *   <topic>/网页/      every fetched page in full
 *   <topic>/素材.md    the cases and data chosen for the draft
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
	writeFileSync,
} from "node:fs";
// Paths.
import { basename, join } from "node:path";
// URL comparison shared with the reference check.
import { normalizeUrl } from "../export/refs.ts";
// Output messages.
import { t } from "../i18n/index.ts";

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

/** A case or a data point for the draft. */
export interface Material {
	// A case: time, reporter, subject, action. Data: time, region, industry, indicator, value.
	kind: "case" | "data";
	time: string;
	reporter?: string;
	subject?: string;
	action?: string;
	region?: string;
	industry?: string;
	indicator?: string;
	value?: string;
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
	// Time, the acting subject and the action; the reporter too when the case is from the web (below).
	case: ["time", "subject", "action"],
	// Time, region, industry, indicator and value.
	data: ["time", "region", "industry", "indicator", "value"],
};

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
	if (item.kind === "case" && !item.file?.trim() && !item.reporter?.trim()) missing.push("reporter");
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

/** One material as a Markdown list item. */
export function renderMaterial(item: Material): string {
	// The source line ends every item.
	// A number or a range is a page (第3页); anything else is written as given (第1条, not 第第1条页).
	const at = item.page?.trim() ?? "";
	const page = /^\d+(?:\s*[-–—~～]\s*\d+)?$/.test(at) ? `第${at}页` : at;
	const source = item.file?.trim() ? `《${item.file}》${page}` : (item.url ?? "");
	const body =
		item.kind === "case"
			? `案例｜时间：${item.time}｜${item.reporter?.trim() ? `报道方：${item.reporter}｜` : ""}主体：${item.subject}｜行为：${item.action}`
			: `数据｜时间：${item.time}｜地区：${item.region}｜行业：${item.industry}｜指标：${item.indicator}｜数值：${item.value}`;
	return `- ${item.section?.trim() ? `【${item.section.trim()}】` : ""}${body}｜来源：${source}`;
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

/** Add materials to 素材.md, all or none; returns how many it holds now. */
export function addMaterials(dir: string, given: readonly Material[]): number {
	// Local paths in url are files; a case's outlet comes from its fetched page when it was left out.
	const items = withPageReporters(dir, given.map(asFileSource));
	// Every item is checked before anything is written.
	const archived = materialUrls(dir);
	const problems = items.flatMap((item, i) => {
		const problem = materialProblem(item, archived);
		return problem ? [t("topic.itemProblem", { n: i + 1, problem })] : [];
	});
	if (problems.length > 0) throw new Error(problems.join("\n"));
	const file = join(dir, MATERIAL_FILE);
	const before = existsSync(file) ? readFileSync(file, "utf-8") : "# 素材\n\n";
	writeFileSync(file, `${before}${items.map(renderMaterial).join("\n")}\n`);
	return `${before}`.split("\n").filter((l) => l.startsWith("- ")).length + items.length;
}
