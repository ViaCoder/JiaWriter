/**
 * What keeps a JiaWriter conversation going when compaction meets a model that cannot help: a summary built
 * on this machine when the model's own summary fails, and the overflow errors of Chinese models and gateways.
 */

// Message types.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// Compaction types and the file lists every summary carries.
import type { CompactionPreparation, CompactionResult } from "../core/compaction/compaction.ts";
import { computeFileLists, formatFileOperations } from "../core/compaction/utils.ts";
// Provider name.
import { JW_PROVIDER } from "./env-config.ts";
// Output messages.
import { t } from "./i18n/index.ts";

/** Longest piece of one message in a local summary (characters). */
const MAX_MESSAGE_CHARS = 2000;
/** Longest earlier summary kept in a local summary (characters). */
const MAX_PREVIOUS_CHARS = 8000;
/** Most user messages kept (the latest ones). */
const MAX_REQUESTS = 40;

/** Overflow errors outside pi-ai's list: Chinese wording, and the combined limit of input and output. */
const WRITER_OVERFLOW = [
	/超长|过长/,
	/超[出过].{0,16}(长度|上下文|限制|上限|最大)/,
	/(输入|上下文|请求).{0,12}(太长|太大)/,
	/input length and .{0,3}max_tokens.{0,3} exceed/i,
];

/** True for a failed reply of the JW_* model that names a request too large for the context. */
export function isWriterOverflow(message: { provider?: string; stopReason?: string; errorMessage?: string }): boolean {
	// Only the JiaWriter provider, and only failures.
	if (message.provider !== JW_PROVIDER || message.stopReason !== "error") return false;
	return WRITER_OVERFLOW.some((p) => p.test(message.errorMessage ?? ""));
}

/** Text of a user or assistant message. */
function messageText(message: AgentMessage): string {
	// Strings and text blocks.
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

/** text cut to at most max characters. */
function clip(text: string, max: number): string {
	// The beginning holds the request.
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A summary without the model: the earlier summary, the user's own words, the model's last reply. */
export function localSummary(preparation: CompactionPreparation, reason: string): string {
	// Every part that will leave the context, oldest first.
	const gone = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	const requests = gone
		.filter((m) => m.role === "user")
		.map((m) => clip(messageText(m).trim(), MAX_MESSAGE_CHARS))
		.filter(Boolean)
		.slice(-MAX_REQUESTS);
	const lastReply = gone
		.filter((m) => m.role === "assistant")
		.map(messageText)
		.filter(Boolean)
		.at(-1);
	// The parts in reading order.
	const parts = [t("compact.localTitle", { reason: clip(reason, 200) })];
	if (preparation.previousSummary)
		parts.push(t("compact.localPrevious"), clip(preparation.previousSummary, MAX_PREVIOUS_CHARS));
	if (requests.length > 0) parts.push(t("compact.localRequests"), requests.map((r) => `- ${r}`).join("\n"));
	if (lastReply) parts.push(t("compact.localReply"), clip(lastReply, MAX_MESSAGE_CHARS));
	return parts.join("\n\n");
}

/** The compaction result built on this machine, in the shape compact() returns. */
export function localCompaction(preparation: CompactionPreparation, reason: string): CompactionResult {
	// The same file lists a model summary carries.
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	return {
		summary: localSummary(preparation, reason) + formatFileOperations(readFiles, modifiedFiles),
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: { readFiles, modifiedFiles, localFallback: true },
	};
}
