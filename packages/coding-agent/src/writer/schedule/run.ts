/**
 * Running the scheduled tasks that are due: each in a child run of this program, in its folder, with its output kept
 * in a log under the agent folder, and the job's last run recorded. Used by the program's own timer while it is
 * open and by `jiawriter schedule run` from the system's cron when it is not.
 */

// Files.
import { mkdirSync, writeFileSync } from "node:fs";
// Paths.
import { join } from "node:path";
// Child runs.
import { type ChildResult, runChild } from "../child-run.ts";
// Output messages.
import { t } from "../i18n/index.ts";
import { describeRule, formatTime, isDue, type Job, loadJobs, nextRun, parseWhen, saveJobs } from "./schedule.ts";

/** Longest a scheduled run may take. */
export const SCHEDULE_TIMEOUT_MS = 30 * 60_000;
/** Environment variable set in a scheduled child run (its job id), so a child never runs schedules itself. */
export const SCHEDULE_ENV = "JW_SCHEDULE_JOB";

/** What one due job ended with. */
export interface RunOutcome {
	job: Job;
	status: NonNullable<Job["lastResult"]>;
	// The log file.
	log: string;
}

/** The runner of one task: the child run by default, a stand-in in tests. */
export type Runner = (
	prompt: string,
	folder: string,
	env: Record<string, string>,
	timeoutMs: number,
) => Promise<ChildResult>;

/** The log file of a run, written. */
function writeLog(agentDir: string, job: Job, now: Date, result: ChildResult, status: RunOutcome["status"]): string {
	const dir = join(agentDir, "schedules", job.id);
	mkdirSync(dir, { recursive: true });
	const stamp = formatTime(now)
		.replace(/[- :]/g, "")
		.replace(/^(\d{8})(\d{4})$/, "$1-$2");
	const path = join(dir, `${stamp}.md`);
	const lines = [
		`# ${job.task}`,
		"",
		`- 时间：${formatTime(now)}`,
		`- 规则：${job.when}`,
		`- 文件夹：${job.folder}`,
		`- 结果：${status}${result.code !== null && result.code !== 0 ? `（退出码 ${result.code}）` : ""}`,
		"",
		"## 回复",
		"",
		result.stdout.trim() || "（无）",
	];
	if (result.stderr.trim()) lines.push("", "## 错误输出", "", result.stderr.trim().slice(-4000));
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

/** Run every due job once, in order, and record it; returns what happened to each. */
export async function runDue(agentDir: string, now = new Date(), runner: Runner = runChild): Promise<RunOutcome[]> {
	// A scheduled child run never runs schedules of its own.
	if (process.env[SCHEDULE_ENV]) return [];
	const jobs = loadJobs(agentDir);
	const out: RunOutcome[] = [];
	for (const job of jobs) {
		if (!isDue(job, now)) continue;
		// Recorded before the run, so a crash mid-run does not run it again at once.
		job.lastRun = now.toISOString();
		saveJobs(agentDir, jobs);
		const result = await runner(job.task, job.folder, { [SCHEDULE_ENV]: job.id }, SCHEDULE_TIMEOUT_MS);
		const status: RunOutcome["status"] = result.timedOut ? "timeout" : result.code === 0 ? "ok" : "failed";
		job.lastResult = status;
		saveJobs(agentDir, jobs);
		out.push({ job, status, log: writeLog(agentDir, job, now, result, status) });
	}
	return out;
}

/** One line per job: id, rule, next time, task, folder. */
export function jobLines(jobs: readonly Job[], now = new Date()): string[] {
	return jobs.map((job) => {
		const rule = parseWhen(job.when);
		const next = rule ? nextRun(rule, new Date(job.lastRun ?? job.created)) : undefined;
		return t("schedule.line", {
			id: job.id,
			when: rule ? describeRule(rule) : job.when,
			next: next ? formatTime(next.getTime() < now.getTime() ? now : next) : "—",
			task: job.task,
			folder: job.folder,
			last: job.lastResult ? `，上次 ${job.lastResult}` : "",
		});
	});
}

/** `jiawriter schedule run|list`: the exit code. */
export async function runScheduleCommand(args: readonly string[], options: { agentDir: string }): Promise<number> {
	const sub = args[0] ?? "";
	if (sub === "run") {
		const done = await runDue(options.agentDir);
		if (done.length === 0) console.log(t("schedule.nothingDue"));
		for (const d of done) console.log(t("schedule.ran", { task: d.job.task, status: d.status, log: d.log }));
		return done.some((d) => d.status !== "ok") ? 1 : 0;
	}
	if (sub === "list") {
		const jobs = loadJobs(options.agentDir);
		console.log(jobs.length === 0 ? t("schedule.none") : jobLines(jobs).join("\n"));
		return 0;
	}
	console.log(t("schedule.usage"));
	return sub === "" ? 0 : 1;
}
