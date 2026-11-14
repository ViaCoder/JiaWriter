/**
 * .pptx → Markdown pages for reference import: one page per slide, in the order of the presentation, the title
 * placeholder as a heading, the other text frames as paragraphs, tables as Markdown tables, and the speaker notes
 * after the slide under 备注. Reads the presentation's slide list and each slide's XML with small regular
 * expressions; no library. Briefing slides are reference material for an official document (2026-11-14).
 */

// Unzip.
import { strFromU8, unzipSync } from "fflate";
// XML entities.
import { decodeXml } from "./docx-read.ts";
// Markdown table of rows.
import { markdownTable } from "./xlsx-read.ts";

/** Relationship id → target path, from a .rels part, resolved against the part's folder. */
export function relTargets(relsXml: string, folder: string): Map<string, string> {
	// Each relationship.
	const out = new Map<string, string>();
	for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
		const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
		const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
		if (!id || !target) continue;
		// Absolute, or relative to the folder (../ steps up).
		if (target.startsWith("/")) out.set(id, target.slice(1));
		else {
			const parts = folder.split("/").filter(Boolean);
			for (const step of target.split("/")) {
				if (step === "..") parts.pop();
				else if (step !== ".") parts.push(step);
			}
			out.set(id, parts.join("/"));
		}
	}
	return out;
}

/** The slides of a presentation in order: the zip path of each. */
export function slideList(presentationXml: string, relsXml: string): string[] {
	// Slide ids name relationships; the relationships name the parts.
	const targets = relTargets(relsXml, "ppt");
	const out: string[] = [];
	for (const m of presentationXml.matchAll(/<p:sldId\b[^>]*>/g)) {
		const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
		const path = targets.get(rid);
		if (path) out.push(path);
	}
	return out;
}

/** The text of one paragraph (a:p): its runs joined, line breaks as spaces. */
function paragraphText(pXml: string): string {
	// Runs and breaks in order.
	const parts: string[] = [];
	for (const m of pXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g))
		parts.push(m[1] !== undefined ? decodeXml(m[1]) : " ");
	return parts.join("").replace(/\s+/g, " ").trim();
}

/** The Markdown lines of one slide (or notes) part: title, paragraphs and tables in document order. */
export function slideLines(slideXml: string): string[] {
	// Blocks: shapes (p:sp) and graphic frames (tables) in order.
	const lines: string[] = [];
	for (const m of slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>|<a:tbl\b[\s\S]*?<\/a:tbl>/g)) {
		const block = m[0];
		if (block.startsWith("<a:tbl")) {
			// Table: rows of cells, each cell's paragraphs joined.
			const rows = [...block.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((r) =>
				[...r[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((c) =>
					[...c[0].matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
						.map((p) => paragraphText(p[0]))
						.filter(Boolean)
						.join(" "),
				),
			);
			if (rows.length > 0) lines.push(markdownTable(rows));
			continue;
		}
		// Shape: a title placeholder becomes a heading; the other paragraphs stay as they are.
		const isTitle = /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(block);
		const paragraphs = [...block.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((p) => paragraphText(p[0])).filter(Boolean);
		if (paragraphs.length === 0) continue;
		if (isTitle) lines.push(`## ${paragraphs.join(" ")}`);
		else lines.push(...paragraphs);
	}
	return lines;
}

/** Markdown pages of a .pptx: one per slide with text, the notes after the slide's text. */
export function pptxToPages(bytes: Uint8Array): string[] {
	// The parts this reader needs: the presentation, its relationships, the slides, their relationships and notes.
	const files = unzipSync(bytes, {
		filter: (f) =>
			f.name === "ppt/presentation.xml" ||
			f.name === "ppt/_rels/presentation.xml.rels" ||
			f.name.startsWith("ppt/slides/") ||
			f.name.startsWith("ppt/notesSlides/"),
	});
	const presentation = files["ppt/presentation.xml"];
	if (!presentation) throw new Error("ppt/presentation.xml missing");
	const text = (name: string) => (files[name] ? strFromU8(files[name]) : "");
	// Each slide as a page.
	const pages: string[] = [];
	for (const path of slideList(strFromU8(presentation), text("ppt/_rels/presentation.xml.rels"))) {
		const xml = text(path);
		if (!xml) continue;
		const lines = slideLines(xml);
		// The notes part, through the slide's relationships.
		const name = path.split("/").pop() ?? "";
		const rels = relTargets(text(`ppt/slides/_rels/${name}.rels`), "ppt/slides");
		const notesPath = [...rels.values()].find((t) => t.startsWith("ppt/notesSlides/"));
		const notes = notesPath
			? slideLines(text(notesPath))
					.map((l) => l.replace(/^#+\s*/, ""))
					// The slide number placeholder of a notes page is not a note.
					.filter((l) => !/^\d+$/.test(l))
			: [];
		if (notes.length > 0) lines.push(`备注：${notes.join(" ")}`);
		if (lines.length > 0) pages.push(lines.join("\n\n"));
	}
	return pages;
}
