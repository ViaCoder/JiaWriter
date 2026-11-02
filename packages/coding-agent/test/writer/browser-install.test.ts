// Unit tests for src/writer/browser/install.ts: the host manifest, Chrome's host folders, the Windows
// registry command, the source-checkout launcher, ensureHost on a temp home, and Chrome's start commands.

// Temp folders.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Host name and id.
import { EXTENSION_ID, HOST_NAME } from "../../src/writer/browser/bridge.ts";
// Module under test.
import {
	chromeCommands,
	ensureHost,
	hostManifest,
	launcherScript,
	manifestDir,
	registryArgs,
	startChrome,
	WINDOWS_KEY,
} from "../../src/writer/browser/install.ts";

// Scratch folder.
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wai-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("hostManifest", () => {
	it("names the program and allows only the WriterAgent extension", () => {
		expect(JSON.parse(hostManifest("/opt/wa/writeragent"))).toEqual({
			name: HOST_NAME,
			description: "WriterAgent browser host",
			path: "/opt/wa/writeragent",
			type: "stdio",
			allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
		});
	});
});

describe("manifestDir", () => {
	it("is Chrome's folder on Linux and macOS", () => {
		expect(manifestDir("linux", "/h")).toBe(join("/h", ".config/google-chrome", "NativeMessagingHosts"));
		expect(manifestDir("darwin", "/h")).toBe(
			join("/h", "Library/Application Support/Google/Chrome", "NativeMessagingHosts"),
		);
	});
});

describe("registryArgs / launcherScript", () => {
	it("sets the key's default value, and launches node with the CLI", () => {
		expect(registryArgs("C:\\w\\m.json")).toEqual([
			"add",
			WINDOWS_KEY,
			"/ve",
			"/t",
			"REG_SZ",
			"/d",
			"C:\\w\\m.json",
			"/f",
		]);
		expect(launcherScript("linux", "/n/node", "/r/cli.js")).toBe('#!/bin/sh\nexec "/n/node" "/r/cli.js" "$@"\n');
		expect(launcherScript("win32", "C:\\n.exe", "C:\\cli.js")).toBe('@echo off\r\n"C:\\n.exe" "C:\\cli.js" %*\r\n');
	});
});

describe("ensureHost", () => {
	it("writes Chrome's manifest once on Linux, and a launcher for a source checkout", () => {
		const opts = {
			platform: "linux" as const,
			home: join(dir, "h"),
			agentDir: join(dir, "a"),
			program: { binary: "/x/writeragent" },
		};
		const first = ensureHost(opts);
		const file = join(dir, "h", ".config/google-chrome/NativeMessagingHosts", `${HOST_NAME}.json`);
		expect(first).toEqual([file]);
		expect(JSON.parse(readFileSync(file, "utf-8")).path).toBe("/x/writeragent");
		// Unchanged: nothing written.
		expect(ensureHost(opts)).toEqual([]);
		// Source checkout: launcher (owner-only, executable) plus the manifest pointing at it.
		const src = ensureHost({ ...opts, program: { node: "/n/node", cli: "/r/cli.js" } });
		const launcher = join(dir, "a", "browser", "host.sh");
		expect(src).toEqual([launcher, file]);
		if (process.platform !== "win32") expect(statSync(launcher).mode & 0o777).toBe(0o700);
	});

	it("writes the manifest file and the registry key on Windows only when needed", () => {
		const calls: string[][] = [];
		let keyPresent = false;
		const runReg = (args: string[]) => {
			calls.push(args);
			if (args[0] === "add") keyPresent = true;
			return args[0] === "query" && !keyPresent ? 1 : 0;
		};
		const opts = {
			platform: "win32" as const,
			home: dir,
			agentDir: join(dir, "a"),
			program: { binary: "C:\\wa\\writeragent.exe" },
			runReg,
		};
		const file = join(dir, "a", "browser", `${HOST_NAME}.json`);
		expect(ensureHost(opts)).toEqual([file, WINDOWS_KEY]);
		expect(calls.map((c) => c[0])).toEqual(["query", "add"]);
		// Current file and key: only the query.
		expect(ensureHost(opts)).toEqual([]);
		expect(calls.map((c) => c[0])).toEqual(["query", "add", "query"]);
		// A failing reg add is an error.
		keyPresent = false;
		expect(() => ensureHost({ ...opts, runReg: (a) => (a[0] === "add" ? 1 : 1) })).toThrow(/reg add/);
	});
});

describe("chromeCommands", () => {
	it("opens the app on macOS, and finds installed programs on Windows and Linux", () => {
		expect(chromeCommands("darwin", {}, () => false)).toEqual([{ cmd: "open", args: ["-a", "Google Chrome"] }]);
		const win = chromeCommands("win32", { ProgramFiles: "C:\\PF", LOCALAPPDATA: "C:\\L" }, (p) =>
			p.startsWith("C:\\L"),
		);
		expect(win).toEqual([{ cmd: join("C:\\L", "Google", "Chrome", "Application", "chrome.exe"), args: [] }]);
		expect(chromeCommands("linux", {}, (p) => p === "/opt/google/chrome/chrome")).toEqual([
			{ cmd: "/opt/google/chrome/chrome", args: [] },
		]);
		expect(chromeCommands("linux", {}, () => false)).toEqual([]);
	});
});

describe("startChrome", () => {
	it("reports false and starts nothing when no Chrome is installed where it looks", () => {
		// Windows with no install folders in the environment, so no program path exists.
		expect(startChrome("win32", {})).toBe(false);
	});
});
