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
	MATERIAL_FILE,
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
		description: "Open or continue a topic folder: 稿件/, 参考资料/, 检索/, 网页/ and 素材.md",
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
			"Record cases and data in 素材.md. A case needs time, reporter, subject, action; data needs time, region, industry, indicator, value; each needs url, or file and page",
		// Argument schema.
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					kind: StringEnum(["case", "data"] as const),
					time: Type.String(),
					reporter: Type.Optional(Type.String({ description: "Outlet's name, such as 路透社" })),
					subject: Type.Optional(Type.String({ description: "Named company, body or person" })),
					action: Type.Optional(Type.String()),
					region: Type.Optional(Type.String()),
					industry: Type.Optional(Type.String()),
					indicator: Type.Optional(Type.String()),
					value: Type.Optional(Type.String({ description: "With its unit" })),
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
			const total = addMaterials(dir, params.items as Material[]);
			const text = t("topic.materialAdded", { count: params.items.length, total, file: MATERIAL_FILE });
			return { content: [{ type: "text", text }], details: { topicDir: dir, total } };
		},
	});
}
