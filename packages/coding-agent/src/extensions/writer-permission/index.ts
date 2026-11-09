/**
 * Built-in JiaWriter extension: bash, powershell, write and edit under the permission modes (the user's choice,
 * 2026-11-08: "the same as Claude Code"). manual asks every time; auto asks once per working directory, and every
 * time for high risk (deleting, moving, rights, publishing, files outside the working directory); bypass never asks.
 * With nobody to answer, an allowlist runs: reading commands and file changes inside the working directory go on,
 * everything else is refused with the reason, so `jiawriter -p` can still write its drafts.
 */

// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Output messages.
// One form for a stopped call.
import { blockedText } from "../../writer/blocked.ts";
import { t } from "../../writer/i18n/index.ts";
// The modes and the session's gate.
import { createPermissionGate, permissionMode } from "../../writer/permission.ts";
// The risk of a call.
import { toolRequest } from "../../writer/tool-risk.ts";

/** Register the gate on tool calls. */
/** The refusal when nobody can confirm: the part that needs no confirmation still goes on (2026-11-09: a run dropped it). */
function noUser(what: string): string {
	return blockedText({ why: t("permission.noUser", { what }), next: "user", still: t("permission.noUserStill") });
}

export default function writerPermissionExtension(pi: ExtensionAPI): void {
	// Answers of this session, per risk and scope.
	const gate = createPermissionGate();
	pi.on("tool_call", async (event, ctx) => {
		const titles = {
			command: t("permission.askCommand"),
			file: t("permission.askFile"),
			outside: t("permission.askOutside"),
		};
		const request = toolRequest(event.toolName, event.input as Record<string, unknown>, ctx.cwd, titles);
		if (!request) return undefined;
		// Nobody to ask: the allowlist instead of a question.
		if (!ctx.hasUI && permissionMode() !== "bypass") {
			if (request.risk === "read" || request.inDirFile) return undefined;
			return { block: true, reason: noUser(request.detail) };
		}
		const refusal = await gate.check(ctx, request);
		if (refusal === "declined") {
			// The user's own words on what to do instead go with the refusal, as Claude Code passes them on.
			const note = gate.lastNote();
			const why = note
				? t("permission.declinedNote", { what: request.detail, note })
				: t("permission.declined", { what: request.detail });
			return { block: true, reason: blockedText({ why, next: note ? "change" : "user" }) };
		}
		if (refusal === "no-user") return { block: true, reason: noUser(request.detail) };
		return undefined;
	});
	// A new session starts with no answers.
	pi.on("session_start", () => gate.reset());
}
