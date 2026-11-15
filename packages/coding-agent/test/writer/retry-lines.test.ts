// Failed attempts on screen: which ones a retry takes away.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { emptyFailure } from "../../src/writer/retry-lines.ts";

const message = (stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]) => ({
	stopReason,
	content,
});

describe("emptyFailure", () => {
	it("is true for an error or abort with no text and no tool call, else false", () => {
		expect(emptyFailure(message("error", []))).toBe(true);
		expect(emptyFailure(message("error", [{ type: "text", text: "  " }]))).toBe(true);
		expect(emptyFailure(message("aborted", [{ type: "thinking", thinking: "…" }]))).toBe(true);
		expect(emptyFailure(message("error", [{ type: "text", text: "开头写到一半" }]))).toBe(false);
		expect(emptyFailure(message("error", [{ type: "toolCall", id: "1", name: "read", arguments: {} }]))).toBe(false);
		expect(emptyFailure(message("stop", []))).toBe(false);
		expect(emptyFailure(undefined)).toBe(false);
	});
});
