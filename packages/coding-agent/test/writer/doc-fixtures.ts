// Test fixtures for import and export: a minimal .docx built from WordprocessingML and a minimal
// multi-page PDF with Helvetica text (an empty page string makes an image-like page without text).

// Zip writer.
import { strToU8, zipSync } from "fflate";

/** Namespace of WordprocessingML. */
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A .docx whose body is bodyXml (inner XML of w:body), with optional styles.xml content. */
export function makeDocx(bodyXml: string, stylesXml = ""): Uint8Array {
	// The parts a reader needs.
	return zipSync({
		"[Content_Types].xml": strToU8(
			'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
		),
		"word/document.xml": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`,
		),
		...(stylesXml
			? { "word/styles.xml": strToU8(`<?xml version="1.0"?><w:styles ${W}>${stylesXml}</w:styles>`) }
			: {}),
	});
}

/** One paragraph of text, optionally with a style id. */
export function wp(text: string, style = ""): string {
	// Paragraph properties only when styled.
	const ppr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
	return `<w:p>${ppr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/** Namespaces of SpreadsheetML and of the package relationships. */
const S =
	'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const R = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

/**
 * A .xlsx with the given sheets: each a name and rows of cells, a cell being a string (shared), a number, a boolean,
 * or { date: serial } for a date-styled number; null for an empty cell. stylesXml replaces the default styles part.
 */
export function makeXlsx(
	sheets: readonly {
		name: string;
		rows: readonly (readonly (string | number | boolean | { date: number } | null)[])[];
	}[],
	stylesXml?: string,
): Uint8Array {
	// Shared strings in order of first use.
	const strings: string[] = [];
	const shared = (s: string) => {
		const at = strings.indexOf(s);
		if (at >= 0) return at;
		strings.push(s);
		return strings.length - 1;
	};
	// Column letters of an index.
	const col = (i: number) => {
		let n = i + 1;
		let out = "";
		while (n > 0) {
			out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
			n = Math.floor((n - 1) / 26);
		}
		return out;
	};
	// Each sheet's XML.
	const parts: Record<string, Uint8Array> = {};
	const sheetTags: string[] = [];
	const relTags: string[] = [];
	sheets.forEach((sheet, si) => {
		const rows = sheet.rows
			.map((row, ri) => {
				const cells = row
					.map((cell, ci) => {
						const ref = `${col(ci)}${ri + 1}`;
						if (cell === null) return "";
						if (typeof cell === "string") return `<c r="${ref}" t="s"><v>${shared(cell)}</v></c>`;
						if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
						if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
						return `<c r="${ref}" s="1"><v>${cell.date}</v></c>`;
					})
					.join("");
				return `<row r="${ri + 1}">${cells}</row>`;
			})
			.join("");
		parts[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
			`<?xml version="1.0"?><worksheet ${S}><sheetData>${rows}</sheetData></worksheet>`,
		);
		sheetTags.push(`<sheet name="${sheet.name}" sheetId="${si + 1}" r:id="rId${si + 1}"/>`);
		relTags.push(
			`<Relationship Id="rId${si + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${si + 1}.xml"/>`,
		);
	});
	// Style 0 general, style 1 the built-in date format 14.
	const styles =
		stylesXml ??
		`<?xml version="1.0"?><styleSheet ${S}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`;
	return zipSync({
		"[Content_Types].xml": strToU8(
			'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
		),
		"xl/workbook.xml": strToU8(
			`<?xml version="1.0"?><workbook ${S}><sheets>${sheetTags.join("")}</sheets></workbook>`,
		),
		"xl/_rels/workbook.xml.rels": strToU8(
			`<?xml version="1.0"?><Relationships ${R}>${relTags.join("")}</Relationships>`,
		),
		"xl/sharedStrings.xml": strToU8(
			`<?xml version="1.0"?><sst ${S}>${strings.map((s) => `<si><t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`).join("")}</sst>`,
		),
		"xl/styles.xml": strToU8(styles),
		...parts,
	});
}

/** Namespaces of PresentationML and DrawingML. */
const P =
	'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** One text shape of a slide: paragraphs of text; a title placeholder when asked. */
export function shape(paragraphs: readonly string[], title = false): string {
	// Placeholder mark, then the paragraphs as single runs.
	const ph = title ? '<p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' : "<p:nvSpPr/>";
	return `<p:sp>${ph}<p:txBody>${paragraphs.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
}

/** A table of a slide: rows of cell texts. */
export function slideTable(rows: readonly (readonly string[])[]): string {
	// Graphic frame around the table.
	const cells = (r: readonly string[]) =>
		r.map((c) => `<a:tc><a:txBody><a:p><a:r><a:t>${c}</a:t></a:r></a:p></a:txBody></a:tc>`).join("");
	return `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${rows.map((r) => `<a:tr>${cells(r)}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** A .pptx with one slide per entry: the slide's shapes XML and, when given, its notes text. */
export function makePptx(slides: readonly { body: string; notes?: string }[]): Uint8Array {
	// Each slide, its relationships and its notes.
	const parts: Record<string, Uint8Array> = {};
	const ids: string[] = [];
	const rels: string[] = [];
	slides.forEach((slide, i) => {
		const n = i + 1;
		parts[`ppt/slides/slide${n}.xml`] = strToU8(
			`<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${slide.body}</p:spTree></p:cSld></p:sld>`,
		);
		ids.push(`<p:sldId id="${255 + n}" r:id="rId${n}"/>`);
		rels.push(
			`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`,
		);
		if (slide.notes !== undefined) {
			parts[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(
				`<?xml version="1.0"?><p:notes ${P}><p:cSld><p:spTree>${shape([slide.notes])}${shape([String(n)])}</p:spTree></p:cSld></p:notes>`,
			);
			parts[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
				`<?xml version="1.0"?><Relationships ${R}><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`,
			);
		}
	});
	return zipSync({
		"[Content_Types].xml": strToU8(
			'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
		),
		"ppt/presentation.xml": strToU8(
			`<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${ids.join("")}</p:sldIdLst></p:presentation>`,
		),
		"ppt/_rels/presentation.xml.rels": strToU8(
			`<?xml version="1.0"?><Relationships ${R}>${rels.join("")}</Relationships>`,
		),
		...parts,
	});
}

/** A PDF with one page per string (ASCII text drawn in Helvetica). */
export function makePdf(pages: readonly string[]): Uint8Array {
	// Objects by number: 1 catalog, 2 page tree, 3 font, then a page and its content per page.
	const objs: string[] = [];
	objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
	objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
	pages.forEach((text, i) => {
		// Text drawing operators (none for an empty page).
		const stream = text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET` : "";
		objs[4 + i * 2] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
		objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	});
	// Body with byte offsets for the cross-reference table.
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let i = 1; i < objs.length; i++) {
		offsets.push(out.length);
		out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
	}
	// Cross-reference table and trailer.
	const xref = out.length;
	out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	// ASCII bytes.
	return strToU8(out);
}
