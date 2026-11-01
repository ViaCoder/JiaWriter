// Functional tests for the built-in writer-ui extension (src/extensions/writer-ui/index.ts): /lang and /wa.

// Files.
import { mkdtempSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Terminal width of rendered text.
import { visibleWidth } from "@earendil-works/pi-tui";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Extension API types.
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
// Extension under test.
import writerUiExtension, { parseLangArg, ReadOnlyPage } from "../../src/extensions/writer-ui/index.ts";
// Language state.
import { currentLang } from "../../src/writer/i18n/index.ts";

// Agent folder of each test.
let agent = "";
beforeEach(() => {
	agent = mkdtempSync(join(tmpdir(), "wa-uiext-"));
	vi.stubEnv("WA_DIR", agent);
	vi.stubEnv("WA_LANG", "");
});
afterEach(() => {
	rmSync(agent, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** Commands of a fresh extension instance. */
function commands() {
	// Collected handlers and completions.
	const map = new Map<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (p: string) => unknown }
	>();
	writerUiExtension({ registerCommand: (name: string, o: never) => map.set(name, o) } as unknown as ExtensionAPI);
	return map;
}

/** A context recording notes, with scripted select answers and a custom-component runner. */
function ctx(mode: "tui" | "print", answers: (string | undefined)[] = []) {
	// Recorded output.
	const notes: { text: string; type: string }[] = [];
	const pages: ReadOnlyPage[] = [];
	const ui = {
		select: async () => answers.shift(),
		notify: (text: string, type: string) => notes.push({ text, type }),
		custom: async (
			factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: undefined) => void) => ReadOnlyPage,
		) => {
			// Build, then close it with a key like a user would.
			let closed = false;
			const page = factory({}, {}, {}, () => {
				closed = true;
			});
			pages.push(page);
			page.handleInput("q");
			expect(closed).toBe(true);
		},
	};
	return { c: { ui, mode, hasUI: mode === "tui" }, notes, pages };
}

describe("parseLangArg / ReadOnlyPage", () => {
	it("accepts zh and en names, and renders lines cut to the width", () => {
		// Names.
		expect(["zh", "中文", "CN", "en", "English", "英文", "fr", ""].map(parseLangArg)).toEqual([
			"zh",
			"zh",
			"zh",
			"en",
			"en",
			"en",
			undefined,
			undefined,
		]);
		// Width.
		let closed = 0;
		const page = new ReadOnlyPage(["abcdefgh", "中文中文中文"], () => closed++);
		const lines = page.render(4);
		expect(lines.every((l) => visibleWidth(l) <= 4)).toBe(true);
		expect(lines[0].startsWith("a")).toBe(true);
		expect(page.render(200)).toEqual(["abcdefgh", "中文中文中文"]);
		page.invalidate();
		page.handleInput("x");
		expect(closed).toBe(1);
	});
});

describe("/lang", () => {
	it("switches by argument or choice, refuses unknown names, and says when WA_LANG wins", async () => {
		const cmd = commands().get("lang");
		// By argument: the message is in the new language.
		let x = ctx("tui");
		await cmd?.handler("en", x.c);
		expect([currentLang(), x.notes[0].text]).toEqual([
			"en",
			"Interface language set to English. Command descriptions and hints change now; built-in skills switch after /reload.",
		]);
		// By choice.
		x = ctx("tui", ["中文"]);
		await cmd?.handler("", x.c);
		expect([currentLang(), x.notes[0].text.startsWith("界面语言已设为中文")]).toEqual(["zh", true]);
		// Cancelled choice; unknown name.
		x = ctx("tui", [undefined]);
		await cmd?.handler("", x.c);
		expect(x.notes).toEqual([]);
		x = ctx("print");
		await cmd?.handler("fr", x.c);
		expect(x.notes).toEqual([{ text: "可选语言：zh、en。", type: "error" }]);
		// WA_LANG set: saved, with a warning.
		vi.stubEnv("WA_LANG", "zh");
		x = ctx("tui");
		await cmd?.handler("en", x.c);
		expect(x.notes).toEqual([{ text: "当前设置了 WA_LANG=zh，它优先于 /lang 的选择。", type: "warning" }]);
		// Completions.
		expect(commands().get("lang")?.getArgumentCompletions?.("e")).toEqual([{ value: "en", label: "en" }]);
	});
});

describe("/wa", () => {
	it("opens a full-screen page in the terminal and prints a note elsewhere, without the key", async () => {
		const cmd = commands().get("wa");
		vi.stubEnv("WA_KEY", "sk-secret-value");
		// Terminal: the page.
		let x = ctx("tui");
		await cmd?.handler("", x.c);
		const text = x.pages[0].render(200).join("\n");
		expect(text.startsWith("WriterAgent 配置（只读，修改请设置环境变量）")).toBe(true);
		expect(text).toContain("WA_KEY");
		expect(text).not.toContain("sk-secret");
		// Print mode: a note.
		x = ctx("print");
		await cmd?.handler("", x.c);
		expect([x.pages.length, x.notes[0].text.includes("模型"), x.notes[0].text.includes("sk-secret")]).toEqual([
			0,
			true,
			false,
		]);
	});
});
