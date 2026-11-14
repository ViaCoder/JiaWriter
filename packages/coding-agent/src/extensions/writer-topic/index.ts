/**
 * Built-in JiaWriter extension: topic folders. The model opens a folder for each writing topic in the
 * course of the conversation (topic_open) and records the facts of its sources (material_add): it names a source and
 * what it needs from it, and the program extracts the facts with a request of its own, checks them against the source
 * and files them in 素材.md; search_web and fetch_web archive into the folder by themselves. There is nothing for the
 * user to set up.
 */

// The model, for the extraction request (tests pass a stand-in).
import { completeSimple } from "@earendil-works/pi-ai/compat";
// Parameter schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// One clean request to the model.
import { type Complete, modelAsker } from "../../writer/model-ask.ts";
// The current topic.
import { currentTopic, ensureTopic, setCurrentTopic, topicFromEntries } from "../../writer/topic/current.ts";
// The extraction: its request, its reply and the check of each fact against the source.
import {
	EXTRACT_REASONING_TOKENS,
	EXTRACT_TIMEOUT_MS,
	extractInstructions,
	extractRequest,
	factProblem,
	parseFacts,
} from "../../writer/topic/extract.ts";
// Topic folders and materials.
import {
	addMaterials,
	adoptUnnamedTopic,
	asFileSource,
	isUnnamedTopic,
	MATERIAL_FILE,
	type Material,
	materialCount,
	materialUrls,
	openTopic,
	sourceOf,
	sourceProblem,
	sourceTextOf,
	timeInSource,
} from "../../writer/topic/topic.ts";

/** One source the model names for material_add, and what it needs from it. */
interface SourceItem {
	url?: string;
	file?: string;
	page?: string;
	section?: string;
	focus?: string;
}

/** Follow the session: the topic of the branch now shown. */
function restore(ctx: ExtensionContext): void {
	// None on a fresh branch.
	setCurrentTopic(topicFromEntries(ctx.sessionManager.getBranch()));
}

/** Extension factory; `complete` reaches the model for the extraction (tests pass a stand-in). */
export default function writerTopicExtension(pi: ExtensionAPI, complete: Complete = completeSimple): void {
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
			"Records the facts of a source in 素材.md: you name the source and what you need from it; the program extracts the facts with a request of its own, checks their figures and names against the source, and files them with the source's outlet and date.\n\nUsage:\n - One item per source: url of a search result or fetched page of this topic, or file (and page) of an imported reference\n - section is the outline part the facts are for; focus says what to take when the source covers more than that (大众汽车在华销量和高管表态)\n - The reply lists the facts recorded: read them to see what the source gave and what is still missing",
		// Argument schema.
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					url: Type.Optional(
						Type.String({ description: "Address of a search result or fetched page of this topic" }),
					),
					file: Type.Optional(Type.String({ description: "Imported reference file" })),
					page: Type.Optional(Type.String({ description: "Its page, for a PDF or Word file" })),
					section: Type.Optional(Type.String({ description: "Outline part" })),
					focus: Type.Optional(Type.String({ description: "What to take from the source, when it covers more" })),
				}),
			),
		}),
		// Appends to one file; asks the model once per source.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		// Extract and record them.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const items = params.items as SourceItem[];
			// The first item says what the material is about, when no topic was opened.
			const dir = ensureTopic(ctx.cwd, String(items[0]?.focus ?? items[0]?.section ?? ""));
			const fail = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { topicDir: dir },
				isError: true,
			});
			// The extraction: a small budget, and a request even when the review is off.
			const budget = { reasoningTokens: EXTRACT_REASONING_TOKENS, timeoutMs: EXTRACT_TIMEOUT_MS };
			const ask = modelAsker(ctx, complete, budget, true);
			if (!ask) return fail(t("topic.noModel"));
			const archived = materialUrls(dir);
			const lines: string[] = [];
			// A source the topic does not hold is an error, so the model gives another; an empty extraction is not.
			let error = false;
			for (const [i, given] of items.entries()) {
				const item = asFileSource(given as Material);
				const name = item.file?.trim() ? `《${item.file.trim()}》` : (item.url?.trim() ?? "");
				const problem = sourceProblem(item, archived) || (name ? "" : t("topic.missingSource"));
				if (problem) {
					lines.push(t("topic.itemProblem", { n: i + 1, problem }));
					error = true;
					continue;
				}
				const text = sourceTextOf(dir, item);
				if (!text?.trim()) {
					lines.push(t("topic.itemProblem", { n: i + 1, problem: t("topic.sourceUnreadable", { file: name }) }));
					error = true;
					continue;
				}
				// The request of its own: the source's text and what is needed, nothing of the conversation.
				let reply: string;
				try {
					reply = await ask(extractInstructions(), extractRequest(text, given.focus ?? "", given.section ?? ""));
				} catch (e) {
					lines.push(
						t("topic.extractFailed", { source: name, reason: e instanceof Error ? e.message : String(e) }),
					);
					error = true;
					continue;
				}
				// Each fact against the source; a time the source does not hold is dropped, and the source's date stands in.
				const source = item.url?.trim() ? sourceOf(dir, item.url) : undefined;
				const dropped: string[] = [];
				const kept = parseFacts(reply).flatMap((fact) => {
					const why = factProblem(fact.fact ?? "", text);
					if (why) {
						dropped.push(why);
						return [];
					}
					const time =
						fact.time && source && !timeInSource(fact.time, source.text, source.date) ? undefined : fact.time;
					return [{ ...fact, time, url: item.url, file: item.file, page: item.page, section: item.section }];
				});
				if (kept.length === 0) {
					lines.push(t("topic.extractNone", { source: name }));
				} else {
					const result = addMaterials(dir, kept);
					lines.push(t("topic.extracted", { source: name, count: result.written.length }));
					// The facts as recorded, for the model to see what the source gave.
					for (const n of result.written) {
						const fact = kept[n - 1];
						lines.push(`- ${fact.kind === "case" ? `${fact.subject}：` : ""}${fact.fact}`);
					}
					if (result.skipped > 0) lines.push(t("topic.duplicates", { count: result.skipped }));
					lines.push(...result.problems);
				}
				if (dropped.length > 0) lines.push(t("topic.factsDropped", { count: dropped.length, why: dropped[0] }));
			}
			const total = materialCount(dir);
			lines.push(t("topic.materialTotal", { file: MATERIAL_FILE, total }));
			const text = lines.join("\n");
			return error
				? { content: [{ type: "text", text }], details: { topicDir: dir, total }, isError: true }
				: { content: [{ type: "text", text }], details: { topicDir: dir, total } };
		},
	});
}
