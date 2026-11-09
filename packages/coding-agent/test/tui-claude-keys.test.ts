// The keys and screen of Claude Code and Kimi Code (2026-11-09: "The operation should be consistent with Claude
// Code, while the interface presentation can take inspiration from Kimi Code"): key names, the shortcut defaults,
// the history search, numbered choices, the working time, the detailed view, tool names and paths.
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { formatToolCallWithArgs, shortenPath } from "../src/core/tools/render-utils.ts";
import {
	AssistantMessageComponent,
	replyHeader,
	setDetailedView,
} from "../src/modes/interactive/components/assistant-message.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { filterHistory, HistorySearchComponent } from "../src/modes/interactive/components/history-search.ts";
import { formatKeyText, keyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { elapsedText } from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { setUiLang } from "../src/writer/i18n/index.ts";
import { MAC_OPTION_NOTE, TOOL_LABELS_ZH, toolLabel, UI_ZH } from "../src/writer/ui-text.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setDetailedView(false));

describe("default keys follow Claude Code", () => {
	it("Shift+Tab cycles the work mode, Ctrl+O the detailed view, Ctrl+T the task list, Ctrl+R the history", () => {
		const kb = new KeybindingsManager();
		expect(kb.getKeys("app.mode.cycle")).toEqual(["shift+tab"]);
		expect(kb.getKeys("app.tools.expand")).toEqual(["ctrl+o"]);
		expect(kb.getKeys("app.todo.toggle")).toEqual(["ctrl+t"]);
		expect(kb.getKeys("app.history.search")).toEqual(["ctrl+r"]);
		expect(kb.getKeys("app.screen.redraw")).toEqual(["ctrl+l"]);
		// Option+T thinking and Option+P model, as Claude Code; Ctrl+P / Ctrl+N browse the history.
		expect(kb.getKeys("app.thinking.cycle")).toEqual(["alt+t"]);
		expect(kb.getKeys("app.model.select")).toEqual(["alt+p"]);
		expect(kb.getKeys("tui.editor.historyPrevious")).toEqual(["ctrl+p"]);
		expect(kb.getKeys("tui.editor.historyNext")).toEqual(["ctrl+n"]);
		// Option+Enter, Shift+Enter and Ctrl+J add a line.
		expect(kb.getKeys("tui.input.newLine")).toEqual(["shift+enter", "alt+enter", "ctrl+j"]);
	});

	it("no two app actions of the editor share a key, but for the send-now chord and copy", () => {
		const kb = new KeybindingsManager();
		const seen = new Map<string, string>();
		const clashes: string[] = [];
		for (const action of [
			"app.mode.cycle",
			"app.thinking.cycle",
			"app.model.select",
			"app.tools.expand",
			"app.todo.toggle",
			"app.screen.redraw",
			"app.history.search",
			"app.editor.external",
			"app.message.followUp",
			"app.message.dequeue",
			"app.message.sendNow",
			"app.clipboard.pasteImage",
			"app.interrupt",
			"app.clear",
			"app.exit",
			"app.suspend",
		] as const) {
			for (const key of kb.getKeys(action)) {
				if (seen.has(key)) clashes.push(`${key}: ${seen.get(key)} / ${action}`);
				seen.set(key, action);
			}
		}
		expect(clashes).toEqual([]);
	});
});

describe("formatKeyText", () => {
	it("writes keys as Claude Code: Ctrl+O, Shift+Tab, Esc; Option on a Mac", () => {
		expect(formatKeyText("ctrl+o", { capitalize: true })).toBe("Ctrl+O");
		expect(formatKeyText("shift+tab", { capitalize: true })).toBe("Shift+Tab");
		expect(formatKeyText("escape", { capitalize: true })).toBe("Esc");
		expect(formatKeyText("alt+p", { capitalize: true })).toBe(process.platform === "darwin" ? "Option+P" : "Alt+P");
	});

	it("keyText: hints use the same names", () => {
		expect(keyText("app.tools.expand")).toBe("Ctrl+O");
		expect(keyText("app.interrupt")).toBe("Esc");
	});
});

describe("filterHistory", () => {
	it("keeps the entries holding every word, ignoring case, in their order", () => {
		const entries = ["写一份调研报告", "Export the DRAFT", "改第二部分", "export notes"];
		expect(filterHistory(entries, "export")).toEqual(["Export the DRAFT", "export notes"]);
		expect(filterHistory(entries, "调研 报告")).toEqual(["写一份调研报告"]);
		expect(filterHistory(entries, "")).toEqual(entries);
	});
});

describe("HistorySearchComponent", () => {
	it("filters as one types and gives the chosen entry; Esc gives nothing", () => {
		let picked: string | undefined;
		let cancelled = false;
		const search = new HistorySearchComponent(
			["写一份调研报告", "改第二部分", "导出 Word"],
			(entry) => {
				picked = entry;
			},
			() => {
				cancelled = true;
			},
		);
		for (const ch of "第二") search.handleInput(ch);
		expect(stripAnsi(search.render(60).join("\n"))).toContain("改第二部分");
		expect(stripAnsi(search.render(60).join("\n"))).not.toContain("导出 Word");
		search.handleInput("\r");
		expect(picked).toBe("改第二部分");
		search.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});
});

describe("ExtensionSelectorComponent numbers", () => {
	it("numbers its options, and a number key picks one at once", () => {
		let picked: string | undefined;
		const selector = new ExtensionSelectorComponent(
			"允许吗？",
			["是", "否"],
			(option) => {
				picked = option;
			},
			() => {},
		);
		const text = stripAnsi(selector.render(60).join("\n"));
		expect(text).toContain("1. 是");
		expect(text).toContain("2. 否");
		selector.handleInput("2");
		expect(picked).toBe("否");
		// A number past the options is ignored.
		picked = undefined;
		selector.handleInput("7");
		expect(picked).toBeUndefined();
	});
});

describe("elapsedText", () => {
	it("gives seconds, then minutes and seconds", () => {
		setUiLang("zh");
		expect(elapsedText(12_400)).toBe("12 秒");
		expect(elapsedText(65_000)).toBe("1 分 05 秒");
		setUiLang("en");
		expect(elapsedText(65_000)).toBe("1m 05s");
	});
});

describe("detailed view", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "先读材料。" },
			{ type: "text", text: "写好了。" },
		],
		model: "glm-5",
		provider: "test",
		api: "openai-completions",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: new Date(2026, 10, 9, 14, 5, 9).getTime(),
	} as never;

	it("replyHeader: the reply's time and model", () => {
		expect(replyHeader(message)).toBe("14:05:09 · glm-5");
		expect(replyHeader({ ...(message as object), responseModel: "glm-5.1" } as never)).toBe("14:05:09 · glm-5.1");
	});

	it("setDetailedView: hidden thinking shows, with the time and model above the reply", () => {
		const reply = new AssistantMessageComponent(message, true);
		expect(stripAnsi(reply.render(60).join("\n"))).not.toContain("先读材料");
		setDetailedView(true);
		reply.invalidate();
		const text = stripAnsi(reply.render(60).join("\n"));
		expect(text).toContain("先读材料");
		expect(text).toContain("14:05:09 · glm-5");
	});
});

describe("tool names and paths", () => {
	it("toolLabel: Chinese names for every tool listed, the name itself in English", () => {
		setUiLang("zh");
		expect(toolLabel("read")).toBe("读取");
		expect(toolLabel("material_add")).toBe("记录素材");
		expect(toolLabel("unknown_tool")).toBe("unknown_tool");
		expect(Object.values(TOOL_LABELS_ZH).every((label) => label.length > 0)).toBe(true);
		setUiLang("en");
		expect(toolLabel("read")).toBe("read");
	});

	it("formatToolCallWithArgs: the call starts with the tool's name as users read it", () => {
		setUiLang("zh");
		expect(stripAnsi(formatToolCallWithArgs("word_count", { path: "稿件/报告.md" }, theme, false))).toMatch(
			/^统计字数 /,
		);
	});

	it("shortenPath: a path in the working folder is shown from there, others as before", () => {
		expect(shortenPath("/work/topic/参考资料/材料.md", "/work/topic")).toBe("参考资料/材料.md");
		expect(shortenPath("参考资料/材料.md", "/work/topic")).toBe("参考资料/材料.md");
		expect(shortenPath("/elsewhere/a.md", "/work/topic")).toBe("/elsewhere/a.md");
	});
});

describe("Mac note", () => {
	it("has its Chinese text and names the terminal settings", () => {
		expect(UI_ZH[MAC_OPTION_NOTE]).toContain("Esc+");
		expect(MAC_OPTION_NOTE).toContain("Use Option as Meta Key");
	});
});
