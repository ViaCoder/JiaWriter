// Unit tests for src/writer/i18n (resolveLang, t, the message tables).

// Test API; stubEnv restores WA_LANG.
import { afterEach, describe, expect, it, vi } from "vitest";
// English table.
import { en } from "../../src/writer/i18n/en.ts";
// Functions under test.
import { resolveLang, t } from "../../src/writer/i18n/index.ts";
// Chinese table.
import { zh } from "../../src/writer/i18n/zh.ts";

// Undo WA_LANG changes.
afterEach(() => vi.unstubAllEnvs());

describe("resolveLang", () => {
	it("returns en for en, EN, en-US and en_GB", () => {
		// Every English spelling.
		for (const v of ["en", "EN", " en ", "en-US", "en_GB"]) expect(resolveLang(v)).toBe("en");
	});
	it("returns zh when unset, empty, zh or anything else", () => {
		// Chinese is the default.
		for (const v of [undefined, "", "zh", "zh-CN", "fr", "eng"]) expect(resolveLang(v)).toBe("zh");
	});
});

describe("t", () => {
	it("fills placeholders and keeps unknown ones visible", () => {
		// Known value filled, missing one kept.
		expect(t("style.hits", { count: 3 }, "zh")).toBe("逐处命中 3 处：");
		// No vars at all.
		expect(t("count.title", {}, "en")).toBe("Word count");
		// A missing variable stays as {name}.
		expect(t("style.hits", {}, "zh")).toContain("{count}");
	});
	it("follows WA_LANG when no language is passed", () => {
		// English from the environment.
		vi.stubEnv("WA_LANG", "en");
		// English text.
		expect(t("style.clean")).toBe("Check passed: no hits.");
		// Chinese from the environment.
		vi.stubEnv("WA_LANG", "zh");
		// Chinese text.
		expect(t("style.clean")).toBe("检查通过：没有命中。");
	});
});

describe("message tables", () => {
	it("have the same keys and keep the same placeholders", () => {
		// Same key set.
		expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
		// Placeholders of one message.
		const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
		// Each key uses the same placeholders in both languages.
		for (const key of Object.keys(zh) as (keyof typeof zh)[]) expect(names(en[key])).toEqual(names(zh[key]));
	});
	it("Chinese messages use full-width punctuation", () => {
		// ASCII , ; : ! ? ( ) next to a Chinese character.
		const ascii = /[一-鿿][,;:!?()]|[,;:!?()][一-鿿]/;
		// No message mixes them.
		for (const text of Object.values(zh)) expect(text).not.toMatch(ascii);
	});
});
