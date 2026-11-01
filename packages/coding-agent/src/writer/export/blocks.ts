/**
 * Markdown draft → document blocks for export: # title, ## / ### / #### headings levels 1–3,
 * paragraphs, list items, tables and code. Inline Markdown is reduced to plain text with bold
 * spans; links keep their text and URL as 文本（URL）.
 */

/** One inline piece of a paragraph. */
export interface Span {
	// Text of the piece.
	text: string;
	// Bold (**…**).
	bold: boolean;
}

/** One block of the document. */
export type Block =
	| { kind: "title" | "h1" | "h2" | "h3" | "para"; spans: Span[] }
	| { kind: "item"; marker: string; spans: Span[] }
	| { kind: "table"; rows: string[][] }
	| { kind: "code"; lines: string[] };

/** Heading kind by the number of # signs. */
const HEADINGS: Readonly<Record<number, "title" | "h1" | "h2" | "h3">> = { 1: "title", 2: "h1", 3: "h2", 4: "h3" };

/** Inline Markdown → spans: **bold** kept, links as 文本（URL）, other marks removed. */
export function parseInline(text: string): Span[] {
	// Links and images to text (URL); emphasis with * or _ and inline code marks dropped.
	const plain = text
		.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
			label === url ? url : `${label}（${url}）`,
		)
		.replace(/(^|[^*])\*(?!\*)([^*\n]+)\*(?!\*)/g, "$1$2")
		.replace(/`([^`]*)`/g, "$1");
	// Split on **; odd pieces are bold.
	const parts = plain.split("**");
	// An unclosed ** at the end stays as text with the piece after it.
	if (parts.length % 2 === 0) parts.push(parts.splice(-2).join("**"));
	// Non-empty pieces.
	return parts.map((text, i) => ({ text, bold: i % 2 === 1 })).filter((s) => s.text !== "");
}

/** Cells of one Markdown table row. */
function tableCells(line: string): string[] {
	// Strip the outer pipes and split.
	return line
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((c) => c.trim());
}

/** Markdown text → blocks. Blank lines end paragraphs; lines of one paragraph are joined. fix (the punctuation
 * pass) runs on the raw text of each paragraph, heading, list item and table cell; code stays verbatim. */
export function parseBlocks(markdown: string, fix: (text: string) => string = (x) => x): Block[] {
	// Result.
	const blocks: Block[] = [];
	// Lines of the paragraph being collected.
	let para: string[] = [];
	// Close the open paragraph. CJK lines join without a space, other lines with one.
	const flush = () => {
		if (para.length === 0) return;
		const joined = para.reduce((acc, l) => (acc === "" ? l : /[　-鿿＀-￯]$/.test(acc) ? acc + l : `${acc} ${l}`), "");
		blocks.push({ kind: "para", spans: parseInline(fix(joined)) });
		para = [];
	};
	// All lines (CRLF and BOM tolerated).
	const lines = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
	// Walk with an index (tables and code span several lines).
	for (let i = 0; i < lines.length; i++) {
		// This line, trimmed on the right.
		const line = lines[i].replace(/\s+$/, "");
		// Code fence: everything up to the closing fence, verbatim.
		if (/^\s*```/.test(line)) {
			flush();
			const code: string[] = [];
			for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
			blocks.push({ kind: "code", lines: code });
			continue;
		}
		// Blank line or rule ends a paragraph.
		if (line.trim() === "" || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flush();
			continue;
		}
		// Heading.
		const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (h) {
			flush();
			blocks.push({ kind: HEADINGS[h[1].length] ?? "h3", spans: parseInline(fix(h[2])) });
			continue;
		}
		// Table: a header row followed by a |---| separator row.
		if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
			flush();
			const rows = [tableCells(line).map(fix)];
			for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim() !== ""; i++)
				rows.push(tableCells(lines[i]).map(fix));
			i--;
			blocks.push({ kind: "table", rows });
			continue;
		}
		// List item: - * + bullets or 1. / 1) numbers.
		const li = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
		if (li) {
			flush();
			blocks.push({
				kind: "item",
				marker: /\d/.test(li[1]) ? `${li[1].slice(0, -1)}．` : "",
				spans: parseInline(fix(li[2])),
			});
			continue;
		}
		// Quote marks are dropped; the text is a normal paragraph line.
		para.push(line.replace(/^\s*>\s?/, "").trim());
	}
	// Last paragraph.
	flush();
	// The blocks.
	return blocks;
}

/** The punctuation pass over a Markdown draft, keeping its Markdown: block marks, code and table rules untouched. */
export function punctMarkdown(markdown: string, fix: (text: string) => string): string {
	// Inside a code fence.
	let code = false;
	// Line by line (a paragraph is one line in model drafts; quotes pair within it).
	return markdown
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => {
			// Fences toggle code; code lines are verbatim.
			if (/^\s*```/.test(line)) {
				code = !code;
				return line;
			}
			if (code || line.trim() === "") return line;
			// Table rule rows stay; other table rows are fixed cell by cell.
			if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) return line;
			if (/^\s*\|.*\|\s*$/.test(line)) return `| ${tableCells(line).map(fix).join(" | ")} |`;
			// Heading, list and quote marks stay in front of the fixed text.
			const m = /^(\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+|>\s?)?)(.*)$/.exec(line) as RegExpExecArray;
			return m[1] + fix(m[2]);
		})
		.join("\n");
}
