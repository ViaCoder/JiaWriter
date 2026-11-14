/**
 * Built-in JiaWriter extension: the loop guard (writer/loop-guard.ts) for every tool. A call that keeps failing, or is
 * made too often, with the same arguments is blocked with a reason; the third block ends the run. A reply that goes on
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

/** Extension factory. */
export default function writerGuardExtension(pi: ExtensionAPI): void {
	// One guard per message of the user.
	let guard = newGuard();
	pi.on("input", () => {
		guard = newGuard();
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
		return { block: true, reason: blockedText({ why, next: stop ? "stop" : "change" }), terminate: stop };
	});

	// After a call: its outcome counts.
	pi.on("tool_result", (event) => {
		recordResult(guard, callKey(event.toolName, event.input), event.isError, event.toolName);
	});
}
