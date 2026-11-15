/**
 * Opening a toolkit: its tools join the active set (pi records the set in the transcript and restores it with the
 * session), the stages its text carries count as given, and the text the model reads comes back. Shared by the
 * toolkit tool, the commands (/write, /research, /search, /computer, /import-doc, /export-doc) and the
 * program's own detection.
 */

// Paths.
import { join } from "node:path";
// Agent directory and the built-in skills folder.
import { getAgentDir, getWriterSkillsDir } from "../../config.ts";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// The stages given so far.
import { givenStages } from "../prompts/stages.ts";
// Skill files.
import { listSkills } from "../skills/manage.ts";
import { type OfferedSkill, TOOLKIT_MARKS, TOOLKITS, type ToolkitId, toolkitText } from "./toolkits.ts";

/** What opening gave: whether the toolkit was closed before, and the text for the model. */
export interface OpenOutcome {
	opened: boolean;
	text: string;
}

/** The skills turned on, built-in and the user's, as the toolkit texts offer them. */
export function offeredSkills(agentDir = getAgentDir(), builtinDir = getWriterSkillsDir()): OfferedSkill[] {
	try {
		return listSkills(agentDir, builtinDir)
			.filter((s) => s.enabled)
			.map((s) => ({ name: s.name, description: s.description, path: join(s.dir, "SKILL.md") }));
	} catch {
		return [];
	}
}

/** Whether the writing toolkit is open: the program's document checks and exports apply only then (2026-11-15: a
 * plain note written to 说明.md was checked for 公文 habits and exported to Word). */
export function writingOpen(pi: Pick<ExtensionAPI, "getActiveTools">): boolean {
	return pi.getActiveTools().includes(TOOLKIT_MARKS.writing);
}

/** Open a toolkit for this session. */
export function openToolkit(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
	id: ToolkitId,
	opts: { hasUI: boolean; skills?: readonly OfferedSkill[] },
): OpenOutcome {
	const kit = TOOLKITS[id];
	// JW_BROWSER=off and JW_COMPUTER=off keep those tools out, as before the toolkits.
	const off =
		(id === "browser" && process.env.JW_BROWSER === "off") ||
		(id === "computer" && process.env.JW_COMPUTER === "off");
	if (off)
		return { opened: false, text: `Toolkit ${id} is turned off in this installation (JW_${id.toUpperCase()}=off).` };
	const active = pi.getActiveTools();
	// Closed when some tool of it is not active yet; a tool that is not registered (an allowlist left it out) cannot
	// join, so the toolkit counts as open once the active set has all it can take.
	const missing = kit.tools.filter((tool) => !active.includes(tool));
	if (missing.length > 0) pi.setActiveTools([...new Set([...active, ...kit.tools])]);
	const opened = missing.length > 0 && pi.getActiveTools().length > active.length;
	// The stage text comes with the toolkit, so the tool's first success does not bring it again.
	const given = givenStages();
	for (const stage of kit.stages) given.add(stage);
	return { opened, text: toolkitText(id, { skills: opts.skills ?? offeredSkills(), hasUI: opts.hasUI }) };
}
