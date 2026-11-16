/**
 * Folding large tool results out of the conversation once they are old: a search result list, a fetched page or a
 * long file read stays in the context for the next few turns and is then replaced, in the model's view only, by one
 * line naming the file that holds it (every search and fetch is archived in the topic folder; a read names its file).
 * The transcript keeps the full text; pi's context_edit entry does the replacing. 2026-11-17, l11: a 3,000-character
 * report took 93 model turns, and 135,000 characters of tool results (search 53,000, fetch 36,000, read 21,000) rode
 * along in every one of them.
 */

// The entry the boundary handler proposes.
import type { ContextEditEntryDraft } from "../core/extensions/types.ts";
// Messages.
import { t } from "./i18n/index.ts";

/** Tools whose results are folded: their text is on disk. */
const TRIM_TOOLS = new Set(["search_web", "fetch_web", "read"]);

/** How many of the latest assistant turns keep their results in full, and from what length a result is folded. */
export const TRIM_DEFAULTS = { keepTurns: 3, minChars: 1500 } as const;

/** True unless JW_CONTEXT_TRIM is off, 0, false or no. */
export function trimEnabled(env: NodeJS.ProcessEnv): boolean {
	return !/^(off|0|false|no)$/i.test((env.JW_CONTEXT_TRIM ?? "").trim());
}

/** One projected entry of the context, as far as this module reads it. */
export interface ProjectedLike {
	sourceEntry: { id: string; type: string };
	messages: readonly unknown[];
}

/** A message as this module reads it. */
interface MessageLike {
	role?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	content?: unknown;
}

/** The archive line a search or fetch result ends with. */
const ARCHIVED = /^(?:已归档|Archived)[:：]\s*(\S.*)$/m;

/** The text of a result whose content is text only; undefined when it holds images or other blocks. */
function textOf(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content as { type?: string; text?: string }[]) {
		if (block?.type !== "text" || typeof block.text !== "string") return undefined;
		parts.push(block.text);
	}
	return parts.join("");
}

/**
 * The context edits that fold old large results: for each result of a folding tool that lies before the last
 * `keepTurns` assistant turns, is longer than `minChars` and names its file, one edit replacing its content with a
 * line naming the file. A result already folded is short and so left alone.
 */
export function trimPlan(
	entries: readonly ProjectedLike[],
	options: { keepTurns: number; minChars: number } = TRIM_DEFAULTS,
): ContextEditEntryDraft[] {
	// Every message with the entry it comes from, in order.
	const flat: { id: string; message: MessageLike }[] = [];
	for (const entry of entries)
		for (const message of entry.messages) flat.push({ id: entry.sourceEntry.id, message: message as MessageLike });
	// Where the kept turns begin: the keepTurns-th assistant message from the end.
	let cut = flat.length;
	let seen = 0;
	for (let i = flat.length - 1; i >= 0; i--) {
		if (flat[i].message.role !== "assistant") continue;
		seen++;
		if (seen === options.keepTurns) {
			cut = i;
			break;
		}
	}
	if (seen < options.keepTurns) return [];
	// The file each read call named, by call id.
	const readPaths = new Map<string, string>();
	for (const { message } of flat) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as {
			type?: string;
			id?: string;
			name?: string;
			arguments?: { path?: unknown };
		}[])
			if (
				block?.type === "toolCall" &&
				block.name === "read" &&
				block.id &&
				typeof block.arguments?.path === "string"
			)
				readPaths.set(block.id, block.arguments.path);
	}
	const edits: ContextEditEntryDraft[] = [];
	for (let i = 0; i < cut; i++) {
		const { id, message } = flat[i];
		if (message.role !== "toolResult" || message.isError || !message.toolName || !TRIM_TOOLS.has(message.toolName))
			continue;
		const text = textOf(message.content);
		if (text === undefined || text.length <= options.minChars) continue;
		// The file that holds the text: the archive line, or the read call's path.
		const path =
			ARCHIVED.exec(text)?.[1].trim() ?? (message.toolCallId ? readPaths.get(message.toolCallId) : undefined);
		if (!path) continue;
		const line = t(message.toolName === "read" ? "context.trimmedRead" : "context.trimmed", {
			tool: message.toolName,
			chars: text.length,
			path,
		});
		edits.push({ type: "context_edit", targetId: id, replacement: { content: [{ type: "text", text: line }] } });
	}
	return edits;
}
