// Unit tests for the interface language (src/writer/i18n/index.ts: currentLang, savedLang, setUiLang)
// and src/writer/ui-text.ts.

// Files.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Functions under test.
import { currentLang, savedLang, setUiLang, t, uiSettingsPath } from "../../src/writer/i18n/index.ts";
import { UI_ZH, uiText } from "../../src/writer/ui-text.ts";

// Agent folder of each test.
let agent = "";
beforeEach(() => {
	agent = mkdtempSync(join(tmpdir(), "wa-uilang-"));
	vi.stubEnv("WA_DIR", agent);
	vi.stubEnv("WA_LANG", "");
});
afterEach(() => {
	rmSync(agent, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("currentLang / savedLang / setUiLang", () => {
	it("uses WA_LANG first, then the /lang choice, then Chinese", () => {
		// Nothing set: Chinese.
		expect([currentLang(), savedLang()]).toEqual(["zh", undefined]);
		// /lang en is saved and used.
		setUiLang("en");
		expect(JSON.parse(readFileSync(uiSettingsPath(), "utf-8"))).toEqual({ lang: "en" });
		expect([currentLang(), t("wa.set")]).toEqual(["en", "set"]);
		// WA_LANG wins.
		vi.stubEnv("WA_LANG", "zh");
		expect(currentLang()).toBe("zh");
	});
	it("reads the file once per agent folder and ignores a broken or unknown value", () => {
		// A broken file in another agent folder.
		const other = mkdtempSync(join(tmpdir(), "wa-uilang2-"));
		writeFileSync(join(other, "writer-settings.json"), "{");
		vi.stubEnv("WA_DIR", other);
		expect(savedLang()).toBeUndefined();
		// An unknown value.
		writeFileSync(join(agent, "writer-settings.json"), JSON.stringify({ lang: "fr" }));
		vi.stubEnv("WA_DIR", agent);
		expect([savedLang(), currentLang()]).toEqual([undefined, "zh"]);
		rmSync(other, { recursive: true, force: true });
	});
});

describe("uiText", () => {
	it("translates known text in Chinese, keeps English and unknown text, and fills placeholders", () => {
		// Chinese by default.
		expect(uiText("to expand")).toBe("展开");
		expect(uiText("Press {key} to show full startup help.", { key: "ctrl+o" })).toBe(
			"按 ctrl+o 查看完整的启动帮助。",
		);
		expect(uiText("Quit {app}", { app: "writeragent" })).toBe("退出 writeragent");
		expect(uiText("A new upstream hint")).toBe("A new upstream hint");
		// English.
		vi.stubEnv("WA_LANG", "en");
		expect(uiText("to expand")).toBe("to expand");
		expect(uiText("Quit {app}", { app: "writeragent" })).toBe("Quit writeragent");
	});
	it("uses full-width punctuation in every Chinese entry", () => {
		// No ASCII sentence punctuation next to Chinese characters (file extensions such as .md excepted).
		const bad = Object.values(UI_ZH).filter((v) =>
			/[\p{Script=Han}][,.;:!?()]|[,.;:!?()][\p{Script=Han}]/u.test(v.replace(/\.[a-z]+\b/g, "")),
		);
		expect(bad).toEqual([]);
	});
});
