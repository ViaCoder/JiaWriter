// convertToolResultOutput (src/api/openai-responses-shared.ts), through convertResponsesMessages: a picture's own
// detail reaches the request, so JiaWriter's small views go out as "low"; a picture without one stays "auto".
import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, ImageContent, Usage } from "../src/types.ts";

// Nothing is counted in this test.
const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The image parts of the tool result's output, for a picture given as the tool's answer. */
function imageParts(picture: ImageContent): { type: string; detail?: string }[] {
	// A model that takes pictures.
	const model = getModel("openai", "gpt-4o-mini");
	const now = Date.now();
	// One tool call and its answer: words and the picture.
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "browser", arguments: { action: "look" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: now,
	};
	const context = normalizeContext({
		messages: [
			{ role: "user", content: "Look at the page", timestamp: now - 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "browser",
				content: [{ type: "text", text: "the page" }, picture],
				isError: false,
				timestamp: now + 1,
			},
		],
	});
	// The request's items, and of them the tool's answer.
	const input = convertResponsesMessages(model, context, new Set(["openai"]));
	const answer = input.find((item) => item.type === "function_call_output") as
		| { output: { type: string; detail?: string }[] }
		| undefined;
	return (answer?.output ?? []).filter((part) => part.type === "input_image");
}

describe("convertToolResultOutput", () => {
	it("sends a picture's own detail", () => {
		expect(getModel("openai", "gpt-4o-mini").input).toContain("image");
		expect(imageParts({ type: "image", data: "UElD", mimeType: "image/png", detail: "low" })).toEqual([
			expect.objectContaining({ type: "input_image", detail: "low" }),
		]);
	});

	it("keeps auto for a picture without one", () => {
		expect(imageParts({ type: "image", data: "UElD", mimeType: "image/png" })).toEqual([
			expect.objectContaining({ type: "input_image", detail: "auto" }),
		]);
	});
});
