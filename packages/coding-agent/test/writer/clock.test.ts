// Tests for src/writer/clock.ts: the date the model reads.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import {
	correction,
	dateNote,
	formatLocalTime,
	SKEW_LIMIT_MS,
	skewFromDate,
	withDateNotes,
} from "../../src/writer/clock.ts";

// 2026-11-03T10:42:30Z.
const T = Date.UTC(2026, 10, 3, 10, 42, 30);

describe("formatLocalTime", () => {
	test("gives date, time, weekday, zone and offset in the zone asked for", () => {
		// Taipei is UTC+8 all year.
		expect(formatLocalTime(T, "Asia/Taipei")).toBe("2026-11-03 18:42 Tuesday, Asia/Taipei, UTC+08:00");
		// A zone west of UTC: 05:42 the same day in New York (EST, UTC-5).
		expect(formatLocalTime(T, "America/New_York")).toBe("2026-11-03 05:42 Tuesday, America/New_York, UTC-05:00");
		// Half-hour offsets.
		expect(formatLocalTime(T, "Asia/Kolkata")).toBe("2026-11-03 16:12 Tuesday, Asia/Kolkata, UTC+05:30");
	});
});

describe("skewFromDate", () => {
	test("reads the HTTP Date header against the local clock", () => {
		// The server is five minutes ahead.
		expect(skewFromDate("Tue, 03 Nov 2026 10:47:30 GMT", T)).toBe(300_000);
	});

	test("gives undefined for a missing or unreadable header", () => {
		expect(skewFromDate(undefined, T)).toBeUndefined();
		expect(skewFromDate("not a date", T)).toBeUndefined();
	});
});

describe("correction", () => {
	test("applies only offsets of two minutes or more", () => {
		expect(correction(undefined)).toBe(0);
		expect(correction(SKEW_LIMIT_MS - 1)).toBe(0);
		expect(correction(-SKEW_LIMIT_MS)).toBe(-SKEW_LIMIT_MS);
		expect(correction(600_000)).toBe(600_000);
	});
});

describe("dateNote", () => {
	test("is the day alone, corrected by the offset", () => {
		expect(dateNote(T, 0, "Asia/Taipei")).toBe("[Date: 2026-11-03 Tuesday, Asia/Taipei]");
		expect(dateNote(T, 86_400_000, "Asia/Taipei")).toBe("[Date: 2026-11-04 Wednesday, Asia/Taipei]");
	});
});

describe("withDateNotes", () => {
	const user = (content: unknown, timestamp: number) => ({ role: "user", content, timestamp });
	const DAY = 86_400_000;

	test("dates the first user message only, in text or in parts, and leaves the input alone", () => {
		const input = [
			user("写一篇综述", T),
			{ role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: T + 1000 },
			user([{ type: "text", text: "继续" }], T + 60_000),
		] as unknown as AgentMessage[];
		const out = withDateNotes(input, 0, "Asia/Taipei") as unknown as Array<{ content: unknown }>;
		expect(out[0].content).toBe("[Date: 2026-11-03 Tuesday, Asia/Taipei]\n写一篇综述");
		expect(out[1]).toBe(input[1]);
		expect(out[2]).toBe(input[2]);
		expect((input[0] as unknown as { content: string }).content).toBe("写一篇综述");
		const parts = withDateNotes(
			[user([{ type: "text", text: "甲" }], T)] as unknown as AgentMessage[],
			0,
			"Asia/Taipei",
		);
		expect((parts[0] as unknown as { content: unknown }).content).toEqual([
			{ type: "text", text: "[Date: 2026-11-03 Tuesday, Asia/Taipei]" },
			{ type: "text", text: "甲" },
		]);
	});

	test("adds one note when the day changes", () => {
		const input = [user("甲", T), user("乙", T + 1000), user("丙", T + DAY), user("丁", T + DAY + 1000)];
		const out = withDateNotes(input as unknown as AgentMessage[], 0, "Asia/Taipei") as unknown as {
			content: unknown;
		}[];
		expect(JSON.stringify(out).match(/\[Date: /g)).toHaveLength(2);
		expect(String(out[2].content)).toContain("2026-11-04");
		expect(out[3]).toBe(input[3]);
	});

	test("never changes an earlier message when a later one arrives", () => {
		const before = [user("甲", T), user("乙", T + 1000)];
		const first = withDateNotes(before as unknown as AgentMessage[], 0, "Asia/Taipei");
		const second = withDateNotes([...before, user("丙", T + 2000)] as unknown as AgentMessage[], 0, "Asia/Taipei");
		expect(JSON.stringify(second.slice(0, 2))).toBe(JSON.stringify(first));
		// Notes already there are not doubled.
		expect(withDateNotes(first, 0, "Asia/Taipei")[0]).toEqual(first[0]);
	});
});
