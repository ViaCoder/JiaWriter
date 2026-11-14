// The loop guard (src/writer/loop-guard.ts) and its extension (src/extensions/writer-guard/index.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerGuardExtension from "../../src/extensions/writer-guard/index.ts";
import {
	callKey,
	checkCall,
	MAX_BLOCKS,
	MAX_CALLS_PER_REPLY,
	MAX_SAME_CALLS,
	MAX_SAME_FAILURES,
	MAX_TOOL_FAILURES,
	newGuard,
	recordResult,
} from "../../src/writer/loop-guard.ts";

beforeEach(() => vi.stubEnv("JW_LANG", "zh"));
afterEach(() => vi.unstubAllEnvs());

describe("callKey", () => {
	it("is the same for the same arguments in any key order, and differs by tool or value", () => {
		expect(callKey("style_check", { genre: "调研报告", path: "a" })).toBe(
			callKey("style_check", { path: "a", genre: "调研报告" }),
		);
		expect(callKey("read", { path: "a" })).not.toBe(callKey("write", { path: "a" }));
		expect(callKey("read", { path: "a" })).not.toBe(callKey("read", { path: "b" }));
	});
});

describe("callKey and the reason of a call", () => {
	it("takes calls that differ only in their reason for the same call", () => {
		// 2026-11-09: a browser run gave each repeated select a new reason, 30 times.
		expect(callKey("browser", { action: "select", option: "2024", reason: "选择年份" })).toBe(
			callKey("browser", { action: "select", option: "2024", reason: "在下拉框中选2024" }),
		);
		expect(callKey("browser", { action: "select", option: "2024" })).not.toBe(
			callKey("browser", { action: "select", option: "2025" }),
		);
	});
});

describe("checkCall and recordResult", () => {
	it("blocks a call after MAX_SAME_FAILURES failures in a row, and a success starts them again", () => {
		const guard = newGuard();
		const key = callKey("style_check", { genre: "调研报告" });
		for (let i = 0; i < MAX_SAME_FAILURES; i++) {
			expect(checkCall(guard, key)).toBe("ok");
			recordResult(guard, key, true);
		}
		expect(checkCall(guard, key)).toBe("failed");
		const other = callKey("read", { path: "a" });
		recordResult(guard, other, true);
		recordResult(guard, other, false);
		expect(checkCall(guard, other)).toBe("ok");
	});
	it("blocks a tool that fails MAX_TOOL_FAILURES times in a row with changing arguments", () => {
		// 2026-11-12: material_add was sent 510 times, each with a new number in its items, every one refused.
		const guard = newGuard();
		for (let i = 0; i < MAX_TOOL_FAILURES; i++) {
			const key = callKey("material_add", { items: [{ section: `现状${i}` }] });
			expect(checkCall(guard, key, "material_add")).toBe("ok");
			recordResult(guard, key, true, "material_add");
		}
		expect(checkCall(guard, callKey("material_add", { items: [{ section: "现状9" }] }), "material_add")).toBe(
			"failing",
		);
		// Other tools are not touched, and one success starts the count again.
		expect(checkCall(guard, callKey("read", { path: "a" }), "read")).toBe("ok");
		recordResult(guard, callKey("material_add", { items: [{ start: "x" }] }), false, "material_add");
		expect(checkCall(guard, callKey("material_add", { items: [{ section: "现状10" }] }), "material_add")).toBe("ok");
	});
	it("starts every count again after a change that worked, since a check then reads a new text", () => {
		const guard = newGuard();
		const check = callKey("word_count", { path: "稿.md" });
		for (let i = 0; i < MAX_SAME_CALLS; i++) recordResult(guard, check, false, "word_count");
		expect(checkCall(guard, check)).toBe("repeated");
		recordResult(guard, callKey("edit", { path: "稿.md" }), false, "edit");
		expect(checkCall(guard, check)).toBe("ok");
		// A change that failed changed nothing.
		for (let i = 0; i < MAX_SAME_CALLS; i++) recordResult(guard, check, false, "word_count");
		recordResult(guard, callKey("edit", { path: "稿.md" }), true, "edit");
		expect(checkCall(guard, check)).toBe("repeated");
	});
	it("still blocks the same change made over and over", () => {
		const guard = newGuard();
		const write = callKey("write", { path: "稿.md", content: "同样的稿" });
		for (let i = 0; i < MAX_SAME_CALLS; i++) recordResult(guard, write, false, "write");
		expect(checkCall(guard, write)).toBe("repeated");
	});
	it("reads a page again after a browser action, and still blocks the same page read over and over", () => {
		// The browser package check read a page a fifth time after a click and was blocked (2026-11-09).
		const guard = newGuard();
		const read = callKey("browser", { action: "read" });
		for (let i = 0; i < MAX_SAME_CALLS; i++) {
			recordResult(guard, read, false, "browser");
			recordResult(guard, callKey("browser", { action: "click", ref: `e${i}` }), false, "browser");
		}
		expect(checkCall(guard, read)).toBe("ok");
		const again = newGuard();
		for (let i = 0; i < MAX_SAME_CALLS; i++) recordResult(again, read, false, "browser");
		expect(checkCall(again, read)).toBe("repeated");
	});
	it("blocks the same call after MAX_SAME_CALLS, even when it works", () => {
		const guard = newGuard();
		const key = callKey("read", { path: "a" });
		for (let i = 0; i < MAX_SAME_CALLS; i++) recordResult(guard, key, false);
		expect(checkCall(guard, key)).toBe("repeated");
	});
});

describe("writer-guard", () => {
	/** The extension's handlers on a fake API. */
	function load() {
		const handlers: Record<string, (event: unknown) => unknown> = {};
		writerGuardExtension({
			on: (name: string, fn: (event: unknown) => unknown) => {
				handlers[name] = fn;
			},
		} as unknown as ExtensionAPI);
		const call = (input: unknown) =>
			handlers.tool_call({ toolName: "style_check", input }) as
				| { block: boolean; reason: string; terminate: boolean }
				| undefined;
		const fail = (input: unknown) => handlers.tool_result({ toolName: "style_check", input, isError: true });
		return { handlers, call, fail };
	}

	it("lets a call fail twice, blocks the third with a reason, and ends the run at the third block", () => {
		const { call, fail } = load();
		const input = { genre: "调研报告" };
		for (let i = 0; i < MAX_SAME_FAILURES; i++) {
			expect(call(input)).toBeUndefined();
			fail(input);
		}
		for (let block = 1; block <= MAX_BLOCKS; block++) {
			const out = call(input);
			expect(out?.block).toBe(true);
			expect(out?.reason).toContain("style_check");
			expect(out?.terminate).toBe(block === MAX_BLOCKS);
		}
		expect(call(input)?.reason).toContain("本轮到此结束");
	});

	it("cuts a reply streaming more than MAX_CALLS_PER_REPLY tool calls, then tells the model once the run has ended", () => {
		const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
		const sent: { content: string; options: unknown }[] = [];
		let aborted = 0;
		writerGuardExtension({
			on: (name: string, fn: (event: unknown, ctx?: unknown) => unknown) => {
				handlers[name] = fn;
			},
			sendMessage: (message: { content: string }, options: unknown) =>
				sent.push({ content: message.content, options }),
		} as unknown as ExtensionAPI);
		const ctx = { abort: () => aborted++ };
		const reply = (calls: number) => ({
			role: "assistant",
			content: Array.from({ length: calls }, (_, i) => ({
				type: "toolCall",
				id: `c${i}`,
				name: "fetch_web",
				arguments: {},
			})),
		});
		handlers.message_start({ message: reply(0) });
		handlers.message_update({ message: reply(MAX_CALLS_PER_REPLY) }, ctx);
		expect(aborted).toBe(0);
		handlers.message_update({ message: reply(MAX_CALLS_PER_REPLY + 1) }, ctx);
		handlers.message_update({ message: reply(MAX_CALLS_PER_REPLY + 5) }, ctx);
		expect(aborted).toBe(1);
		// The user's text and tool results are not replies.
		handlers.message_update({ message: { role: "user", content: "x" } }, ctx);
		expect(aborted).toBe(1);
		// Told once the run has ended, with the count, as a follow-up that starts a turn.
		handlers.agent_end({ messages: [] });
		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain(`${MAX_CALLS_PER_REPLY + 1} 个工具调用`);
		expect(sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		handlers.agent_end({ messages: [] });
		expect(sent).toHaveLength(1);
		// A reply that arrived whole: the calls past the limit are blocked, with the stop hint.
		for (let i = 0; i < MAX_CALLS_PER_REPLY; i++)
			expect(handlers.tool_call({ toolName: "read", input: { path: `f${i}` } })).toBeUndefined();
		const out = handlers.tool_call({ toolName: "read", input: { path: "more" } }) as {
			block: boolean;
			terminate: boolean;
			reason: string;
		};
		expect(out).toMatchObject({ block: true, terminate: true });
		expect(out.reason).toContain(`超过 ${MAX_CALLS_PER_REPLY} 个`);
		// The next reply starts the count again.
		handlers.message_start({ message: reply(0) });
		expect(handlers.tool_call({ toolName: "read", input: { path: "again" } })).toBeUndefined();
	});

	it("starts again with a new message of the user", () => {
		const { handlers, call, fail } = load();
		const input = { genre: "调研报告" };
		for (let i = 0; i < MAX_SAME_FAILURES; i++) fail(input);
		expect(call(input)?.block).toBe(true);
		handlers.input({});
		expect(call(input)).toBeUndefined();
	});
});
