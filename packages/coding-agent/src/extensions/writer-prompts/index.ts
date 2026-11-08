/**
 * Built-in JiaWriter extension: the one place that gives the model the rules of a stage (writer/prompts/stages.ts).
 * Text is only appended, to a tool result or as a message, so the system prompt and the history never change
 * and the provider's cache stays valid. Each stage is given once, and again after compaction.
 */

// Message types.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Stages and their text.
import { dueStages, givenStages, PROMPT_STAGES, stageText, WRITING_STAGE } from "../../writer/prompts/stages.ts";

/** Told once to a session nobody can answer (print mode): a run on 2026-11-08 stopped at its outline, asking. */
export const NO_USER_NOTE =
	"Nobody can answer in this session: do not ask; settle open points from the materials and the document's usual form, finish, and state your assumptions at the end";

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
	// Whether this session was told that nobody answers.
	let toldNoUser = false;
	// A new session has written nothing yet.
	pi.on("session_start", () => {
		writing = false;
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

	// Without an interface there is nobody to answer a question: said once, before the first run. After compaction a
	// document under way needs its rules back; a topic alone asks for nothing.
	pi.on("before_agent_start", (_event, ctx) => {
		if (!ctx.hasUI && !toldNoUser) {
			toldNoUser = true;
			return { message: { customType: "jiawriter-no-user", content: NO_USER_NOTE, display: false } };
		}
		const given = givenStages();
		if (!writing || given.has(WRITING_STAGE)) return;
		const stage = PROMPT_STAGES.find((s) => s.id === WRITING_STAGE);
		if (!stage) return;
		given.add(stage.id);
		// The model reads it; the conversation on screen stays as it was.
		return { message: { customType: "jiawriter-rules", content: stageText(stage), display: false } };
	});
}
