/**
 * .docx → Markdown pages for reference import. Reads word/document.xml with a small tag scanner:
 * paragraphs (heading levels from styles.xml: "heading N", "Title" or an outline level), tables
 * as Markdown tables, and the page breaks Word recorded at its last layout
 * (w:lastRenderedPageBreak, w:br w:type="page"), so citations can name a page.
 */

// Unzip.
import { strFromU8, unzipSync } from "fflate";

/** A numeric entity's character; one outside Unicode stays as written instead of failing the whole file. */
function codePoint(entity: string, code: number): string {
	return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
}

/** XML text → plain text (the five predefined entities and numeric references). */
export function decodeXml(s: string): string {
	// Numeric references first, then the named ones (&amp; last).
	return s
		.replace(/&#x([0-9a-f]+);/gi, (m, h: string) => codePoint(m, Number.parseInt(h, 16)))
		.replace(/&#(\d+);/g, (m, d: string) => codePoint(m, Number(d)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/** Paragraph style id → heading level (1 = title or heading 1, …), from styles.xml. */
export function headingStyles(stylesXml: string): Map<string, number> {
	// Result.
	const levels = new Map<string, number>();
	// Each paragraph style.
	for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:type="paragraph"[^>]*>[\s\S]*?<\/w:style>/g)) {
		// Its id and name.
		const id = /w:styleId="([^"]+)"/.exec(m[0])?.[1];
		const name = (/<w:name w:val="([^"]+)"/.exec(m[0])?.[1] ?? "").toLowerCase();
		if (!id) continue;
		// "heading N" (Word's built-in names, also in localized documents), "Title", or an outline level.
		const h = /^heading (\d)$/.exec(name);
		const outline = /<w:outlineLvl w:val="(\d)"/.exec(m[0]);
		const level = h ? Number(h[1]) : name === "title" ? 1 : outline ? Number(outline[1]) + 1 : 0;
		if (level > 0 && level <= 6) levels.set(id, level);
	}
	// The map.
	return levels;
}

/** Markdown pages of a .docx (one string per page Word recorded; one page when it recorded none). */
export function docxToPages(bytes: Uint8Array): string[] {
	// The two parts this reader needs.
	const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" || f.name === "word/styles.xml" });
	const doc = files["word/document.xml"];
	if (!doc) throw new Error("word/document.xml missing");
	const styles = headingStyles(files["word/styles.xml"] ? strFromU8(files["word/styles.xml"]) : "");
	// Pages of finished lines.
	const pages: string[][] = [[]];
	// Current paragraph: text, heading level, inside w:t.
	let text = "";
	let level = 0;
	let inText = false;
	// Table state: depth, rows of the outermost table, the row and cell being read.
	let tableDepth = 0;
	let rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	// Add a finished line to the current page.
	const emit = (line: string) => {
		if (line.trim() !== "") pages[pages.length - 1].push(line);
	};
	// End the current paragraph: into the table cell, or onto the page with its heading marks.
	const endParagraph = () => {
		const s = text.replace(/[ \t]+/g, " ").trim();
		if (tableDepth > 0) cell = cell ? `${cell} ${s}` : s;
		else if (s) emit(level > 0 ? `${"#".repeat(level)} ${s}` : s);
		text = "";
		level = 0;
	};
	// Tags of interest and the text between them.
	const re =
		/<(\/?)w:(p|tbl|tr|tc|t|tab|br|cr|lastRenderedPageBreak|pStyle|outlineLvl|instrText|delText)\b([^>]*?)(\/?)>|([^<]+)/g;
	// Skip field codes and deleted text.
	let skip = false;
	// Walk the body.
	for (const m of strFromU8(doc).matchAll(re)) {
		const [, close, tag, attrs, selfClose, chars] = m;
		// Text between tags counts only inside w:t.
		if (chars !== undefined) {
			if (inText && !skip) text += decodeXml(chars);
			continue;
		}
		switch (tag) {
			case "t":
				inText = !close && !selfClose;
				break;
			case "instrText":
			case "delText":
				skip = !close && !selfClose;
				break;
			case "tab":
				if (!close) text += " ";
				break;
			case "cr":
				if (!close) text += " ";
				break;
			case "br":
			case "lastRenderedPageBreak":
				// A page break outside tables ends the page here; other breaks are spaces.
				if (close) break;
				if ((tag === "lastRenderedPageBreak" || /w:type="page"/.test(attrs)) && tableDepth === 0) {
					// Text before the break stays on the old page.
					const before = text;
					const lvl = level;
					endParagraph();
					if (before.trim() !== "" || pages[pages.length - 1].length > 0) pages.push([]);
					// The rest of the paragraph keeps its level.
					level = lvl;
				} else text += " ";
				break;
			case "pStyle":
				level = styles.get(/w:val="([^"]+)"/.exec(attrs)?.[1] ?? "") ?? level;
				break;
			case "outlineLvl":
				if (level === 0) level = Number(/w:val="(\d)"/.exec(attrs)?.[1] ?? 9) + 1;
				if (level > 6) level = 0;
				break;
			case "p":
				if (close || selfClose) endParagraph();
				break;
			case "tbl":
				if (!close) {
					tableDepth++;
					if (tableDepth === 1) rows = [];
				} else if (--tableDepth === 0 && rows.length > 0) {
					// Markdown table: header, rule, rows padded to the widest row.
					const width = Math.max(...rows.map((r) => r.length));
					const fmt = (r: string[]) =>
						`| ${[...r, ...Array(width - r.length).fill("")].map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
					emit([fmt(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(fmt)].join("\n"));
				}
				break;
			case "tr":
				if (tableDepth === 1) {
					if (!close) row = [];
					else rows.push(row);
				}
				break;
			case "tc":
				if (tableDepth === 1) {
					if (!close) cell = "";
					else row.push(cell);
				}
				break;
		}
	}
	// Pages as Markdown, empty pages dropped.
	return pages.map((p) => p.join("\n\n")).filter((p) => p !== "");
}
