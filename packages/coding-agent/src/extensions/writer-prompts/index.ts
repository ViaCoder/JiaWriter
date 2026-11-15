/**
 * Built-in JiaWriter extension: the one place that gives the model the rules of a stage (writer/prompts/stages.ts).
 * Text is only appended, to a tool result or as a message, so the system prompt and the history never change
 * and the provider's cache stays valid. Each stage is given once, and again after compaction. The writing and
 * research rules come with their toolkits (extensions/writer-toolkit); this extension carries the stages a tool's
 * first success brings (methods, checks, export, browser, computer) and the notes of a run.
 */

// Message types.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Stages and their text.
import {
	dueStages,
	givenStages,
	listedSteps,
	PROMPT_STAGES,
	STEPS_FOR_TODO,
	stageText,
	stepsNote,
} from "../../writer/prompts/stages.ts";

/**
 * Told once to a session nobody can answer (print mode): a run on 2026-11-08 stopped at its outline, asking. Worded
 * for any task since 2026-11-15 (it spoke of materials and documents, and so did the model, to a greeting).
 */
export const NO_USER_NOTE =
	"Nobody can answer in this session: do not ask; settle open points the usual way, finish, and state your assumptions at the end";

/** The key of a tool result's details that names the stages it brought. */
export const STAGES_KEY = "jwStages";

/** Messages with the stages each tool result brought added after its own text, for the request only. */
export function withStageTexts(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((m) => {
		if (m.role !== "toolResult") return m;
		const ids = (m as { details?: Record<string, unknown> }).details?.[STAGES_KEY];
		if (!Array.isArray(ids) || ids.length === 0) return m;
		const text = PROMPT_STAGES.filter((s) => ids.includes(s.id))
			.map(stageText)
			.join("\n\n");
		if (!text) return m;
		return { ...m, content: [...(m as { content: unknown[] }).content, { type: "text", text }] } as AgentMessage;
	});
}

/** Extension factory. */
export default function writerPromptsExtension(pi: ExtensionAPI): void {
	/** Forget what was given: a shorter or another history may have lost it. */
	const forget = () => givenStages().clear();
	pi.on("session_compact", forget);
	pi.on("session_tree", forget);
	// Whether this session was told that nobody answers.
	let toldNoUser = false;
	pi.on("session_start", () => {
		toldNoUser = false;
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
		// The stages are named in the result's details and added to the request in context below, so the model reads
		// them and the screen does not (2026-11-08: "Using readability_check: …" showed in the interface). Details that
		// are not an object cannot carry the names: the text goes after the tool's own then.
		const details = event.details;
		if (details === undefined || (details !== null && typeof details === "object" && !Array.isArray(details)))
			return {
				content: event.content,
				details: { ...(details as object | undefined), [STAGES_KEY]: due.map((s) => s.id) },
			};
		const text = due.map(stageText).join("\n\n");
		return { content: [...event.content, { type: "text", text }], details };
	});

	// Every request: each result's stages after its own text.
	pi.on("context", (event) => ({ messages: withStageTexts(event.messages) }));

	// Without an interface there is nobody to answer a question: said once, before the first run. A request that
	// lists several items gets the task-list note, now that it applies.
	pi.on("before_agent_start", (event, ctx) => {
		// One message holds whatever is due.
		const parts: { type: string; text: string }[] = [];
		if (event.messageType === "user") {
			const steps = listedSteps(event.prompt);
			if (steps >= STEPS_FOR_TODO) parts.push({ type: "jiawriter-steps", text: stepsNote(steps) });
		}
		if (!ctx.hasUI && !toldNoUser) {
			toldNoUser = true;
			parts.push({ type: "jiawriter-no-user", text: NO_USER_NOTE });
		}
		if (parts.length === 0) return;
		// The model reads it; the conversation on screen stays as it was.
		const content = parts.map((p) => p.text).join("\n\n");
		return { message: { customType: parts[0].type, content, display: false } };
	});
}
