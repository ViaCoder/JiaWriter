/**
 * Background commands, as in Claude Code (2026-11-09: "also ctrl+b etc for background"). A command the user sends to
 * the background with Ctrl+B, or one the model starts with run_in_background, keeps running while the conversation
 * goes on; its output goes to a file, and the end of the file says how it ended. /tasks lists them and stops one.
 */

// Output files.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One command in the background. */
export interface BackgroundTask {
	// Its number in this program, from 1.
	id: number;
	// The command as given.
	command: string;
	// Where its output goes.
	outputFile: string;
	// When it started (ms).
	startedAt: number;
	// When it ended (ms), and how; undefined while it runs.
	endedAt?: number;
	exitCode?: number;
	// Whether the model was told it ended.
	told: boolean;
	// Stops it (kills its process tree).
	stop: () => void;
}

/** A command running in the foreground that Ctrl+B can send to the background. */
interface Foreground {
	// Moves it to the background; returns its task.
	toBackground: () => BackgroundTask;
}

// The tasks of this program, in order.
const tasks: BackgroundTask[] = [];
// The commands running in the foreground now.
const foreground = new Set<Foreground>();
// Who hears when a task ends (the interface).
const listeners = new Set<(task: BackgroundTask) => void>();

/** The folder of the output files. */
export function backgroundDir(): string {
	return join(tmpdir(), "jiawriter-tasks");
}

/** A new task with its output file holding what the command printed so far. */
export function addBackgroundTask(command: string, outputSoFar: string, stop: () => void): BackgroundTask {
	const id = tasks.length + 1;
	mkdirSync(backgroundDir(), { recursive: true });
	const outputFile = join(backgroundDir(), `task-${process.pid}-${id}.log`);
	writeFileSync(outputFile, outputSoFar);
	const task: BackgroundTask = { id, command, outputFile, startedAt: Date.now(), told: false, stop };
	tasks.push(task);
	return task;
}

/** More output of a task. */
export function appendTaskOutput(task: BackgroundTask, text: string): void {
	appendFileSync(task.outputFile, text);
}

/** A task ended: its exit line goes at the end of the file, and the listeners hear of it. */
export function endTask(task: BackgroundTask, exitCode: number): void {
	if (task.endedAt !== undefined) return;
	task.endedAt = Date.now();
	task.exitCode = exitCode;
	appendTaskOutput(task, `\n[exit code ${exitCode}]\n`);
	for (const listener of listeners) listener(task);
}

/** All tasks of this program. */
export function backgroundTasks(): readonly BackgroundTask[] {
	return tasks;
}

/** The tasks still running. */
export function runningTasks(): BackgroundTask[] {
	return tasks.filter((task) => task.endedAt === undefined);
}

/** Stop a running task; false when it is not running. */
export function stopTask(id: number): boolean {
	const task = tasks.find((t) => t.id === id);
	if (!task || task.endedAt !== undefined) return false;
	task.stop();
	return true;
}

/** Hear when a task ends; returns the way to stop hearing. */
export function onTaskEnd(listener: (task: BackgroundTask) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The ended tasks the model was not told of yet, marked as told. */
export function takeUntoldEnded(): BackgroundTask[] {
	const ended = tasks.filter((task) => task.endedAt !== undefined && !task.told);
	for (const task of ended) task.told = true;
	return ended;
}

/** Register a foreground command for Ctrl+B; returns the way to take it off again. */
export function registerForeground(entry: Foreground): () => void {
	foreground.add(entry);
	return () => foreground.delete(entry);
}

/** Ctrl+B: every command running in the foreground goes to the background; returns their tasks. */
export function backgroundAll(): BackgroundTask[] {
	const moved = [...foreground].map((entry) => entry.toBackground());
	foreground.clear();
	return moved;
}

/** Forget every task (tests). */
export function resetBackground(): void {
	tasks.length = 0;
	foreground.clear();
	listeners.clear();
}
