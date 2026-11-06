// Regressions from the code review: each case is a step that used to do the wrong thing.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freeName } from "../../src/extensions/writer-docs/index.ts";
import { isEffort } from "../../src/extensions/writer-ui/index.ts";
import { decodedName } from "../../src/writer/browser/fetch.ts";
import { nowText, setClockOffset } from "../../src/writer/clock.ts";
import { decodeXml } from "../../src/writer/docs/docx-read.ts";
import { archivedUrls, archivePage, openTopic, safeName } from "../../src/writer/topic/topic.ts";
import { anysearchSearch } from "../../src/writer/websearch/anysearch.ts";
import { normalizeResults, readSearchEnv } from "../../src/writer/websearch/core.ts";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jw-logic-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	setClockOffset(0);
	vi.useRealTimers();
});

describe("freeName", () => {
	it("keeps the name when it is free or the file is the same", () => {
		const a = join(dir, "a.txt");
		writeFileSync(a, "甲");
		const folder = mkdtempSync(join(dir, "refs-"));
		expect(freeName(folder, a)).toBe(join(folder, "a.txt"));
		writeFileSync(join(folder, "a.txt"), "甲");
		expect(freeName(folder, a)).toBe(join(folder, "a.txt"));
	});

	it("never takes the name of a different file", () => {
		const a = join(dir, "报告.pdf");
		writeFileSync(a, "新");
		const folder = mkdtempSync(join(dir, "refs-"));
		writeFileSync(join(folder, "报告.pdf"), "旧");
		expect(freeName(folder, a)).toBe(join(folder, "报告-2.pdf"));
		writeFileSync(join(folder, "报告-2.pdf"), "也不同");
		expect(freeName(folder, a)).toBe(join(folder, "报告-3.pdf"));
		expect(readFileSync(join(folder, "报告.pdf"), "utf-8")).toBe("旧");
	});
});

describe("names and text", () => {
	it("keeps a file name that is not valid percent-encoding", () => {
		expect(decodedName("100%.pdf")).toBe("100%.pdf");
		expect(decodedName("%E6%8A%A5%E5%91%8A.pdf")).toBe("报告.pdf");
	});

	it("leaves no dot or space at the end of a cut name", () => {
		expect(safeName(`${"甲".repeat(39)}.后面的字`)).toBe("甲".repeat(39));
		expect(safeName(`${"甲".repeat(39)} 后面的字`)).toBe("甲".repeat(39));
		expect(safeName("..甲..")).toBe("甲");
	});

	it("keeps an entity outside Unicode instead of failing the file", () => {
		expect(decodeXml("甲&#9999999;乙&#x4e2d;")).toBe("甲&#9999999;乙中");
	});
});

describe("archivePage", () => {
	it("counts a new way to a page it already holds", () => {
		const { dir: topic } = openTopic(dir, "t");
		const page = { url: "https://a.example/final", title: "T", date: "", content: "正文" };
		archivePage(topic, page, "https://a.example/final", "sf", "时间");
		archivePage(topic, page, "https://a.example/short", "sf", "时间");
		expect(archivedUrls(topic)).toContain("a.example/short");
	});
});

describe("search results", () => {
	it("reads the date from the head of a long text only", () => {
		const long = `${"正文".repeat(400)}2020年1月2日的旧事`;
		const [r] = normalizeResults([{ title: "T", url: "https://a.example/", snippet: long, date: "" }], []);
		expect(r.date).toBe("");
		expect(r.snippet).toBe(long);
	});

	it("keeps every result without an address", () => {
		const raw = [
			{ title: "甲", url: "", snippet: "", date: "" },
			{ title: "乙", url: "", snippet: "", date: "" },
		];
		expect(normalizeResults(raw, [])).toHaveLength(2);
	});

	it("does not take a date from far into AnySearch's text", async () => {
		const content = `${"正文".repeat(1200)}2020年1月2日`;
		const fetchFn = async () =>
			new Response(
				JSON.stringify({ code: 0, data: { results: [{ title: "T", url: "https://a.example/", content }] } }),
			);
		const out = await anysearchSearch(readSearchEnv({}), "q", {}, undefined, fetchFn);
		expect(out[0].date).toBe("");
		expect(out[0].snippet).toBe(content);
	});

	it("reports an answer that is not JSON without its text", async () => {
		const fetchFn = async () => new Response("<html>password=秘密</html>");
		const error = await anysearchSearch(readSearchEnv({}), "q", {}, undefined, fetchFn).catch((e: Error) => e);
		expect((error as Error).message).not.toContain("秘密");
	});
});

describe("small helpers", () => {
	it("tells the effort levels", () => {
		expect(isEffort("high")).toBe(true);
		expect(isEffort("highest")).toBe(false);
	});

	it("gives the corrected time for the archive", () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 10, 3, 10, 42) });
		expect(nowText("Asia/Taipei")).toContain("2026-11-03 18:42");
		setClockOffset(3_600_000);
		expect(nowText("Asia/Taipei")).toContain("2026-11-03 19:42");
	});
});
