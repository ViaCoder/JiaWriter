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
