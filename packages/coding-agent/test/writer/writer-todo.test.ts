// The task list: cleaning the model's list, the lines above the editor, and the tool with its state.
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerTodoExtension, { cleanTodos, MAX_TODOS, todoLines } from "../../src/extensions/writer-todo/index.ts";

describe("cleanTodos", () => {
	it("keeps tasks with text, gives unknown states pending, and stops at MAX_TODOS", () => {
		expect(
			cleanTodos([
				{ content: " 读材料 ", status: "completed" },
				{ content: "", status: "pending" },
				{ content: "写稿", status: "x" },
			]),
		).toEqual([
			{ content: "读材料", status: "completed" },
			{ content: "写稿", status: "pending" },
		]);
		expect(cleanTodos("none")).toEqual([]);
		expect(cleanTodos(Array.from({ length: 30 }, (_, n) => ({ content: `t${n}`, status: "pending" }))).length).toBe(
			MAX_TODOS,
		);
	});
});

describe("todoLines", () => {
	it("shows the count and a mark per task, and nothing once all are done", () => {
		const lines = todoLines([
			{ content: "读材料", status: "completed" },
			{ content: "写稿", status: "in_progress" },
			{ content: "检查", status: "pending" },
		]);
		expect(lines[0]).toContain("1/3");
		expect(lines.slice(1)).toEqual(["  ✓ 读材料", "  ▶ 写稿", "  ○ 检查"]);
		expect(todoLines([{ content: "读材料", status: "completed" }])).toEqual([]);
		expect(todoLines([])).toEqual([]);
	});
});

describe("writer-todo", () => {
	it("saves the list in the result, shows it, and restores it from the branch", async () => {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		let tool:
			| { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: unknown }> }
			| undefined;
		writerTodoExtension({
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
				handlers[name] = fn;
			},
			registerTool: (def: never) => {
				tool = def;
			},
		} as unknown as ExtensionAPI);
		const widgets: (string[] | undefined)[] = [];
		const ctx = (branch: unknown[] = []) => ({
			hasUI: true,
			ui: { setWidget: (_k: string, lines: string[] | undefined) => widgets.push(lines) },
			sessionManager: { getBranch: () => branch },
		});
		const todos = [
			{ content: "读材料", status: "in_progress" },
			{ content: "写稿", status: "pending" },
		];
		const result = await tool?.execute("1", { todos }, undefined, undefined, ctx());
		expect(result?.content[0].text).toContain("0/2");
		expect(result?.content[0].text).toContain("读材料");
		expect(widgets.at(-1)?.length).toBe(3);
		// A resumed session finds the list in the latest result; a branch without one shows none.
		const entry = {
			type: "message",
			message: { role: "toolResult", toolName: "todo_write", details: result?.details },
		};
		await handlers.session_start({}, ctx([entry]));
		expect(widgets.at(-1)?.length).toBe(3);
		await handlers.session_tree({}, ctx([]));
		expect(widgets.at(-1)).toBeUndefined();
	});
});
