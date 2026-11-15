/**
 * Built-in JiaWriter extension: the loop guard (writer/loop-guard.ts) for every tool. A call that keeps failing, or is
 * made too often, with the same arguments is blocked with a reason; at the third block the model is told to reply to the
 * user, and a tool call after that ends the run. A reply that goes on
 * calling tools past MAX_CALLS_PER_REPLY is cut while it streams, and the model is told to go on with what it has.
 */

// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Output messages.
// One form for a stopped call.
import { blockedText } from "../../writer/blocked.ts";
import { t } from "../../writer/i18n/index.ts";
// The guard's rules.
import {
	callKey,
	checkCall,
	MAX_BLOCKS,
	MAX_CALLS_PER_REPLY,
	MAX_SAME_CALLS,
	MAX_SAME_FAILURES,
	MAX_TOOL_FAILURES,
	newGuard,
	recordResult,
} from "../../writer/loop-guard.ts";

/** Blocked calls after the guard's stop before the run ends. */
export const AFTER_STOP_CALLS = 3;

/** Extension factory. */
export default function writerGuardExtension(pi: ExtensionAPI): void {
	// One guard per message of the user.
	let guard = newGuard();
	// The guard said stop: the model gets one reply to the user; a tool call after that ends the run (2026-11-15: a
	// run ended at the third block with no reply at all, and print mode wrote nothing).
	let stopped = false;
	// Calls blocked after the stop: the third ends the run (the model usually writes after a block or two).
	let afterStop = 0;
	pi.on("input", () => {
		guard = newGuard();
		stopped = false;
		afterStop = 0;
	});

	// Tool calls of the reply now streaming, and the count at which a reply was cut (0: none was).
	let replyCalls = 0;
	let flooded = 0;
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") replyCalls = 0;
	});
	// A reply calling tools past the limit is a loop: cut it where it is.
	pi.on("message_update", (event, ctx) => {
		if (flooded || event.message.role !== "assistant" || !Array.isArray(event.message.content)) return;
		const calls = event.message.content.filter((c) => c.type === "toolCall").length;
		if (calls <= MAX_CALLS_PER_REPLY) return;
		flooded = calls;
		ctx.abort();
	});
	// Once the cut run has ended, the model is told and goes on.
	pi.on("agent_end", () => {
		if (!flooded) return;
		const count = flooded;
		flooded = 0;
		pi.sendMessage(
			{
				customType: "jiawriter-guard-flood",
				content: t("guard.flood", { count, max: MAX_CALLS_PER_REPLY }),
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	// Before a call: the same call again, where it cannot help, is blocked.
	pi.on("tool_call", (event) => {
		if (stopped) {
			afterStop++;
			return {
				block: true,
				reason: blockedText({ why: t("guard.afterStop"), next: "stop" }),
				terminate: afterStop >= AFTER_STOP_CALLS,
			};
		}
		// A reply that arrived whole with too many calls: the ones past the limit are not run.
		replyCalls++;
		if (replyCalls > MAX_CALLS_PER_REPLY)
			return {
				block: true,
				reason: blockedText({ why: t("guard.floodCall", { max: MAX_CALLS_PER_REPLY }), next: "stop" }),
				terminate: true,
			};
		const verdict = checkCall(guard, callKey(event.toolName, event.input), event.toolName);
		if (verdict === "ok") return;
		guard.blocks++;
		const stop = guard.blocks >= MAX_BLOCKS;
		const why =
			verdict === "failed"
				? t("guard.failed", { tool: event.toolName, count: MAX_SAME_FAILURES })
				: verdict === "failing"
					? t("guard.failing", { tool: event.toolName, count: MAX_TOOL_FAILURES })
					: t("guard.repeated", { tool: event.toolName, count: MAX_SAME_CALLS });
		if (stop) stopped = true;
		return { block: true, reason: blockedText({ why, next: stop ? "stop" : "change" }) };
	});

	// After a call: its outcome counts.
	pi.on("tool_result", (event) => {
		recordResult(guard, callKey(event.toolName, event.input), event.isError, event.toolName);
	});
}
