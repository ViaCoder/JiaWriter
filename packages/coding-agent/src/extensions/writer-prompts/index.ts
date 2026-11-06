/**
 * Built-in JiaWriter extension: the one place that gives the model the rules of a stage (writer/prompts/stages.ts).
 * Text is only appended, to a tool result or as a message, so the system prompt and the history never change
 * and the provider's cache stays valid. Each stage is given once, and again after compaction.
 */

// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Stages and their text.
import { dueStages, givenStages, PROMPT_STAGES, stageText, WRITING_STAGE } from "../../writer/prompts/stages.ts";

/** Extension factory. */
export default function writerPromptsExtension(pi: ExtensionAPI): void {
	// A document was under way when compaction cleared the record.
	let writing = false;
	/** Forget what was given: a shorter or another history may have lost it. */
	const forget = () => {
		const given = givenStages();
		// Only writing that had started goes on after this.
		writing = given.has(WRITING_STAGE);
		given.clear();
	};
	pi.on("session_compact", forget);
	pi.on("session_tree", forget);
	// A new session has written nothing yet.
	pi.on("session_start", () => {
		writing = false;
		givenStages().clear();
	});

	// A stage arrives with the first success of its tool.
	pi.on("tool_result", (event) => {
		// A failed call taught nothing yet.
		if (event.isError) return;
		const given = givenStages();
		// What this call brings that was not given.
		const due = dueStages(event.toolName, event.input, given);
		if (due.length === 0) return;
		// Each stage once.
		for (const stage of due) given.add(stage.id);
		// After the tool's own text, which stays as it is.
		const text = due.map(stageText).join("\n\n");
		return { content: [...event.content, { type: "text", text }], details: event.details };
	});

	// After compaction a document under way needs its rules back; a topic alone asks for nothing.
	pi.on("before_agent_start", () => {
		const given = givenStages();
		if (!writing || given.has(WRITING_STAGE)) return;
		const stage = PROMPT_STAGES.find((s) => s.id === WRITING_STAGE);
		if (!stage) return;
		given.add(stage.id);
		// The model reads it; the conversation on screen stays as it was.
		return { message: { customType: "jiawriter-rules", content: stageText(stage), display: false } };
	});
}
