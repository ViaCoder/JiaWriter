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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** Folder of a topic: the working folder itself when it already carries the topic's name. */
export function topicPath(cwd: string, name: string): string {
	// A user who started JiaWriter inside the topic folder gets no folder within a folder.
	return basename(cwd) === name ? cwd : join(cwd, name);
}

/** Create or reuse a topic's folders; returns the folder and whether it was there already. */
export function openTopic(cwd: string, name: string): { dir: string; existed: boolean } {
	// A name left empty by cleaning is refused.
	const clean = safeName(name);
	if (!clean) throw new Error(t("topic.badName", { name }));
	const dir = topicPath(cwd, clean);
	const existed = existsSync(join(dir, INDEX_FILE)) || existsSync(join(dir, TOPIC_DIRS.drafts));
	for (const sub of Object.values(TOPIC_DIRS)) mkdirSync(join(dir, sub), { recursive: true });
	return { dir, existed };
}

/** Name of the folder used when work starts before a topic is named. */
export function unnamedTopic(now: Date): string {
	// The day in local time, YYYYMMDD.
	const p = (n: number) => String(n).padStart(2, "0");
	return `未命名主题-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/** True for the folder made when work started before a topic was named. */
export function isUnnamedTopic(dir: string): boolean {
	return /^未命名主题-\d{8}$/.test(basename(dir));
}

/** Give an unnamed folder its topic's name, so research done first stays with the draft; false when that name is taken. */
export function adoptUnnamedTopic(unnamed: string, cwd: string, name: string): boolean {
	const clean = safeName(name);
	if (!clean || !isUnnamedTopic(unnamed) || !existsSync(unnamed)) return false;
	const target = topicPath(cwd, clean);
	if (existsSync(target)) return false;
	renameSync(unnamed, target);
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
	const file = join(sub, `${String(n).padStart(3, "0")}-${safeName(title) || kind}.md`);
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
	return archive(dir, "page", TOPIC_DIRS.web, page.title || page.url, `${head}${page.content}\n`, page.url, asked);
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
	// Time, reporter, the acting subject and the action.
	case: ["time", "reporter", "subject", "action"],
	// Time, region, industry, indicator and value.
	data: ["time", "region", "industry", "indicator", "value"],
};

/** What is wrong with one material, as a sentence; empty when it is complete. */
export function materialProblem(item: Material, archived: readonly string[]): string {
	// Missing fields first.
	const missing = REQUIRED[item.kind].filter((f) => !String(item[f] ?? "").trim());
	if (missing.length > 0) return t("topic.missingFields", { fields: missing.join("、") });
	// A reference file needs its page.
	if (item.file?.trim()) return item.page?.trim() ? "" : t("topic.missingPage", { file: item.file });
	// A web source must be a page or a search result of this topic.
	if (!item.url?.trim()) return t("topic.missingSource");
	return archived.includes(materialKey(item.url)) ? "" : t("topic.notArchived", { url: item.url });
}

/** One material as a Markdown list item. */
export function renderMaterial(item: Material): string {
	// The source line ends every item.
	const source = item.file?.trim() ? `《${item.file}》第${item.page}页` : (item.url ?? "");
	const body =
		item.kind === "case"
			? `案例｜时间：${item.time}｜报道方：${item.reporter}｜主体：${item.subject}｜行为：${item.action}`
			: `数据｜时间：${item.time}｜地区：${item.region}｜行业：${item.industry}｜指标：${item.indicator}｜数值：${item.value}`;
	return `- ${item.section?.trim() ? `【${item.section.trim()}】` : ""}${body}｜来源：${source}`;
}

/** Add materials to 素材.md, all or none; returns how many it holds now. */
export function addMaterials(dir: string, items: readonly Material[]): number {
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
