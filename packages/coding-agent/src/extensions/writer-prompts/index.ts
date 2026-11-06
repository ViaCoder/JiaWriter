/**
 * Built-in JiaWriter extension: the one place that gives the model the rules of a stage (writer/prompts/stages.ts).
 * Text is only appended, to a tool result or as a message, so the system prompt and the history never change
 * and the provider's cache stays valid. Each stage is given once, and again after compaction.
 */

// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Stages and their text.
import { dueStages, givenStages, PROMPT_STAGES, stageText, WRITING_STAGE } from "../../writer/prompts/stages.ts";
// The open topic.
import { currentTopic } from "../../writer/topic/current.ts";

/** Extension factory. */
export default function writerPromptsExtension(pi: ExtensionAPI): void {
	// A shorter or another history may have lost what was given.
	const forget = () => givenStages().clear();
	pi.on("session_start", forget);
	pi.on("session_compact", forget);
	pi.on("session_tree", forget);

	// A stage arrives with the first success of its tool.
	pi.on("tool_result", (event) => {
		// A failed call taught nothing yet.
		if (event.isError) return;
		const given = givenStages();
		// What this call brings that was not given.
		const due = dueStages(event.toolName, event.input.method, given);
		if (due.length === 0) return;
		// Each stage once.
		for (const stage of due) given.add(stage.id);
		// After the tool's own text, which stays as it is.
		const text = due.map(stageText).join("\n\n");
		return { content: [...event.content, { type: "text", text }], details: event.details };
	});

	// A run inside a topic needs the writing rules even when no tool triggers them first.
	pi.on("before_agent_start", () => {
		const given = givenStages();
		// Outside a topic, or already given: nothing to add.
		if (!currentTopic() || given.has(WRITING_STAGE)) return;
		const stage = PROMPT_STAGES.find((s) => s.id === WRITING_STAGE);
		if (!stage) return;
		given.add(stage.id);
		// The model reads it; the conversation on screen stays as it was.
		return { message: { customType: "jiawriter-rules", content: stageText(stage), display: false } };
	});
}
