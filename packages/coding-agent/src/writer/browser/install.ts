/**
 * Registration of the native messaging host with Chrome, and starting Chrome.
 *
 * Chrome finds a host by its manifest: a JSON file in the NativeMessagingHosts folder of the
 * browser's profile root (Linux, macOS), or a file named by a registry value under
 * HKCU\Software\Google\Chrome\NativeMessagingHosts (Windows). The manifest names the program
 * to start (this writeragent executable) and the one extension allowed to start it.
 */

// Running reg.exe and starting Chrome (no shell).
import { spawn, spawnSync } from "node:child_process";
// Files.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// Paths.
import { join } from "node:path";
// Host name and extension id.
import { EXTENSION_ID, HOST_NAME } from "./bridge.ts";

/** The manifest Chrome reads to start the host. */
export function hostManifest(programPath: string): string {
	// Fixed fields; only our extension may connect.
	const manifest = {
		name: HOST_NAME,
		description: "WriterAgent browser host",
		path: programPath,
		type: "stdio",
		allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
	};
	// Pretty JSON with a final newline.
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Chrome's NativeMessagingHosts folder on Linux and macOS (Chrome only: the user does not use Chromium). */
export function manifestDir(platform: NodeJS.Platform, home: string): string {
	// Chrome's profile root per system; written even before Chrome is installed, so a later install finds the host.
	const root =
		platform === "darwin"
			? join(home, "Library/Application Support/Google/Chrome")
			: join(home, ".config/google-chrome");
	return join(root, "NativeMessagingHosts");
}

/** The registry key that points Chrome on Windows at the manifest file. */
export const WINDOWS_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;

/** reg.exe arguments that set the key's default value to the manifest path. */
export function registryArgs(manifestPath: string): string[] {
	// add <key> /ve /t REG_SZ /d <path> /f
	return ["add", WINDOWS_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"];
}

/** Launcher for source checkouts: the host is node running this CLI (a binary needs none). */
export function launcherScript(platform: NodeJS.Platform, node: string, cli: string): string {
	// Windows batch file or POSIX shell script, passing Chrome's arguments on.
	return platform === "win32" ? `@echo off\r\n"${node}" "${cli}" %*\r\n` : `#!/bin/sh\nexec "${node}" "${cli}" "$@"\n`;
}

/** Write text when it differs from the file's content; true when something was written. */
function writeIfChanged(path: string, text: string, mode: number): boolean {
	// Same content: nothing to do.
	if (existsSync(path) && readFileSync(path, "utf-8") === text) return false;
	// Atomic replace.
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode });
	chmodSync(tmp, mode);
	renameSync(tmp, path);
	return true;
}

/** Inputs of ensureHost. */
export interface EnsureHostOptions {
	// Operating system.
	platform: NodeJS.Platform;
	// User's home folder.
	home: string;
	// ~/.writeragent/agent.
	agentDir: string;
	// The writeragent executable (release binary), or node plus the CLI script (source checkout).
	program: { binary: string } | { node: string; cli: string };
	// Runs reg.exe (tests replace it); returns the exit status.
	runReg?: (args: string[]) => number;
}

/** Register the host with Chrome; returns the files written (empty when all were current). */
export function ensureHost(opts: EnsureHostOptions): string[] {
	// Default for the registry side effect.
	const runReg =
		opts.runReg ?? ((args: string[]) => spawnSync("reg", args, { stdio: "ignore", windowsHide: true }).status ?? 1);
	// Private folder for the launcher and the Windows manifest.
	const dir = join(opts.agentDir, "browser");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Files written.
	const written: string[] = [];
	// The program Chrome starts.
	let programPath: string;
	if ("binary" in opts.program) programPath = opts.program.binary;
	else {
		programPath = join(dir, opts.platform === "win32" ? "host.cmd" : "host.sh");
		if (writeIfChanged(programPath, launcherScript(opts.platform, opts.program.node, opts.program.cli), 0o700))
			written.push(programPath);
	}
	// The manifest.
	const manifest = hostManifest(programPath);
	if (opts.platform === "win32") {
		// One file, named by the registry value.
		const file = join(dir, `${HOST_NAME}.json`);
		const changed = writeIfChanged(file, manifest, 0o600);
		if (changed) written.push(file);
		// Set the key when the file is new or changed, or the key is missing.
		const missing = runReg(["query", WINDOWS_KEY, "/ve"]) !== 0;
		if (changed || missing) {
			if (runReg(registryArgs(file)) !== 0) throw new Error(`reg add ${WINDOWS_KEY} failed`);
			written.push(WINDOWS_KEY);
		}
	} else {
		// Chrome's folder.
		const d = manifestDir(opts.platform, opts.home);
		mkdirSync(d, { recursive: true });
		const file = join(d, `${HOST_NAME}.json`);
		if (writeIfChanged(file, manifest, 0o644)) written.push(file);
	}
	// What changed.
	return written;
}

/** Commands that start Chrome on this system, most likely first (each: program and arguments). */
export function chromeCommands(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	exists: (p: string) => boolean,
): { cmd: string; args: string[] }[] {
	// macOS: the app by name.
	if (platform === "darwin") return [{ cmd: "open", args: ["-a", "Google Chrome"] }];
	// Windows: the usual install folders.
	if (platform === "win32") {
		const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
		return roots
			.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe"))
			.filter(exists)
			.map((cmd) => ({ cmd, args: [] }));
	}
	// Linux: Chrome's usual program paths.
	return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"]
		.filter(exists)
		.map((cmd) => ({ cmd, args: [] }));
}

/** Start Chrome in the background (no window of ours, not waited for); false when none was found. */
export function startChrome(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
	// First known command.
	const c = chromeCommands(platform, env, existsSync)[0];
	if (!c) return false;
	// Detached, silent.
	const child = spawn(c.cmd, c.args, { detached: true, stdio: "ignore", windowsHide: false });
	child.on("error", () => {});
	child.unref();
	return true;
}
