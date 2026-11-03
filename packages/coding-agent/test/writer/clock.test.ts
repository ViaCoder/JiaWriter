// Tests for src/writer/clock.ts: the time each user message carries for the model.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import {
	correction,
	formatLocalTime,
	SKEW_LIMIT_MS,
	skewFromDate,
	timeNote,
	withTimeNotes,
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

describe("timeNote", () => {
	test("is one bracketed line, corrected by the offset", () => {
		expect(timeNote(T, 0, "Asia/Taipei")).toBe("[Sent 2026-11-03 18:42 Tuesday, Asia/Taipei, UTC+08:00]");
		expect(timeNote(T, 3_600_000, "Asia/Taipei")).toBe("[Sent 2026-11-03 19:42 Tuesday, Asia/Taipei, UTC+08:00]");
	});
});

describe("withTimeNotes", () => {
	test("puts the note first in every user message and leaves other messages and the input alone", () => {
		// A text message, a message with parts, and an assistant reply.
		const input = [
			{ role: "user", content: "写一篇综述", timestamp: T },
			{ role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: T + 1000 },
			{ role: "user", content: [{ type: "text", text: "继续" }], timestamp: T + 60_000 },
		] as unknown as AgentMessage[];
		const out = withTimeNotes(input, 0, "Asia/Taipei") as unknown as Array<{ content: unknown }>;
		expect(out[0].content).toBe("[Sent 2026-11-03 18:42 Tuesday, Asia/Taipei, UTC+08:00]\n写一篇综述");
		expect(out[1]).toBe(input[1]);
		expect(out[2].content).toEqual([
			{ type: "text", text: "[Sent 2026-11-03 18:43 Tuesday, Asia/Taipei, UTC+08:00]" },
			{ type: "text", text: "继续" },
		]);
		// The session's messages are not changed.
		expect((input[0] as unknown as { content: string }).content).toBe("写一篇综述");
	});

	test("gives the same text on every call, so earlier messages stay byte-identical", () => {
		// Two calls, and a call on already noted messages.
		const input = [{ role: "user", content: "a", timestamp: T }] as unknown as AgentMessage[];
		const once = withTimeNotes(input, 0, "Asia/Taipei");
		expect(withTimeNotes(input, 0, "Asia/Taipei")).toEqual(once);
		expect(withTimeNotes(once, 0, "Asia/Taipei")).toEqual(once);
	});
});
