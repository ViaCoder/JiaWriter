/**
 * Scheduled tasks (2026-11-15, WorkBuddy parity: "set recurring tasks and let it run them on a schedule"): a task
 * is a prompt run in a folder at the times a rule names. Rules are written as people say them (每天 08:00,
 * 工作日 08:30, 每周一 09:00, 每月1日 09:00) or as the five fields of cron. The jobs live in schedules.json of the
 * agent folder; schedule/run.ts runs the due ones, from the program's own timer or from `jiawriter schedule run`
 * in the system's cron. Times are local.
 */

// Files.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// Paths.
import { dirname, join } from "node:path";

/** When a task runs. */
export type Rule =
	| { kind: "daily" | "weekdays"; hour: number; minute: number }
	| { kind: "weekly"; weekday: number; hour: number; minute: number }
	| { kind: "monthly"; day: number; hour: number; minute: number }
	| { kind: "cron"; fields: CronFields; text: string };

/** The sets a cron expression allows, one per field. */
export interface CronFields {
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
	// Whether the day and weekday fields were both restricted (cron then takes either).
	dayOrWeekday: boolean;
}

/** One scheduled task. */
export interface Job {
	id: string;
	// The rule as the user wrote it.
	when: string;
	task: string;
	folder: string;
	// ISO times.
	created: string;
	lastRun?: string;
	lastResult?: "ok" | "failed" | "timeout";
}

/** Chinese weekday names to numbers (Sunday 0). */
const WEEKDAYS: Readonly<Record<string, number>> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
/** Names of the weekdays, for descriptions. */
const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

/** HH:MM or H点M分 forms → [hour, minute]; undefined for none. */
function timeOf(text: string): [number, number] | undefined {
	const m = /(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?/.exec(text);
	if (!m) return undefined;
	const hour = Number(m[1]);
	const minute = Number(m[2] ?? 0);
	if (hour > 23 || minute > 59) return undefined;
	return [hour, minute];
}

/** One cron field → the set of values it allows within [lo, hi]. */
function cronSet(field: string, lo: number, hi: number): Set<number> | undefined {
	const out = new Set<number>();
	for (const part of field.split(",")) {
		const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
		if (!m) return undefined;
		const step = m[2] ? Number(m[2]) : 1;
		if (step < 1) return undefined;
		let from = lo;
		let to = hi;
		if (m[1] !== "*") {
			const [a, b] = m[1].split("-").map(Number);
			from = a;
			to = b ?? (m[2] ? hi : a);
		}
		if (from < lo || to > hi || from > to) return undefined;
		for (let v = from; v <= to; v += step) out.add(v);
	}
	return out;
}

/** Five cron fields → the sets; undefined when a field is malformed. */
export function parseCron(text: string): CronFields | undefined {
	const f = text.trim().split(/\s+/);
	if (f.length !== 5) return undefined;
	const minutes = cronSet(f[0], 0, 59);
	const hours = cronSet(f[1], 0, 23);
	const days = cronSet(f[2], 1, 31);
	const months = cronSet(f[3], 1, 12);
	const weekdays = cronSet(f[4].replace(/7/g, "0"), 0, 6);
	if (!minutes || !hours || !days || !months || !weekdays) return undefined;
	return { minutes, hours, days, months, weekdays, dayOrWeekday: f[2] !== "*" && f[4] !== "*" };
}

/** A rule from the user's words or a cron expression; undefined when it is neither. */
export function parseWhen(text: string): Rule | undefined {
	const s = text.trim().replace(/\s+/g, " ");
	if (!s) return undefined;
	const time = timeOf(s);
	if (/^(每天|每日|天天)/.test(s) && time) return { kind: "daily", hour: time[0], minute: time[1] };
	if (/^(工作日|每个工作日|周一至周五|周一到周五)/.test(s) && time)
		return { kind: "weekdays", hour: time[0], minute: time[1] };
	const weekly = /^每(?:周|星期|礼拜)([一二三四五六日天])/.exec(s);
	if (weekly && time) return { kind: "weekly", weekday: WEEKDAYS[weekly[1]], hour: time[0], minute: time[1] };
	const monthly = /^每月\s*(\d{1,2})\s*[日号]/.exec(s);
	if (monthly && time && Number(monthly[1]) >= 1 && Number(monthly[1]) <= 31)
		return { kind: "monthly", day: Number(monthly[1]), hour: time[0], minute: time[1] };
	const fields = parseCron(s);
	return fields ? { kind: "cron", fields, text: s } : undefined;
}

/** The rule in words. */
export function describeRule(rule: Rule): string {
	const hm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
	switch (rule.kind) {
		case "daily":
			return `每天 ${hm(rule.hour, rule.minute)}`;
		case "weekdays":
			return `工作日 ${hm(rule.hour, rule.minute)}`;
		case "weekly":
			return `每周${WEEKDAY_NAMES[rule.weekday]} ${hm(rule.hour, rule.minute)}`;
		case "monthly":
			return `每月${rule.day}日 ${hm(rule.hour, rule.minute)}`;
		default:
			return `cron ${rule.text}`;
	}
}

/** Whether a minute matches a cron rule. */
function cronMatches(f: CronFields, d: Date): boolean {
	if (!f.minutes.has(d.getMinutes()) || !f.hours.has(d.getHours()) || !f.months.has(d.getMonth() + 1)) return false;
	const dayOk = f.days.has(d.getDate());
	const weekdayOk = f.weekdays.has(d.getDay());
	return f.dayOrWeekday ? dayOk || weekdayOk : dayOk && weekdayOk;
}

/** The next time the rule fires strictly after `from`, at minute resolution; undefined when none within 400 days. */
export function nextRun(rule: Rule, from: Date): Date | undefined {
	// Start at the next whole minute.
	const start = new Date(from.getTime());
	start.setSeconds(0, 0);
	start.setMinutes(start.getMinutes() + 1);
	if (rule.kind === "cron") {
		const d = new Date(start.getTime());
		const end = start.getTime() + 400 * 86400000;
		while (d.getTime() <= end) {
			if (!rule.fields.months.has(d.getMonth() + 1)) {
				d.setMonth(d.getMonth() + 1, 1);
				d.setHours(0, 0, 0, 0);
				continue;
			}
			const dayOk = rule.fields.dayOrWeekday
				? rule.fields.days.has(d.getDate()) || rule.fields.weekdays.has(d.getDay())
				: rule.fields.days.has(d.getDate()) && rule.fields.weekdays.has(d.getDay());
			if (!dayOk) {
				d.setDate(d.getDate() + 1);
				d.setHours(0, 0, 0, 0);
				continue;
			}
			if (cronMatches(rule.fields, d)) return d;
			d.setMinutes(d.getMinutes() + 1);
		}
		return undefined;
	}
	// A time of day on the days the rule names: today at that time if still ahead, else the next such day.
	const at = (day: Date) => {
		const t = new Date(day.getTime());
		t.setHours(rule.hour, rule.minute, 0, 0);
		return t;
	};
	const dayFits = (d: Date) =>
		rule.kind === "daily" ||
		(rule.kind === "weekdays" && d.getDay() >= 1 && d.getDay() <= 5) ||
		(rule.kind === "weekly" && d.getDay() === rule.weekday) ||
		(rule.kind === "monthly" && d.getDate() === rule.day);
	const d = new Date(start.getTime());
	for (let i = 0; i < 400; i++) {
		const t = at(d);
		if (dayFits(d) && t.getTime() >= start.getTime()) return t;
		d.setDate(d.getDate() + 1);
		d.setHours(0, 0, 0, 0);
	}
	return undefined;
}

/** Whether the job is due at `now`: its next time after the last run (or its creation) has come. */
export function isDue(job: Job, now: Date): boolean {
	const rule = parseWhen(job.when);
	if (!rule) return false;
	const since = new Date(job.lastRun ?? job.created);
	const next = nextRun(rule, since);
	return next !== undefined && next.getTime() <= now.getTime();
}

/** A local time as 2026-11-15 08:00. */
export function formatTime(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The jobs file. */
export function jobsPath(agentDir: string): string {
	return join(agentDir, "schedules.json");
}

/** The jobs on disk; none when the file is missing or unreadable. */
export function loadJobs(agentDir: string): Job[] {
	const path = jobsPath(agentDir);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { jobs?: unknown };
		return Array.isArray(parsed.jobs) ? (parsed.jobs as Job[]).filter((j) => j && typeof j.id === "string") : [];
	} catch {
		return [];
	}
}

/** Write the jobs atomically. */
export function saveJobs(agentDir: string, jobs: readonly Job[]): void {
	const path = jobsPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, `${JSON.stringify({ jobs }, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
}

/** A short id for a new job: the time, base36, with a suffix when taken. */
export function newJobId(taken: readonly Job[], now = new Date()): string {
	const base = now.getTime().toString(36).slice(-6);
	let id = base;
	for (let i = 2; taken.some((j) => j.id === id); i++) id = `${base}-${i}`;
	return id;
}
