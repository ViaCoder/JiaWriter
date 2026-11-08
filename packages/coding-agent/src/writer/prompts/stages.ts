/**
 * The table of what reaches the model and when. Stage 0 (core.ts and tool descriptions) and the date note
 * (clock.ts) go with every request; compaction has its own prompts in writer/compact. Everything else is
 * here: a stage names what triggers it, and extensions/writer-prompts adds its text once, until compaction.
 */

// The name of a file being read.
import { basename } from "node:path";
// The text of each stage.
import {
	BROWSER_MANUAL,
	CHECK_MANUALS,
	COMPUTER_MANUAL,
	EXPORT_MANUAL,
	MATERIAL_MANUAL,
	RESEARCH_MANUAL,
	RESTORE_MANUAL,
	WRITING_MANUAL,
} from "./manuals.ts";
import { FETCH_METHODS, SEARCH_METHODS } from "./methods.ts";

/** One stage. */
export interface PromptStage {
	// Unique name; what "already given" is tracked by.
	id: string;
	// Heading the model reads.
	title: string;
	// The rules.
	rules: readonly string[];
	// Tools whose successful result triggers it.
	tools: readonly string[];
	// Only with this method.
	method?: string;
	// Also when a skill file is read: that is the first step of writing a document.
	onSkill?: boolean;
}

/** Stage of the writing manual, also sent when a run starts inside a topic. */
export const WRITING_STAGE = "writing";

/** The stages of each method. */
function methodStages(tool: string, methods: Readonly<Record<string, readonly string[]>>): PromptStage[] {
	// One stage per method.
	return Object.entries(methods).map(([method, rules]) => ({
		id: `${tool}:${method}`,
		title: `Method ${method} of ${tool}`,
		rules,
		tools: [tool],
		method,
	}));
}

/** Every stage, in the order they are added to one result. */
export const PROMPT_STAGES: readonly PromptStage[] = [
	// Searching is not writing: these rules wait until a document is really started.
	{ id: WRITING_STAGE, title: "Writing rules", rules: WRITING_MANUAL, tools: ["write", "edit"], onSkill: true },
	{ id: "research", title: "Research rules", rules: RESEARCH_MANUAL, tools: ["search_web", "fetch_web"] },
	...methodStages("search_web", SEARCH_METHODS),
	...methodStages("fetch_web", FETCH_METHODS),
	{ id: "material", title: "Material rules", rules: MATERIAL_MANUAL, tools: ["material_add"] },
	...Object.entries(CHECK_MANUALS).map(([tool, rules]) => ({
		id: tool,
		title: `Using ${tool}`,
		rules,
		tools: [tool],
	})),
	{ id: "export", title: "Export rules", rules: EXPORT_MANUAL, tools: ["export_document"] },
	{ id: "restore", title: "Restoring", rules: RESTORE_MANUAL, tools: ["draft_restore"] },
	{ id: "browser", title: "Using the browser", rules: BROWSER_MANUAL, tools: ["browser"] },
	{ id: "computer", title: "Using the computer", rules: COMPUTER_MANUAL, tools: ["computer"] },
];

/** A stage as the model reads it. */
export function stageText(stage: PromptStage): string {
	// The heading, then one line per rule.
	return [`${stage.title}:`, ...stage.rules.map((rule) => `- ${rule}`)].join("\n");
}

/** Stages given so far: one set per process, shared by the extension and /jw prompts. */
const GIVEN_KEY = Symbol.for("jiawriter.promptsGiven");
const holder = globalThis as Record<symbol, Set<string> | undefined>;

/** The stages given so far. */
export function givenStages(): Set<string> {
	// Made on first use.
	holder[GIVEN_KEY] ??= new Set<string>();
	return holder[GIVEN_KEY];
}

/** The table as lines for /jw prompts: given or not, name, trigger, size. */
export function stageLines(): string[] {
	const given = givenStages();
	return PROMPT_STAGES.map((s) => {
		// What sets it off.
		const trigger = `${[...s.tools, ...(s.onSkill ? ["SKILL.md"] : [])].join(", ")}${s.method ? ` (${s.method})` : ""}`;
		return `${given.has(s.id) ? "✓" : "·"} ${s.title}: ${trigger}, ${stageText(s).length} chars`;
	});
}

/** The stages a successful tool call triggers that were not given yet. */
export function dueStages(tool: string, input: Record<string, unknown>, given: ReadonlySet<string>): PromptStage[] {
	// A skill being read.
	const skill = tool === "read" && basename(String(input.path ?? "")) === "SKILL.md";
	// This tool, this method if the stage names one, and not given yet.
	return PROMPT_STAGES.filter(
		(s) =>
			(s.tools.includes(tool) || (skill && s.onSkill === true)) &&
			(s.method === undefined || s.method === input.method) &&
			!given.has(s.id),
	);
}
