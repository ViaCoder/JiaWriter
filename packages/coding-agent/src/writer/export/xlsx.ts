/**
 * Document blocks → .xlsx: one sheet per table, named after the heading above it, the first row as a bold header,
 * numbers as numbers, column widths from the text; a draft without tables gives one sheet of its lines. Written as
 * SpreadsheetML by hand (inline strings, no shared-string table) and zipped with fflate; no spreadsheet library.
 * The reverse of docs/xlsx-read.ts, so an export reads back as it was written (2026-11-14: WorkBuddy parity).
 */

// Zip.
import { strToU8, zipSync } from "fflate";
// The blocks of a draft.
import type { Block } from "./blocks.ts";

/** Longest sheet name Excel allows. */
const MAX_SHEET_NAME = 31;
/** Widest column, in characters. */
const MAX_WIDTH = 60;
/** Characters Excel forbids in a sheet name. */
const BAD_NAME = /[\\/?*[\]:]/g;

/** XML text of a string. */
export function xmlText(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** The column letters of an index: 0 → A, 25 → Z, 26 → AA. */
export function columnName(i: number): string {
	let n = i + 1;
	let out = "";
	while (n > 0) {
		out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
}

/** A cell's text as a number when it is one as written (12, -3.5, 1,267, 45%), else undefined. */
export function numberOf(text: string): number | undefined {
	const t = text.trim().replace(/,/g, "");
	if (!/^-?\d+(?:\.\d+)?%?$/.test(t)) return undefined;
	return t.endsWith("%") ? Number(t.slice(0, -1)) / 100 : Number(t);
}

/** Display width of text in character cells: a CJK character takes two. */
function widthOf(text: string): number {
	let w = 0;
	for (const ch of text) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
	return w;
}

/** One sheet: its name and rows. */
export interface Sheet {
	name: string;
	rows: string[][];
}

/** A sheet name from a heading: forbidden characters out, at most 31 characters, unique among those taken. */
export function sheetName(heading: string, taken: ReadonlySet<string>): string {
	const base = (heading.replace(BAD_NAME, "").trim() || "表").slice(0, MAX_SHEET_NAME);
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) {
		const name = `${base.slice(0, MAX_SHEET_NAME - String(i).length - 1)} ${i}`;
		if (!taken.has(name)) return name;
	}
}

/** The sheets of a draft: each table under the heading above it; a draft without tables as one sheet of lines. */
export function sheetsOf(blocks: readonly Block[]): Sheet[] {
	const sheets: Sheet[] = [];
	const taken = new Set<string>();
	let heading = "";
	for (const b of blocks) {
		if (b.kind === "title" || b.kind === "h1" || b.kind === "h2" || b.kind === "h3")
			heading = b.spans.map((s) => s.text).join("");
		if (b.kind !== "table" || b.rows.length === 0) continue;
		const name = sheetName(heading, taken);
		taken.add(name);
		sheets.push({ name, rows: b.rows.map((r) => [...r]) });
	}
	if (sheets.length > 0) return sheets;
	// No table: the text, one line a row.
	const rows = blocks.flatMap((b) => {
		if (b.kind === "table") return [];
		if (b.kind === "code") return b.lines.map((l) => [l]);
		const text = b.spans.map((s) => s.text).join("");
		return text.trim() ? [[b.kind === "item" ? `${b.marker} ${text}` : text]] : [];
	});
	return [{ name: "正文", rows }];
}

/** The XML of one sheet: the rows as inline strings or numbers, the first row in the bold style, widths set. */
export function sheetXml(sheet: Sheet): string {
	const width = Math.max(1, ...sheet.rows.map((r) => r.length));
	// Column widths from the longest text, a little padding, capped.
	const cols = Array.from({ length: width }, (_, i) => {
		const w = Math.max(8, ...sheet.rows.map((r) => widthOf(r[i] ?? "")));
		return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(MAX_WIDTH, w + 2)}" customWidth="1"/>`;
	}).join("");
	const rows = sheet.rows
		.map((r, ri) => {
			const cells = r
				.map((text, ci) => {
					const ref = `${columnName(ci)}${ri + 1}`;
					const style = ri === 0 ? ' s="1"' : "";
					const n = numberOf(text);
					if (n !== undefined && ri > 0) return `<c r="${ref}"${style}><v>${n}</v></c>`;
					if (text === "") return "";
					return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
				})
				.join("");
			return `<row r="${ri + 1}">${cells}</row>`;
		})
		.join("");
	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
		`<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
		`<cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`
	);
}

/** The styles part: style 0 plain, style 1 bold with a light fill for the header row; a Chinese font throughout. */
function stylesXml(font: string): string {
	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
		`<fonts count="2"><font><sz val="11"/><name val="${xmlText(font)}"/></font><font><b/><sz val="11"/><name val="${xmlText(font)}"/></font></fonts>` +
		'<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/></patternFill></fill></fills>' +
		'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
		'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
		'<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
		'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
	);
}

/** The .xlsx bytes of the blocks. */
export function buildXlsx(blocks: readonly Block[], font = "宋体"): Uint8Array {
	const sheets = sheetsOf(blocks);
	const parts: Record<string, Uint8Array> = {};
	const sheetTags: string[] = [];
	const relTags: string[] = [];
	const overrides: string[] = [];
	sheets.forEach((sheet, i) => {
		const n = i + 1;
		parts[`xl/worksheets/sheet${n}.xml`] = strToU8(sheetXml(sheet));
		sheetTags.push(`<sheet name="${xmlText(sheet.name)}" sheetId="${n}" r:id="rId${n}"/>`);
		relTags.push(
			`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`,
		);
		overrides.push(
			`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
		);
	});
	const stylesId = `rId${sheets.length + 1}`;
	return zipSync(
		{
			"[Content_Types].xml": strToU8(
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
					'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
					'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
					'<Default Extension="xml" ContentType="application/xml"/>' +
					'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
					'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
					`${overrides.join("")}</Types>`,
			),
			"_rels/.rels": strToU8(
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
					'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
					'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
					"</Relationships>",
			),
			"xl/workbook.xml": strToU8(
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
					'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
					`<sheets>${sheetTags.join("")}</sheets></workbook>`,
			),
			"xl/_rels/workbook.xml.rels": strToU8(
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
					'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
					`${relTags.join("")}<Relationship Id="${stylesId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
					"</Relationships>",
			),
			"xl/styles.xml": strToU8(stylesXml(font)),
			...parts,
		},
		{ level: 6 },
	);
}
