// Unit tests for the dates of search results and pages (2026-11-10): absoluteDate, relativeDate, dayOf, and the
// days normalizeResults gives.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import { absoluteDate, dayOf, normalizeResults, relativeDate } from "../../src/writer/websearch/core.ts";

// 2026-11-10 12:00 local time, the moment of a search.
const NOW = new Date(2026, 10, 10, 12, 0).getTime();

describe("absoluteDate", () => {
	it("reads numbers, 年月日 and English months as one day", () => {
		expect(absoluteDate("published 2026-10-31T08:00")).toBe("2026-10-31");
		expect(absoluteDate("新华社2026年10月3日电")).toBe("2026-10-03");
		expect(absoluteDate("Nov 7, 2026 · Reuters")).toBe("2026-11-07");
		expect(absoluteDate("7 November 2026")).toBe("2026-11-07");
		expect(absoluteDate("Sept. 3, 2026")).toBe("2026-09-03");
		// An age is not an absolute date.
		expect(absoluteDate("3 hours ago")).toBe("");
	});
});

describe("relativeDate", () => {
	it("counts an age back from the moment of the search", () => {
		expect(relativeDate("9小时前", NOW)).toBe("2026-11-10");
		expect(relativeDate("16小时前", NOW)).toBe("2026-11-09");
		expect(relativeDate("3 days ago", NOW)).toBe("2026-11-07");
		expect(relativeDate("昨天 08:00", NOW)).toBe("2026-11-09");
		expect(relativeDate("5 分钟前", NOW)).toBe("2026-11-10");
		expect(relativeDate("刚刚", NOW)).toBe("2026-11-10");
		expect(relativeDate("no age", NOW)).toBe("");
	});
});

describe("dayOf and normalizeResults", () => {
	it("gives every result a day or nothing", () => {
		expect(dayOf("2 hours ago", NOW)).toBe("2026-11-10");
		expect(dayOf("no date here", NOW)).toBe("");
		const [r] = normalizeResults(
			[{ title: "t", url: "https://a.example/x", snippet: "16小时前 消息", date: "" }],
			[],
			NOW,
		);
		expect(r.date).toBe("2026-11-09");
	});
});
