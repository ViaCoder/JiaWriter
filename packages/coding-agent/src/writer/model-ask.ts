/**
 * One question to the session's model in a context of its own: the review, a section, an extraction. The request
 * carries only what the caller gives it (instructions and one text), with the conversation's credentials and a
 * reasoning budget, and nothing of the conversation itself.
 */

// The model and the request.
import { type Api, completeSimple, type Model } from "@earendil-works/pi-ai/compat";
// Extension context: the model and its credentials.
import type { ExtensionContext } from "../core/extensions/types.ts";
// The review switch (JW_REVIEW=off).
import { reviewEnabled } from "./style/review.ts";

/** How one request reaches a model: completeSimple, or a stand-in in tests. */
export type Complete = typeof completeSimple;

/** A way to ask the session's model one question with its own credentials; undefined without a model or with JW_REVIEW=off. */
/** Reasoning tokens a review may use: with 4,096 it caught the same 5 of 5 seeded faults, its median fell from 108 to
 * 23 s and its longest from 719 to 124 s (2026-11-10; one review of a 400-character brief had waited 607 s). */
export const REVIEW_REASONING_TOKENS = 4096;
/** Longest wait for one review: past it the draft goes on without one. */
export const REVIEW_TIMEOUT_MS = 180_000;

/** The request body with a reasoning budget, in OpenRouter's form (other APIs keep theirs). */
export function withReviewBudget(payload: unknown, tokens = REVIEW_REASONING_TOKENS): unknown {
	if (!payload || typeof payload !== "object") return payload;
	return { ...(payload as Record<string, unknown>), reasoning: { max_tokens: tokens } };
}

/** How one clean request is bounded: its reasoning tokens and its longest wait. */
export interface AskBudget {
	reasoningTokens: number;
	timeoutMs: number;
}

export function modelAsker(
	ctx: ExtensionContext,
	complete: Complete = completeSimple,
	budgetOf: AskBudget = { reasoningTokens: REVIEW_REASONING_TOKENS, timeoutMs: REVIEW_TIMEOUT_MS },
	// The review can be switched off (JW_REVIEW=off); a section must still be written.
	always = false,
): ((instructions: string, text: string) => Promise<string>) | undefined {
	const model = ctx.model;
	if (!model || (!always && !reviewEnabled())) return undefined;
	// The budget goes to OpenAI-style requests until an upstream refuses it.
	let budget = model.api === "openai-completions";
	return async (instructions, text) => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		// The same address and keys the conversation uses.
		const target: Model<Api> = { ...model, baseUrl: auth.baseUrl ?? model.baseUrl };
		const ask = (capped: boolean) =>
			complete(
				target,
				{ systemPrompt: instructions, messages: [{ role: "user", content: text, timestamp: Date.now() }] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: AbortSignal.timeout(budgetOf.timeoutMs),
					...(capped
						? { onPayload: (payload: unknown) => withReviewBudget(payload, budgetOf.reasoningTokens) }
						: {}),
				},
			);
		let reply = await ask(budget);
		// An upstream that refuses the budget's field: once more without it, and never again in this run. Other
		// errors are not retried (2026-11-10: a retry on any error took the next scripted reply in a compaction test).
		if (
			reply.stopReason === "error" &&
			budget &&
			/\b400\b|reasoning|max_tokens|unknown|unsupported|unrecognized|invalid/i.test(reply.errorMessage ?? "")
		) {
			budget = false;
			reply = await ask(false);
		}
		if (reply.stopReason === "error" || reply.stopReason === "aborted")
			throw new Error(reply.errorMessage ?? "review failed");
		return reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
	};
}
