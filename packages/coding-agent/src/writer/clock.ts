/**
 * The date for the model. The first user message and the first of each later day start with a note such as
 * "[Date: 2026-11-03 Tuesday, Asia/Taipei]", and no other time reaches the model, so there is only one date to
 * read. Which messages carry it follows from their own timestamps, so old text never changes and the provider's
 * prompt cache keeps working. When the machine clock is off, the Date header of the model API's responses gives
 * the offset, and the date is corrected by it.
 */

// Message types of the conversation.
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Smallest clock offset (ms) that is corrected and reported: two minutes. */
export const SKEW_LIMIT_MS = 120_000;

/** Prefix of the time note at the start of a user message. */
const NOTE_PREFIX = "[Date: ";

/** "UTC+08:00" for an offset in minutes east of UTC. */
function utcOffset(minutes: number): string {
	// Sign, hours and minutes.
	const sign = minutes < 0 ? "-" : "+";
	const abs = Math.abs(minutes);
	return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** "2026-11-03 18:42 Tuesday, Asia/Taipei, UTC+08:00" for ms in timeZone (default: this machine's zone). */
export function formatLocalTime(ms: number, timeZone?: string): string {
	// The zone name this machine uses.
	const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	// Date and time parts in that zone.
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			weekday: "long",
			hourCycle: "h23",
		})
			.formatToParts(new Date(ms))
			.map((p) => [p.type, p.value]),
	);
	// The zone's offset at that moment: the same wall time read as UTC, minus the real instant.
	const wall = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
	);
	const offset = Math.round((wall - Math.floor(ms / 60_000) * 60_000) / 60_000);
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.weekday}, ${zone}, ${utcOffset(offset)}`;
}

/** Server time minus local time (ms) from an HTTP Date header; undefined when it is missing or unreadable. */
export function skewFromDate(header: string | undefined, nowMs: number): number | undefined {
	// No header.
	if (!header) return undefined;
	// RFC 7231 dates parse with Date.parse.
	const server = Date.parse(header);
	if (!Number.isFinite(server)) return undefined;
	// The header has whole seconds: half a second is the expected rounding.
	return server - nowMs;
}

/** The offset to apply: the measured skew when it is beyond the limit, else 0. */
export function correction(skewMs: number | undefined): number {
	// Small differences are network delay and rounding.
	return skewMs !== undefined && Math.abs(skewMs) >= SKEW_LIMIT_MS ? skewMs : 0;
}

/** The date note: the day alone, so the model has one date and never several times to choose from. */
export function dateNote(ms: number, offsetMs = 0, timeZone?: string): string {
	// "2026-11-03 18:42 Tuesday, Asia/Taipei, UTC+08:00" without the minutes and the offset.
	const [, date, weekday, zone] = /^(\S+) \S+ (\S+), ([^,]+)/.exec(formatLocalTime(ms + offsetMs, timeZone)) ?? [];
	return `${NOTE_PREFIX}${date} ${weekday}, ${zone}]`;
}

/** Add the date to the first user message and to the first of each later day; all others stay untouched. */
export function withDateNotes(messages: AgentMessage[], offsetMs = 0, timeZone?: string): AgentMessage[] {
	// The day of the last note.
	let day = "";
	return messages.map((m) => {
		// Only user messages with a timestamp count.
		if (m.role !== "user" || typeof m.timestamp !== "number") return m;
		const note = dateNote(m.timestamp, offsetMs, timeZone);
		// Same day: nothing to say. This depends only on the messages' own times, so old text never changes.
		if (note === day) return m;
		day = note;
		// Text content: the note on its own line first.
		if (typeof m.content === "string")
			return m.content.startsWith(NOTE_PREFIX) ? m : { ...m, content: `${note}\n${m.content}` };
		// Parts: a text part first.
		const first = m.content[0];
		if (first?.type === "text" && first.text.startsWith(NOTE_PREFIX)) return m;
		return { ...m, content: [{ type: "text" as const, text: note }, ...m.content] };
	});
}

/** Where the measured offset lives: one value per process on globalThis (every copy of this module sees it). */
const OFFSET_KEY = Symbol.for("jiawriter.clockOffset");
/** The process-wide holder. */
const offsetHolder = globalThis as Record<symbol, number | undefined>;

/** Remember the server-minus-local offset to apply (0 when the clock is right). */
export function setClockOffset(ms: number): void {
	// Stored for every reader in this process.
	offsetHolder[OFFSET_KEY] = ms;
}

/** The offset to apply to the local clock (ms). */
export function clockOffset(): number {
	// 0 until a response told otherwise.
	return offsetHolder[OFFSET_KEY] ?? 0;
}

/** The current local time as the model reads it ("2026-11-03 18:42 Tuesday, Asia/Taipei, UTC+08:00"). */
export function nowText(timeZone?: string): string {
	// The machine clock, corrected.
	return formatLocalTime(Date.now() + clockOffset(), timeZone);
}
