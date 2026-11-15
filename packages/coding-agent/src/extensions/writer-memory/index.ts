/**
 * Built-in JiaWriter extension: what the user asked to remember (2026-11-15, the plan's general-capability line; as
 * Claude Code's memory and WorkBuddy's Memory tools). One file under the agent directory, one line per entry. The
 * remember tool adds an entry, /memory lists or removes entries, and every run's system prompt carries them, so a
 * preference said once holds in later sessions.
 */

// The file: read, atomic write.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Schemas.
import { Type } from "typebox";
// The agent directory (JW_DIR).
import { getAgentDir } from "../../config.ts";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";

/** Most entries kept: the oldest go when more come. */
export const MAX_MEMORIES = 50;
/** Longest entry: one or two sentences. */
export const MAX_MEMORY_CHARS = 300;

/** The file of entries. */
export function memoryPath(): string {
	return join(getAgentDir(), "memory.md");
}

/** The entries of a file's text: one per non-empty line, list marks dropped. */
export function parseMemories(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
		.filter((line) => line !== "");
}

/** The entries on disk; none when there is no file. */
export function readMemories(path: string = memoryPath()): string[] {
	try {
		return parseMemories(readFileSync(path, "utf-8"));
	} catch {
		return [];
	}
}

/** Write the entries (folder, temp file, rename). */
export function writeMemories(items: readonly string[], path: string = memoryPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, items.map((item) => `- ${item}\n`).join(""));
	renameSync(`${path}.tmp`, path);
}

/** An entry as kept: one line, bounded. */
export function cleanMemory(note: string): string {
	return note.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CHARS);
}

/** The list with a note added: no duplicates; when full, the oldest entry goes. */
export function addMemory(items: readonly string[], note: string): { items: string[]; added: boolean } {
	const clean = cleanMemory(note);
	if (clean === "" || items.includes(clean)) return { items: [...items], added: false };
	return { items: [...items, clean].slice(-MAX_MEMORIES), added: true };
}

/** The section the system prompt carries, or "" when there is nothing to remember. */
export function memorySection(items: readonly string[]): string {
	if (items.length === 0) return "";
	return (
		"# What the user asked you to remember\n\n" +
		"Standing notes from earlier sessions, saved with remember. Follow them unless the user says otherwise.\n\n" +
		items.map((item) => `- ${item}`).join("\n")
	);
}

/** The numbered list /memory shows. */
export function memoryList(items: readonly string[]): string {
	return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

/** Register the tool, the command and the prompt section. */
export default function writerMemoryExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Saves a preference or standing instruction the user asked you to remember; every later session reads it.\n\nUsage:\n" +
			" - Only when the user asks to remember something\n" +
			" - One entry per call, in the user's own terms",
		parameters: Type.Object({
			note: Type.String({ description: "What to remember" }),
		}),
		async execute(_id, params) {
			// Read, add, write.
			const { items, added } = addMemory(readMemories(), params.note);
			if (added) writeMemories(items);
			const text = added ? t("memory.saved", { count: String(items.length) }) : t("memory.notAdded");
			return { content: [{ type: "text", text }], details: { added, count: items.length } };
		},
	});
	// /memory lists; /memory forget <n> removes one; /memory clear removes all.
	pi.registerCommand("memory", {
		description: t("memory.description"),
		getArgumentCompletions: (prefix) => {
			const words = ["forget", "clear"].filter((w) => w.startsWith(prefix.trim()));
			return words.length > 0 ? words.map((w) => ({ value: w, label: w })) : null;
		},
		handler: async (args, ctx) => {
			const items = readMemories();
			const [verb, rest] = args.trim().split(/\s+/, 2);
			if (verb === "clear") {
				writeMemories([]);
				ctx.ui.notify(t("memory.cleared", { count: String(items.length) }), "info");
				return;
			}
			if (verb === "forget") {
				const n = Number(rest);
				if (!Number.isInteger(n) || n < 1 || n > items.length) {
					ctx.ui.notify(t("memory.badIndex", { count: String(items.length) }), "warning");
					return;
				}
				const [gone] = items.splice(n - 1, 1);
				writeMemories(items);
				ctx.ui.notify(t("memory.forgot", { entry: gone }), "info");
				return;
			}
			if (items.length === 0) {
				ctx.ui.notify(t("memory.empty", { path: memoryPath() }), "info");
				return;
			}
			ctx.ui.notify(
				`${t("memory.title", { count: String(items.length), path: memoryPath() })}\n${memoryList(items)}`,
				"info",
			);
		},
	});
	// Every run's prompt carries the entries, after whatever earlier handlers made of it.
	pi.on("before_agent_start", (event) => {
		const section = memorySection(readMemories());
		if (section === "") return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
	});
}
