// Methods that are down for a session: which failures last, and the extension's refusal of a second try.
import { describe, expect, it } from "vitest";
import { lastingFailure, newMethodHealth, recordMethod } from "../../src/writer/websearch/method-health.ts";

describe("lastingFailure", () => {
	it("takes refused requests, missing keys and a missing extension as lasting, and busy servers as passing", () => {
		expect(lastingFailure("firecrawl 请求失败（HTTP 400）。")).toBe(true);
		expect(lastingFailure("browser 方式现在不可用：Chrome 里的 JiaWriter 扩展没有连接。")).toBe(true);
		expect(lastingFailure("firecrawl 方式需要 FIRECRAWL_KEY。")).toBe(true);
		expect(lastingFailure("deepseek 请求失败（HTTP 503）。")).toBe(false);
		expect(lastingFailure("firecrawl 请求失败（HTTP 429）。")).toBe(false);
		// A page that is not there says nothing about the method.
		expect(lastingFailure("deepseek 无法读取该网页（HTTP 404）：https://a.example/")).toBe(false);
	});
});

describe("recordMethod", () => {
	it("marks a method down after a lasting failure and up again after a success", () => {
		const health = newMethodHealth();
		recordMethod(health, "firecrawl", true, "firecrawl 请求失败（HTTP 400）。\n详情");
		recordMethod(health, "deepseek", true, "deepseek 请求失败（HTTP 503）。");
		recordMethod(health, "anysearch", false, "结果");
		expect([...health.down.entries()]).toEqual([["firecrawl", "firecrawl 请求失败（HTTP 400）。"]]);
		expect([...health.worked]).toEqual(["anysearch"]);
		recordMethod(health, "firecrawl", false, "结果");
		expect(health.down.size).toBe(0);
	});
});
