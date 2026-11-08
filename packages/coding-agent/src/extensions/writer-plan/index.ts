/**
 * Built-in JiaWriter extension: /plan (the plan's general-capability line, 2026-11-08). While plan mode is on, the
 * model may look, read and search, but every change is refused: write, edit, exports, recorded materials, topic
 * folders and any shell command that is not plain reading. Each request then carries a note asking for a numbered
 * plan and a stop. /plan again turns it off, and the next request carries the plan out.
 */

// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
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
	"Plan mode is on: look, read and search as needed, then give a numbered plan of the changes and stop. Change no file until the user turns plan mode off with /plan";

/** True when plan mode refuses this call. */
export function refusedInPlan(toolName: string, input: Record<string, unknown>): boolean {
	if (PLAN_REFUSED.has(toolName)) return true;
	if (toolName === "bash" || toolName === "powershell") return bashRisk(String(input.command ?? "")) !== "read";
	return false;
}

/** Register /plan, the refusals and the note. */
export default function writerPlanExtension(pi: ExtensionAPI): void {
	// On or off for this session.
	let planning = false;
	pi.registerCommand("plan", {
		description: t("plan.description"),
		handler: async (_args, ctx) => {
			planning = !planning;
			ctx.ui.notify(t(planning ? "plan.on" : "plan.off"), "info");
			if (ctx.hasUI) ctx.ui.setStatus("writer-plan", planning ? t("plan.status") : undefined);
		},
	});
	pi.on("tool_call", (event) => {
		if (!planning || !refusedInPlan(event.toolName, event.input as Record<string, unknown>)) return undefined;
		return { block: true, reason: t("plan.refused", { tool: event.toolName }) };
	});
	pi.on("before_agent_start", () => {
		if (!planning) return undefined;
		return { message: { customType: "jiawriter-plan", content: PLAN_NOTE, display: false } };
	});
}
