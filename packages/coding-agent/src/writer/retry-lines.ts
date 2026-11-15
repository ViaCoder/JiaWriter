/**
 * Failed attempts and retries on screen (2026-11-15: a request the model address refused showed three lines of
 * "Error: Connection error." and then a fourth for the final failure, as Claude Code shows one). An attempt that
 * failed without producing anything is taken off the screen when the retry begins, and when the retries are
 * exhausted only the summary line stays.
 */

// Message types.
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** True when the assistant message is a failed attempt with nothing shown besides its error: no text, no tool call. */
export function emptyFailure(message: Pick<AssistantMessage, "stopReason" | "content"> | undefined): boolean {
	if (!message || (message.stopReason !== "error" && message.stopReason !== "aborted")) return false;
	return message.content.every((part) => (part.type === "text" ? part.text.trim() === "" : part.type === "thinking"));
}
