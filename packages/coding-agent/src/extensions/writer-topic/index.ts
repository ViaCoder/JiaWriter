/**
 * Built-in JiaWriter extension: topic folders. The model opens a folder for each writing topic in the
 * course of the conversation (topic_open) and records the cases and data it will use (material_add);
 * web_search and web_fetch archive into the folder by themselves. There is nothing for the user to set up.
 */

// Parameter schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// The current topic.
import { currentTopic, ensureTopic, setCurrentTopic, topicFromEntries } from "../../writer/topic/current.ts";
// Topic folders and materials.
import { addMaterials, MATERIAL_FILE, type Material, openTopic, TOPIC_DIRS } from "../../writer/topic/topic.ts";

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
		description: `Open the folder of a writing topic in the working folder, creating it or continuing it when the name exists. It holds ${TOPIC_DIRS.drafts}/ (drafts and exports), ${TOPIC_DIRS.refs}/ (the user's files), ${TOPIC_DIRS.search}/ and ${TOPIC_DIRS.web}/ (searches and full pages, archived automatically) and ${MATERIAL_FILE} (cases and data).`,
		// One line in the tools section.
		promptSnippet: "Open the folder that holds a writing topic's research, reference files and drafts",
		// Rules added while the tool is active.
		promptGuidelines: [
			"When the user starts a writing topic, call topic_open once with a short name taken from the request, before the first search or draft, and use the same name to continue a topic",
			`Work on a topic in this order: outline in ${TOPIC_DIRS.drafts}/大纲.md, confirm which parts need cases or data, search and fetch for those parts, record what you will use, compare ${MATERIAL_FILE} with the outline and search again for the gaps, then write the draft from ${MATERIAL_FILE}`,
			`Read earlier results in ${TOPIC_DIRS.search}/ and ${TOPIC_DIRS.web}/ with read and grep, in place of searching or fetching the same thing again`,
		],
		// Argument schema.
		parameters: Type.Object({
			name: Type.String({ description: "Short topic name, for example 城市绿化调研" }),
		}),
		// Creates folders only.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		// Open it.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { dir, existed } = openTopic(ctx.cwd, params.name);
			setCurrentTopic(dir);
			const text = t(existed ? "topic.continued" : "topic.opened", { dir, drafts: TOPIC_DIRS.drafts });
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
		description: `Record cases and data points for the draft in ${MATERIAL_FILE} of the current topic. A case needs time, reporter, subject and action; a data point needs time, region, industry, indicator and value. Each needs a source: the url of a page fetched in this topic, or file and page of a reference file. Nothing is written when an item is incomplete.`,
		// One line in the tools section.
		promptSnippet: "Record a case or data point with its source in the topic's materials",
		// Rules added while the tool is active.
		promptGuidelines: [
			"Record each case and figure you may use with material_add right after reading its source, and fetch a page with web_fetch before recording it, because a source is a page you have read",
		],
		// Argument schema.
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					kind: Type.Union([Type.Literal("case"), Type.Literal("data")]),
					time: Type.String({ description: "When it happened or the period of the figure" }),
					reporter: Type.Optional(Type.String({ description: "Case: who reported it" })),
					subject: Type.Optional(Type.String({ description: "Case: who acted" })),
					action: Type.Optional(Type.String({ description: "Case: what was done" })),
					region: Type.Optional(Type.String({ description: "Data: region" })),
					industry: Type.Optional(Type.String({ description: "Data: industry" })),
					indicator: Type.Optional(Type.String({ description: "Data: indicator, for example 总产值" })),
					value: Type.Optional(Type.String({ description: "Data: value with its unit" })),
					url: Type.Optional(Type.String({ description: "Source page, fetched in this topic" })),
					file: Type.Optional(Type.String({ description: "Reference file name" })),
					page: Type.Optional(Type.String({ description: "Page in the reference file" })),
					section: Type.Optional(Type.String({ description: "Outline part it belongs to" })),
				}),
			),
		}),
		// Appends to one file.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		// Record them.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = currentTopic() ?? ensureTopic(ctx.cwd);
			const total = addMaterials(dir, params.items as Material[]);
			const text = t("topic.materialAdded", { count: params.items.length, total, file: MATERIAL_FILE });
			return { content: [{ type: "text", text }], details: { topicDir: dir, total } };
		},
	});
}
