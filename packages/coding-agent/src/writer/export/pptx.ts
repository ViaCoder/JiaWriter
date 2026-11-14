/**
 * Document blocks → .pptx: a cover slide from the title, one slide per level-1 heading with its paragraphs and list
 * items as the body (lower headings as bold lines), a table on a slide of its own, and continuation slides when a
 * section runs long. Written as PresentationML by hand (a master, a layout and a theme of our own, 16:9) and zipped
 * with fflate; no presentation library. The reverse of docs/pptx-read.ts (2026-11-14: WorkBuddy parity).
 */

// Zip.
import { strToU8, zipSync } from "fflate";
// The blocks of a draft.
import type { Block, Span } from "./blocks.ts";
// XML text.
import { xmlText } from "./xlsx.ts";

/** Slide size in EMU (16:9). */
const CX = 12192000;
const CY = 6858000;
/** Margins and boxes, in EMU. */
const LEFT = 609600;
const WIDTH = CX - 2 * LEFT;
const TITLE_TOP = 365125;
const TITLE_HEIGHT = 1143000;
const BODY_TOP = 1600200;
const BODY_HEIGHT = CY - BODY_TOP - 457200;
/** Point sizes, in hundredths. */
const COVER_SIZE = 4000;
const TITLE_SIZE = 3200;
const BODY_SIZE = 1800;
const TABLE_SIZE = 1400;
/** Most text lines on one slide before a continuation slide; a long paragraph counts as two. */
export const MAX_LINES = 9;
/** A paragraph longer than this counts as two lines. */
const LONG_LINE = 60;
/** Most rows of a table on one slide. */
const MAX_TABLE_ROWS = 12;

/** One line of a slide's body. */
export interface SlideLine {
	text: string;
	// A list item gets a bullet.
	bullet: boolean;
	// A lower heading is bold.
	bold: boolean;
}

/** One slide: a cover, a text slide or a table slide. */
export type Slide =
	| { kind: "cover"; title: string }
	| { kind: "text"; title: string; lines: SlideLine[] }
	| { kind: "table"; title: string; rows: string[][] };

/** The text of spans. */
function textOf(spans: readonly Span[]): string {
	return spans.map((s) => s.text).join("");
}

/** The slides of a draft's blocks. */
export function slidesOf(blocks: readonly Block[]): Slide[] {
	const slides: Slide[] = [];
	let title = "";
	let section = "";
	let lines: SlideLine[] = [];
	let count = 0;
	// Close the open text slide, when it holds anything.
	const flush = () => {
		if (lines.length > 0) slides.push({ kind: "text", title: section || title || "概述", lines });
		lines = [];
		count = 0;
	};
	// Continuation: the same title with （续）.
	const add = (line: SlideLine) => {
		const cost = line.text.length > LONG_LINE ? 2 : 1;
		if (count + cost > MAX_LINES && lines.length > 0) {
			flush();
			section = section.endsWith("（续）") ? section : `${section || title || "概述"}（续）`;
		}
		lines.push(line);
		count += cost;
	};
	for (const b of blocks) {
		if (b.kind === "title") {
			title = textOf(b.spans);
			slides.push({ kind: "cover", title });
		} else if (b.kind === "h1") {
			flush();
			section = textOf(b.spans);
		} else if (b.kind === "h2" || b.kind === "h3") add({ text: textOf(b.spans), bullet: false, bold: true });
		else if (b.kind === "para") {
			const text = textOf(b.spans).trim();
			if (text) add({ text, bullet: false, bold: false });
		} else if (b.kind === "item") add({ text: textOf(b.spans), bullet: true, bold: false });
		else if (b.kind === "code") for (const l of b.lines) add({ text: l, bullet: false, bold: false });
		else if (b.kind === "table" && b.rows.length > 0) {
			flush();
			// A long table over several slides, the header row repeated.
			const [head, ...rest] = b.rows;
			for (let i = 0; i < Math.max(1, rest.length); i += MAX_TABLE_ROWS - 1) {
				const part = rest.slice(i, i + MAX_TABLE_ROWS - 1);
				slides.push({
					kind: "table",
					title: `${section || title || "表"}${i > 0 ? "（续）" : ""}`,
					rows: [head, ...part],
				});
			}
		}
	}
	flush();
	return slides;
}

/** Fonts of the deck: Latin and East Asian. */
export interface DeckFonts {
	latin: string;
	eastAsia: string;
}

/** Default fonts. */
export const DEFAULT_FONTS: DeckFonts = { latin: "Arial", eastAsia: "微软雅黑" };

/** Run properties: size, bold, fonts. */
function rPr(size: number, bold: boolean, f: DeckFonts): string {
	return `<a:rPr lang="zh-CN" altLang="en-US" sz="${size}"${bold ? ' b="1"' : ""} dirty="0"><a:latin typeface="${xmlText(f.latin)}"/><a:ea typeface="${xmlText(f.eastAsia)}"/></a:rPr>`;
}

/** One paragraph of a text body. */
function paragraph(
	text: string,
	size: number,
	f: DeckFonts,
	opts: { bold?: boolean; bullet?: boolean; center?: boolean } = {},
): string {
	const pPr = `<a:pPr${opts.center ? ' algn="ctr"' : ""}${opts.bullet ? ' marL="342900" indent="-342900"' : ""}><a:spcBef><a:spcPts val="600"/></a:spcBef>${
		opts.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : "<a:buNone/>"
	}</a:pPr>`;
	return `<a:p>${pPr}<a:r>${rPr(size, opts.bold ?? false, f)}<a:t>${xmlText(text)}</a:t></a:r></a:p>`;
}

/** A shape with a text body at a position; a title placeholder when asked. */
function textShape(
	id: number,
	name: string,
	box: [number, number, number, number],
	paragraphs: string,
	title: boolean,
	anchor = "t",
): string {
	const ph = title ? '<p:nvPr><p:ph type="title"/></p:nvPr>' : "<p:nvPr/>";
	return (
		`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlText(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>${ph}</p:nvSpPr>` +
		`<p:spPr><a:xfrm><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
		`<p:txBody><a:bodyPr wrap="square" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
	);
}

/** A table frame at the body position. */
function tableFrame(id: number, rows: readonly string[][], f: DeckFonts): string {
	const cols = Math.max(1, ...rows.map((r) => r.length));
	const colW = Math.floor(WIDTH / cols);
	const rowH = 457200;
	const grid = Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join("");
	const body = rows
		.map((r, ri) => {
			const cells = Array.from({ length: cols }, (_, ci) => {
				const text = r[ci] ?? "";
				return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraph(text, TABLE_SIZE, f, { bold: ri === 0 })}</a:txBody><a:tcPr anchor="ctr"/></a:tc>`;
			}).join("");
			return `<a:tr h="${rowH}">${cells}</a:tr>`;
		})
		.join("");
	return (
		`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
		`<p:xfrm><a:off x="${LEFT}" y="${BODY_TOP}"/><a:ext cx="${colW * cols}" cy="${rowH * rows.length}"/></p:xfrm>` +
		'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
		`<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
	);
}

/** Namespaces of a slide part. */
const NS =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
/** The empty group every shape tree starts with. */
const TREE_HEAD =
	'<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** The XML of one slide. */
export function slideXml(slide: Slide, f: DeckFonts): string {
	let shapes = "";
	if (slide.kind === "cover")
		shapes = textShape(
			2,
			"Title",
			[LEFT, 2514600, WIDTH, 1828800],
			paragraph(slide.title, COVER_SIZE, f, { bold: true, center: true }),
			true,
			"ctr",
		);
	else {
		shapes = textShape(
			2,
			"Title",
			[LEFT, TITLE_TOP, WIDTH, TITLE_HEIGHT],
			paragraph(slide.title, TITLE_SIZE, f, { bold: true }),
			true,
			"ctr",
		);
		if (slide.kind === "text")
			shapes += textShape(
				3,
				"Body",
				[LEFT, BODY_TOP, WIDTH, BODY_HEIGHT],
				slide.lines.map((l) => paragraph(l.text, BODY_SIZE, f, { bold: l.bold, bullet: l.bullet })).join(""),
				false,
			);
		else shapes += tableFrame(3, slide.rows, f);
	}
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree>${TREE_HEAD}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/** The theme: colours, the deck's fonts, and the format scheme every theme must carry. */
function themeXml(f: DeckFonts): string {
	const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
	const line = (w: number) =>
		`<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/></a:ln>`;
	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="JiaWriter"><a:themeElements>' +
		'<a:clrScheme name="JiaWriter"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
		'<a:accent1><a:srgbClr val="2F5597"/></a:accent1><a:accent2><a:srgbClr val="C00000"/></a:accent2><a:accent3><a:srgbClr val="7F7F7F"/></a:accent3><a:accent4><a:srgbClr val="BF9000"/></a:accent4><a:accent5><a:srgbClr val="548235"/></a:accent5><a:accent6><a:srgbClr val="7030A0"/></a:accent6>' +
		'<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
		`<a:fontScheme name="JiaWriter"><a:majorFont><a:latin typeface="${xmlText(f.latin)}"/><a:ea typeface="${xmlText(f.eastAsia)}"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${xmlText(f.latin)}"/><a:ea typeface="${xmlText(f.eastAsia)}"/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
		`<a:fmtScheme name="JiaWriter"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
		"<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
		`<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
	);
}

/** The master: a title and a body placeholder, the colour map, the one layout, the text styles. */
function masterXml(f: DeckFonts): string {
	const ph = (id: number, type: string, idx: string, box: [number, number, number, number]) =>
		`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${type}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${type}"${idx}/></p:nvPr></p:nvSpPr>` +
		`<p:spPr><a:xfrm><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>`;
	const style = (size: number, bold: boolean) =>
		`<a:lvl1pPr><a:defRPr sz="${size}"${bold ? ' b="1"' : ""}><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${xmlText(f.latin)}"/><a:ea typeface="${xmlText(f.eastAsia)}"/></a:defRPr></a:lvl1pPr>`;
	return (
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${TREE_HEAD}` +
		`${ph(2, "title", "", [LEFT, TITLE_TOP, WIDTH, TITLE_HEIGHT])}${ph(3, "body", ' idx="1"', [LEFT, BODY_TOP, WIDTH, BODY_HEIGHT])}</p:spTree></p:cSld>` +
		'<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
		'<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
		`<p:txStyles><p:titleStyle>${style(TITLE_SIZE, true)}</p:titleStyle><p:bodyStyle>${style(BODY_SIZE, false)}</p:bodyStyle><p:otherStyle>${style(BODY_SIZE, false)}</p:otherStyle></p:txStyles></p:sldMaster>`
	);
}

/** The one layout: title and body, as the master has them. */
function layoutXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${TREE_HEAD}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

/** A relationships part. */
function rels(entries: readonly [string, string, string][]): string {
	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
		entries
			.map(
				([id, type, target]) =>
					`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`,
			)
			.join("") +
		"</Relationships>"
	);
}

/** The .pptx bytes of the blocks. */
export function buildPptx(blocks: readonly Block[], fonts: DeckFonts = DEFAULT_FONTS): Uint8Array {
	const slides = slidesOf(blocks);
	const parts: Record<string, Uint8Array> = {};
	const ids: string[] = [];
	const presRels: [string, string, string][] = [["rId1", "slideMaster", "slideMasters/slideMaster1.xml"]];
	const overrides: string[] = [];
	slides.forEach((slide, i) => {
		const n = i + 1;
		parts[`ppt/slides/slide${n}.xml`] = strToU8(slideXml(slide, fonts));
		parts[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
			rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
		);
		ids.push(`<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`);
		presRels.push([`rId${n + 1}`, "slide", `slides/slide${n}.xml`]);
		overrides.push(
			`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
		);
	});
	presRels.push([`rId${slides.length + 2}`, "theme", "theme/theme1.xml"]);
	return zipSync(
		{
			"[Content_Types].xml": strToU8(
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
					'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
					'<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
					'<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
					'<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
					'<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
					`${overrides.join("")}</Types>`,
			),
			"_rels/.rels": strToU8(rels([["rId1", "officeDocument", "ppt/presentation.xml"]])),
			"ppt/presentation.xml": strToU8(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS} saveSubsetFonts="1">` +
					'<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
					`<p:sldIdLst>${ids.join("")}</p:sldIdLst><p:sldSz cx="${CX}" cy="${CY}"/><p:notesSz cx="6858000" cy="9144000"/>` +
					`<p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:defaultTextStyle></p:presentation>`,
			),
			"ppt/_rels/presentation.xml.rels": strToU8(rels(presRels)),
			"ppt/slideMasters/slideMaster1.xml": strToU8(masterXml(fonts)),
			"ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(
				rels([
					["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
					["rId2", "theme", "../theme/theme1.xml"],
				]),
			),
			"ppt/slideLayouts/slideLayout1.xml": strToU8(layoutXml()),
			"ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(
				rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
			),
			"ppt/theme/theme1.xml": strToU8(themeXml(fonts)),
			...parts,
		},
		{ level: 6 },
	);
}
