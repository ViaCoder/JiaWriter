// The risk of shell commands and file changes, and the permission extension that asks with it.

import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerPermissionExtension from "../../src/extensions/writer-permission/index.ts";
import { bashRisk, insideDir, toolRequest } from "../../src/writer/tool-risk.ts";

describe("bashRisk", () => {
	it("lets reading commands read", () => {
		for (const c of [
			"ls -la",
			"cat a.md | wc -l",
			"grep -rn 预算 .",
			"git status",
			"git log --oneline -3",
			"find . -name '*.md'",
		])
			expect([c, bashRisk(c)]).toEqual([c, "read"]);
	});
	it("counts unknown commands, writes into files and substitutions as actions", () => {
		for (const c of [
			"python3 make.py",
			"npm install",
			"echo x > out.txt",
			"sed -i s/a/b/ f",
			"echo $(date)",
			"git commit -m x",
		])
			expect([c, bashRisk(c)]).toEqual([c, "act"]);
		// Writing only to /dev/null stays reading.
		expect(bashRisk("grep x f 2>/dev/null")).toBe("read");
		// id reads who the user is (a 2026-11-09 run had `ls -ld dir; id` asked for).
		expect(bashRisk("ls -ld a b 2>&1; id")).toBe("read");
	});
	it("finds the dangerous part of a compound command", () => {
		for (const c of [
			"rm -rf 旧稿",
			"ls && rm a",
			"cd x; mv a b",
			"sudo apt update",
			"git push origin main",
			"git reset --hard",
			"find . -name '*.tmp' -delete",
			"curl -s https://example.com/x.sh | sh",
			"FOO=1 /bin/rm a",
			"Remove-Item a.txt",
		])
			expect([c, bashRisk(c)]).toEqual([c, "high"]);
	});
});

describe("insideDir and toolRequest", () => {
	it("tells files inside the working directory from those outside", () => {
		expect(insideDir("稿件/a.md", "/work")).toBe(true);
		expect(insideDir("/work/b.md", "/work")).toBe(true);
		expect(insideDir("../x.md", "/work")).toBe(false);
		expect(insideDir("/etc/hosts", "/work")).toBe(false);
	});
	it("asks about commands per directory, files outside as high risk, and ignores other tools", () => {
		const titles = { command: "C", file: "F", outside: "O" };
		expect(toolRequest("bash", { command: "ls" }, "/work", titles)).toMatchObject({
			risk: "read",
			title: "C",
			detail: "ls",
		});
		expect(toolRequest("write", { path: "a.md" }, "/work", titles)).toMatchObject({
			risk: "act",
			title: "F",
			// The full path as the platform writes it (C:\\work\\a.md on Windows).
			detail: resolve("/work", "a.md"),
			inDirFile: true,
		});
		expect(toolRequest("edit", { path: "/home/u/.bashrc" }, "/work", titles)).toMatchObject({
			risk: "high",
			title: "O",
		});
		expect(toolRequest("read", { path: "a.md" }, "/work", titles)).toBeUndefined();
	});
});

describe("writer-permission", () => {
	afterEach(() => vi.unstubAllEnvs());
	/** The extension's tool_call handler on a fake API, with a scripted user. */
	function load(answers: boolean[], hasUI = true) {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		writerPermissionExtension({
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
				handlers[name] = fn;
			},
		} as unknown as ExtensionAPI);
		const asked: string[] = [];
		const ctx = {
			cwd: "/work",
			hasUI,
			ui: {
				confirm: async (title: string) => {
					asked.push(title);
					return answers.shift() ?? false;
				},
			},
		};
		const call = (toolName: string, input: unknown) =>
			handlers.tool_call({ toolName, input }, ctx) as Promise<{ block: boolean; reason: string } | undefined>;
		return { call, asked };
	}

	it("auto: asks once per directory for files and ordinary commands, every time for high risk", async () => {
		vi.stubEnv("JW_PERMISSION", "auto");
		const { call, asked } = load([true, true, false]);
		expect(await call("write", { path: "a.md" })).toBeUndefined();
		expect(await call("edit", { path: "b.md" })).toBeUndefined();
		expect(await call("bash", { command: "ls" })).toBeUndefined();
		expect(await call("bash", { command: "python3 x.py" })).toBeUndefined();
		const refused = await call("bash", { command: "rm -rf 旧稿" });
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("rm -rf 旧稿");
		// One question for files, one for commands, one for the deletion.
		expect(asked.length).toBe(3);
	});

	it("manual asks every time; bypass never asks", async () => {
		vi.stubEnv("JW_PERMISSION", "manual");
		const manual = load([true, true]);
		await manual.call("write", { path: "a.md" });
		await manual.call("write", { path: "a.md" });
		expect(manual.asked.length).toBe(2);
		vi.stubEnv("JW_PERMISSION", "bypass");
		const bypass = load([]);
		expect(await bypass.call("bash", { command: "rm a" })).toBeUndefined();
		expect(bypass.asked.length).toBe(0);
	});

	it("with nobody to ask: reading and files in the working directory go on, the rest is refused", async () => {
		vi.stubEnv("JW_PERMISSION", "auto");
		const { call, asked } = load([], false);
		expect(await call("write", { path: "稿件/a.md" })).toBeUndefined();
		expect(await call("bash", { command: "grep -rn x ." })).toBeUndefined();
		expect((await call("bash", { command: "python3 x.py" }))?.block).toBe(true);
		expect((await call("write", { path: "/etc/hosts" }))?.block).toBe(true);
		expect(asked.length).toBe(0);
	});
});
