/**
 * Built-in JiaWriter extension: the loop guard (writer/loop-guard.ts) for every tool. A call that keeps failing, or is
 * made too often, with the same arguments is blocked with a reason; the third block ends the run.
 */

// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Output messages.
// One form for a stopped call.
import { blockedText } from "../../writer/blocked.ts";
// Sites waiting for the user to pass their verification.
import { heldIn, resetHeldSites } from "../../writer/held-sites.ts";
import { t } from "../../writer/i18n/index.ts";
// The guard's rules.
import {
	callKey,
	checkCall,
	MAX_BLOCKS,
	MAX_SAME_CALLS,
	MAX_SAME_FAILURES,
	newGuard,
	recordResult,
} from "../../writer/loop-guard.ts";

/** Extension factory. */
export default function writerGuardExtension(pi: ExtensionAPI): void {
	// One guard per message of the user.
	let guard = newGuard();
	pi.on("input", () => {
		guard = newGuard();
		// The user may have passed a verification since.
		resetHeldSites();
	});

	// Before a call: a site held for its verification is reached by no tool; the same call again, where it cannot help,
	// is blocked.
	pi.on("tool_call", (event) => {
		const host = heldIn(JSON.stringify(event.input ?? {}));
		if (host && event.toolName !== "browser")
			return {
				block: true,
				reason: blockedText({ why: t("guard.held", { host }), next: "user", still: t("guard.heldStill") }),
			};
		const verdict = checkCall(guard, callKey(event.toolName, event.input));
		if (verdict === "ok") return;
		guard.blocks++;
		const stop = guard.blocks >= MAX_BLOCKS;
		const why =
			verdict === "failed"
				? t("guard.failed", { tool: event.toolName, count: MAX_SAME_FAILURES })
				: t("guard.repeated", { tool: event.toolName, count: MAX_SAME_CALLS });
		return { block: true, reason: blockedText({ why, next: stop ? "stop" : "change" }), terminate: stop };
	});

	// After a call: its outcome counts.
	pi.on("tool_result", (event) => {
		recordResult(guard, callKey(event.toolName, event.input), event.isError, event.toolName);
	});
}
