// Unit tests for src/writer/websearch/sf.ts (a fake sf script stands in for search_fetch).

// Temp files for the fake sf.
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API; stubEnv fixes the message language.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Defaults for the configuration.
import { readSearchEnv } from "../../src/writer/websearch/core.ts";
// Functions under test.
import {
	locateSf,
	parseSfFetch,
	parseSfSearch,
	runSf,
	sfCandidates,
	sfChildEnv,
	sfError,
	sfModelOff,
	sfPlatform,
	sfSearchArgs,
	sfStateEnv,
} from "../../src/writer/websearch/sf.ts";

// These cases run fake sf scripts with a shebang line: Linux and macOS only.
const UNIX_ONLY = process.platform === "win32";

// Directory of the fake sf.
let dir = "";
// Fresh directory and Chinese messages.
beforeEach(() => {
	// Real path: macOS temp folders are symlinks (/var → /private/var), and sf reports the real cwd.
	dir = realpathSync(mkdtempSync(join(tmpdir(), "wa-sf-")));
	vi.stubEnv("JW_LANG", "zh");
});
// Clean up.
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** Write an executable node script and return its path. */
function script(body: string): string {
	// Path inside the test directory.
	const p = join(dir, "sf");
	// Shebang to the running node binary.
	writeFileSync(p, `#!${process.execPath}\n${body}\n`);
	chmodSync(p, 0o755);
	return p;
}

describe("sfPlatform / sfCandidates / locateSf", () => {
	it("maps platforms and lists candidates in order without PATH", () => {
		// Known and unknown systems.
		expect(sfPlatform("darwin", "arm64")).toEqual({ os: "macos", arch: "arm64" });
		expect(sfPlatform("linux", "x64")).toEqual({ os: "linux", arch: "amd64" });
		expect(sfPlatform("win32", "arm64")).toEqual({ os: "windows", arch: "arm64" });
		expect([sfPlatform("freebsd", "x64"), sfPlatform("linux", "ia32")]).toEqual([null, null]);
		// JW_SF first, then the release layout, then the agent dir.
		const cfg = readSearchEnv({ JW_SF: "/opt/sf" });
		expect(sfCandidates(cfg, "linux", "arm64", "/app", "/home/u/.jiawriter/agent")).toEqual([
			"/opt/sf",
			join("/app", "search_fetch", "linux", "arm64", "sf"),
			join("/home/u/.jiawriter/agent", "sf", "linux", "arm64", "sf"),
		]);
		// Windows: sf.exe in the windows folders.
		expect(sfCandidates(readSearchEnv({}), "win32", "x64", "/app", "/ag")).toEqual([
			join("/app", "search_fetch", "windows", "amd64", "sf.exe"),
			join("/ag", "sf", "windows", "amd64", "sf.exe"),
		]);
	});
	it("returns the first existing candidate on every system and explains a miss", () => {
		// Configuration without JW_SF.
		const cfg = readSearchEnv({});
		// Second candidate exists.
		const want = join("/a", "sf", "macos", "amd64", "sf");
		expect(locateSf(cfg, "darwin", "x64", "/x", "/a", (p) => p === want)).toBe(want);
		// Windows finds sf.exe; nothing found.
		const exe = join("/x", "search_fetch", "windows", "arm64", "sf.exe");
		expect(locateSf(cfg, "win32", "arm64", "/x", "/a", (p) => p === exe)).toBe(exe);
		expect(() => locateSf(cfg, "linux", "x64", "/x", "/a", () => false)).toThrow("找不到 search_fetch");
	});
});

describe("sfModelOff / sfStateEnv / sfChildEnv", () => {
	it("keeps sf's state under the agent folder and points it at JiaWriter's browser host", () => {
		// PyApp runtime, caches and search_fetch's home.
		const state = {
			PYAPP_INSTALL_DIR_SEARCH_FETCH: join("/a", "sf", "runtime", "install"),
			PYAPP_CACHE_DIR: join("/a", "sf", "runtime", "cache"),
			SEARCH_FETCH_HOME: join("/a", "sf", "home"),
			PYTHONUTF8: "1",
		};
		// Linux and macOS: the host's socket.
		expect(sfStateEnv("/a", "linux")).toEqual({
			...state,
			SEARCH_FETCH_BRIDGE_SOCKET: join("/a", "browser", "bridge.sock"),
		});
		// Windows: the port file the host writes (port and token).
		expect(sfStateEnv("/a", "win32")).toEqual({
			...state,
			SEARCH_FETCH_BRIDGE_FILE: join("/a", "browser", "bridge.json"),
		});
	});
	it("clears every driver-model variable, even ones the user set, and lets the parent choose the folders", () => {
		// The four names, empty.
		expect(sfModelOff()).toEqual({ SF_URL: "", SF_KEY: "", SF_MODEL: "", SF_API: "" });
		// A parent key never reaches sf; print mode disables human waits.
		expect(sfChildEnv({ A: "1", SF_KEY: "sk-user", JW_KEY: "w" }, false, "/a")).toEqual({
			...sfStateEnv("/a"),
			A: "1",
			JW_KEY: "w",
			...sfModelOff(),
			SEARCH_FETCH_NO_HUMAN: "1",
			SEARCH_FETCH_ALLOW_PRIVATE: "1",
		});
		// Windows children get the port file.
		expect(sfChildEnv({}, true, "/a", "win32").SEARCH_FETCH_BRIDGE_FILE).toBe(join("/a", "browser", "bridge.json"));
		// Interactive; the parent's SEARCH_FETCH_HOME wins.
		expect(sfChildEnv({ A: "1", SEARCH_FETCH_HOME: "/mine" }, true, "/a")).toEqual({
			SEARCH_FETCH_ALLOW_PRIVATE: "1",
			...sfStateEnv("/a"),
			A: "1",
			SEARCH_FETCH_HOME: "/mine",
			...sfModelOff(),
		});
	});
});

describe.skipIf(UNIX_ONLY)("runSf / sfError", () => {
	it("passes arguments and environment without a shell", async () => {
		// Echo argv and two variables.
		const bin = script(
			"console.log(JSON.stringify({argv: process.argv.slice(2), api: process.env.SF_API, cwd: process.cwd()}))",
		);
		const run = await runSf(bin, ["search", "--", "-x; rm -rf ~"], {
			cwd: dir,
			env: { SF_API: "anthropic-messages" },
			timeoutMs: 10_000,
		});
		// Exit code and output.
		expect(run.code).toBe(0);
		expect(JSON.parse(run.stdout)).toEqual({
			argv: ["search", "--", "-x; rm -rf ~"],
			api: "anthropic-messages",
			cwd: dir,
		});
	});
	it("reports sf's failed line, a timeout and a spawn error", async () => {
		// Failure with sf's own message.
		const bin = script(
			'console.error("[search_fetch] note\\n[search_fetch] failed: blocked by captcha"); process.exit(3)',
		);
		const run = await runSf(bin, [], { cwd: dir, env: {}, timeoutMs: 10_000 });
		expect(sfError(run, 10_000).message).toBe("sf 运行失败（退出码 3）：failed: blocked by captcha");
		// Timeout.
		const slow = script("setTimeout(() => {}, 60_000)");
		const late = await runSf(slow, [], { cwd: dir, env: {}, timeoutMs: 200 });
		expect(late.timedOut).toBe(true);
		expect(sfError(late, 200_000).message).toBe("sf 运行超时（200 秒）。");
		// Missing binary.
		await expect(runSf(join(dir, "nope"), [], { cwd: dir, env: {}, timeoutMs: 1000 })).rejects.toThrow();
	});
	it("stops the child when the caller aborts", async () => {
		// Long-running child, aborted after 100 ms.
		const slow = script("setTimeout(() => {}, 60_000)");
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const run = await runSf(slow, [], { cwd: dir, env: {}, timeoutMs: 30_000, signal: ac.signal });
		// Killed by the signal, not the timeout.
		expect([run.code, run.timedOut]).toEqual([null, false]);
	});
});

describe("sfSearchArgs / parseSfSearch / parseSfFetch", () => {
	it("builds search arguments with the query after the separator", () => {
		// Plain and with options.
		expect(sfSearchArgs("q", {})).toEqual(["search", "--json", "--pages=1", "--", "q"]);
		expect(sfSearchArgs("--help", { fresh: "day", language: "zh-CN" })).toEqual([
			"search",
			"--json",
			"--pages=1",
			"--fresh=day",
			"--lang=zh-CN",
			"--",
			"--help",
		]);
	});
	it("parses the JSON contracts of search and fetch", () => {
		// Two blocks of links.
		const out = parseSfSearch(
			JSON.stringify({
				query: "q",
				blocks: [{ results: [{ u: "https://a.example/", t: "A" }] }, { results: [{ u: "https://b.example/" }] }],
			}),
		);
		expect(out).toEqual([
			{ title: "A", url: "https://a.example/", snippet: "", date: "" },
			{ title: "", url: "https://b.example/", snippet: "", date: "" },
		]);
		// Page with sf's date line; final URL falls back to the request.
		expect(
			parseSfFetch(
				JSON.stringify({ final_url: "https://a.example/p", markdown: "（发布时间：2026-10-30）\n正文" }),
				"u",
			),
		).toEqual({
			url: "https://a.example/p",
			title: "",
			content: "（发布时间：2026-10-30）\n正文",
			date: "2026-10-30",
		});
		expect(parseSfFetch("{}", "https://c.example/").url).toBe("https://c.example/");
		// No date in the text: the final URL's path date.
		expect(
			parseSfFetch(JSON.stringify({ final_url: "https://r.example/x-2026-11-01/", markdown: "正文" }), "u").date,
		).toBe("2026-11-01");
	});
});
