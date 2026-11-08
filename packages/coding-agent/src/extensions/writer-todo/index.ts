/**
 * Built-in JiaWriter extension: the task list of the plan's general-capability line (2026-11-08). The model sends the
 * whole list each time (content and status), which keeps it simpler to get right than item-by-item edits; the list
 * stands above the editor until every item is done. The state lives in the tool results, so a resumed session or
 * another branch shows the list as it was at that point.
 */

// Schema helpers.
import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
// Schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";

/** One task. */
export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
}

/** Most tasks a list holds: more is a plan, not a list. */
export const MAX_TODOS = 20;
/** Marks of the three states. */
const MARK: Readonly<Record<TodoItem["status"], string>> = { completed: "✓", in_progress: "▶", pending: "○" };

/** The items that hold: text present, a known status, at most MAX_TODOS. */
export function cleanTodos(raw: unknown): TodoItem[] {
	const list = Array.isArray(raw) ? raw : [];
	return list
		.map((x) => x as { content?: unknown; status?: unknown })
		.filter((x) => typeof x.content === "string" && x.content.trim() !== "")
		.map((x) => ({
			content: String(x.content).trim(),
			status: (["pending", "in_progress", "completed"].includes(String(x.status))
				? x.status
				: "pending") as TodoItem["status"],
		}))
		.slice(0, MAX_TODOS);
}

/** The lines shown above the editor; none once every task is done. */
export function todoLines(todos: readonly TodoItem[]): string[] {
	const done = todos.filter((x) => x.status === "completed").length;
	if (todos.length === 0 || done === todos.length) return [];
	return [t("todo.title", { done, total: todos.length }), ...todos.map((x) => `  ${MARK[x.status]} ${x.content}`)];
}

/** Register the tool and keep the list on screen. */
export default function writerTodoExtension(pi: ExtensionAPI): void {
	// The list as of the latest call on this branch.
	let todos: TodoItem[] = [];
	/** Show the list, or take it away when there is none to show. */
	const show = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const lines = todoLines(todos);
		ctx.ui.setWidget("writer-todo", lines.length > 0 ? lines : undefined);
	};
	/** The list from the latest todo_write result on the branch. */
	const restore = (ctx: ExtensionContext) => {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo_write")
				continue;
			todos = cleanTodos((entry.message.details as { todos?: unknown } | undefined)?.todos);
		}
		show(ctx);
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.registerTool({
		name: "todo_write",
		label: "Tasks",
		description:
			"Keeps the task list of work with three or more steps, shown to the user above the input.\n\nUsage:\n" +
			" - Send the whole list each time, each task with its status: pending, in_progress or completed\n" +
			" - Mark a task in_progress before starting it, and completed as soon as it is done; one in progress at a time\n" +
			" - Skip it for work of one or two steps",
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String({ description: "The task, as an imperative" }),
					status: StringEnum(["pending", "in_progress", "completed"] as const),
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			todos = cleanTodos(params.todos);
			show(ctx);
			const done = todos.filter((x) => x.status === "completed").length;
			const now = todos.find((x) => x.status === "in_progress")?.content ?? "";
			return {
				content: [{ type: "text", text: t("todo.saved", { done, total: todos.length, now: now || "—" }) }],
				details: { todos },
			};
		},
	});
}
