/**
 * Built-in JiaWriter extension: delegated subtasks (2026-11-15, WorkBuddy parity: a lead agent with experts working
 * in parallel). The delegate tool runs a self-contained task in a fresh process of this program, in its own context
 * and folder, and returns the final reply; several calls may run at once. A subtask cannot delegate further, so the
 * tree stays one level deep.
 */

// Files.
import { mkdirSync } from "node:fs";
// Paths.
import { resolve } from "node:path";
// Schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Child runs.
import { type ChildResult, runChild } from "../../writer/child-run.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";

/** Environment variable that marks a delegated run (its depth). */
export const DELEGATE_ENV = "JW_DELEGATE_DEPTH";
/** Default and longest wait for a subtask, in minutes. */
export const DEFAULT_MINUTES = 20;
export const MAX_MINUTES = 60;
/** Most characters of a subtask's reply returned. */
export const MAX_REPLY = 20_000;

/** The text returned for a finished subtask. */
export function delegateText(result: ChildResult, minutes: number): string {
	const reply = result.stdout.trim().slice(0, MAX_REPLY) || "（无）";
	if (result.timedOut) return t("delegate.timeout", { minutes: String(minutes), reply });
	if (result.code !== 0)
		return t("delegate.failed", { code: String(result.code), reply, error: result.stderr.trim().slice(-2000) });
	return reply;
}

/** Register the tool. */
export default function writerDelegateExtension(pi: ExtensionAPI, run = runChild): void {
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Runs a self-contained subtask in a fresh JiaWriter process with a context of its own and returns its final reply; several calls may run at once, for independent pieces of work (研究一个子题、写一节、整理一批文件).\n\nUsage:\n" +
			" - task: the whole request, as the user would type it; the subtask knows nothing of this conversation\n" +
			" - folder: where it works (default the working folder); say in the task which files to write\n" +
			" - minutes: longest wait (default 20)\n" +
			" - A subtask cannot delegate further",
		parameters: Type.Object({
			task: Type.String(),
			folder: Type.Optional(Type.String()),
			minutes: Type.Optional(Type.Number()),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			const depth = Number(process.env[DELEGATE_ENV] ?? 0);
			if (depth >= 1) return { content: [{ type: "text", text: t("delegate.depth") }], details: {}, isError: true };
			const task = params.task.trim();
			if (!task) return { content: [{ type: "text", text: t("delegate.noTask") }], details: {}, isError: true };
			const minutes = Math.min(MAX_MINUTES, Math.max(1, Math.round(params.minutes ?? DEFAULT_MINUTES)));
			// The folder is made when it is new: a subtask often works in a folder of its own.
			const folder = resolve(ctx.cwd, params.folder ?? ".");
			mkdirSync(folder, { recursive: true });
			const result = await run(task, folder, { [DELEGATE_ENV]: String(depth + 1) }, minutes * 60_000, signal);
			return {
				content: [{ type: "text", text: delegateText(result, minutes) }],
				details: { folder, code: result.code, timedOut: result.timedOut },
				isError: result.timedOut || result.code !== 0,
			};
		},
	});
}
