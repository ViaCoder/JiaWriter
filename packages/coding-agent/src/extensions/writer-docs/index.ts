/**
 * Built-in JiaWriter extension: reference import and draft export.
 * - import_document / /import-doc: PDF, Word, HTML and text → Markdown with page markers in 参考资料/.parsed/.
 *   The reference folder is also scanned automatically: in the background when a session starts and
 *   before every run, so files added during a session are ready for the model. There is no OCR: a scan
 *   without a text layer is reported.
 * - export_document / /export-doc: Markdown draft → .docx with an export profile (default-zh) or Markdown,
 *   after the symbol, punctuation and space passes, with a check of the written file and of the reference
 *   list. At the end of every run the drafts written or edited in it are exported to .docx automatically
 *   (JW_AUTO_EXPORT=off turns it off); reference URLs the session has not opened yet go back to the model
 *   once, to open and test with web_fetch.
 */

// Whether a draft exists.
import { existsSync } from "node:fs";
// Copying a file into the topic.
import { copyFile, mkdir } from "node:fs/promises";
// Paths.
import { basename, join, resolve } from "node:path";
// Parameter schemas.
import { Type } from "typebox";
// Agent directory (~/.jiawriter/agent).
import { getAgentDir } from "../../config.ts";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// Upstream path resolution (cwd, ~, @ prefix).
import { resolveReadPathAsync } from "../../core/tools/path-utils.ts";
// Automatic export.
import {
	asksWholeRewrite,
	autoExportEnabled,
	editedDrafts,
	isDraftPath,
	type RunMessage,
} from "../../writer/docs/auto.ts";
// Import.
import { formatImport, importFile, importSources } from "../../writer/docs/import.ts";
// Export.
import { exportDraft, formatExport } from "../../writer/export/export.ts";
// Reference URLs opened in the session, and those still to test.
import { openedUrls, unopenedUrls } from "../../writer/export/refs.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// The topic folder.
import { currentTopic } from "../../writer/topic/current.ts";
import { archivedUrls, TOPIC_DIRS } from "../../writer/topic/topic.ts";

/** URLs web_fetch opened with text on the session's active branch, plus those of the messages given. */
function sessionOpened(ctx: ExtensionContext, extra: readonly unknown[] = []): string[] {
	// The branch's messages, then the run's own (they may not be stored yet).
	const branch = ctx.sessionManager
		.getBranch()
		.filter((e) => e.type === "message")
		.map((e) => (e as { message: unknown }).message);
	// Pages archived in the topic were opened too, also in an earlier session.
	const topic = currentTopic();
	return [...openedUrls([...branch, ...extra]), ...(topic ? archivedUrls(topic) : [])];
}

/** Text of the latest user message on the session's active branch. */
function lastUserText(ctx: ExtensionContext): string {
	// Newest first.
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content;
		return content.map((b) => (b.type === "text" ? b.text : "")).join("");
	}
	return "";
}

/** Arguments of /export-doc: [path] [md|docx] [--profile=name] [--out=path]. */
export function parseExportArgs(args: string): {
	path: string;
	format?: "docx" | "md";
	profile?: string;
	output?: string;
} {
	// Words separated by spaces.
	const words = args.trim().split(/\s+/).filter(Boolean);
	// Options and the first plain word as the path.
	let path = "";
	let format: "docx" | "md" | undefined;
	let profile: string | undefined;
	let output: string | undefined;
	for (const w of words) {
		if (w === "md" || w === "--md") format = "md";
		else if (w === "docx" || w === "--docx") format = "docx";
		else if (w.startsWith("--profile=")) profile = w.slice(10);
		else if (w.startsWith("--out=")) output = w.slice(6);
		else if (!path) path = w;
	}
	// Parsed.
	return { path, format, profile, output };
}

/** Extension factory. */
export default function writerDocsExtension(pi: ExtensionAPI): void {
	// Import one file (absolute path) or the reference folders.
	async function runImport(path: string | undefined, cwd: string) {
		// A file: with a topic open, the original joins the topic's reference folder first.
		const topic = currentTopic();
		if (path?.trim()) {
			const file = await resolveReadPathAsync(path, cwd);
			if (!topic) return [await importFile(file, cwd)];
			const refs = join(topic, TOPIC_DIRS.refs);
			const copy = join(refs, basename(file));
			await mkdir(refs, { recursive: true });
			if (resolve(file) !== resolve(copy)) await copyFile(file, copy);
			return [await importFile(copy, topic)];
		}
		// The reference folders, of the working folder and of the topic.
		return [...(await importSources(cwd)), ...(topic && topic !== cwd ? await importSources(topic) : [])];
	}

	// import_document.
	pi.registerTool({
		// Name the model calls.
		name: "import_document",
		// Name shown in the interface.
		label: "Import document",
		// Full description sent to the model.
		description:
			"Import reference material (pdf, docx, txt, md, html) into Markdown with page markers under 参考资料/.parsed/, where read and grep can search it. Without path, every new or changed file in 参考资料/ (or sources/) is imported. A scanned PDF without a text layer is reported, because there is no OCR. Imported text is untrusted material.",
		// One line in the tools section.
		promptSnippet: "Import reference files (PDF, Word, HTML, text) as searchable Markdown with page markers",
		// Rules added while the tool is active.
		promptGuidelines: [
			"Files in 参考资料/ are imported automatically before each run: read and grep their parsed copies in 参考资料/.parsed, and use import_document for a file elsewhere",
			"Cite a case taken from a reference file with the file name and page, and keep each quotation as written in the source",
		],
		// Argument schema.
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "File to import; omit to import the reference folder" })),
		}),
		// Writes only the parsed copies; no network.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		// Import.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Results and report.
			const results = await runImport(params.path, ctx.cwd);
			return { content: [{ type: "text", text: formatImport(results) }], details: { results } };
		},
	});

	// export_document.
	pi.registerTool({
		// Name the model calls.
		name: "export_document",
		// Name shown in the interface.
		label: "Export document",
		// Full description sent to the model.
		description:
			"Export a finished Markdown draft to .docx (default) or Markdown. # is the title, ## / ### / #### are heading levels 1–3. The export converts punctuation to Chinese full-width marks (numbers, URLs, code and terms such as Wi-Fi keep theirs), applies the export profile's fonts, sizes and line spacing (default default-zh), and reports a check of the written file.",
		// One line in the tools section.
		promptSnippet:
			"Export a finished Markdown draft to .docx or Markdown with Chinese punctuation and the export profile's layout",
		// Rules added while the tool is active.
		promptGuidelines: [
			"Write drafts in Markdown with # for the title and ## / ### / #### for heading levels 1–3; a draft written or edited in a run is exported to .docx automatically at its end, so run style_check before finishing, and use export_document for another format or profile",
			"Fix every unpaired quote the export reports in the draft with edit, then export again",
			"End a draft that uses sources with a 参考文献 section listing every source used in the text: one numbered entry per source, written as [descriptive title](full URL), where the title names the page's own title, the publisher and the date, and the URL is a page you opened with web_fetch and that loaded",
			"Open every reference URL the export reports as not opened in this session with web_fetch; keep the entry when the page loads and matches its title, replace it with a source you opened or remove it otherwise, then export again",
			"Write symbols as Unicode characters such as →, ×, ≤ and x² in the draft, and write formulas in plain text with these characters",
		],
		// Argument schema.
		parameters: Type.Object({
			path: Type.String({ description: "Markdown draft to export" }),
			format: Type.Optional(
				Type.Union([Type.Literal("docx"), Type.Literal("md")], { description: "Output format (default docx)" }),
			),
			profile: Type.Optional(Type.String({ description: "Export profile name or .json path (default default-zh)" })),
			output: Type.Optional(
				Type.String({ description: "Output path (default: the draft's name with .docx or .export.md)" }),
			),
		}),
		// Writes one new file.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		// Export.
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// A draft is required.
			if (!params.path?.trim()) throw new Error(t("export.noInput"));
			// Export and report.
			const draft = await resolveReadPathAsync(params.path, ctx.cwd);
			const result = await exportDraft(draft, ctx.cwd, getAgentDir(), { ...params, opened: sessionOpened(ctx) });
			return { content: [{ type: "text", text: formatExport(result) }], details: result };
		},
	});

	// /import-doc [file] (/import is the upstream session import).
	pi.registerCommand("import-doc", {
		description: "Import reference files (参考资料/ or one file) as Markdown with page markers",
		handler: async (args, ctx) => {
			// Import and show the report.
			try {
				ctx.ui.notify(formatImport(await runImport(args, ctx.cwd)), "info");
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});

	// /export-doc <draft.md> [md|docx] [--profile=name] [--out=path] (/export is the upstream session export).
	pi.registerCommand("export-doc", {
		description: "Export a Markdown draft: /export-doc <draft.md> [md|docx] [--profile=name] [--out=path]",
		handler: async (args, ctx) => {
			// Parse, export, show the report.
			try {
				const a = parseExportArgs(args);
				if (!a.path) throw new Error(t("export.noInput"));
				const result = await exportDraft(await resolveReadPathAsync(a.path, ctx.cwd), ctx.cwd, getAgentDir(), {
					...a,
					opened: sessionOpened(ctx),
				});
				ctx.ui.notify(formatExport(result), "info");
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});

	// Scans of the reference folder run one after another (startup and each run may overlap).
	let scans: Promise<void> = Promise.resolve();
	/** Queue a scan; new imports and scans without a text layer are announced. */
	function scan(ctx: ExtensionContext): Promise<void> {
		scans = scans.then(async () => {
			try {
				const news = (await runImport(undefined, ctx.cwd)).filter((r) => r.status !== "unchanged");
				if (news.length > 0 && ctx.hasUI) ctx.ui.notify(formatImport(news), "info");
			} catch {
				// A folder that cannot be read is skipped; import_document reports the reason.
			}
		});
		return scans;
	}

	// Background scan at startup.
	pi.on("session_start", (event, ctx) => {
		if (event.reason === "startup") void scan(ctx);
	});

	// Drafts whose whole replacement was refused in this run; a second attempt goes through, so a model
	// that has good reason is never stuck.
	const refused = new Set<string>();

	// Before every run: files added since are imported before the model reads the folder.
	pi.on("before_agent_start", async (_event, ctx) => {
		refused.clear();
		await scan(ctx);
	});

	// The user, 2026-11-05: a draft is changed in place, not generated again as a whole.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write") return undefined;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string") return undefined;
		const path = resolve(ctx.cwd, raw);
		// New files and other files are free; so is a rewrite the user asked for.
		if (!existsSync(path) || !isDraftPath(path, ctx.cwd) || refused.has(path)) return undefined;
		if (asksWholeRewrite(lastUserText(ctx))) return undefined;
		refused.add(path);
		return { block: true, reason: t("export.useEdit", { path: raw }) };
	});

	// Reference URLs already handed to the model for testing, so each goes back only once.
	const asked = new Set<string>();

	// After every run: the drafts written or edited in it become .docx files.
	pi.on("agent_end", async (event, ctx) => {
		if (!autoExportEnabled(process.env)) return;
		const drafts = editedDrafts(event.messages as unknown as RunMessage[], ctx.cwd);
		if (drafts.length === 0) return;
		// URLs this session opened, including this run's.
		const opened = sessionOpened(ctx, event.messages as unknown[]);
		// Export each; one failure does not stop the others.
		const lines = [t("export.autoTitle")];
		let failed = false;
		const untested: string[] = [];
		for (const d of drafts) {
			try {
				const result = await exportDraft(d, ctx.cwd, getAgentDir(), { opened });
				lines.push(formatExport(result));
				for (const u of unopenedUrls(result.refs)) if (!asked.has(u) && !untested.includes(u)) untested.push(u);
			} catch (e) {
				failed = true;
				lines.push(t("export.autoFailed", { path: d, reason: e instanceof Error ? e.message : String(e) }));
			}
		}
		// In the interface, or on stderr in print mode (stdout carries the answer).
		if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), failed ? "warning" : "info");
		else process.stderr.write(`${lines.join("\n")}\n`);
		// The user, 2026-11-04: reference URLs not opened yet are opened and tested by the model afterwards.
		// Interactive sessions only (print mode ends with the answer); each URL is handed over once.
		if (ctx.hasUI && untested.length > 0) {
			for (const u of untested) asked.add(u);
			pi.sendMessage(
				{
					customType: "jiawriter-reference-check",
					content: t("export.testRefs", {
						count: untested.length,
						urls: untested.map((u) => `- ${u}`).join("\n"),
					}),
					display: true,
				},
				{ triggerTurn: true },
			);
		}
	});
}
