/**
 * Built-in JiaWriter extension: the loop guard (writer/loop-guard.ts) for every tool. A call that keeps failing, or is
 * made too often, with the same arguments is blocked with a reason; the third block ends the run.
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

	// Before a call: the same call again, where it cannot help, is blocked.
	pi.on("tool_call", (event) => {
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
