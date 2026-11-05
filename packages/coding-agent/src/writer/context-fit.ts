/**
 * Keeps a request inside the context window when tool results alone do not fit. Compaction cuts only at
 * user and assistant messages, so the results of one turn cannot be compacted away: a message that fetched
 * seven long pages fails, compacts, and fails again at the same size. fitToolResults() clips the largest
 * results in the request; the session file keeps the full text.
 */

// Message types.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// Token estimate of a whole message.
import { estimateTokens } from "../core/compaction/compaction.ts";
// Output messages.
import { t } from "./i18n/index.ts";

/** Share of the context window the messages may use; the rest holds the system prompt, tools and the reply. */
export const CONTEXT_SHARE = 0.85;
/** Smallest size a result is clipped to (tokens). */
const MIN_RESULT_TOKENS = 500;

/** The largest size every result may keep so that the sizes add up to at most room. */
export function resultCap(sizes: readonly number[], room: number): number {
	// Smallest first: a small result keeps its size and leaves its share to the others.
	const sorted = [...sizes].sort((a, b) => a - b);
	let left = room;
	for (let i = 0; i < sorted.length; i++) {
		const share = Math.floor(left / (sorted.length - i));
		if (sorted[i] > share) return Math.max(MIN_RESULT_TOKENS, share);
		left -= sorted[i];
	}
	// Everything fits.
	return Number.POSITIVE_INFINITY;
}

/** One result's text blocks clipped to cap tokens, with a note saying so. */
function clipResult(message: AgentMessage, tokens: number, cap: number): AgentMessage {
	// Characters are kept in proportion to the tokens kept.
	const keep = cap / tokens;
	const content = ((message as { content: { type: string; text?: string }[] }).content ?? []).map((b) => {
		if (b.type !== "text" || !b.text) return b;
		const chars = Math.floor(b.text.length * keep);
		return { ...b, text: `${b.text.slice(0, chars)}\n\n${t("context.clipped", { chars: b.text.length })}` };
	});
	return { ...message, content } as AgentMessage;
}

/** messages with their largest tool results clipped so the request fits budget tokens; the same array when it fits. */
export function fitToolResults(messages: AgentMessage[], budget: number): AgentMessage[] {
	// Size of each message, and of the tool results alone.
	// Tool-call arguments count: a whole draft can sit in a write call.
	const sizes = messages.map((m) => estimateTokens(m));
	const total = sizes.reduce((a, b) => a + b, 0);
	if (total <= budget) return messages;
	const results = messages.flatMap((m, i) => (m.role === "toolResult" ? [sizes[i]] : []));
	const others = total - results.reduce((a, b) => a + b, 0);
	// What is left for tool results decides the limit of each.
	const cap = resultCap(results, Math.max(0, budget - others));
	if (cap === Number.POSITIVE_INFINITY) return messages;
	return messages.map((m, i) => (m.role === "toolResult" && sizes[i] > cap ? clipResult(m, sizes[i], cap) : m));
}
