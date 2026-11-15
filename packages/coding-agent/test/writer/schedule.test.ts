// Unit and functional tests for src/writer/schedule: the rules people write and cron fields, the next time of each,
// the jobs file, running the due jobs with a stand-in runner (log, last run), the command line, and the tool.

// Files.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Extension API types.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
// The extension.
import writerScheduleExtension, {
	cronLine,
	prepareScheduleArguments,
} from "../../src/extensions/writer-schedule/index.ts";
// Functions under test.
import { jobLines, runDue, runScheduleCommand, SCHEDULE_ENV } from "../../src/writer/schedule/run.ts";
import {
	describeRule,
	formatTime,
	isDue,
	type Job,
	loadJobs,
	newJobId,
	nextRun,
	parseCron,
	parseWhen,
	saveJobs,
} from "../../src/writer/schedule/schedule.ts";

// Agent folder of each test.
let agentDir = "";
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "wa-schedule-"));
	vi.stubEnv("JW_LANG", "zh");
	vi.stubEnv(SCHEDULE_ENV, "");
});
afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** A local date. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe("parseWhen / describeRule / parseCron", () => {
	it("reads the forms people write and cron fields, and refuses the rest", () => {
		expect(parseWhen("每天 08:00")).toEqual({ kind: "daily", hour: 8, minute: 0 });
		expect(parseWhen("每日8点30分")).toEqual({ kind: "daily", hour: 8, minute: 30 });
		expect(parseWhen("工作日 08:30")).toEqual({ kind: "weekdays", hour: 8, minute: 30 });
		expect(parseWhen("每周一 09:00")).toEqual({ kind: "weekly", weekday: 1, hour: 9, minute: 0 });
		expect(parseWhen("每星期天 20:00")).toEqual({ kind: "weekly", weekday: 0, hour: 20, minute: 0 });
		expect(parseWhen("每月1日 09:00")).toEqual({ kind: "monthly", day: 1, hour: 9, minute: 0 });
		expect(parseWhen("0 8 * * 1-5")).toMatchObject({ kind: "cron", text: "0 8 * * 1-5" });
		for (const bad of ["", "明天", "每天 25:00", "每月32日 09:00", "0 8 * *", "a b c d e", "每周八 09:00"])
			expect(parseWhen(bad), bad).toBeUndefined();
		expect(describeRule(parseWhen("每周一 9:05") as never)).toBe("每周一 09:05");
		expect(describeRule(parseWhen("每月15号 18:00") as never)).toBe("每月15日 18:00");
		expect(describeRule(parseWhen("*/15 9-17 * * *") as never)).toBe("cron */15 9-17 * * *");
		const f = parseCron("*/15 9-17 1,15 * 7");
		expect([...(f?.minutes ?? [])]).toEqual([0, 15, 30, 45]);
		expect([...(f?.hours ?? [])]).toHaveLength(9);
		expect([...(f?.days ?? [])]).toEqual([1, 15]);
		expect([...(f?.weekdays ?? [])]).toEqual([0]);
		expect(f?.dayOrWeekday).toBe(true);
		expect(parseCron("60 * * * *")).toBeUndefined();
	});
});

describe("nextRun / isDue", () => {
	it("gives the next time after the moment, on the days the rule names", () => {
		// 2026-11-15 is a Sunday.
		const sun = at(2026, 11, 15, 10, 0);
		expect(formatTime(nextRun(parseWhen("每天 08:00") as never, sun) as Date)).toBe("2026-11-16 08:00");
		expect(formatTime(nextRun(parseWhen("每天 10:00") as never, sun) as Date)).toBe("2026-11-16 10:00");
		expect(formatTime(nextRun(parseWhen("每天 10:01") as never, sun) as Date)).toBe("2026-11-15 10:01");
		expect(formatTime(nextRun(parseWhen("工作日 08:30") as never, sun) as Date)).toBe("2026-11-16 08:30");
		expect(formatTime(nextRun(parseWhen("每周五 17:00") as never, sun) as Date)).toBe("2026-11-20 17:00");
		expect(formatTime(nextRun(parseWhen("每月1日 09:00") as never, sun) as Date)).toBe("2026-12-01 09:00");
		expect(formatTime(nextRun(parseWhen("每月31日 09:00") as never, sun) as Date)).toBe("2026-12-31 09:00");
		expect(formatTime(nextRun(parseWhen("0 8 * * 1-5") as never, sun) as Date)).toBe("2026-11-16 08:00");
		expect(formatTime(nextRun(parseWhen("30 */6 * * *") as never, sun) as Date)).toBe("2026-11-15 12:30");
		expect(formatTime(nextRun(parseWhen("0 9 1 1 *") as never, sun) as Date)).toBe("2027-01-01 09:00");
		// A rule that never fires within the horizon.
		expect(nextRun(parseWhen("0 9 31 2 *") as never, sun)).toBeUndefined();
	});

	it("isDue: due once the next time after the last run (or creation) has come", () => {
		const job: Job = {
			id: "a",
			when: "每天 08:00",
			task: "写简报",
			folder: "/w",
			created: at(2026, 11, 15, 7, 0).toISOString(),
		};
		expect(isDue(job, at(2026, 11, 15, 7, 59))).toBe(false);
		expect(isDue(job, at(2026, 11, 15, 8, 0))).toBe(true);
		expect(isDue(job, at(2026, 11, 15, 12, 0))).toBe(true);
		expect(isDue({ ...job, lastRun: at(2026, 11, 15, 8, 0).toISOString() }, at(2026, 11, 15, 12, 0))).toBe(false);
		expect(isDue({ ...job, when: "乱写" }, at(2026, 11, 16, 8, 0))).toBe(false);
	});
});

describe("jobs file / runDue / command line", () => {
	it("saves and loads jobs, with unique ids; an unreadable file is no jobs", () => {
		expect(loadJobs(agentDir)).toEqual([]);
		const jobs: Job[] = [
			{ id: "x1", when: "每天 08:00", task: "写简报", folder: "/w", created: new Date().toISOString() },
		];
		saveJobs(agentDir, jobs);
		expect(loadJobs(agentDir)).toEqual(jobs);
		const id = newJobId(jobs, new Date(1_000_000_000_000));
		expect(id).toMatch(/^[0-9a-z]{6}$/);
		expect(newJobId([{ ...jobs[0], id }], new Date(1_000_000_000_000))).toBe(`${id}-2`);
	});

	it("runs the due jobs with the runner, writes a log, records the run, and skips them next time", async () => {
		const created = at(2026, 11, 15, 7, 0).toISOString();
		saveJobs(agentDir, [
			{ id: "a", when: "每天 08:00", task: "写简报", folder: agentDir, created },
			{ id: "b", when: "每天 20:00", task: "晚上的事", folder: agentDir, created },
		]);
		const calls: { prompt: string; folder: string; env: Record<string, string> }[] = [];
		const runner = async (prompt: string, folder: string, env: Record<string, string>) => {
			calls.push({ prompt, folder, env });
			return { code: 0, stdout: "简报已写好。", stderr: "", timedOut: false };
		};
		const done = await runDue(agentDir, at(2026, 11, 15, 8, 5), runner);
		expect(done.map((d) => [d.job.id, d.status])).toEqual([["a", "ok"]]);
		expect(calls).toEqual([{ prompt: "写简报", folder: agentDir, env: { [SCHEDULE_ENV]: "a" } }]);
		const log = readFileSync(done[0].log, "utf-8");
		expect(log).toContain("# 写简报");
		expect(log).toContain("- 结果：ok");
		expect(log).toContain("简报已写好。");
		expect(done[0].log).toContain(join("schedules", "a", "20261115-0805.md"));
		const after = loadJobs(agentDir);
		expect(after[0].lastResult).toBe("ok");
		expect(new Date(after[0].lastRun ?? "").getTime()).toBe(at(2026, 11, 15, 8, 5).getTime());
		// Nothing due five minutes later; a failed run is recorded as such.
		expect(await runDue(agentDir, at(2026, 11, 15, 8, 10), runner)).toEqual([]);
		const failing = async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });
		const night = await runDue(agentDir, at(2026, 11, 15, 20, 0), failing);
		expect(night.map((d) => [d.job.id, d.status])).toEqual([["b", "failed"]]);
		expect(readFileSync(night[0].log, "utf-8")).toContain("boom");
		// A scheduled child run never runs schedules itself.
		vi.stubEnv(SCHEDULE_ENV, "a");
		expect(await runDue(agentDir, at(2026, 11, 16, 8, 5), runner)).toEqual([]);
	});

	it("jobLines name the rule, the next time and the folder; the command line lists and explains itself", async () => {
		const lines = jobLines(
			[
				{
					id: "a",
					when: "每周一 09:00",
					task: "周报",
					folder: "/w",
					created: at(2026, 11, 15, 7, 0).toISOString(),
					lastResult: "ok",
				},
			],
			at(2026, 11, 15, 10, 0),
		);
		expect(lines).toEqual(["- a：每周一 09:00，下次 2026-11-16 09:00，上次 ok｜周报｜/w"]);
		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((s: string) => {
			logs.push(String(s));
		});
		expect(await runScheduleCommand(["list"], { agentDir })).toBe(0);
		expect(await runScheduleCommand(["run"], { agentDir })).toBe(0);
		expect(await runScheduleCommand([], { agentDir })).toBe(0);
		expect(await runScheduleCommand(["what"], { agentDir })).toBe(1);
		spy.mockRestore();
		expect(logs[0]).toBe("没有定时任务。");
		expect(logs[1]).toBe("没有到点的定时任务。");
		expect(logs[2]).toContain("用法");
	});
});

describe("schedule_task tool", () => {
	/** The tool and the commands, registered on a stand-in API. */
	function tool() {
		const tools = new Map<string, ToolDefinition>();
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		let active: string[] = ["read"];
		const pi = {
			registerTool: (t: ToolDefinition) => tools.set(t.name, t),
			// /schedule opens the schedule toolkit: an active tool set to add to.
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = names;
			},
			registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, c),
			on: () => undefined,
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		writerScheduleExtension(pi, agentDir);
		const ctx = { cwd: agentDir } as unknown as ExtensionToolContext;
		const run = (params: Record<string, unknown>) =>
			tools.get("schedule_task")?.execute("c", params, undefined, undefined, ctx) as Promise<{
				content: { text: string }[];
				isError?: boolean;
				details?: Record<string, unknown>;
			}>;
		return { run, commands };
	}

	it("adds with the cron hint once, lists, removes, and refuses a time it cannot read", async () => {
		const { run, commands } = tool();
		const added = await run({ action: "add", when: "每天 08:00", task: "写一份昨日舆情简报到 简报.md" });
		expect(added.isError).toBeUndefined();
		expect(added.content[0].text).toContain("已添加定时任务");
		expect(added.content[0].text).toContain("每天 08:00");
		expect(added.content[0].text).toContain(cronLine());
		const second = await run({ action: "add", when: "0 9 * * 1", task: "周报", folder: "周报" });
		expect(second.content[0].text).not.toContain("crontab");
		expect(loadJobs(agentDir).map((j) => j.folder)).toEqual([agentDir, join(agentDir, "周报")]);
		const list = await run({ action: "list" });
		expect(list.content[0].text.split("\n")).toHaveLength(2);
		expect(list.content[0].text).toContain("cron 0 9 * * 1");
		const id = loadJobs(agentDir)[0].id;
		expect((await run({ action: "remove", id })).content[0].text).toContain("已删除定时任务");
		expect(loadJobs(agentDir)).toHaveLength(1);
		expect((await run({ action: "remove", id: "zzz" })).isError).toBe(true);
		expect((await run({ action: "add", when: "明天", task: "x" })).content[0].text).toContain("看不懂时间");
		expect((await run({ action: "add", when: "每天 08:00", task: " " })).content[0].text).toContain(
			"add 需要 task 参数",
		);
		// The command lists through the interface.
		const shown: string[] = [];
		await commands.get("schedule")?.handler("", { ui: { notify: (text: string) => shown.push(text) } });
		expect(shown[0]).toContain("周报");
		expect(existsSync(join(agentDir, "schedules.json"))).toBe(true);
	});
});

describe("prepareScheduleArguments", () => {
	it("takes the rule and the task under the names a model gives them, and leaves the rest as it is", () => {
		// eval G10 (2026-11-15): GLM sent add calls without when or task, three times.
		expect(prepareScheduleArguments({ action: "add", time: "每天 08:00", prompt: "统计日志", id: "x" })).toEqual({
			action: "add",
			time: "每天 08:00",
			prompt: "统计日志",
			id: "x",
			when: "每天 08:00",
			task: "统计日志",
		});
		expect(prepareScheduleArguments({ action: "add", when: "0 8 * * *", task: "t" })).toEqual({
			action: "add",
			when: "0 8 * * *",
			task: "t",
		});
		expect(prepareScheduleArguments("x")).toEqual({});
	});
});
