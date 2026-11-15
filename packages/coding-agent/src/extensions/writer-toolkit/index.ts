/**
 * Built-in JiaWriter extension: the toolkits (writer/toolkit/toolkits.ts). The `toolkit` tool opens one for the
 * model; /write, /research, /search and /computer open one for the user and send their argument as the request;
 * a request that plainly names the work opens its toolkit before the run. Each opening gives the model the
 * toolkit's text once, and again after compaction. A closed toolkit's tools are not declared, so a greeting or a
 * question carries none of the writing rules (the user, 2026-11-15: "hello" went into the writing workflow).
 */

// Schema helpers.
import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
// Schemas.
import { Type } from "typebox";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// Opening.
import { offeredSkills, openToolkit } from "../../writer/toolkit/open.ts";
// The toolkits.
import { detectToolkits, openToolkits, TOOLKIT_IDS, type ToolkitId } from "../../writer/toolkit/toolkits.ts";

/** The type of the hidden message that carries a toolkit's text. */
export const TOOLKIT_MESSAGE = "jiawriter-toolkit";

/** The toolkit's name as the interface shows it. */
export function toolkitName(id: ToolkitId): string {
	return t(`toolkit.name.${id}` as "toolkit.name.writing");
}

/** Extension factory. */
export default function writerToolkitExtension(pi: ExtensionAPI): void {
	// Whether the open toolkits' texts have to be given again (after compaction, the summary may have lost them).
	let resend = false;
	pi.on("session_compact", () => {
		resend = true;
	});
	pi.on("session_start", () => {
		resend = false;
	});

	/** Open one and tell the user, when it was closed; the text for the model. */
	function open(id: ToolkitId, ctx: Pick<ExtensionContext, "hasUI" | "ui">): string {
		const out = openToolkit(pi, id, { hasUI: ctx.hasUI, skills: offeredSkills() });
		if (out.opened && ctx.hasUI) ctx.ui.notify(t("toolkit.opened", { name: toolkitName(id) }), "info");
		return out.text;
	}

	// The tool: the model opens what the request needs.
	pi.registerTool({
		name: "toolkit",
		label: "Toolkit",
		description:
			"Opens a toolkit, whose tools and rules then join this conversation. Toolkits: writing (documents, 公文, reports, articles: topic, materials, outline, sections, checks, export), research (web search and pages, with sources recorded), office (import or export Word, Excel, PowerPoint, PDF), browser (web pages in the user's Chrome), computer (desktop applications), schedule (tasks run at set times). Open one before the first step that needs it; it stays open",
		parameters: Type.Object({ name: StringEnum(TOOLKIT_IDS) }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Open already: one line, not the text again (it is in the conversation).
			if (openToolkits(pi.getActiveTools()).includes(params.name))
				return {
					content: [{ type: "text", text: t("toolkit.already", { name: params.name }) }],
					details: { toolkit: params.name, opened: false },
				};
			return {
				content: [{ type: "text", text: open(params.name, ctx) }],
				details: { toolkit: params.name, opened: true },
			};
		},
	});

	// A request that names the work plainly opens its toolkit before the run; after compaction the open toolkits'
	// texts come again. One hidden message holds everything that is due.
	pi.on("before_agent_start", (event, ctx) => {
		const texts: string[] = [];
		const active = pi.getActiveTools();
		if (resend) {
			resend = false;
			for (const id of openToolkits(active)) texts.push(open(id, ctx));
		}
		if (event.messageType === "user") {
			for (const id of detectToolkits(event.prompt)) {
				if (openToolkits(pi.getActiveTools()).includes(id)) continue;
				texts.push(open(id, ctx));
			}
		}
		if (texts.length === 0) return;
		return { message: { customType: TOOLKIT_MESSAGE, content: texts.join("\n\n"), display: false } };
	});

	/** A command that opens a toolkit and sends its argument as the request. */
	function command(name: string, id: ToolkitId, description: string, request: (args: string) => string | undefined) {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				open(id, ctx);
				const prompt = request(args.trim());
				if (prompt) pi.sendUserMessage(prompt);
				else ctx.ui.notify(t(`toolkit.hint.${id}` as "toolkit.hint.writing"), "info");
			},
		});
	}
	command("write", "writing", t("toolkit.cmd.write"), (args) => args || undefined);
	command("research", "research", t("toolkit.cmd.research"), (args) => args || undefined);
	command("search", "research", t("toolkit.cmd.search"), (args) =>
		args ? t("toolkit.searchPrompt", { words: args }) : undefined,
	);
	command("computer", "computer", t("toolkit.cmd.computer"), () => undefined);
}
