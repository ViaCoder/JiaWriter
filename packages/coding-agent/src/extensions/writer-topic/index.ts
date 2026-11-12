/**
 * Built-in JiaWriter extension: topic folders. The model opens a folder for each writing topic in the
 * course of the conversation (topic_open) and records the cases and data it will use (material_add);
 * search_web and fetch_web archive into the folder by themselves. There is nothing for the user to set up.
 */

// Parameter schemas.
import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// The current topic.
import { currentTopic, ensureTopic, setCurrentTopic, topicFromEntries } from "../../writer/topic/current.ts";
// Topic folders and materials.
import {
	addMaterials,
	adoptUnnamedTopic,
	isUnnamedTopic,
	longAnchors,
	MATERIAL_FILE,
	MAX_ANCHOR,
	type Material,
	openTopic,
} from "../../writer/topic/topic.ts";

/** Follow the session: the topic of the branch now shown. */
function restore(ctx: ExtensionContext): void {
	// None on a fresh branch.
	setCurrentTopic(topicFromEntries(ctx.sessionManager.getBranch()));
}

/** Extension factory. */
export default function writerTopicExtension(pi: ExtensionAPI): void {
	// A session started, resumed or forked; the tree moved.
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	// topic_open.
	pi.registerTool({
		// Name the model calls.
		name: "topic_open",
		// Name shown in the interface.
		label: "Open topic",
		// Full description sent to the model.
		description: "Opens or continues a topic directory: 稿件/, 参考资料/, 检索/, 网页/ and 素材.md",
		// Argument schema.
		parameters: Type.Object({
			name: Type.String({
				description: "1–3 key words, such as 城市绿化; the date is added, and the same words continue",
			}),
		}),
		// Creates folders only.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		// Open it.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Research done before the topic had a name moves with it.
			const before = currentTopic();
			const moved = before ? adoptUnnamedTopic(before, ctx.cwd, params.name) : false;
			const { dir, existed } = openTopic(ctx.cwd, params.name);
			setCurrentTopic(dir);
			// A folder of that name was there already: the earlier research stays where it is, and the model is told.
			const left = before && !moved && isUnnamedTopic(before) ? t("topic.earlier", { dir: before }) : "";
			const opened = t(existed && !moved ? "topic.continued" : "topic.opened", { dir });
			const text = [opened, left].filter(Boolean).join("\n");
			return { content: [{ type: "text", text }], details: { topicDir: dir } };
		},
	});

	// material_add.
	pi.registerTool({
		// Name the model calls.
		name: "material_add",
		// Name shown in the interface.
		label: "Add material",
		// Full description sent to the model.
		description:
			"Records cases and data in 素材.md: the program copies each one's passage out of its source, so you write only where it starts and ends.\n\nUsage:\n - Name the one to three sentences that state the fact: start is their first few words and end their last few, about 4 to 12 characters each as the source writes them, in its language; leave end out for one sentence. For 据中国民航局预测，2025年中国低空经济市场规模将达1.5万亿元。 start is 据中国民航局预测, not the whole sentence\n - A case also needs subject, and reporter when it is from the web\n - time is the one the source states, else the source's own date; leave it out when the source has none, never infer one\n - Each needs url, or file and page",
		// Argument schema.
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					kind: StringEnum(["case", "data"] as const),
					time: Type.Optional(Type.String({ description: "As the source states it, else its date" })),
					reporter: Type.Optional(Type.String({ description: "Outlet's name, such as 路透社" })),
					subject: Type.Optional(Type.String({ description: "Named company, body or person" })),
					start: Type.String({ description: "First 4 to 12 characters of the passage, as in the source" }),
					end: Type.Optional(
						Type.String({ description: "Last 4 to 12 characters, when it runs past that sentence" }),
					),
					url: Type.Optional(Type.String()),
					file: Type.Optional(Type.String()),
					page: Type.Optional(Type.String()),
					section: Type.Optional(Type.String({ description: "Outline part" })),
				}),
			),
		}),
		// Appends to one file.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		// Record them.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// The first item says what the material is about, when no topic was opened.
			const dir = ensureTopic(ctx.cwd, String(params.items[0]?.subject ?? ""));
			const items = params.items as Material[];
			const { total, written, problems } = addMaterials(dir, items);
			// What went in, then what came back: an error only when something came back, so the model resends only that.
			const added =
				written.length > 0
					? t("topic.materialAdded", {
							count: written.length,
							which: written.join("、"),
							total,
							file: MATERIAL_FILE,
						})
					: "";
			if (problems.length === 0) {
				// Whole sentences as start or end: the next call needs only a few words of each.
				const text = longAnchors(items) ? `${added}\n${t("topic.anchorsLong", { max: MAX_ANCHOR })}` : added;
				return { content: [{ type: "text", text }], details: { topicDir: dir, total } };
			}
			const back = t("topic.materialBack", { count: items.length - written.length });
			const text = [added, back, ...problems].filter(Boolean).join("\n");
			return { content: [{ type: "text", text }], details: { topicDir: dir, total }, isError: true };
		},
	});
}
