// Unit tests for src/writer/config-view.ts (the /jw page).

// Files.
import { mkdtempSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Functions under test.
import { formatWaConfig, modelRows, otherRows, setupCommands } from "../../src/writer/config-view.ts";
// The /lang setting.
import { setUiLang } from "../../src/writer/i18n/index.ts";
// Main-model state type.
import type { WriterModelState } from "../../src/writer/writer-model.ts";

// Agent folder of each test.
let agent = "";
beforeEach(() => {
	agent = mkdtempSync(join(tmpdir(), "wa-view-"));
	vi.stubEnv("JW_DIR", agent);
	vi.stubEnv("JW_LANG", "");
});
afterEach(() => {
	rmSync(agent, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** A ready state with the given API source. */
function ready(source: "env" | "cache" | "detect"): WriterModelState {
	// Fields the page reads.
	return {
		kind: "ready",
		api: "openai-responses",
		source,
		reasoning: { mode: "effort", levels: ["low", "medium", "high"] },
	} as unknown as WriterModelState;
}

// A full environment with a secret in the key and credentials in the URL.
const ENV = {
	JW_URL: "https://user:pw@llm.example.com/v1?token=abc",
	JW_KEY: "sk-secret-value",
	JW_MODEL: "m1",
	JW_CTX: "64000",
	JW_REASONING: "max",
};

describe("modelRows", () => {
	it("shows values and sources, the key only as set, and the URL without credentials", () => {
		// Detected API, default output limit.
		const rows = modelRows(ENV, ready("detect"), "zh");
		expect(rows).toEqual([
			{ name: "JW_URL", value: "https://llm.example.com/v1?token=%3Credacted%3E", source: "环境变量" },
			{ name: "JW_KEY", value: "已设置", source: "环境变量" },
			{ name: "JW_MODEL", value: "m1", source: "环境变量" },
			{ name: "JW_API", value: "openai-responses", source: "自动检测" },
			{ name: "JW_CTX", value: "64000", source: "环境变量" },
			{ name: "JW_OUT", value: "128000", source: "默认值" },
			{ name: "JW_REASONING", value: "max（可用：low/medium/high）", source: "环境变量" },
		]);
		expect(JSON.stringify(rows)).not.toContain("sk-secret");
		// Cache and JW_API sources; nothing configured.
		expect(modelRows(ENV, ready("cache"), "zh")[3].source).toBe("自动检测（缓存）");
		expect(modelRows(ENV, ready("env"), "en")[3].source).toBe("set by JW_API");
		expect(modelRows({}, { kind: "none" }, "zh").map((r) => r.value)).toEqual([
			"未设置",
			"未设置",
			"未设置",
			"-",
			"128000",
			"128000",
			"medium",
		]);
	});
});

describe("otherRows / setupCommands", () => {
	it("shows the language source and the search settings, and builds commands per platform", () => {
		// Defaults, then the /lang choice, then JW_LANG.
		expect(otherRows({}, "zh")).toEqual([
			{ name: "JW_LANG", value: "zh", source: "默认值" },
			{ name: "JW_SEARCH", value: "auto", source: "默认值" },
			{ name: "JW_ENGINES", value: "bing,google", source: "默认值" },
			{ name: "JW_SEARCH_PAGES", value: "3", source: "默认值" },
			{ name: "JW_SEARCH_URL", value: "https://api.anysearch.com", source: "默认值" },
			{ name: "JW_SEARCH_KEY", value: "未设置（匿名调用）", source: "默认值" },
			{ name: "JW_SF", value: "未设置（在约定位置查找）", source: "默认值" },
		]);
		setUiLang("en");
		expect(otherRows({}, "zh")[0]).toEqual({ name: "JW_LANG", value: "en", source: "/lang 设置" });
		expect(otherRows({ JW_LANG: "zh", JW_SEARCH_KEY: "k" }, "zh").map((r) => r.source)[0]).toBe("环境变量");
		// Commands: current values, the key as a placeholder.
		expect(setupCommands(ENV, "linux", "zh")).toEqual([
			'export JW_URL="https://llm.example.com/v1?token=%3Credacted%3E"',
			'export JW_KEY="<你的 API key>"',
			'export JW_MODEL="m1"',
		]);
		expect(setupCommands({}, "win32", "en")).toEqual([
			'$env:JW_URL="https://api.example.com"',
			'$env:JW_KEY="<your API key>"',
			'$env:JW_MODEL="<model name>"',
		]);
	});
});

describe("formatWaConfig", () => {
	it("lays out groups with aligned columns, shows a configuration problem, and never the key", () => {
		// An error state.
		const lines = formatWaConfig(ENV, { kind: "error", message: "缺少：JW_MODEL" }, "linux", "zh");
		expect(lines.slice(0, 5)).toEqual([
			"JiaWriter 配置（只读，修改请设置环境变量）",
			"",
			"配置问题：",
			"  缺少：JW_MODEL",
			"",
		]);
		expect(lines.at(-1)).toBe("按任意键关闭");
		expect(lines.join("\n")).not.toContain("sk-secret");
		// Source columns line up (CJK values count two columns).
		const group = lines.slice(lines.indexOf("界面与检索") + 1, lines.indexOf("界面与检索") + 6);
		const col = (l: string) =>
			[...l.slice(0, l.lastIndexOf("  "))].reduce((w, c) => w + (/[　-鿿＀-￯]/.test(c) ? 2 : 1), 0);
		expect(new Set(group.map(col)).size).toBe(1);
		// Windows heading.
		expect(formatWaConfig({}, { kind: "none" }, "win32", "zh")).toContain(
			'设置命令（PowerShell，当前窗口有效；长期有效用 setx 变量名 "值"）',
		);
	});
});
