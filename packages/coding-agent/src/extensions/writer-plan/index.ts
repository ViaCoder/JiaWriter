/**
 * Built-in JiaWriter extension: /plan (the plan's general-capability line, 2026-11-08). While plan mode is on, the
 * model may look, read and search, but every change is refused: write, edit, exports, recorded materials, topic
 * folders and any shell command that is not plain reading. Each request then carries a note asking for a numbered
 * plan and a stop. /plan again turns it off, and the next request carries the plan out.
 */

// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Output messages.
// One form for a stopped call.
import { blockedText } from "../../writer/blocked.ts";
import { t } from "../../writer/i18n/index.ts";
// Plan mode is shared with Shift+Tab, which cycles it with the permission modes.
import { isPlanning, setPlanning } from "../../writer/permission.ts";
// Which shell commands only read.
import { bashRisk } from "../../writer/tool-risk.ts";

/** Tools that change files or the topic, refused in plan mode. */
export const PLAN_REFUSED = new Set([
	"write",
	"edit",
	"export_document",
	"material_add",
	"topic_open",
	"draft_restore",
]);

/** The note each request carries while plan mode is on. */
export const PLAN_NOTE =
	"Plan mode is on: look, read and search as needed, then give a numbered plan of the changes and stop. Change no file until the user turns plan mode off (/plan or Shift+Tab)";

/** True when plan mode refuses this call. */
export function refusedInPlan(toolName: string, input: Record<string, unknown>): boolean {
	if (PLAN_REFUSED.has(toolName)) return true;
	if (toolName === "bash" || toolName === "powershell") return bashRisk(String(input.command ?? "")) !== "read";
	return false;
}

/** Register /plan, the refusals and the note. */
export default function writerPlanExtension(pi: ExtensionAPI): void {
	// On or off for this session; the status line shows it with the work mode.
	pi.registerCommand("plan", {
		description: t("plan.description"),
		handler: async (_args, ctx) => {
			setPlanning(!isPlanning());
			ctx.ui.notify(t(isPlanning() ? "plan.on" : "plan.off"), "info");
		},
	});
	// A new session starts outside plan mode.
	pi.on("session_start", () => setPlanning(false));
	pi.on("tool_call", (event) => {
		if (!isPlanning() || !refusedInPlan(event.toolName, event.input as Record<string, unknown>)) return undefined;
		const why = t("plan.refused", { tool: event.toolName });
		return { block: true, reason: blockedText({ why, next: "user", still: t("plan.refusedStill") }) };
	});
	pi.on("before_agent_start", () => {
		if (!isPlanning()) return undefined;
		return { message: { customType: "jiawriter-plan", content: PLAN_NOTE, display: false } };
	});
}
