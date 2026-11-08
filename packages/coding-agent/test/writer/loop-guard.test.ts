// The loop guard (src/writer/loop-guard.ts) and its extension (src/extensions/writer-guard/index.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerGuardExtension from "../../src/extensions/writer-guard/index.ts";
import {
	callKey,
	checkCall,
	MAX_BLOCKS,
	MAX_SAME_CALLS,
	MAX_SAME_FAILURES,
	newGuard,
	recordResult,
} from "../../src/writer/loop-guard.ts";

beforeEach(() => vi.stubEnv("JW_LANG", "zh"));
afterEach(() => vi.unstubAllEnvs());

describe("callKey", () => {
	it("is the same for the same arguments in any key order, and differs by tool or value", () => {
		expect(callKey("gongwen_check", { genre: "调研报告", path: "a" })).toBe(
			callKey("gongwen_check", { path: "a", genre: "调研报告" }),
		);
		expect(callKey("read", { path: "a" })).not.toBe(callKey("write", { path: "a" }));
		expect(callKey("read", { path: "a" })).not.toBe(callKey("read", { path: "b" }));
	});
});

describe("checkCall and recordResult", () => {
	it("blocks a call after MAX_SAME_FAILURES failures in a row, and a success starts them again", () => {
		const guard = newGuard();
		const key = callKey("gongwen_check", { genre: "调研报告" });
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
			handlers.tool_call({ toolName: "gongwen_check", input }) as
				| { block: boolean; reason: string; terminate: boolean }
				| undefined;
		const fail = (input: unknown) => handlers.tool_result({ toolName: "gongwen_check", input, isError: true });
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
			expect(out?.reason).toContain("gongwen_check");
			expect(out?.terminate).toBe(block === MAX_BLOCKS);
		}
		expect(call(input)?.reason).toContain("本轮已停止");
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
