/**
 * The model's own replies checked for the marks of machine writing, as the drafts are (the user, 2026-11-10: the
 * standard "applies to everything, including intermediate outputs, summaries, and so on"). Every pattern of the
 * default packs counts, the stock phrases too (a reply is short, and one 综上所述 in it is the tell), except the
 * denials judged by density (a single one may answer a real claim). When a reply carries a mark, the extension asks
 * the model once to say it again under the rules. Pure text work; the extension reads the messages and sends the ask.
 */

// The hits and the patterns.
import { findHits, type StyleHit } from "./style/check.ts";
import { DEFAULT_PACKS, DENSITY_ONLY, STYLE_PACKS, type StylePattern } from "./style/patterns.ts";

/**
 * Markdown dress a reply must not wear (the core rule: no bold, headings or bullet lists in a reply; 2026-11-15: a
 * research reply came with **国家层面** headings). Numbered items are left alone: a list of sources is one.
 */
export const REPLY_FORMAT_MARKS: readonly StylePattern[] = [
	{ id: "md-bold", re: /\*\*[^*\n]{1,60}\*\*/g, zh: "加粗", en: "bold" },
	{ id: "md-heading", re: /^#{1,6}\s+\S[^\n]*/gm, zh: "标题", en: "heading" },
	{ id: "md-list", re: /^[ \t]*[-*•]\s+\S[^\n]*/gm, zh: "列表", en: "bullet list" },
	// An account of the checks passed (2026-11-15: "AI 腔和篇幅检查均通过" in a reply, against the tone rule).
	{
		id: "checks-passed",
		re: /(?:检查|校验|核对)[^。\n]{0,8}?(?:均|都|已)?通过/g,
		zh: "汇报检查通过",
		en: "checks passed",
	},
];

/** Most asks to restate a reply after one message of the user: one, so a reply that cannot be cleaned does not loop. */
export const MAX_REPLY_ROUNDS = 1;

/** A message as the agent_end event carries it. */
interface Message {
	role?: string;
	content?: string | { type?: string; text?: string }[];
}

/** The text the model wrote since the user's last message: every text block of its replies, in order. */
export function replyText(messages: readonly unknown[] | undefined): string {
	// The messages after the last one from the user.
	const all = (messages ?? []) as Message[];
	let from = 0;
	for (let i = all.length - 1; i >= 0; i--)
		if (all[i].role === "user") {
			from = i + 1;
			break;
		}
	// Their text blocks.
	return all
		.slice(from)
		.filter((m) => m.role === "assistant")
		.flatMap((m) =>
			typeof m.content === "string"
				? [m.content]
				: (m.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")),
		)
		.filter((t) => t.trim() !== "")
		.join("\n");
}

/** The marks in a text: hits of the default packs, except the denials judged by density. */
export function replyMarks(text: string): StyleHit[] {
	if (!text.trim()) return [];
	const patterns = [...DEFAULT_PACKS.flatMap((p) => STYLE_PACKS[p]), ...REPLY_FORMAT_MARKS];
	return findHits(text, patterns).filter((hit) => !DENSITY_ONLY.has(hit.id));
}

/** The marks as the ask names them: “综上所述”（第 2 行）, the first few, each wording once. */
export function marksList(marks: readonly StyleHit[], text: string, most = 5): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const hit of marks) {
		const words = text.slice(hit.start, hit.end).trim();
		if (seen.has(words)) continue;
		seen.add(words);
		out.push(`“${words}”（第 ${hit.line} 行）`);
		if (out.length >= most) break;
	}
	return out.join("、");
}
