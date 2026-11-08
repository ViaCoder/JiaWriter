// /plan: what plan mode refuses, the note each request carries, and turning it off.
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerPlanExtension, { PLAN_NOTE, refusedInPlan } from "../../src/extensions/writer-plan/index.ts";

describe("refusedInPlan", () => {
	it("refuses changes and non-reading commands, and lets reading and searching through", () => {
		expect(refusedInPlan("write", { path: "a.md" })).toBe(true);
		expect(refusedInPlan("material_add", {})).toBe(true);
		expect(refusedInPlan("bash", { command: "python3 x.py" })).toBe(true);
		expect(refusedInPlan("bash", { command: "grep -rn 预算 ." })).toBe(false);
		expect(refusedInPlan("read", { path: "a.md" })).toBe(false);
		expect(refusedInPlan("search_web", { query: "q" })).toBe(false);
	});
});

describe("writer-plan", () => {
	it("toggles with /plan: while on, changes are refused and each request carries the note", async () => {
		const handlers: Record<string, (event: unknown) => unknown> = {};
		let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
		writerPlanExtension({
			on: (name: string, fn: (event: unknown) => unknown) => {
				handlers[name] = fn;
			},
			registerCommand: (_name: string, def: never) => {
				command = def;
			},
		} as unknown as ExtensionAPI);
		const notes: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (m: string) => notes.push(m), setStatus: () => {} } };
		// Off: nothing refused, no note.
		expect(handlers.tool_call({ toolName: "write", input: {} })).toBeUndefined();
		expect(handlers.before_agent_start({})).toBeUndefined();
		await command?.handler("", ctx);
		expect((handlers.tool_call({ toolName: "write", input: {} }) as { block: boolean }).block).toBe(true);
		expect(handlers.tool_call({ toolName: "read", input: { path: "a" } })).toBeUndefined();
		expect((handlers.before_agent_start({}) as { message: { content: string } }).message.content).toBe(PLAN_NOTE);
		// Off again: the plan can be carried out.
		await command?.handler("", ctx);
		expect(handlers.tool_call({ toolName: "write", input: {} })).toBeUndefined();
		expect(notes.length).toBe(2);
	});
});
