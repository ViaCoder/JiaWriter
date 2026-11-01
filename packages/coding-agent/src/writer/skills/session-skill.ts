/**
 * A skill from the current session (the user, 2026-11-01): the user's own requests on the active
 * branch (messages, steering and the reasons given when a tool call was refused; no model replies),
 * secrets removed, the last request kept when a topic comes up again, grouped by category into a
 * standard SKILL.md draft that the user reviews before anything is written.
 */

// Session entry types.
import type { SessionEntry } from "../../core/session-manager.ts";
// Unified diff of the edit tool.
import { generateUnifiedPatch } from "../../core/tools/edit-diff.ts";
// Blank-template text.
import { t } from "../i18n/index.ts";
// Secret redaction.
import { redactSecrets } from "../redact.ts";

/** One request of the user. */
export interface UserRequest {
	// The request text (one clause of a message).
	text: string;
	// Position in the session (later is larger).
	order: number;
}

/** Topic → words that name it (Chinese and English). A request may belong to several topics. */
export const TOPICS: Readonly<Record<string, RegExp>> = {
	font: /字体|宋体|黑体|楷体|仿宋|\bfonts?\b|Times New Roman/i,
	size: /字号|号字|[小]?[一二三四五六]号|\bfont size\b|\bpt\b|磅(?!数)/i,
	spacing: /行距|行间距|段距|\bline spacing\b/i,
	length: /篇幅|字数|字以内|字左右|多少字|\blength\b|\bwords?\b/i,
	punct: /标点|引号|破折号|全角|半角|\bpunctuation\b|\bquotes?\b/i,
	citation: /引用|来源|出处|核实|案例|\bcit(?:e|ation)s?\b|\bsources?\b/i,
	tone: /语气|口吻|文风|风格|AI ?腔|生僻|古雅|\btone\b|\bstyle\b/i,
	audience: /读者|受众|对象是|\baudience\b|\breaders?\b/i,
	structure: /结构|标题|大纲|段落|层次|\bheadings?\b|\boutline\b|\bstructure\b/i,
	language: /中文|英文|双语|\bChinese\b|\bEnglish\b/i,
	search: /搜索|检索|联网|anysearch|\bsearch\b/i,
};

/** Category of each topic in the draft, in output order. */
const CATEGORIES: readonly { key: string; zh: string; en: string; topics: readonly string[] }[] = [
	{ key: "style", zh: "文风", en: "Style", topics: ["tone", "audience", "language"] },
	{ key: "structure", zh: "结构与篇幅", en: "Structure and length", topics: ["structure", "length"] },
	{ key: "punct", zh: "标点", en: "Punctuation", topics: ["punct"] },
	{ key: "layout", zh: "排版", en: "Layout", topics: ["font", "size", "spacing"] },
	{ key: "citation", zh: "引用与来源", en: "Citations and sources", topics: ["citation", "search"] },
];

// Acknowledgements and control words that carry no request.
const ACK_RE =
	/^(?:ok(?:ay)?|yes|no|go on|continue|approved?|thanks?|好的?|可以|继续|是的?|对|谢谢|收到|行|批准|同意)[\s.!。！,，]*$/i;
// Reasons of refused tool calls start with one of these.
const REFUSAL_RE = /^(?:blocked|rejected|denied|user|refused|用户|拒绝|否决)/i;

/** Text of a message content (string or text blocks). */
function contentText(content: unknown): string {
	// Plain string.
	if (typeof content === "string") return content;
	// Text blocks only.
	return Array.isArray(content)
		? content
				.map((b) =>
					b && typeof b === "object" && (b as { type?: string }).type === "text"
						? String((b as { text?: string }).text ?? "")
						: "",
				)
				.join("\n")
		: "";
}

/** Clauses of a message: split at line ends and sentence ends, trimmed, without acknowledgements. */
export function splitRequests(text: string): string[] {
	// Lines, then sentences (the end mark stays with its sentence).
	return text
		.split(/\n+/)
		.flatMap((line) => line.match(/[^。！？；!?;]+[。！？；!?;]?/g) ?? [])
		.map((s) => s.trim())
		.filter((s) => s.length >= 4 && !ACK_RE.test(s));
}

/** The user's requests on the branch, in order: user messages and the reasons of refused tool calls. */
export function collectUserRequests(entries: readonly SessionEntry[]): UserRequest[] {
	// Result.
	const out: UserRequest[] = [];
	for (const e of entries) {
		// Only message entries.
		if (e.type !== "message") continue;
		const m = e.message as { role?: string; content?: unknown; isError?: boolean };
		// User messages (typed, steering and follow-ups are all user messages).
		let text = "";
		if (m.role === "user") text = contentText(m.content);
		// A refused tool call carries the user's reason in its error text.
		else if (m.role === "toolResult" && m.isError) {
			const reason = contentText(m.content).trim();
			if (REFUSAL_RE.test(reason)) text = reason.replace(/^[^:：]*[:：]\s*/, "");
		}
		// Clauses in order.
		for (const clause of splitRequests(text)) out.push({ text: clause, order: out.length });
	}
	// The requests.
	return out;
}

/** Topics a request mentions. */
export function topicsOf(text: string): string[] {
	// Every matching topic.
	return Object.keys(TOPICS).filter((k) => TOPICS[k].test(text));
}

/** Drop every request whose topics all come up again later; requests without a topic stay. */
export function resolveLatest(requests: readonly UserRequest[]): { kept: UserRequest[]; dropped: UserRequest[] } {
	// Latest position per topic.
	const last = new Map<string, number>();
	for (const r of requests) for (const t of topicsOf(r.text)) last.set(t, r.order);
	// Split.
	const kept: UserRequest[] = [];
	const dropped: UserRequest[] = [];
	for (const r of requests) {
		const topics = topicsOf(r.text);
		// Superseded when a later request covers each of its topics.
		if (topics.length > 0 && topics.every((t) => (last.get(t) ?? -1) > r.order)) dropped.push(r);
		else kept.push(r);
	}
	// Both lists.
	return { kept, dropped };
}

/** Inputs of a draft. */
export interface SkillDraftInput {
	// Skill name (lowercase letters, digits, hyphens).
	name: string;
	// Display title (may be Chinese).
	title: string;
	// When the skill applies (routing description).
	description: string;
	// Draft language.
	lang: "zh" | "en";
	// Requests to include.
	requests: readonly UserRequest[];
	// Date for the metadata (YYYY-MM-DD).
	date: string;
}

/** Problems with a skill name under the Agent Skills rules ([] when valid). */
export function skillNameProblems(name: string): string[] {
	// Each rule.
	const p: string[] = [];
	if (!/^[a-z0-9-]+$/.test(name)) p.push("a-z 0-9 -");
	if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) p.push("hyphens");
	if (name.length === 0 || name.length > 64) p.push("1–64");
	return p;
}

/** Quote a YAML scalar on one line. */
function yaml(s: string): string {
	// JSON strings are valid YAML double-quoted scalars.
	return JSON.stringify(s.replace(/\s+/g, " ").trim());
}

/** SKILL.md draft: frontmatter, then the requests grouped by category (each redacted again), or the blank template without requests. */
export function renderSkillDraft(d: SkillDraftInput): string {
	// Requests per category; requests of no category go to "other".
	const zh = d.lang === "zh";
	const groups = new Map<string, string[]>();
	for (const r of d.requests) {
		const topics = topicsOf(r.text);
		const cat = CATEGORIES.find((c) => c.topics.some((t) => topics.includes(t)))?.key ?? "other";
		groups.set(cat, [...(groups.get(cat) ?? []), redactSecrets(r.text)]);
	}
	// Sections in category order.
	const sections = [...CATEGORIES, { key: "other", zh: "其他要求", en: "Other requests", topics: [] }]
		.filter((c) => groups.has(c.key))
		.map((c) => `## ${zh ? c.zh : c.en}\n\n${(groups.get(c.key) ?? []).map((x) => `- ${x}`).join("\n")}`);
	// Frontmatter with portable fields; the title and origin go into metadata.
	const head = [
		"---",
		`name: ${d.name}`,
		`description: ${yaml(d.description)}`,
		"metadata:",
		`  title: ${yaml(d.title)}`,
		"  source: session",
		`  created: ${d.date}`,
		"---",
	].join("\n");
	// Intro line in the draft language.
	const intro = zh
		? "按以下要求完成写作任务。这些要求整理自用户在会话中的原话，同一主题以最后一次为准。"
		: "Follow these requirements for the writing task. They come from the user's own words in a session; for a repeated topic the latest request is kept.";
	// No requests: the blank template.
	const body = d.requests.length > 0 ? `${intro}\n\n${sections.join("\n\n")}` : t("skills.blankBody", {}, d.lang);
	// The file.
	return `${head}\n\n# ${d.title}\n\n${body}\n`;
}

/** Unified diff between the current SKILL.md and the new draft ("" when equal). */
export function diffSkill(path: string, current: string, draft: string): string {
	// Nothing changed.
	if (current === draft) return "";
	return generateUnifiedPatch(path, current, draft);
}
