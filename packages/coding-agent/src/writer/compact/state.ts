/**
 * Compaction for writing. The topic folder is the memory: what can be read back from disk is written into the
 * summary by the program, so it is exact, survives repeated compaction, and is there even when the model's
 * summary fails. The model only adds what the files do not show. Research results are already archived, so they
 * reach the summary request as one line each.
 */

// Reading the topic folder.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
// Message and session types.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
} from "../../core/compaction/compaction.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
// Topic folder names, and its index.
import { MATERIAL_FILE, readIndex, TOPIC_DIRS } from "../topic/topic.ts";
// Draft length.
import { wordCount } from "../word-count.ts";

/** Share of the context window left free: compaction starts at 80%, before a long draft can overflow. */
const RESERVE_SHARE = 0.2;
/** Share of the context window kept after compaction. */
const KEEP_SHARE = 0.15;
/** Characters of the user's own words kept in a summary, newest first. */
const MAX_USER_CHARS = 4000;
/** Longest text left of a tool result without an archive line. */
const MAX_RESULT_CHARS = 200;
/** Where the program's part ends and the model's begins. */
const MODEL_PART = "## Decisions";
/** Tools whose results can be found again on disk. */
const ARCHIVED_TOOLS = new Set(["search_web", "fetch_web", "read", "import_document"]);

/** Automatic compaction scaled to the context window; a value the user configured stays as it is. */
export function writerCompactionSettings<T extends CompactionSettings>(settings: T, contextWindow: number): T {
	// Unknown window: as configured.
	if (contextWindow <= 0) return settings;
	// Only the untouched defaults follow the window.
	const scaled = (value: number, fallback: number, share: number) =>
		value === fallback ? Math.max(value, Math.floor(contextWindow * share)) : value;
	return {
		...settings,
		reserveTokens: scaled(settings.reserveTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens, RESERVE_SHARE),
		keepRecentTokens: scaled(settings.keepRecentTokens, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, KEEP_SHARE),
	};
}

/** The text of a message's content. */
function textOf(content: unknown): string {
	// Plain text.
	if (typeof content === "string") return content;
	// Nothing readable.
	if (!Array.isArray(content)) return "";
	// Text parts only.
	return content
		.flatMap((part: { type?: string; text?: string }) => (part.type === "text" && part.text ? [part.text] : []))
		.join("\n");
}

/** A tool result as one line: where it is archived, or its beginning. */
function pointer(text: string, path: string | undefined): string {
	// The line writer-search adds after archiving.
	const archived = text.split("\n").find((line) => /^(已归档|Archived)[：:]/.test(line));
	if (archived) return archived;
	// A read file is on disk under its own name.
	if (path) return `Read ${path}`;
	// Anything else keeps its start.
	return text.slice(0, MAX_RESULT_CHARS);
}

/** Messages for the summary request, with archived results as one line. The history itself does not change. */
export function slimForSummary(messages: readonly AgentMessage[]): AgentMessage[] {
	// The path of each read call.
	const paths = new Map<string, string>();
	for (const m of messages) {
		// Calls are in the assistant's messages.
		if (m.role !== "assistant") continue;
		for (const part of m.content)
			if (part.type === "toolCall" && part.name === "read") paths.set(part.id, String(part.arguments.path ?? ""));
	}
	return messages.map((m) => {
		// Only results that can be found again.
		if (m.role !== "toolResult" || !ARCHIVED_TOOLS.has(m.toolName)) return m;
		// One line in place of the text.
		const line = pointer(textOf(m.content), paths.get(m.toolCallId));
		return { ...m, content: [{ type: "text" as const, text: line }] };
	});
}

/** Everything the user said on this branch, newest kept when it is too long, in reading order. */
function userWords(entries: readonly SessionEntry[]): string[] {
	const said: string[] = [];
	// Room left, filled from the newest message back.
	let left = MAX_USER_CHARS;
	for (const entry of [...entries].reverse()) {
		// The user's messages only.
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = textOf(entry.message.content).trim();
		if (!text) continue;
		// Whole messages: the first that does not fit ends it.
		if (text.length > left) break;
		left -= text.length;
		// In reading order.
		said.unshift(text);
	}
	return said;
}

/** The genre: the skill read last on this branch. */
function genre(entries: readonly SessionEntry[]): string {
	let name = "";
	for (const entry of entries) {
		// Reads are calls in the assistant's messages.
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (part.type !== "toolCall" || part.name !== "read") continue;
			const path = String(part.arguments.path ?? "");
			// A skill is named by its folder; a later read replaces an earlier one.
			if (basename(path) === "SKILL.md") name = basename(dirname(path));
		}
	}
	return name;
}

/** The drafts of a topic with their lengths; the outline comes first. */
function drafts(dir: string): string[] {
	const folder = join(dir, TOPIC_DIRS.drafts);
	// No drafts yet.
	if (!existsSync(folder)) return [];
	return readdirSync(folder)
		.filter((name) => name.endsWith(".md"))
		.sort((a, b) => Number(b === "大纲.md") - Number(a === "大纲.md"))
		.map((name) => {
			const path = join(folder, name);
			return `${path}（${wordCount(readFileSync(path, "utf-8")).counts.total} 字）`;
		});
}

/** The program's part of a summary, read fresh from disk every time. */
export function writingState(entries: readonly SessionEntry[], dir: string | undefined): string {
	const lines = ["## 写作状态"];
	if (dir) {
		// The archive counts.
		const index = readIndex(dir);
		// One line per material.
		const materials = join(dir, MATERIAL_FILE);
		const records = existsSync(materials)
			? readFileSync(materials, "utf-8")
					.split("\n")
					.filter((line) => line.startsWith("- ")).length
			: 0;
		const searches = index.filter((e) => e.kind === "search").length;
		// Where the work is.
		lines.push(`主题文件夹：${dir}`, ...drafts(dir).map((d) => `稿件：${d}`));
		lines.push(`素材 ${records} 条，检索 ${searches} 次，页面 ${index.length - searches} 个`);
	}
	const skill = genre(entries);
	if (skill) lines.push(`文体：${skill}`);
	// A document under way is read from its files, not from this summary; research alone asks for nothing.
	if (dir && drafts(dir).length > 0) lines.push("继续写稿之前先读大纲和当前稿件。");
	// The user's words, as they were written.
	const said = userWords(entries);
	if (said.length > 0) lines.push("", "用户说过的话：", ...said.map((text) => `- ${text}`));
	return lines.join("\n");
}

/** What goes to the model: archived results as one line, and only its own part of the last summary. */
export function prepareForSummary(preparation: CompactionPreparation): CompactionPreparation {
	const previous = preparation.previousSummary;
	// The program's part is written anew each time.
	const start = previous?.indexOf(MODEL_PART) ?? -1;
	return {
		...preparation,
		messagesToSummarize: slimForSummary(preparation.messagesToSummarize),
		turnPrefixMessages: slimForSummary(preparation.turnPrefixMessages),
		previousSummary: previous && start >= 0 ? previous.slice(start) : previous,
	};
}

/** The finished summary: the program's part first, so it is there even when the model's is not. */
export function withWritingState(result: CompactionResult, state: string): CompactionResult {
	return { ...result, summary: `${state}\n\n${result.summary}` };
}
