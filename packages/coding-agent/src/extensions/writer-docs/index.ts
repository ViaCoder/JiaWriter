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
 *   once, to open and test with fetch_web.
 */

// Whether a draft exists.
// Copying a file into the topic.
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
// Paths.
import { basename, join, resolve } from "node:path";
// Parameter schemas.
import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
import { Type } from "typebox";
// Agent directory (~/.jiawriter/agent).
import { getAgentDir } from "../../config.ts";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// Upstream path resolution (cwd, ~, @ prefix).
import { resolveReadPathAsync } from "../../core/tools/path-utils.ts";
// Automatic export.
import { autoExportEnabled, editedDrafts, type RunMessage } from "../../writer/docs/auto.ts";
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

/** URLs fetch_web opened with text on the session's active branch, plus those of the messages given. */
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

/** Where a file is copied in a folder: its own name, or a numbered one when another file holds that name. */
export function freeName(folder: string, file: string): string {
	// The same content under the same name is the same file.
	const name = basename(file);
	const same = (path: string) => !existsSync(path) || readFileSync(path).equals(readFileSync(file));
	// Name and extension apart, for 报告-2.pdf.
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	let path = join(folder, name);
	for (let n = 2; !same(path); n++) path = join(folder, `${stem}-${n}${ext}`);
	return path;
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
			await mkdir(refs, { recursive: true });
			const copy = freeName(refs, file);
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
			"Imports a reference file (pdf, docx, txt, md, html) to Markdown with page markers under 参考资料/.parsed/; without path, every new file in 参考资料/",
		// Argument schema.
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "File" })),
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
		description: "Exports a Markdown draft to .docx (default) or Markdown, with Chinese punctuation",
		// Argument schema.
		parameters: Type.Object({
			path: Type.String({ description: "Draft" }),
			format: Type.Optional(StringEnum(["docx", "md"] as const)),
			profile: Type.Optional(Type.String({ description: "Profile name or .json path" })),
			output: Type.Optional(Type.String({ description: "Output path" })),
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
	// Files already reported as giving nothing.
	const reported = new Set<string>();
	/** Queue a scan; new imports and scans without a text layer are announced. */
	function scan(ctx: ExtensionContext): Promise<void> {
		scans = scans.then(async () => {
			try {
				// A file that yields nothing (a scan) comes up in every scan: it is reported once.
				const news = (await runImport(undefined, ctx.cwd)).filter(
					(r) => r.status !== "unchanged" && (r.status === "ok" || !reported.has(`${r.source}\n${r.status}`)),
				);
				for (const r of news) reported.add(`${r.source}\n${r.status}`);
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

	// Before every run: files added since are imported before the model reads the folder.
	pi.on("before_agent_start", async (_event, ctx) => {
		await scan(ctx);
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
