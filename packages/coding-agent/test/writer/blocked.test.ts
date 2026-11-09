// One form for a stopped call (src/writer/blocked.ts): why, what comes next, what is still allowed (2026-11-09).
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedText } from "../../src/writer/blocked.ts";

afterEach(() => vi.unstubAllEnvs());

describe("blockedText", () => {
	it("says why, then the next step, then what is still allowed", () => {
		vi.stubEnv("JW_LANG", "zh");
		expect(blockedText({ why: "用户没有同意执行 rm a", next: "user" })).toBe(
			"已拦下：用户没有同意执行 rm a。下一步：问用户想怎么做；被拦下的这一步不要换工具、命令或路径再试。",
		);
		expect(blockedText({ why: "x 不可用", next: "change", still: "用成功过的 y" })).toBe(
			"已拦下：x 不可用。下一步：换参数、换方法或用已有结果继续；同样的调用不要再试。仍可做：用成功过的 y。",
		);
	});
	it("has the same three steps in English", () => {
		vi.stubEnv("JW_LANG", "en");
		expect(blockedText({ why: "a failed twice", next: "stop" })).toBe(
			"Blocked: a failed twice. Next: this round ends here; tell the user what was done and what blocks you.",
		);
	});
});
