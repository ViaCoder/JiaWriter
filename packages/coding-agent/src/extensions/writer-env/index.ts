/**
 * Built-in JiaWriter extension: registers the "jw" provider built from JW_* variables,
 * keeps every request's output limit inside the context window, and switches to the
 * nearest supported reasoning level when the server rejects the current one.
 */

// Nearest supported thinking level (pi's own rule).
import { clampThinkingLevel } from "@earendil-works/pi-ai";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Rejected reasoning levels are remembered in the detection cache.
import { markReasoningUnsupported } from "../../writer/api-detect.ts";
// The time each user message carries, and the clock check.
import { clockOffset, correction, setClockOffset, skewFromDate, withTimeNotes } from "../../writer/clock.ts";
// Output clamp and the provider name.
import { applyOutputClamp, JW_PROVIDER } from "../../writer/env-config.ts";
// Messages.
import { t } from "../../writer/i18n/index.ts";
// State prepared by main.ts at startup.
import { buildProviderConfig, dropReasoningLevel, getWriterModel, setWriterModel } from "../../writer/writer-model.ts";

/** Error text that points at a reasoning parameter. */
export const REASONING_ERROR = /reasoning|effort|thinking|budget/i;

/** Extension factory. */
export default function writerEnvExtension(pi: ExtensionAPI): void {
	// Every model call: each user message carries the local time it was sent (the latest one is "now").
	pi.on("context", (event) => ({ messages: withTimeNotes(event.messages, clockOffset()) }));
	// The first model response with a Date header shows how far the machine clock is off.
	let clockChecked = false;
	pi.on("after_provider_response", (event, ctx) => {
		if (clockChecked) return;
		// Header names in any case.
		const date = Object.entries(event.headers).find(([k]) => k.toLowerCase() === "date")?.[1];
		const skew = skewFromDate(date, Date.now());
		if (skew === undefined) return;
		clockChecked = true;
		// Two minutes or more: the model gets the server's time, and the user hears about it once.
		const offset = correction(skew);
		setClockOffset(offset);
		if (offset !== 0 && ctx.hasUI)
			ctx.ui.notify(t("clock.skew", { minutes: Math.round(Math.abs(offset) / 60_000) }), "warning");
	});
	// Result of the startup step in main.ts.
	const state = getWriterModel();
	// Nothing to register unless JW_* produced a ready configuration.
	if (state.kind !== "ready") return;
	// Register the provider; its apiKey is the "$JW_KEY" reference, never the value.
	pi.registerProvider(JW_PROVIDER, state.provider);
	// Before each request, lower the output limit when the input leaves less room.
	pi.on("before_provider_request", (event, ctx) => {
		// Only requests to the JW_* model are adjusted.
		if (ctx.model?.provider !== JW_PROVIDER) return undefined;
		// A new payload, or undefined to keep the original one.
		return applyOutputClamp(event.payload, state.api, state.contextWindow, state.maxTokens);
	});
	// After a failed reply, fall back to the nearest supported reasoning level.
	pi.on("message_end", (event, ctx) => {
		// Only the JW_* model.
		if (ctx.model?.provider !== JW_PROVIDER) return;
		// The finished message.
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		// Only assistant errors that name a reasoning parameter.
		if (
			message.role !== "assistant" ||
			message.stopReason !== "error" ||
			!REASONING_ERROR.test(message.errorMessage ?? "")
		)
			return;
		// Level that was rejected.
		const level = pi.getThinkingLevel();
		// Nothing to lower when reasoning is already off.
		if (level === "off") return;
		// Current shared state.
		const now = getWriterModel();
		// Only a ready configuration can be updated.
		if (now.kind !== "ready") return;
		// Remember the rejection for later starts; fall back to an in-memory update.
		const reasoning =
			markReasoningUnsupported(now.cachePath, now.cacheKey, level) ?? dropReasoningLevel(now.reasoning, level);
		// Provider with the reduced level map.
		const provider = buildProviderConfig(now.root, now.api, now.model, now.contextWindow, now.maxTokens, reasoning);
		// Share the new state.
		setWriterModel({ ...now, reasoning, provider });
		// Re-register; later calls take effect immediately.
		pi.registerProvider(JW_PROVIDER, provider);
		// The model as pi will see it now.
		const updatedModel = {
			...ctx.model,
			reasoning: provider.models[0].reasoning,
			thinkingLevelMap: provider.models[0].thinkingLevelMap,
		};
		// Nearest supported level by pi's rule.
		const next = clampThinkingLevel(updatedModel as never, level);
		// Switch the session to it.
		pi.setThinkingLevel(next as never);
		// Tell the user in Chinese.
		ctx.ui.notify(`当前模型不支持「${level}」推理档，已改用「${next}」。请重新发送上一条消息。`, "warning");
	});
}
