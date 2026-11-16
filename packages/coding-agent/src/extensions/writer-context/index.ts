/**
 * JiaWriter: large tool results fold out of the conversation once they are a few turns old, replaced in the model's
 * view by a line naming the file that holds them (writer/context-trim.ts). JW_CONTEXT_TRIM=off turns it off.
 */

// The extension API.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// The plan of edits.
import { trimEnabled, trimPlan } from "../../writer/context-trim.ts";

export default function writerContextExtension(pi: ExtensionAPI): void {
	// At each turn's end, the entries proposed so far plus the folds due now (a returned list replaces the proposal).
	pi.on("turn_end", (event) => {
		if (!trimEnabled(process.env)) return undefined;
		const folds = trimPlan(event.context.contextEntries);
		return folds.length === 0 ? undefined : { entries: [...event.entries, ...folds] };
	});
}
