/**
 * The topic this process is working on. One value per process on globalThis, so every copy of this module
 * (the extension loader may evaluate modules twice) sees the same topic. It is restored from the session,
 * whose tool results carry the topic folder in details.topicDir.
 */

// Folder creation and the name of an unnamed topic.
import { openAutoTopic } from "./topic.ts";

/** Holder key. */
const KEY = Symbol.for("jiawriter.topic");
/** The process-wide holder. */
const holder = globalThis as Record<symbol, string | undefined>;

/** Folder of the current topic, if any. */
export function currentTopic(): string | undefined {
	// As set last.
	return holder[KEY];
}

/** Set or clear the current topic. */
export function setCurrentTopic(dir: string | undefined): void {
	// One value for the process.
	holder[KEY] = dir;
}

/** The current topic; when work started before one was named, one named after the search or page at hand. */
export function ensureTopic(cwd: string, hint: string, now = new Date()): string {
	// Nothing is lost when the model skips topic_open.
	const dir = currentTopic() ?? openAutoTopic(cwd, hint, now);
	setCurrentTopic(dir);
	return dir;
}

/** The latest topic folder in a session branch, from the details of its tool results. */
export function topicFromEntries(entries: readonly unknown[]): string | undefined {
	// Newest first.
	for (const entry of [...entries].reverse()) {
		const message = (entry as { message?: { role?: string; details?: { topicDir?: unknown } } }).message;
		if (message?.role === "toolResult" && typeof message.details?.topicDir === "string")
			return message.details.topicDir;
	}
	return undefined;
}
