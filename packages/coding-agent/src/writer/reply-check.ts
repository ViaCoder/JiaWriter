/**
 * The model's own replies checked for the marks of machine writing, as the drafts are (the user, 2026-11-10: the
 * standard "applies to everything, including intermediate outputs, summaries, and so on"). Every pattern of the
 * default packs counts, the stock phrases too (a reply is short, and one 综上所述 in it is the tell), except the
 * denials judged by density (a single one may answer a real claim). When a reply carries a mark, the extension asks
 * the model once to say it again under the rules. Pure text work; the extension reads the messages and sends the ask.
 */

// The hits and the patterns.
import { findHits, type StyleHit } from "./style/check.ts";
import { DEFAULT_PACKS, DENSITY_ONLY, STYLE_PACKS } from "./style/patterns.ts";

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
	const patterns = DEFAULT_PACKS.flatMap((p) => STYLE_PACKS[p]);
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
