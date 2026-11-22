// One line per browser and computer action in the chat (src/writer/tool-lines.ts), 2026-11-22: a demo recording
// showed the model's JSON and whole window trees under every step.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { actionLine, actionRenderers, outcomeLine } from "../../src/writer/tool-lines.ts";

beforeAll(() => initTheme("dark"));
afterEach(() => vi.unstubAllEnvs());

/** A result as the tools return it: the outcome JSON line, then the body. */
const result = (json: Record<string, unknown>, body = "") => ({
	content: [{ type: "text" as const, text: body ? `${JSON.stringify(json)}\n${body}` : JSON.stringify(json) }],
	details: undefined,
});
/** The rows a component draws, without colours. */
const rows = (c: { render(width: number): string[] }) => c.render(120).map((r) => stripAnsi(r).trimEnd());

describe("actionLine (with word, short and shortUrl)", () => {
	it("says the tool, the action and its object in Chinese, briefly", () => {
		vi.stubEnv("JW_LANG", "zh");
		expect(actionLine("browser", { action: "open", url: "https://www.amazon.com/s?k=headphones" })).toBe(
			"浏览器 · 打开 amazon.com/s?k=headphones",
		);
		expect(actionLine("browser", { action: "click", ref: "e48" })).toBe("浏览器 · 点击 e48");
		expect(actionLine("browser", { action: "read" })).toBe("浏览器 · 读取 页面");
		expect(actionLine("computer", { action: "launch", name: "Text Editor" })).toBe("桌面 · 启动 Text Editor");
		expect(actionLine("computer", { action: "key", key: "Return" })).toBe("桌面 · 按键 Return");
		const long = actionLine("computer", { action: "type", text: `Line one\n${"x".repeat(60)}` });
		expect(long.startsWith("桌面 · 输入 「Line one x")).toBe(true);
		expect(long.endsWith("…」")).toBe(true);
	});
	it("speaks English when the interface does", () => {
		vi.stubEnv("JW_LANG", "en");
		expect(actionLine("browser", { action: "type", text: "hello" })).toBe("Browser · Type 「hello」");
	});
});

describe("outcomeLine", () => {
	it("adds nothing when it was done, the page title when there is one", () => {
		vi.stubEnv("JW_LANG", "zh");
		expect(outcomeLine(JSON.stringify({ effect: "confirmed", next: "model" }))).toBeUndefined();
		expect(outcomeLine(JSON.stringify({ effect: "confirmed", data: { title: "Product editor" } }))).toEqual({
			text: "「Product editor」",
			tone: "dim",
		});
	});
	it("says plainly what went wrong, and loudly when it is the user's to do", () => {
		vi.stubEnv("JW_LANG", "zh");
		expect(outcomeLine(JSON.stringify({ effect: "unverifiable", reason: "no-change" }))?.text).toBe("未能确认变化");
		expect(outcomeLine(JSON.stringify({ effect: "failed", next: "user", reason: "not-connected" }))).toEqual({
			text: "需要你处理：没有连上 Chrome 扩展",
			tone: "warning",
		});
		expect(
			outcomeLine(JSON.stringify({ effect: "failed", next: "model", reason: "error", data: { message: "boom" } }))
				?.text,
		).toBe("失败：boom");
		expect(outcomeLine(JSON.stringify({ effect: "refused", next: "model", reason: "no-ref" }))?.text).toBe(
			"未执行：没有指明控件",
		);
		expect(outcomeLine("not json")).toBeUndefined();
	});
});

describe("actionRenderers (with resultText)", () => {
	it("draws one line for the call, one or none for the result, and the whole text when expanded", () => {
		vi.stubEnv("JW_LANG", "zh");
		const { renderCall, renderResult } = actionRenderers("computer");
		expect(rows(renderCall({ action: "launch", name: "Text Editor" }, theme))).toEqual(["桌面 · 启动 Text Editor"]);
		const done = result({ effect: "confirmed" }, '- [0] application "Doc"');
		expect(rows(renderResult(done, { expanded: false, isPartial: false }, theme))).toEqual([]);
		expect(rows(renderResult(done, { expanded: true, isPartial: false }, theme)).join("\n")).toContain(
			'application "Doc"',
		);
		const stuck = result({ effect: "failed", next: "user", reason: "declined" });
		expect(rows(renderResult(stuck, { expanded: false, isPartial: false }, theme))).toEqual([
			"需要你处理：你没有同意",
		]);
		expect(rows(renderResult(stuck, { expanded: false, isPartial: true }, theme))).toEqual([]);
	});
});
