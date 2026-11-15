/**
 * Built-in JiaWriter extension: scheduled tasks (2026-11-15). The model adds, lists and removes jobs with
 * schedule_add, schedule_list and schedule_remove; /schedule lists them. While the interface is open, a timer runs the due jobs every minute, each in a
 * child run of its own, and says what it did; when it is closed, `jiawriter schedule run` from the system's cron
 * does the same, and the tool tells the user the one line to install.
 */

// Paths.
import { resolve } from "node:path";
// Schemas.
import { Type } from "typebox";
// The agent folder.
import { getAgentDir } from "../../config.ts";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// The program's name in messages.
import { brandText } from "../../writer/brand.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// Running due jobs.
import { jobLines, runDue } from "../../writer/schedule/run.ts";
// The jobs and their rules.
import {
	describeRule,
	formatTime,
	type Job,
	loadJobs,
	newJobId,
	nextRun,
	parseWhen,
	saveJobs,
} from "../../writer/schedule/schedule.ts";
// The schedule toolkit, opened by /schedule.
import { openToolkit } from "../../writer/toolkit/open.ts";

/** How often the open program looks for due jobs. */
export const CHECK_EVERY_MS = 60_000;

/** Other names a model gives the fields (2026-11-15, eval G10: GLM sent add calls three times without when or task). */
const WHEN_ALIASES = ["when", "time", "schedule", "cron", "at", "rule", "frequency", "interval", "every"];
const TASK_ALIASES = ["task", "prompt", "request", "content", "command", "job", "description", "what"];

/** The arguments with the fields under their own names, whatever the model called them. */
export function prepareScheduleArguments(args: unknown): Record<string, unknown> {
	const given = (args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {}) as Record<
		string,
		unknown
	>;
	const pick = (names: readonly string[]) =>
		names.map((n) => given[n]).find((v) => typeof v === "string" && v.trim() !== "") as string | undefined;
	const when = pick(WHEN_ALIASES);
	const task = pick(TASK_ALIASES);
	if (when !== undefined) given.when = when;
	if (task !== undefined) given.task = task;
	return given;
}

/** The cron line that runs due jobs when the program is closed. */
export function cronLine(): string {
	return `*/5 * * * * ${brandText("jiawriter")} schedule run >> ~/.jiawriter/schedule.log 2>&1`;
}

/** Register the tool, the command and the timer. */
export default function writerScheduleExtension(pi: ExtensionAPI, agentDir = getAgentDir()): void {
	// Whether the cron hint was given in this session.
	let hinted = false;
	// Whether a timer run is under way.
	let running = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	/** A failed call. */
	const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
	// Three tools with their own required fields (2026-11-15, eval G10: with one tool and an action field, GLM sent
	// add calls without when or task seven times running; a required field is never left out).
	pi.registerTool({
		name: "schedule_add",
		// Declared only while its toolkit is open (writer/toolkit).
		exposure: "deferred",
		label: "Schedule",
		description:
			"Adds a scheduled task: a request run in a folder at the times a rule names.\n\nUsage:\n" +
			" - when: 每天 08:00 | 工作日 08:30 | 每周一 09:00 | 每月1日 09:00 | five cron fields (0 8 * * 1-5)\n" +
			" - task: the request as the user would type it, complete in itself (the run has no other context)\n" +
			" - folder: where it runs (default the working folder)",
		parameters: Type.Object({
			when: Type.String({ description: "The rule: 每天 08:00, or five cron fields" }),
			task: Type.String({ description: "The request to run, complete in itself" }),
			folder: Type.Optional(Type.String()),
		}),
		prepareArguments: (args) => prepareScheduleArguments(args) as { when: string; task: string; folder?: string },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const jobs = loadJobs(agentDir);
			if (!params.when?.trim())
				return fail(t("schedule.missing", { field: "when", got: Object.keys(params).join(", ") }));
			const rule = parseWhen(params.when);
			if (!rule) return fail(t("schedule.badWhen", { when: params.when }));
			const task = (params.task ?? "").trim();
			if (!task) return fail(t("schedule.missing", { field: "task", got: Object.keys(params).join(", ") }));
			const job: Job = {
				id: newJobId(jobs),
				when: params.when.trim(),
				task,
				folder: resolve(ctx.cwd, params.folder ?? "."),
				created: new Date().toISOString(),
			};
			jobs.push(job);
			saveJobs(agentDir, jobs);
			const next = nextRun(rule, new Date());
			const lines = [
				t("schedule.added", {
					id: job.id,
					when: describeRule(rule),
					next: next ? formatTime(next) : "—",
					folder: job.folder,
				}),
			];
			if (!hinted) {
				hinted = true;
				lines.push(t("schedule.cronHint", { line: cronLine() }));
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: { id: job.id } };
		},
	});

	pi.registerTool({
		name: "schedule_list",
		exposure: "deferred",
		label: "Schedule",
		description: "Lists the scheduled tasks with their ids, rules, next times and folders",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute() {
			const jobs = loadJobs(agentDir);
			const text = jobs.length === 0 ? t("schedule.none") : jobLines(jobs).join("\n");
			return { content: [{ type: "text", text }], details: { count: jobs.length } };
		},
	});

	pi.registerTool({
		name: "schedule_remove",
		exposure: "deferred",
		label: "Schedule",
		description: "Removes a scheduled task by the id schedule_list shows",
		parameters: Type.Object({ id: Type.String({ description: "The task's id" }) }),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_id, params) {
			const jobs = loadJobs(agentDir);
			const at = jobs.findIndex((j) => j.id === (params.id ?? "").trim());
			if (at < 0) return fail(t("schedule.noSuch", { id: params.id ?? "" }));
			const [gone] = jobs.splice(at, 1);
			saveJobs(agentDir, jobs);
			return {
				content: [{ type: "text", text: t("schedule.removed", { task: gone.task }) }],
				details: { id: gone.id },
			};
		},
	});

	pi.registerCommand("schedule", {
		description: t("schedule.command"),
		handler: async (_args, ctx) => {
			// The model gets the schedule tools too, so the user can add or remove tasks in words.
			openToolkit(pi, "schedule", { hasUI: ctx.hasUI, skills: [] });
			const jobs = loadJobs(agentDir);
			ctx.ui.notify(jobs.length === 0 ? t("schedule.none") : jobLines(jobs).join("\n"), "info");
		},
	});

	// The timer: due jobs run while the program is open, and the outcome is said in the conversation.
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || timer) return;
		timer = setInterval(async () => {
			if (running) return;
			running = true;
			try {
				for (const done of await runDue(agentDir)) {
					pi.sendMessage(
						{
							customType: "jiawriter-schedule",
							content: t("schedule.ran", { task: done.job.task, status: done.status, log: done.log }),
							display: true,
						},
						{ deliverAs: "followUp" },
					);
				}
			} catch {
				// A failed check is tried again next minute.
			} finally {
				running = false;
			}
		}, CHECK_EVERY_MS);
		timer.unref();
	});
}
