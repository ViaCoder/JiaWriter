// Commands in the background (src/writer/background.ts, the bash tool, writer-tasks), as in Claude Code
// (2026-11-09: "also ctrl+b etc for background").
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import writerTasksExtension, { endedNote, taskLine } from "../../src/extensions/writer-tasks/index.ts";
import {
	addBackgroundTask,
	appendTaskOutput,
	backgroundAll,
	backgroundDir,
	backgroundTasks,
	endTask,
	onTaskEnd,
	registerForeground,
	resetBackground,
	runningTasks,
	stopTask,
	takeUntoldEnded,
} from "../../src/writer/background.ts";
import { setUiLang } from "../../src/writer/i18n/index.ts";

afterEach(() => {
	// The output files go with their tasks.
	for (const task of backgroundTasks()) if (existsSync(task.outputFile)) rmSync(task.outputFile);
	resetBackground();
});

/** Wait until ready() or the time is up. */
async function until(ready: () => boolean, ms = 8000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return ready();
}

describe("the task registry", () => {
	it("backgroundDir: a folder in the temporary directory", () => {
		expect(backgroundDir().startsWith(tmpdir())).toBe(true);
	});

	it("addBackgroundTask / appendTaskOutput / endTask: the file holds the output and ends with the exit line", () => {
		const heard: number[] = [];
		const stopHearing = onTaskEnd((task) => heard.push(task.id));
		const task = addBackgroundTask("make", "so far\n", () => {});
		appendTaskOutput(task, "more\n");
		expect(runningTasks()).toEqual([task]);
		endTask(task, 0);
		endTask(task, 1);
		expect(readFileSync(task.outputFile, "utf-8")).toBe("so far\nmore\n\n[exit code 0]\n");
		expect(task.exitCode).toBe(0);
		expect(heard).toEqual([1]);
		stopHearing();
		rmSync(task.outputFile);
	});

	it("backgroundTasks / runningTasks: all of them, and the ones still running", () => {
		const a = addBackgroundTask("a", "", () => {});
		const b = addBackgroundTask("b", "", () => {});
		endTask(a, 0);
		expect(backgroundTasks().map((t) => t.id)).toEqual([1, 2]);
		expect(runningTasks()).toEqual([b]);
	});

	it("stopTask: stops a running task only", () => {
		let stopped = 0;
		const task = addBackgroundTask("a", "", () => stopped++);
		expect(stopTask(task.id)).toBe(true);
		endTask(task, 130);
		expect(stopTask(task.id)).toBe(false);
		expect(stopTask(99)).toBe(false);
		expect(stopped).toBe(1);
	});

	it("onTaskEnd: hears each end until stopped", () => {
		const heard: number[] = [];
		const stop = onTaskEnd((t) => heard.push(t.id));
		endTask(
			addBackgroundTask("a", "", () => {}),
			0,
		);
		stop();
		endTask(
			addBackgroundTask("b", "", () => {}),
			0,
		);
		expect(heard).toEqual([1]);
	});

	it("takeUntoldEnded: each ended task once", () => {
		const a = addBackgroundTask("a", "", () => {});
		addBackgroundTask("b", "", () => {});
		endTask(a, 2);
		expect(takeUntoldEnded().map((t) => t.id)).toEqual([1]);
		expect(takeUntoldEnded()).toEqual([]);
	});

	it("registerForeground / backgroundAll: Ctrl+B moves what runs, once", () => {
		let moves = 0;
		const unregister = registerForeground({
			toBackground: () => {
				moves++;
				return addBackgroundTask("x", "", () => {});
			},
		});
		expect(backgroundAll().map((t) => t.id)).toEqual([1]);
		expect(backgroundAll()).toEqual([]);
		unregister();
		expect(moves).toBe(1);
	});

	it("resetBackground: forgets every task", () => {
		addBackgroundTask("a", "", () => {});
		resetBackground();
		expect(backgroundTasks()).toEqual([]);
	});
});

describe("bash in the background", () => {
	const cwd = mkdtempSync(join(tmpdir(), "jw-bg-"));
	const tool = createBashToolDefinition(cwd);
	const text = (result: { content: { type: string; text?: string }[] }) =>
		result.content.map((c) => c.text ?? "").join("");

	it("run_in_background: the call returns at once and the command goes on to its end", async () => {
		const started = Date.now();
		const result = await tool.execute(
			"c1",
			{ command: "echo first; sleep 1; echo last", run_in_background: true },
			undefined,
			undefined,
			undefined as never,
		);
		expect(Date.now() - started).toBeLessThan(900);
		expect(text(result)).toContain("Started in the background as task 1");
		const [task] = backgroundTasks();
		expect(await until(() => task.endedAt !== undefined)).toBe(true);
		const output = readFileSync(task.outputFile, "utf-8");
		expect(output).toContain("first");
		expect(output).toContain("last");
		expect(output.trimEnd().endsWith("[exit code 0]")).toBe(true);
	});

	it("Ctrl+B while it runs: the call returns, Esc no longer stops it, and its output keeps coming", async () => {
		const controller = new AbortController();
		const call = tool.execute(
			"c2",
			{ command: "echo before; sleep 1; echo after" },
			controller.signal,
			undefined,
			undefined as never,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const moved = backgroundAll();
		expect(moved).toHaveLength(1);
		const result = await call;
		expect(text(result)).toContain("Moved to the background by the user as task");
		// Esc after Ctrl+B: the command is not the call's any more.
		controller.abort();
		const [task] = moved;
		expect(await until(() => task.endedAt !== undefined)).toBe(true);
		const output = readFileSync(task.outputFile, "utf-8");
		expect(output).toContain("before");
		expect(output).toContain("after");
		expect(task.exitCode).toBe(0);
	});

	it("a command in the foreground still stops with Esc, and Ctrl+B after it ends moves nothing", async () => {
		const controller = new AbortController();
		const call = tool.execute("c3", { command: "sleep 5" }, controller.signal, undefined, undefined as never);
		await new Promise((resolve) => setTimeout(resolve, 200));
		controller.abort();
		await expect(call).rejects.toThrow(/aborted/);
		expect(backgroundAll()).toEqual([]);
	});

	it("stopTask stops a command in the background", async () => {
		await tool.execute(
			"c4",
			{ command: "sleep 30", run_in_background: true },
			undefined,
			undefined,
			undefined as never,
		);
		const [task] = backgroundTasks();
		expect(stopTask(task.id)).toBe(true);
		expect(await until(() => task.endedAt !== undefined)).toBe(true);
		expect(task.exitCode).toBe(130);
		rmSync(cwd, { recursive: true, force: true });
	});
});

describe("writer-tasks", () => {
	/** The extension on a fake API. */
	function load() {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
		writerTasksExtension({
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
				handlers[name] = fn;
			},
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands[name] = options;
			},
		} as unknown as ExtensionAPI);
		return { handlers, commands };
	}

	it("taskLine: number, state, time and command", () => {
		setUiLang("zh");
		const task = addBackgroundTask("npm run build", "", () => {});
		expect(taskLine(task, task.startedAt + 3000)).toBe("任务 1｜运行中｜3 秒｜npm run build");
		endTask(task, 0);
		expect(taskLine(task)).toContain("已结束（退出码 0）");
	});

	it("endedNote: names the task, its exit code and its file", () => {
		const task = addBackgroundTask("make", "", () => {});
		endTask(task, 2);
		expect(endedNote([task])).toContain(
			`Background task 1 (make) ended with exit code 2; its output is in ${task.outputFile}`,
		);
	});

	it("the model is told of an ended task once, with its next request; the screen at once", async () => {
		const { handlers } = load();
		const notes: string[] = [];
		handlers.session_start({}, { hasUI: true, ui: { notify: (m: string) => notes.push(m) } });
		const task = addBackgroundTask("make", "", () => {});
		endTask(task, 0);
		expect(notes[0]).toContain("后台任务 1 已结束");
		const first = (await handlers.before_agent_start({}, {})) as { message: { content: string; display: boolean } };
		expect(first.message.content).toContain("Background task 1");
		expect(first.message.display).toBe(false);
		expect(await handlers.before_agent_start({}, {})).toBeUndefined();
	});

	it("/tasks: lists the tasks, and stops the running one picked", async () => {
		const { commands } = load();
		let stopped = false;
		addBackgroundTask("sleep 30", "", () => {
			stopped = true;
		});
		const notes: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				notify: (m: string) => notes.push(m),
				select: async (_title: string, options: string[]) => options[0],
			},
		};
		await commands.tasks.handler("", ctx);
		expect(stopped).toBe(true);
		expect(notes).toContain("已停止任务 1");
		// With none: how to make one.
		for (const task of backgroundTasks()) rmSync(task.outputFile, { force: true });
		resetBackground();
		await commands.tasks.handler("", ctx);
		expect(notes.at(-1)).toContain("Ctrl+B");
	});
});
