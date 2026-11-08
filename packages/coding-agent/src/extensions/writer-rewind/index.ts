/**
 * Built-in JiaWriter extension: going back. Every write and edit first saves the file (src/writer/rewind).
 * - /rewind: pick a user message; the conversation, the files, or both return to the moment before it.
 * - draft_restore: the same for one file in conversation, when the user asks for an earlier version.
 * Restored drafts are exported again, so the .docx matches the Markdown.
 */

// Whether a restored file is there.
import { existsSync } from "node:fs";
// The materials file of a topic.
import { join } from "node:path";
// Parameter schemas.
import { Type } from "typebox";
// Agent directory.
import { getAgentDir } from "../../config.ts";
// Extension API types.
import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "../../core/extensions/types.ts";
// Upstream path resolution (cwd, ~).
import { resolveToCwd } from "../../core/tools/path-utils.ts";
// Which files are drafts.
import { isDraftPath } from "../../writer/docs/auto.ts";
// Export after a restore.
import { exportDraft } from "../../writer/export/export.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// Snapshots.
import {
	pruneStores,
	readSnapshots,
	restoreSnapshot,
	type Snapshot,
	storeDir,
	takeSnapshot,
	undoTargets,
	versionsOf,
} from "../../writer/rewind/rewind.ts";
// The current topic and its materials file.
import { currentTopic } from "../../writer/topic/current.ts";
import { MATERIAL_FILE } from "../../writer/topic/topic.ts";

/** Longest message shown in the list (characters). */
const LABEL_CHARS = 60;

/** One user message of the active branch. */
interface UserTurn {
	id: string;
	text: string;
}

/** The user messages of the active branch, oldest first. */
export function userTurns(ctx: ExtensionContext): UserTurn[] {
	// Text blocks of each.
	return ctx.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const content = entry.message.content;
		const text =
			typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("");
		return [{ id: entry.id, text }];
	});
}

/** Export the restored drafts again; a failure leaves the Markdown restored. */
async function exportAgain(files: readonly string[], ctx: ExtensionContext): Promise<void> {
	// Drafts that are there.
	for (const file of files) {
		if (!existsSync(file) || !isDraftPath(file, ctx.cwd)) continue;
		await exportDraft(file, ctx.cwd, getAgentDir(), {}).catch(() => undefined);
	}
}

/** Extension factory. */
export default function writerRewindExtension(pi: ExtensionAPI): void {
	/** Store of the working folder. */
	const store = (ctx: ExtensionContext) => storeDir(getAgentDir(), ctx.cwd);

	// Snapshots older than a month leave by themselves.
	pi.on("session_start", (event) => {
		if (event.reason === "startup") pruneStores(getAgentDir(), Date.now());
	});

	// Before a file changes. A snapshot that fails must not stop the writing.
	pi.on("tool_call", (event, ctx) => {
		// The file this call will change: a draft, or the topic's materials.
		const topic = currentTopic();
		const file =
			isToolCallEventType("write", event) || isToolCallEventType("edit", event)
				? resolveToCwd(event.input.path, ctx.cwd)
				: event.toolName === "material_add" && topic
					? join(topic, MATERIAL_FILE)
					: undefined;
		const turn = userTurns(ctx).at(-1);
		if (!file || !turn) return;
		try {
			takeSnapshot(store(ctx), file, turn.id);
		} catch {
			// Going back to this change will be unavailable; the change itself goes ahead.
		}
	});

	// draft_restore.
	pi.registerTool({
		// Name the model calls.
		name: "draft_restore",
		// Name shown in the interface.
		label: "Restore draft",
		// Full description sent to the model.
		description: "Lists a file's saved versions, or restores one; each user message keeps one",
		// Argument schema.
		parameters: Type.Object({
			path: Type.String({ description: "The file" }),
			version: Type.Optional(Type.Number({ description: "Version number from the list; omit to list" })),
		}),
		// Replaces one file, whose current state is saved first.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		// List or restore.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const file = resolveToCwd(params.path, ctx.cwd);
			const versions = versionsOf(readSnapshots(store(ctx)), file);
			if (versions.length === 0) throw new Error(t("rewind.noVersions", { path: params.path }));
			if (params.version === undefined) {
				const lines = versions.map((v: Snapshot, i) =>
					t("rewind.version", { n: i + 1, time: new Date(v.at).toLocaleString(), size: v.size }),
				);
				return { content: [{ type: "text", text: lines.join("\n") }], details: { versions: versions.length } };
			}
			const chosen = versions[params.version - 1];
			if (!chosen) throw new Error(t("rewind.badVersion", { count: versions.length }));
			restoreSnapshot(store(ctx), chosen);
			await exportAgain([file], ctx);
			const text = t("rewind.restored", { path: params.path, n: params.version });
			return { content: [{ type: "text", text }], details: { version: params.version } };
		},
	});

	// /rewind.
	pi.registerCommand("rewind", {
		description: "Go back to an earlier message: the conversation, the files, or both",
		handler: async (_args, ctx) => {
			// Going back during a reply would race it.
			if (!ctx.isIdle()) {
				ctx.ui.notify(t("rewind.busy"), "warning");
				return;
			}
			const turns = userTurns(ctx);
			if (turns.length === 0) {
				ctx.ui.notify(t("rewind.none"), "info");
				return;
			}
			// Newest first, numbered so equal messages stay apart.
			const labels = turns
				.map((turn, i) => `${i + 1}. ${turn.text.replace(/\s+/g, " ").trim().slice(0, LABEL_CHARS)}`)
				.reverse();
			const choice = await ctx.ui.select(t("rewind.pick"), labels);
			if (choice === undefined) return;
			const at = turns.length - 1 - labels.indexOf(choice);
			const target = turns[at];
			// Files changed by this message and the ones after it.
			const targets = undoTargets(readSnapshots(store(ctx)), new Set(turns.slice(at).map((turn) => turn.id)));
			const both = t("rewind.both", { count: targets.length });
			const talk = t("rewind.talk");
			const files = t("rewind.files", { count: targets.length });
			const mode = targets.length > 0 ? await ctx.ui.select(t("rewind.mode"), [both, talk, files]) : talk;
			if (mode === undefined) return;
			// Files first: a failure leaves the conversation where it was.
			// The conversation first: when that is cancelled, the files stay as they are.
			if (mode !== files) {
				const result = await ctx.navigateTree(target.id, { summarize: false });
				if (result.cancelled) return;
				ctx.ui.setEditorText(target.text);
			}
			if (mode !== talk) {
				for (const snapshot of targets) restoreSnapshot(store(ctx), snapshot);
				await exportAgain(
					targets.map((s) => s.file),
					ctx,
				);
			}
			ctx.ui.notify(t("rewind.done", { count: mode === talk ? 0 : targets.length }), "info");
		},
	});
}
