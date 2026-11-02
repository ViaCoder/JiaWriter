/**
 * search_fetch (`sf`) backend: WriterSuite's engine, which searches and fetches in the user's
 * own Chrome through its extension bridge. sf is started as a child process without a shell;
 * options are `--opt=value` and the query or URL comes after `--`, so a value starting with
 * "-" can never become an option. Linux, macOS and Windows (sf.exe), amd64 and arm64.
 */

// Child processes.
import { spawn } from "node:child_process";
// Locating the binary.
import { existsSync } from "node:fs";
// Path arithmetic.
import { join } from "node:path";
// The browser host's address (socket, or the Windows port file).
import { bridgeAddress } from "../browser/bridge.ts";
// Output messages.
import { t } from "../i18n/index.ts";
// Shared types.
import { type FetchResult, findDate, type SearchConfig, type SearchResult, urlDate } from "./core.ts";

/** Result of one sf run. */
export interface SfRun {
	// Exit code (null when killed).
	code: number | null;
	// Standard output.
	stdout: string;
	// Standard error.
	stderr: string;
	// True when the timeout killed it.
	timedOut: boolean;
}

/** sf's platform folder names: linux|macos|windows and amd64|arm64 (null on other systems). */
export function sfPlatform(platform: NodeJS.Platform, arch: string): { os: string; arch: string } | null {
	// Operating system.
	const os = platform === "linux" ? "linux" : platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "";
	// CPU.
	const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : "";
	// Both must be known.
	return os && cpu ? { os, arch: cpu } : null;
}

/** Places sf is looked for, in order: WA_SF, next to the writeragent binary, under the agent dir. Never PATH
 * (Salesforce's CLI is also called `sf`). */
export function sfCandidates(
	cfg: SearchConfig,
	platform: NodeJS.Platform,
	arch: string,
	execDir: string,
	agentDir: string,
): string[] {
	// Folder names of this machine.
	const p = sfPlatform(platform, arch);
	// Explicit path first.
	const out = cfg.sfPath ? [cfg.sfPath] : [];
	// Program name (sf.exe on Windows).
	const name = platform === "win32" ? "sf.exe" : "sf";
	// The release layout and the agent directory.
	if (p) out.push(join(execDir, "search_fetch", p.os, p.arch, name), join(agentDir, "sf", p.os, p.arch, name));
	// The list.
	return out;
}

/** Path of sf; throws a translated error when no candidate exists. */
export function locateSf(
	cfg: SearchConfig,
	platform: NodeJS.Platform,
	arch: string,
	execDir: string,
	agentDir: string,
	exists: (p: string) => boolean = existsSync,
): string {
	// Candidates in order.
	const candidates = sfCandidates(cfg, platform, arch, execDir, agentDir);
	// First that exists.
	const found = candidates.find((c) => exists(c));
	// Missing everywhere.
	if (!found) throw new Error(t("sf.missing", { paths: candidates.join("、") || "WA_SF" }));
	// The binary.
	return found;
}

/** Driver-model variables sf reads (SF_URL, SF_KEY, SF_MODEL, SF_API), all empty: WriterAgent runs sf
 * without a model for now (the user, 2026-11-01). Empty values also stop sf's rag.env from filling
 * them, so sf makes no model call; it then searches the first results page and fetches pages with its
 * deterministic rules. Model hook: to drive sf with a model later, return the main model's
 * { SF_URL: root, SF_KEY, SF_MODEL, SF_API: api } here instead. */
export function sfModelOff(): Record<string, string> {
	// The four names, cleared.
	return { SF_URL: "", SF_KEY: "", SF_MODEL: "", SF_API: "" };
}

/** Where a release sf keeps its state, all under <agentDir>/sf: the bundled Python with its packages, unpacked
 * once on first run (no download), PyApp's cache, and search_fetch's own state (pacing, caches); its pages go through WriterAgent's
 * browser host: the socket on Linux and macOS, the port file (port and token) on Windows. PYTHONUTF8=1
 * makes sf read, write and print UTF-8 (Windows defaults to the ANSI code page). */
export function sfStateEnv(agentDir: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
	// One folder for everything sf writes.
	const root = join(agentDir, "sf");
	// The host's address, computed like the host computes it.
	const addr = bridgeAddress(agentDir, platform);
	return {
		PYAPP_INSTALL_DIR_SEARCH_FETCH: join(root, "runtime", "install"),
		PYAPP_CACHE_DIR: join(root, "runtime", "cache"),
		SEARCH_FETCH_HOME: join(root, "home"),
		PYTHONUTF8: "1",
		...(addr.kind === "unix" ? { SEARCH_FETCH_BRIDGE_SOCKET: addr.path } : { SEARCH_FETCH_BRIDGE_FILE: addr.file }),
	};
}

/** Environment of the sf child: state under agentDir unless the parent sets it, no driver model, and
 * no human waits when nobody watches. */
export function sfChildEnv(
	base: NodeJS.ProcessEnv,
	interactive: boolean,
	agentDir: string,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	// State folders first (the parent's values win), then the model variables cleared.
	const env: NodeJS.ProcessEnv = { ...sfStateEnv(agentDir, platform), ...base, ...sfModelOff() };
	// Print mode: a captcha must not wait for a person.
	if (!interactive) env.SEARCH_FETCH_NO_HUMAN = "1";
	// The environment.
	return env;
}

/** Run sf once (no shell), killed after timeoutMs or when signal aborts. */
export function runSf(
	bin: string,
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<SfRun> {
	// One promise per run.
	return new Promise((resolve, reject) => {
		// Start it.
		const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
		// Output.
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (c) => {
			stdout += c;
		});
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		// Timeout and cancellation kill the child.
		const kill = () => child.kill("SIGTERM");
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, opts.timeoutMs);
		opts.signal?.addEventListener("abort", kill, { once: true });
		// Spawn failures (missing binary, no permission).
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		// Finished.
		child.on("close", (code) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", kill);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

/** Error for a failed run: timeout, or sf's own `failed:` line (else its last stderr line). */
export function sfError(run: SfRun, timeoutMs: number): Error {
	// Killed by the timeout.
	if (run.timedOut) return new Error(t("sf.timeout", { seconds: Math.round(timeoutMs / 1000) }));
	// sf prints "[search_fetch] failed: …" for every handled error.
	const lines = run.stderr.trim().split("\n").filter(Boolean);
	const failed = lines.reverse().find((l) => l.includes("failed:")) ?? lines[0] ?? "";
	// Exit code and reason.
	return new Error(
		t("sf.failed", { code: String(run.code), reason: failed.replace(/^\[search_fetch\]\s*/, "").slice(0, 300) }),
	);
}

/** Arguments of `sf search`. */
export function sfSearchArgs(query: string, opts: { fresh?: string; language?: string }): string[] {
	// JSON contract, first results page.
	const args = ["search", "--json", "--pages=1"];
	// Time window.
	if (opts.fresh) args.push(`--fresh=${opts.fresh}`);
	// Language.
	if (opts.language) args.push(`--lang=${opts.language}`);
	// The query after the separator.
	return [...args, "--", query];
}

/** Results of `sf search --json` ({query, blocks:[{results:[{u, t}]}]}). */
export function parseSfSearch(stdout: string): SearchResult[] {
	// The JSON contract.
	const data = JSON.parse(stdout) as { blocks?: { results?: { u?: string; t?: string }[] }[] };
	// Links of every block.
	return (data.blocks ?? [])
		.flatMap((b) => b.results ?? [])
		.map((r) => ({ title: r.t ?? "", url: r.u ?? "", snippet: "", date: "" }));
}

/** Page of `sf fetch --json` ({final_url, markdown}). */
export function parseSfFetch(stdout: string, url: string): FetchResult {
	// The JSON contract.
	const data = JSON.parse(stdout) as { final_url?: string; markdown?: string };
	// Page text; sf opens it with （发布时间：YYYY-MM-DD） when the page declares one.
	const content = data.markdown ?? "";
	// Final address.
	const final = data.final_url || url;
	// Common shape; the date from the text, else from the address.
	return { url: final, title: "", content, date: findDate(content.slice(0, 200)) || urlDate(final) };
}
