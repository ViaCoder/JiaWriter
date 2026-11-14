/**
 * .xlsx → Markdown pages for reference import: one page per sheet, the sheet's name as a heading and its cells as a
 * Markdown table (the first row as the header). Reads the workbook's sheet list, the shared strings, the cell styles
 * (to show date cells as dates) and each sheet's XML with small regular expressions; no spreadsheet library. Statistics
 * tables are common reference material for an official document (2026-11-14), and were skipped as binary before.
 */

// Unzip.
import { strFromU8, unzipSync } from "fflate";
// XML entities.
import { decodeXml } from "./docx-read.ts";

/** Most rows read from one sheet: a table longer than this is cut, with a note. */
export const MAX_ROWS = 500;
/** Most columns read from one sheet. */
export const MAX_COLS = 60;

/** Excel's built-in number formats that show a date or a time. */
const DATE_FORMAT_IDS = new Set([
	14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56,
	57, 58,
]);

/** The column number (0-based) of a cell reference: A → 0, Z → 25, AA → 26. */
export function columnOf(ref: string): number {
	// The letters before the row number.
	const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

/** An Excel serial date as yyyy-mm-dd (with the time when the serial has a fraction and it is not midnight). */
export function serialToDate(serial: number): string {
	// Day 0 of Excel's 1900 system is 1899-12-30 (the system counts a 1900 leap day that never was).
	const ms = Math.round((serial - 25569) * 86400 * 1000);
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return String(serial);
	const date = d.toISOString().slice(0, 10);
	const time = d.toISOString().slice(11, 16);
	return time === "00:00" ? date : `${date} ${time}`;
}

/** Whether a custom format code shows a date: year, month or day letters outside quoted text. */
export function isDateFormat(code: string): boolean {
	// Quoted literals and escaped characters do not count.
	const bare = code
		.replace(/"[^"]*"/g, "")
		.replace(/\\./g, "")
		.replace(/\[[^\]]*\]/g, "");
	return /[ymd]/i.test(bare) && !/^[#0,.?% E+-]*$/.test(bare);
}

/** The cell styles (xf index → shows a date), from xl/styles.xml. */
export function dateStyles(stylesXml: string): Set<number> {
	// Custom formats that are dates.
	const customDates = new Set<number>();
	for (const m of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g))
		if (isDateFormat(decodeXml(m[2]))) customDates.add(Number(m[1]));
	// The cell formats, in order: each one's number format.
	const out = new Set<number>();
	const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
	let i = 0;
	for (const m of xfs.matchAll(/<xf\b([^>]*)\/?>/g)) {
		const id = Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0);
		if (DATE_FORMAT_IDS.has(id) || customDates.has(id)) out.add(i);
		i++;
	}
	return out;
}

/** The shared strings, in order: each one's text (rich text runs joined). */
export function sharedStrings(xml: string): string[] {
	// One entry per si.
	return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
		[...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join(""),
	);
}

/** The sheets of a workbook in order: name and the zip path of each. */
export function sheetList(workbookXml: string, relsXml: string): { name: string; path: string }[] {
	// Relationship id → target.
	const targets = new Map<string, string>();
	for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
		const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
		const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
		if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
	}
	// Each sheet, by its relationship.
	const out: { name: string; path: string }[] = [];
	for (const m of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
		const name = decodeXml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? "");
		const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
		const path = targets.get(rid);
		if (path) out.push({ name, path });
	}
	return out;
}

/** The rows of one sheet as text cells, gaps filled, at most MAX_ROWS by MAX_COLS; whether rows were cut. */
export function sheetRows(
	sheetXml: string,
	strings: readonly string[],
	dates: ReadonlySet<number>,
): { rows: string[][]; cut: boolean } {
	// Finished rows.
	const rows: string[][] = [];
	let cut = false;
	for (const r of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
		if (rows.length >= MAX_ROWS) {
			cut = true;
			break;
		}
		// The row's cells by column.
		const row: string[] = [];
		for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const attrs = c[1];
			const inner = c[2] ?? "";
			const col = columnOf(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "");
			if (col >= MAX_COLS) continue;
			const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
			const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
			const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
			// The cell's text by its type: a shared string, an inline string, a formula string, a boolean, else a number.
			let text = "";
			if (type === "s") text = strings[Number(v)] ?? "";
			else if (type === "inlineStr")
				text = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join("");
			else if (type === "str" || type === "e") text = decodeXml(v ?? "");
			else if (type === "b") text = v === "1" ? "TRUE" : "FALSE";
			else if (v !== undefined) {
				const n = Number(v);
				text = Number.isFinite(n) ? (dates.has(style) ? serialToDate(n) : String(n)) : decodeXml(v);
			}
			while (row.length < col) row.push("");
			row[col] = text.replace(/\s+/g, " ").trim();
		}
		rows.push(row);
	}
	// Trailing empty rows and columns go.
	while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) rows.pop();
	const width = Math.max(0, ...rows.map((r) => r.reduce((w, c, i) => (c !== "" ? i + 1 : w), 0)));
	return { rows: rows.map((r) => [...r.slice(0, width), ...Array(Math.max(0, width - r.length)).fill("")]), cut };
}

/** A Markdown table of rows: the first as the header. */
export function markdownTable(rows: readonly string[][]): string {
	if (rows.length === 0) return "";
	const width = rows[0].length;
	const fmt = (r: readonly string[]) => `| ${r.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
	return [fmt(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(fmt)].join("\n");
}

/** Markdown pages of a .xlsx: one per sheet with content, headed by the sheet's name. */
export function xlsxToPages(bytes: Uint8Array): string[] {
	// The parts this reader needs.
	const files = unzipSync(bytes, {
		filter: (f) =>
			f.name === "xl/workbook.xml" ||
			f.name === "xl/_rels/workbook.xml.rels" ||
			f.name === "xl/sharedStrings.xml" ||
			f.name === "xl/styles.xml" ||
			f.name.startsWith("xl/worksheets/"),
	});
	const workbook = files["xl/workbook.xml"];
	if (!workbook) throw new Error("xl/workbook.xml missing");
	const text = (name: string) => (files[name] ? strFromU8(files[name]) : "");
	const strings = sharedStrings(text("xl/sharedStrings.xml"));
	const dates = dateStyles(text("xl/styles.xml"));
	// Each sheet as a page.
	const pages: string[] = [];
	for (const sheet of sheetList(strFromU8(workbook), text("xl/_rels/workbook.xml.rels"))) {
		const xml = text(sheet.path);
		if (!xml) continue;
		const { rows, cut } = sheetRows(xml, strings, dates);
		if (rows.length === 0) continue;
		const parts = [`## ${sheet.name}`, markdownTable(rows)];
		if (cut) parts.push(`（只读了前 ${MAX_ROWS} 行）`);
		pages.push(parts.join("\n\n"));
	}
	return pages;
}
