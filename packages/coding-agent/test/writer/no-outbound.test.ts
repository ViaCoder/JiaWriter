// Functional test: JiaWriter opens no network connection on its own.
// The CLI runs from source with a preload that records every socket connect and DNS lookup.

// Start child processes.
import { spawn } from "node:child_process";
// Temp directories and the record file.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
// Local TCP server for the positive control.
import { createServer } from "node:net";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join, resolve } from "node:path";
// --import needs file:// URLs.
import { pathToFileURL } from "node:url";
// Test API.
import { afterEach, describe, expect, it } from "vitest";
// Built-in slash commands (unit check that /share and /bug are gone).
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";

// CLI entry point in the source tree.
const cliPath = resolve(__dirname, "../../src/cli.ts");
// Loader that lets Node run the TypeScript sources.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../../src/experimental/source-resolver.ts")).href;
// Preload that records connection attempts.
const recorderUrl = pathToFileURL(resolve(__dirname, "fixtures/net-recorder.mjs")).href;

// Directories created by a test, removed afterwards.
const tempDirs: string[] = [];
// Clean up after every test.
afterEach(() => {
	// Remove each temp directory.
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Record of one connection attempt written by the recorder. */
interface NetRecord {
	// "connect" or "dns".
	kind: string;
	// host:port, socket path or host name.
	target: string;
}

/** Run a node command with the recorder; resolve with exit code and records. */
function runRecorded(args: string[], killAfterMs?: number): Promise<{ code: number | null; records: NetRecord[] }> {
	// Long-running modes (killAfterMs) keep stdin open; others get no stdin so -p does not wait for piped input.
	const stdin = killAfterMs ? "pipe" : "ignore";
	// Fresh directory for config, sessions and the record file.
	const dir = mkdtempSync(join(tmpdir(), "wa-no-outbound-"));
	// Remember it for cleanup.
	tempDirs.push(dir);
	// File the recorder appends to.
	const logFile = join(dir, "net.jsonl");
	// Copy the environment without proxy and offline overrides, so nothing hides an attempt.
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Remove variables that could change networking behaviour.
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"PI_OFFLINE",
		"PI_TELEMETRY",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"http_proxy",
		"https_proxy",
	])
		delete env[key];
	// Isolated config directory and the record file.
	Object.assign(env, { JW_DIR: join(dir, "agent"), JW_NET_LOG: logFile });
	// Wrap the asynchronous child process in a promise.
	return new Promise((resolvePromise, reject) => {
		// Recorder first, then the source loader, then the actual arguments.
		const child = spawn(process.execPath, ["--import", recorderUrl, ...args], {
			cwd: dir,
			env,
			stdio: [stdin, "ignore", "ignore"],
		});
		// Optional: stop a long-running mode after a fixed idle time.
		const timer = killAfterMs ? setTimeout(() => child.kill("SIGTERM"), killAfterMs) : undefined;
		// Propagate spawn failures.
		child.on("error", reject);
		// Collect the records once the process has exited.
		child.on("close", (code) => {
			// Stop the idle timer if it is still pending.
			if (timer) clearTimeout(timer);
			// Parse one JSON object per line; no file means no attempt.
			const records = existsSync(logFile)
				? readFileSync(logFile, "utf-8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as NetRecord)
				: [];
			// Hand back the result.
			resolvePromise({ code, records });
		});
	});
}

describe("JiaWriter makes no outbound connections by itself", () => {
	it("records a connection in the positive control", async () => {
		// Local server so the control never leaves the machine.
		const server = createServer((socket) => socket.destroy());
		// Listen on a random free port.
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		// Port chosen by the OS.
		const port = (server.address() as { port: number }).port;
		try {
			// A child that connects to the local server and closes at once.
			const { records } = await runRecorded([
				"-e",
				`const s=require("net").connect(${port},"127.0.0.1",()=>s.destroy());`,
			]);
			// The recorder saw exactly that destination.
			expect(records).toContainEqual({ kind: "connect", target: `127.0.0.1:${port}` });
		} finally {
			// Stop the server.
			server.close();
		}
	});

	it("opens no connection for --version", async () => {
		// Print the version and exit.
		const { code, records } = await runRecorded(["--import", sourceResolverUrl, cliPath, "--version"]);
		// The command succeeds.
		expect(code).toBe(0);
		// No connection or lookup happened.
		expect(records).toEqual([]);
	}, 60_000);

	it("opens no connection for -p without a configured model", async () => {
		// Print mode with no model: fails locally before any request.
		const { code, records } = await runRecorded(["--import", sourceResolverUrl, cliPath, "-p", "hello"]);
		// It exits with an error.
		expect(code).not.toBe(0);
		// Still no connection.
		expect(records).toEqual([]);
	}, 60_000);

	it("opens no connection while idle in rpc mode", async () => {
		// RPC mode waits for commands on stdin; stop it after 2 seconds idle.
		const { records } = await runRecorded(["--import", sourceResolverUrl, cliPath, "--mode", "rpc"], 2_000);
		// Nothing was contacted during startup and idling.
		expect(records).toEqual([]);
	}, 60_000);
});

describe("built-in slash commands", () => {
	it("no longer offer /share or /bug", () => {
		// Names of all built-in commands.
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		// Session upload and bug reports to upstream are removed.
		expect(names).not.toContain("share");
		expect(names).not.toContain("bug");
	});
});
