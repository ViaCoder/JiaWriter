// Unit and functional tests for the delegate tool and the child run: the command of a child, a real child run of a
// stand-in program, the depth guard, and the texts of a finished, failed and timed-out subtask.

// Files.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { basename, join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Extension API types.
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
// The extension.
import writerDelegateExtension, { DELEGATE_ENV, delegateText } from "../../src/extensions/writer-delegate/index.ts";
// The child run.
import { runChild, SELF_COMMAND_ENV, selfCommand } from "../../src/writer/child-run.ts";

// Working folder of each test.
let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "wa-delegate-"));
	vi.stubEnv("JW_LANG", "zh");
	vi.stubEnv(DELEGATE_ENV, "");
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** The stand-in programs, written as scripts: node reads -p as its own option when a script is given with -e. */
function standIns(): { echo: string[]; slow: string[] } {
	// Prints its prompt (the argument after -p), the folder and the depth it was given.
	writeFileSync(
		join(cwd, "echo.cjs"),
		'const i=process.argv.indexOf("-p");console.log("回复："+process.argv[i+1]+"｜"+require("node:path").basename(process.cwd())+"｜深度"+(process.env.JW_DELEGATE_DEPTH||"0"))',
	);
	// Never ends on its own.
	writeFileSync(join(cwd, "slow.cjs"), "setTimeout(()=>{},60000)");
	return { echo: [process.execPath, join(cwd, "echo.cjs")], slow: [process.execPath, join(cwd, "slow.cjs")] };
}

describe("selfCommand / runChild", () => {
	it("takes the command from the environment when given, else this program", () => {
		vi.stubEnv(SELF_COMMAND_ENV, JSON.stringify(["prog", "--x"]));
		expect(selfCommand()).toEqual(["prog", "--x"]);
		vi.stubEnv(SELF_COMMAND_ENV, "not json");
		expect(selfCommand()[0]).toBe(process.execPath);
	});

	it("runs the prompt in the folder with the extra environment and returns what it printed", async () => {
		const { echo, slow } = standIns();
		vi.stubEnv(SELF_COMMAND_ENV, JSON.stringify(echo));
		const r = await runChild("整理文件", cwd, { JW_DELEGATE_DEPTH: "1" }, 20_000);
		expect([r.code, r.timedOut]).toEqual([0, false]);
		expect(r.stdout.trim()).toBe(`回复：整理文件｜${basename(cwd)}｜深度1`);
		// A run that takes too long is stopped and says so.
		vi.stubEnv(SELF_COMMAND_ENV, JSON.stringify(slow));
		const late = await runChild("x", cwd, {}, 500);
		expect(late.timedOut).toBe(true);
		// A command that cannot start.
		vi.stubEnv(SELF_COMMAND_ENV, JSON.stringify(["/no/such/program"]));
		const none = await runChild("x", cwd, {}, 5000);
		expect(none.code).toBeNull();
	});
});

describe("delegate tool", () => {
	/** The tool with a stand-in runner. */
	function tool(run?: Parameters<typeof writerDelegateExtension>[1]) {
		const tools = new Map<string, ToolDefinition>();
		const pi = {
			registerTool: (t: ToolDefinition) => tools.set(t.name, t),
			on: () => undefined,
		} as unknown as ExtensionAPI;
		writerDelegateExtension(pi, run);
		const ctx = { cwd } as unknown as ExtensionToolContext;
		return (params: Record<string, unknown>) =>
			tools.get("delegate")?.execute("c", params, undefined, undefined, ctx) as Promise<{
				content: { text: string }[];
				isError?: boolean;
				details?: Record<string, unknown>;
			}>;
	}

	it("runs the task in a child of this program and returns its reply; the depth is passed on", async () => {
		vi.stubEnv(SELF_COMMAND_ENV, JSON.stringify(standIns().echo));
		const run = tool();
		const r = await run({ task: "研究低空经济", folder: "子题" });
		expect(r.isError).toBe(false);
		expect(r.content[0].text).toBe("回复：研究低空经济｜子题｜深度1");
		expect(r.details).toMatchObject({ folder: join(cwd, "子题"), code: 0 });
	});

	it("refuses inside a subtask, needs a task, and names a failure or a time-out", async () => {
		vi.stubEnv(DELEGATE_ENV, "1");
		const inner = await tool()({ task: "再派" });
		expect([inner.isError, inner.content[0].text]).toEqual([true, "子任务里不能再派子任务：直接做。"]);
		vi.stubEnv(DELEGATE_ENV, "");
		expect((await tool()({ task: "  " })).content[0].text).toContain("缺少 task");
		const failing = tool(async () => ({ code: 2, stdout: "写到一半", stderr: "坏了", timedOut: false }));
		const f = await failing({ task: "x", minutes: 1 });
		expect(f.isError).toBe(true);
		expect(f.content[0].text).toContain("退出码 2");
		expect(f.content[0].text).toContain("坏了");
		expect(delegateText({ code: null, stdout: "", stderr: "", timedOut: true }, 20)).toContain("超过 20 分钟");
		// Minutes are clamped and passed as milliseconds.
		let given = 0;
		const timed = tool(async (_p, _f, _e, ms) => {
			given = ms;
			return { code: 0, stdout: "ok", stderr: "", timedOut: false };
		});
		await timed({ task: "x", minutes: 500 });
		expect(given).toBe(60 * 60_000);
	});
});
