// What the user asked to remember: the file, the remember tool, /memory and the prompt section.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerMemoryExtension, {
	addMemory,
	cleanMemory,
	MAX_MEMORIES,
	MAX_MEMORY_CHARS,
	memoryList,
	memoryPath,
	memorySection,
	parseMemories,
	readMemories,
	writeMemories,
} from "../../src/extensions/writer-memory/index.ts";

let dir: string;
beforeEach(() => {
	// Each test has its own agent directory.
	dir = mkdtempSync(join(tmpdir(), "jw-memory-"));
	vi.stubEnv("JW_DIR", dir);
	vi.stubEnv("JW_LANG", "zh");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("parseMemories / cleanMemory / addMemory", () => {
	it("reads one entry per line without the list marks, and keeps entries one line long and bounded", () => {
		expect(parseMemories("- 一\n\n* 二  \n三\n")).toEqual(["一", "二", "三"]);
		expect(cleanMemory("  多行\n的  备注 ")).toBe("多行 的 备注");
		expect(cleanMemory("长".repeat(MAX_MEMORY_CHARS + 5)).length).toBe(MAX_MEMORY_CHARS);
	});
	it("adds once, ignores blanks and repeats, and drops the oldest when full", () => {
		expect(addMemory([], "引用用脚注")).toEqual({ items: ["引用用脚注"], added: true });
		expect(addMemory(["引用用脚注"], " 引用用脚注 ")).toEqual({ items: ["引用用脚注"], added: false });
		expect(addMemory(["a"], "  ")).toEqual({ items: ["a"], added: false });
		const full = Array.from({ length: MAX_MEMORIES }, (_x, i) => `n${i}`);
		const { items } = addMemory(full, "new");
		expect(items.length).toBe(MAX_MEMORIES);
		expect(items[0]).toBe("n1");
		expect(items[items.length - 1]).toBe("new");
	});
});

describe("the file and the prompt section", () => {
	it("round-trips through memory.md under the agent directory, and reads nothing when there is no file", () => {
		expect(memoryPath()).toBe(join(dir, "memory.md"));
		expect(readMemories()).toEqual([]);
		writeMemories(["稿件用宋体", "不要结语"]);
		expect(readFileSync(memoryPath(), "utf-8")).toBe("- 稿件用宋体\n- 不要结语\n");
		expect(readMemories()).toEqual(["稿件用宋体", "不要结语"]);
	});
	it("is empty with no entries, and otherwise a headed section listing them", () => {
		expect(memorySection([])).toBe("");
		const section = memorySection(["稿件用宋体"]);
		expect(section.startsWith("# What the user asked you to remember\n")).toBe(true);
		expect(section.endsWith("\n- 稿件用宋体")).toBe(true);
		expect(memoryList(["a", "b"])).toBe("1. a\n2. b");
	});
});

describe("writer-memory", () => {
	/** The extension's tool, command and handlers. */
	function wire() {
		const handlers: Record<string, (event: unknown) => unknown> = {};
		let tool:
			| { execute: (id: string, params: { note: string }) => Promise<{ content: { text: string }[] }> }
			| undefined;
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		writerMemoryExtension({
			on: (name: string, fn: (event: unknown) => unknown) => {
				handlers[name] = fn;
			},
			registerTool: (def: never) => {
				tool = def;
			},
			registerCommand: (_name: string, def: never) => {
				command = def;
			},
		} as unknown as ExtensionAPI);
		const notes: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
		return { handlers, tool, command, notes, ctx };
	}
	it("remember writes the file, the prompt carries the entries, and /memory lists, forgets and clears", async () => {
		const { handlers, tool, command, notes, ctx } = wire();
		// Nothing yet: the prompt is left alone, /memory says so.
		expect(handlers.before_agent_start({ systemPrompt: "base" })).toBeUndefined();
		await command?.handler("", ctx);
		expect(notes[0]).toContain("还没有");
		// Two entries, the second a repeat.
		const first = await tool?.execute("1", { note: "稿件用宋体" });
		expect(first?.content[0].text).toContain("1");
		const again = await tool?.execute("2", { note: "稿件用宋体" });
		expect(again?.content[0].text).toContain("已经");
		await tool?.execute("3", { note: "不要结语" });
		expect(readMemories()).toEqual(["稿件用宋体", "不要结语"]);
		// The prompt: the base, then the section.
		const result = handlers.before_agent_start({ systemPrompt: "base" }) as { systemPrompt: string };
		expect(result.systemPrompt.startsWith("base\n\n# What the user asked you to remember")).toBe(true);
		expect(result.systemPrompt).toContain("- 不要结语");
		// /memory lists; forget 1 removes the first; a bad number is refused; clear empties.
		await command?.handler("", ctx);
		expect(notes[notes.length - 1]).toContain("1. 稿件用宋体\n2. 不要结语");
		await command?.handler("forget 1", ctx);
		expect(readMemories()).toEqual(["不要结语"]);
		await command?.handler("forget 9", ctx);
		expect(readMemories()).toEqual(["不要结语"]);
		await command?.handler("clear", ctx);
		expect(readMemories()).toEqual([]);
		expect(handlers.before_agent_start({ systemPrompt: "base" })).toBeUndefined();
	});
});
