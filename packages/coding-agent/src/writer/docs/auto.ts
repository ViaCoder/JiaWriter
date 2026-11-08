/**
 * Automatic export: at the end of each run, the Markdown drafts the agent wrote or edited in that run
 * are exported to .docx with the default profile. Notes, outlines, reference copies and drafts the
 * model already exported after its last change are left alone. JW_AUTO_EXPORT=off turns it off.
 */

// Paths.
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
// The topic folders that hold research, not drafts.
import { TOPIC_DIRS } from "../topic/topic.ts";
// Reference folders and the parsed-copy folder.
import { PARSED_DIR, SOURCE_DIRS } from "./import.ts";

/** One message of a run, as far as this module reads it. */
export interface RunMessage {
	// user, assistant or toolResult.
	role: string;
	// Assistant content blocks (tool calls among them).
	content?: unknown;
	// Tool results: the call they answer and whether it failed.
	toolCallId?: string;
	isError?: boolean;
}

// Names of working material, not a draft: notes, materials, the working outline, plans, to-do lists. Only the whole
// name: a deliverable named after its document, such as 工作方案提纲, is a draft and is checked and exported (a
// 2026-11-08 outline the user asked for skipped both under the old rule, which matched any name containing 提纲).
// Notes, materials and to-do lists whatever comes first (素材笔记); an outline or plan only by that name alone, since
// 工作计划 and 方案提纲 are documents.
const NOT_DRAFT =
	/(?:笔记|素材|待办|notes?|todo|readme|changelog)(?:[-_ ]?\d+)?$|^(?:大纲|提纲|计划|outline|plan)(?:[-_ ]?\d+)?$/i;

/** True unless JW_AUTO_EXPORT is off, 0, false or no. */
export function autoExportEnabled(env: NodeJS.ProcessEnv): boolean {
	// Off switches.
	return !/^(off|0|false|no)$/i.test((env.JW_AUTO_EXPORT ?? "").trim());
}

/** True for a Markdown file in the working folder that reads as a draft. */
export function isDraftPath(path: string, cwd: string): boolean {
	// Markdown only, not an export copy.
	const ext = extname(path).toLowerCase();
	if ((ext !== ".md" && ext !== ".markdown") || path.endsWith(".export.md")) return false;
	// Inside the working folder.
	const rel = relative(cwd, path);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
	// Not in a hidden folder, a reference folder or the parsed copies.
	const parts = rel.split(sep).slice(0, -1);
	const research: string[] = [TOPIC_DIRS.search, TOPIC_DIRS.web];
	if (parts.some((p) => p.startsWith(".") || p === PARSED_DIR || SOURCE_DIRS.includes(p) || research.includes(p)))
		return false;
	// Not notes or an outline.
	return !NOT_DRAFT.test(basename(path, ext));
}

/** Drafts written or edited successfully in the run and not exported by the model since their last change. */
export function editedDrafts(messages: readonly RunMessage[], cwd: string): string[] {
	// Failed tool calls by id.
	const failed = new Set(messages.filter((m) => m.role === "toolResult" && m.isError).map((m) => m.toolCallId));
	// Last change and last export per draft, by position.
	const changed = new Map<string, number>();
	const exported = new Map<string, number>();
	let at = 0;
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content as {
			type?: string;
			id?: string;
			name?: string;
			arguments?: { path?: unknown };
		}[]) {
			at++;
			if (block.type !== "toolCall" || failed.has(block.id) || typeof block.arguments?.path !== "string") continue;
			const abs = resolve(cwd, block.arguments.path);
			if (block.name === "write" || block.name === "edit") changed.set(abs, at);
			else if (block.name === "export_document") exported.set(abs, at);
		}
	}
	// Drafts in the order they were first changed.
	return [...changed.entries()]
		.filter(([p, when]) => isDraftPath(p, cwd) && (exported.get(p) ?? 0) < when)
		.map(([p]) => p);
}
