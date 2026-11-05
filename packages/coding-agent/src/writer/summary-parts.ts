/**
 * Summarizing a history that may not fit one request. The history goes out in parts, each updating the
 * summary before it. The parts are sized from JW_CTX, which can be larger than what the model really takes;
 * when a part is rejected as too large, the rest is sized smaller and the work goes on from that part.
 */

// Message types.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// Overflow errors of known providers, and model and usage types.
import { isContextOverflow, type Model, type Usage } from "@earendil-works/pi-ai";
// The text a summary request sees.
import { serializeConversation } from "../core/compaction/utils.ts";
import { convertToLlm } from "../core/messages.ts";
import { combineUsage } from "../core/usage-totals.ts";
// Overflow errors of Chinese models and gateways.
import { isWriterOverflow } from "./compact-fallback.ts";
// Provider name.
import { JW_PROVIDER } from "./env-config.ts";
// Token estimate.
import { estimateTextTokens } from "./token-estimate.ts";

/** Share of the context window one summary request may use for the conversation. */
const SUMMARY_INPUT_SHARE = 0.7;
/** Most summary requests for one attempt; older parts beyond this are dropped. */
const MAX_SUMMARY_PARTS = 24;
/** How many times the parts get smaller before the failure stands. */
const MAX_SMALLER_TRIES = 3;

/** One summary with its usage. */
type Summary = { text: string; usage: Usage };

/** Starting size of a part (tokens), from the configured window. */
export function summaryLimit(model: Model<any>): number {
	// Room for the instructions and the summary itself.
	return Math.floor(model.contextWindow * SUMMARY_INPUT_SHARE);
}

/** A message with its text cut to keep the given share; one message larger than a request is shortened. */
export function shortenMessage(message: AgentMessage, keep: number): AgentMessage {
	// The beginning of the text, in proportion.
	const cut = (text: string) => text.slice(0, Math.floor(text.length * keep));
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return { ...message, content: cut(content) } as AgentMessage;
	if (!Array.isArray(content)) return message;
	const blocks = content.map((b: { type?: string; text?: string }) =>
		b.type === "text" && b.text ? { ...b, text: cut(b.text) } : b,
	);
	return { ...message, content: blocks } as AgentMessage;
}

/** Messages in order, grouped so each group's serialized text fits limit tokens. */
export function splitForSummary(
	messages: AgentMessage[],
	model: Model<any>,
	limit = summaryLimit(model),
): AgentMessage[][] {
	// Only the JW_* model, and only with a window to size by; other models keep one request.
	if (model.provider !== JW_PROVIDER || limit <= 0) return [messages];
	const parts: AgentMessage[][] = [[]];
	let size = 0;
	for (const message of messages) {
		// The size the summary request will see: long tool output is already cut by serialization.
		const tokens = estimateTextTokens(serializeConversation(convertToLlm([message])));
		if (size + tokens > limit && (parts.at(-1)?.length ?? 0) > 0) {
			parts.push([]);
			size = 0;
		}
		// A single message larger than a part cannot be split at a boundary.
		parts.at(-1)?.push(tokens > limit ? shortenMessage(message, limit / tokens) : message);
		size += Math.min(tokens, limit);
	}
	return parts.slice(-MAX_SUMMARY_PARTS);
}

/** True when a summary request of the JW_* model failed for being too large. */
export function isSummaryOverflow(error: unknown, model: Model<any>): boolean {
	// compact() wraps the provider's message.
	if (model.provider !== JW_PROVIDER || !(error instanceof Error)) return false;
	const errorMessage = error.message.replace(/^(Turn prefix s|S)ummarization failed: /, "");
	const failed = { provider: model.provider, stopReason: "error", errorMessage };
	return isContextOverflow(failed as never) || isWriterOverflow(failed);
}

/** The whole history as one summary, in parts, going smaller when the model rejects a part. */
export async function summarizeInParts(
	messages: AgentMessage[],
	model: Model<any>,
	previous: string | undefined,
	summarize: (part: AgentMessage[], previous: string | undefined) => Promise<Summary>,
): Promise<Summary> {
	// What is left to do, and the size of a part now.
	let rest = messages;
	let limit = summaryLimit(model);
	let result: Summary | undefined;
	for (let tries = 0; ; tries++) {
		const parts = splitForSummary(rest, model, limit);
		const failedAt = await (async () => {
			for (const [i, part] of parts.entries()) {
				try {
					const next = await summarize(part, result?.text ?? previous);
					result = result ? { text: next.text, usage: combineUsage(result.usage, next.usage) } : next;
				} catch (error) {
					// Only a request that was too large gets another try; parts already done are kept.
					if (tries >= MAX_SMALLER_TRIES || !isSummaryOverflow(error, model)) throw error;
					return i;
				}
			}
			return -1;
		})();
		if (failedAt < 0) return result as Summary;
		// One rejection teaches the size for everything still to come.
		rest = parts.slice(failedAt).flat();
		limit = Math.floor(limit / 2);
	}
}

/** The start of a split turn as one summary: when it is too large, its latest part is what matters most. */
export async function summarizeTurnStart(
	messages: AgentMessage[],
	model: Model<any>,
	summarize: (part: AgentMessage[]) => Promise<Summary>,
): Promise<Summary> {
	// The size of a request now.
	let limit = summaryLimit(model);
	for (let tries = 0; ; tries++) {
		try {
			return await summarize(splitForSummary(messages, model, limit).at(-1) ?? messages);
		} catch (error) {
			if (tries >= MAX_SMALLER_TRIES || !isSummaryOverflow(error, model)) throw error;
			limit = Math.floor(limit / 2);
		}
	}
}
