/**
 * Export a Markdown draft to .docx (with an export profile) or to Markdown, after the symbol pass (LaTeX,
 * HTML entities), the Chinese punctuation pass and the space pass, and report what the final check of the
 * written file and of the reference list found.
 */

// Files.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
// Path helpers.
import { basename, dirname, extname, join, relative, resolve } from "node:path";
// Output messages.
import { t, type WriterLang } from "../i18n/index.ts";
// Markdown blocks.
import { type Block, parseBlocks, punctMarkdown } from "./blocks.ts";
// docx writer and check.
import { auditDocx, buildDocx, type DocxAudit } from "./docx.ts";
// Profiles.
import { loadProfile } from "./profile.ts";
// Punctuation and spaces.
import { countAsciiNextToHan, countLooseSpaces, normalizePunct, tightenSpaces } from "./punct.ts";
// The reference list.
import { checkReferences, type RefReport } from "./refs.ts";
// Unicode symbols for LaTeX and HTML entities.
import { fixSymbols } from "./symbols.ts";

/** Export options. */
export interface ExportOptions {
	// "docx" (default) or "md".
	format?: "docx" | "md";
	// Profile name or JSON path (default default-zh).
	profile?: string;
	// Output path (default next to the draft).
	output?: string;
	// URLs web_fetch opened in this session (openedUrls); undefined: the check is skipped.
	opened?: readonly string[];
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
	// LaTeX math, commands, HTML entities and escapes turned into Unicode symbols.
	symbols: number;
	// LaTeX commands left without a Unicode form.
	unknownSymbols: string[];
	// Spaces other than one between English words, in the exported text (code excluded).
	looseSpaces: number;
	// The reference list.
	refs: RefReport;
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
	// Symbol pass, then punctuation and spaces; remembers paragraphs with an unpaired quote and unknown commands.
	const unpaired: string[] = [];
	let symbols = 0;
	const unknownSymbols: string[] = [];
	const fix = (text: string) => {
		// Symbols always: Word shows LaTeX source as plain text.
		const sym = fixSymbols(text);
		symbols += sym.converted;
		for (const u of sym.unknown) if (!unknownSymbols.includes(u)) unknownSymbols.push(u);
		if (!profile.punct) return sym.text;
		const r = normalizePunct(sym.text);
		if (r.unpaired.length > 0) unpaired.push(r.text.slice(0, 24));
		return tightenSpaces(r.text);
	};
	// The file's bytes.
	let bytes: Uint8Array;
	let audit: DocxAudit | undefined;
	let asciiNextToHan = 0;
	let looseSpaces = 0;
	if (format === "docx") {
		const blocks = parseBlocks(markdown, fix);
		looseSpaces = blocks.reduce((n, b) => n + blockSpaces(b), 0);
		bytes = await buildDocx(blocks, profile);
		audit = auditDocx(bytes);
	} else {
		const text = punctMarkdown(markdown, fix);
		const prose = text.replace(/```[\s\S]*?```|`[^`]*`|\]\([^)]*\)|https?:\/\/\S+/g, "");
		asciiNextToHan = countAsciiNextToHan(prose);
		// Markdown marks at the line starts and table pipes are layout, not text.
		looseSpaces = prose
			.split("\n")
			.map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,3}[.)．]\s*|>\s?)?/, ""))
			.filter((l) => !/^\s*\|/.test(l))
			.reduce((n, l) => n + countLooseSpaces(l), 0);
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
		symbols,
		unknownSymbols,
		looseSpaces,
		refs: checkReferences(markdown, opts.opened),
		audit,
	};
}

/** Loose spaces in the text of one block; code keeps its spaces. */
function blockSpaces(b: Block): number {
	// Tables cell by cell, code not at all, the rest span text (link URLs have no spaces).
	if (b.kind === "code") return 0;
	if (b.kind === "table") return b.rows.flat().reduce((n, c) => n + countLooseSpaces(c), 0);
	return countLooseSpaces(b.spans.map((s) => s.text).join(""));
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
	// Spaces and symbols.
	lines.push(t("export.spaces", { count: r.looseSpaces }, lang));
	if (r.symbols > 0) lines.push(t("export.symbols", { count: r.symbols }, lang));
	if (r.unknownSymbols.length > 0)
		lines.push(
			t("export.symbolsUnknown", { count: r.unknownSymbols.length, names: r.unknownSymbols.join(" ") }, lang),
		);
	// Hyperlinks of a .docx.
	if (r.audit && r.audit.hyperlinks > 0)
		lines.push(t("export.links", { links: r.audit.hyperlinks, broken: r.audit.brokenLinks }, lang));
	// The reference list.
	if (r.refs.entries > 0) {
		const count = (p: string) => r.refs.issues.filter((i) => i.problems.includes(p as never)).length;
		lines.push(
			t(
				"export.refs",
				{ entries: r.refs.entries, url: count("url"), title: count("title"), opened: count("opened") },
				lang,
			),
		);
		for (const i of r.refs.issues.slice(0, 8))
			lines.push(
				t(
					"export.refIssue",
					{
						start: i.start,
						problems: i.problems.map((p) => t(`export.ref.${p}`, {}, lang)).join(t("export.listSep", {}, lang)),
					},
					lang,
				),
			);
	}
	// 待核实 marks.
	if (r.pendingMarks > 0) lines.push(t("export.pending", { count: r.pendingMarks }, lang));
	// The report.
	return lines.join("\n");
}
