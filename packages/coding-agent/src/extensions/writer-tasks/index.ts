/**
 * Built-in JiaWriter extension: commands in the background (2026-11-09: "also ctrl+b etc for background", as in
 * Claude Code). /tasks lists them and stops a running one; when one ends, the screen says so and the next request
 * tells the model where its output is.
 */

// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// The tasks.
import {
	type BackgroundTask,
	backgroundTasks,
	onTaskEnd,
	runningTasks,
	stopTask,
	takeUntoldEnded,
} from "../../writer/background.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";

/** One task as a line of /tasks: number, state, time, command. */
export function taskLine(task: BackgroundTask, now: number = Date.now()): string {
	const seconds = Math.round(((task.endedAt ?? now) - task.startedAt) / 1000);
	const state =
		task.endedAt === undefined ? t("tasks.running") : t("tasks.ended", { code: String(task.exitCode ?? "?") });
	const command = task.command.length > 60 ? `${task.command.slice(0, 57)}...` : task.command;
	return t("tasks.line", { id: String(task.id), state, seconds: String(seconds), command });
}

/** The note for the model on tasks that ended since it was last asked. */
export function endedNote(tasks: readonly BackgroundTask[]): string {
	return tasks
		.map(
			(task) =>
				`Background task ${task.id} (${task.command}) ended with exit code ${task.exitCode}; its output is in ${task.outputFile}.`,
		)
		.join("\n");
}

/** Register /tasks, the notices and the note. */
export default function writerTasksExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tasks", {
		description: t("tasks.description"),
		handler: async (_args, ctx) => {
			const all = backgroundTasks();
			if (all.length === 0) {
				ctx.ui.notify(t("tasks.none"), "info");
				return;
			}
			const lines = all.map((task) => taskLine(task));
			const running = runningTasks();
			if (!ctx.hasUI || running.length === 0) {
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			// A running task picked here is stopped; the others are only listed.
			const stops = running.map((task) => t("tasks.stop", { line: taskLine(task) }));
			const picked = await ctx.ui.select(`${t("tasks.title")}\n${lines.join("\n")}`, [...stops, t("tasks.close")]);
			const at = picked ? stops.indexOf(picked) : -1;
			if (at >= 0 && stopTask(running[at].id))
				ctx.ui.notify(t("tasks.stopped", { id: String(running[at].id) }), "info");
		},
	});
	// The screen hears of each end.
	let stopHearing: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		stopHearing?.();
		stopHearing = onTaskEnd((task) => {
			if (ctx.hasUI)
				ctx.ui.notify(t("tasks.endedNotice", { id: String(task.id), code: String(task.exitCode) }), "info");
		});
	});
	// The model hears of ends with its next request.
	pi.on("before_agent_start", () => {
		const ended = takeUntoldEnded();
		if (ended.length === 0) return undefined;
		return { message: { customType: "jiawriter-tasks", content: endedNote(ended), display: false } };
	});
}
