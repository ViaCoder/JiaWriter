/**
 * A run of this program as a child process, in non-interactive mode, for work that needs a context of its own: a
 * delegated subtask (the delegate tool) or a scheduled task (schedule). The child inherits the environment, so it
 * uses the same model and keys; its final reply is what print mode writes to stdout.
 */

// Child processes.
import { spawn } from "node:child_process";
// Whether this is the compiled binary.
import { isBunBinary } from "../config.ts";
// The keys this process took out of its environment: the child is the same program and needs them.
import { withSecrets } from "./secrets.ts";

/** Most output kept from a child, in characters. */
export const MAX_CHILD_OUTPUT = 200_000;

/** Environment variable that overrides the command of a child run (a JSON array), for tests. */
export const SELF_COMMAND_ENV = "JW_SELF_COMMAND";

/** The command that starts this program again: the binary, or node with the same entry script. */
export function selfCommand(env: NodeJS.ProcessEnv = process.env): string[] {
	const given = env[SELF_COMMAND_ENV];
	if (given) {
		try {
			const parsed = JSON.parse(given) as unknown;
			if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string") && parsed.length > 0) return parsed;
		} catch {
			// Not JSON: ignored.
		}
	}
	if (isBunBinary) return [process.execPath];
	return [process.execPath, ...process.execArgv, process.argv[1] ?? ""];
}

/** What a child run ended with. */
export interface ChildResult {
	// Exit code; null when killed.
	code: number | null;
	// What it printed: the final reply in print mode.
	stdout: string;
	stderr: string;
	// Whether the time ran out.
	timedOut: boolean;
}

/** Run the prompt in a child process in the folder, with extra environment, for at most timeoutMs. */
export function runChild(
	prompt: string,
	folder: string,
	extraEnv: Record<string, string>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ChildResult> {
	const [cmd, ...head] = selfCommand();
	return new Promise((resolve) => {
		const child = spawn(cmd, [...head, "-p", prompt], {
			cwd: folder,
			// Keys go back in for the child (it takes them out of its own environment again at start).
			env: withSecrets({ ...process.env, ...extraEnv }),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const keep = (have: string, chunk: Buffer) =>
			have.length < MAX_CHILD_OUTPUT ? have + chunk.toString("utf-8") : have;
		child.stdout?.on("data", (c: Buffer) => {
			stdout = keep(stdout, c);
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr = keep(stderr, c);
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		}, timeoutMs);
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}
