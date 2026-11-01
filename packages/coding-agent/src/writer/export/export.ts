/**
 * Export a Markdown draft to .docx (with an export profile) or to Markdown, after the Chinese
 * punctuation pass, and report what the final check of the written file found.
 */

// Files.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
// Path helpers.
import { basename, dirname, extname, join, relative, resolve } from "node:path";
// Output messages.
import { t, type WriterLang } from "../i18n/index.ts";
// Markdown blocks.
import { parseBlocks, punctMarkdown } from "./blocks.ts";
// docx writer and check.
import { auditDocx, buildDocx, type DocxAudit } from "./docx.ts";
// Profiles.
import { loadProfile } from "./profile.ts";
// Punctuation.
import { countAsciiNextToHan, normalizePunct } from "./punct.ts";

/** Export options. */
export interface ExportOptions {
	// "docx" (default) or "md".
	format?: "docx" | "md";
	// Profile name or JSON path (default default-zh).
	profile?: string;
	// Output path (default next to the draft).
	output?: string;
}

/** Outcome of an export. */
export interface ExportResult {
	// Written file, relative to the working folder.
	out: string;
	// Format written.
	format: "docx" | "md";
	// Profile used.
	profile: string;
	// Whether the punctuation pass ran.
	punct: boolean;
	// Starts of paragraphs with an unpaired quote.
	unpaired: string[];
	// Occurrences of 待核实 (the user: no such marks in a finished draft).
	pendingMarks: number;
	// ASCII punctuation next to Chinese characters in the Markdown output.
	asciiNextToHan: number;
	// XML check of a .docx.
	audit?: DocxAudit;
}

/** Default output path: the draft's name with .docx, or .export.md for Markdown. */
export function defaultOutput(draft: string, format: "docx" | "md"): string {
	// Name without its extension.
	const stem = join(dirname(draft), basename(draft, extname(draft)));
	return format === "docx" ? `${stem}.docx` : `${stem}.export.md`;
}

/** Export the draft at the absolute path `draft`. */
export async function exportDraft(
	draft: string,
	cwd: string,
	agentDir: string,
	opts: ExportOptions = {},
): Promise<ExportResult> {
	// Format, profile, output.
	const format = opts.format ?? "docx";
	const profile = loadProfile(opts.profile, cwd, agentDir);
	const outAbs = opts.output ? resolve(cwd, opts.output) : defaultOutput(draft, format);
	// The draft.
	const markdown = (await readFile(draft, "utf-8")).replace(/^﻿/, "");
	// Punctuation pass that remembers paragraphs with an unpaired quote.
	const unpaired: string[] = [];
	const fix = (text: string) => {
		if (!profile.punct) return text;
		const r = normalizePunct(text);
		if (r.unpaired.length > 0) unpaired.push(r.text.slice(0, 24));
		return r.text;
	};
	// The file's bytes.
	let bytes: Uint8Array;
	let audit: DocxAudit | undefined;
	let asciiNextToHan = 0;
	if (format === "docx") {
		bytes = await buildDocx(parseBlocks(markdown, fix), profile);
		audit = auditDocx(bytes);
	} else {
		const text = punctMarkdown(markdown, fix);
		asciiNextToHan = countAsciiNextToHan(text.replace(/```[\s\S]*?```|`[^`]*`|\]\([^)]*\)|https?:\/\/\S+/g, ""));
		bytes = new TextEncoder().encode(text);
	}
	// Written atomically.
	await mkdir(dirname(outAbs), { recursive: true });
	const tmp = `${outAbs}.${process.pid}.tmp`;
	await writeFile(tmp, bytes);
	await rename(tmp, outAbs);
	// The report data.
	return {
		out: relative(cwd, outAbs),
		format,
		profile: profile.name,
		punct: profile.punct,
		unpaired,
		pendingMarks: (markdown.match(/待核实/g) ?? []).length,
		asciiNextToHan: audit ? audit.asciiNextToHan : asciiNextToHan,
		audit,
	};
}

/** Report of an export. */
export function formatExport(r: ExportResult, lang?: WriterLang): string {
	// Heading.
	const lines = [t("export.done", { out: r.out, format: r.format, profile: r.profile }, lang)];
	// The .docx check.
	if (r.audit) {
		const a = r.audit;
		lines.push(
			t(
				"export.audit",
				{
					runs: a.chineseRuns,
					hint: a.missingHint,
					font: a.missingEastAsia,
					sizes: a.sizesPt.join("/"),
					spacing: a.lineSpacingsPt.join("/"),
				},
				lang,
			),
		);
	}
	// Punctuation.
	lines.push(
		t(r.punct ? "export.punct" : "export.punctOff", { ascii: r.asciiNextToHan, quotes: r.unpaired.length }, lang),
	);
	for (const u of r.unpaired.slice(0, 5)) lines.push(t("export.unpaired", { start: u }, lang));
	// 待核实 marks.
	if (r.pendingMarks > 0) lines.push(t("export.pending", { count: r.pendingMarks }, lang));
	// The report.
	return lines.join("\n");
}
