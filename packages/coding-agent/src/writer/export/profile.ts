/**
 * Export profiles: fonts, sizes, spacing and page layout per document level. default-zh holds the
 * user's fonts (2026-11-01): 大标题 方正小标宋简体 二号, 一级 黑体, 二级 楷体_GB2312, 三级 黑体,
 * 正文 方正仿宋_GBK 小二, English and digits Times New Roman, fixed 32 pt line spacing, no fallback
 * fonts. Page size and margins follow GB/T 9704-2012 (A4; 37/35/28/26 mm). A custom profile is a
 * JSON file that overrides any of these fields.
 */

// Profile files.
import { existsSync, readFileSync } from "node:fs";
// Path helpers.
import { isAbsolute, join, resolve } from "node:path";
// Error messages.
import { t } from "../i18n/index.ts";

/** Formatting of one document level. */
export interface LevelFormat {
	// Chinese font (the eastAsia slot).
	eastAsia: string;
	// Latin font (the ascii and hAnsi slots).
	latin: string;
	// Size in points.
	sizePt: number;
	// Bold.
	bold: boolean;
	// Alignment.
	align: "left" | "center" | "both";
	// First-line indent in characters.
	indentChars: number;
}

/** A complete export profile. */
export interface ExportProfile {
	// Name shown in reports.
	name: string;
	// Page size and margins in millimetres.
	page: { widthMm: number; heightMm: number; topMm: number; bottomMm: number; leftMm: number; rightMm: number };
	// Fixed line spacing in points.
	lineSpacingPt: number;
	// Formatting per level.
	levels: {
		title: LevelFormat;
		h1: LevelFormat;
		h2: LevelFormat;
		h3: LevelFormat;
		body: LevelFormat;
		table: LevelFormat;
	};
	// Page numbers centred in the footer.
	pageNumbers: boolean;
	// Chinese punctuation pass before export.
	punct: boolean;
}

/** Latin font of every level. */
const TNR = "Times New Roman";
/** 小二 in points. */
const XIAO_ER = 18;

/** The default profile (Chinese official-document layout with the user's fonts). */
export const DEFAULT_ZH: ExportProfile = {
	name: "default-zh",
	page: { widthMm: 210, heightMm: 297, topMm: 37, bottomMm: 35, leftMm: 28, rightMm: 26 },
	lineSpacingPt: 32,
	levels: {
		title: { eastAsia: "方正小标宋简体", latin: TNR, sizePt: 22, bold: false, align: "center", indentChars: 0 },
		h1: { eastAsia: "黑体", latin: TNR, sizePt: XIAO_ER, bold: false, align: "both", indentChars: 2 },
		h2: { eastAsia: "楷体_GB2312", latin: TNR, sizePt: XIAO_ER, bold: false, align: "both", indentChars: 2 },
		h3: { eastAsia: "黑体", latin: TNR, sizePt: XIAO_ER, bold: false, align: "both", indentChars: 2 },
		body: { eastAsia: "方正仿宋_GBK", latin: TNR, sizePt: XIAO_ER, bold: false, align: "both", indentChars: 2 },
		table: { eastAsia: "方正仿宋_GBK", latin: TNR, sizePt: XIAO_ER, bold: false, align: "left", indentChars: 0 },
	},
	pageNumbers: true,
	punct: true,
};

/** Plain object check. */
function isObject(v: unknown): v is Record<string, unknown> {
	// Objects, not arrays or null.
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** base with every field of override that has the same type replaced; problems lists the rest. */
export function mergeProfile(base: unknown, override: unknown, path: string, problems: string[]): unknown {
	// Nested objects merge field by field.
	if (isObject(base)) {
		// Wrong shape: keep the base.
		if (!isObject(override)) {
			problems.push(path);
			return base;
		}
		// Unknown fields are reported.
		for (const k of Object.keys(override)) if (!(k in base)) problems.push(path ? `${path}.${k}` : k);
		// Known fields merged.
		return Object.fromEntries(
			Object.entries(base).map(([k, v]) => [
				k,
				k in override ? mergeProfile(v, override[k], path ? `${path}.${k}` : k, problems) : v,
			]),
		);
	}
	// Leaves: same type, non-empty strings, positive numbers (indents may be 0), known alignments.
	const ok =
		typeof override === typeof base &&
		(typeof override !== "string" || override.trim() !== "") &&
		(typeof override !== "number" ||
			(Number.isFinite(override) && (override > 0 || (override === 0 && path.endsWith("indentChars"))))) &&
		(!path.endsWith(".align") || ["left", "center", "both"].includes(String(override)));
	// Bad leaf: keep the base and report it.
	if (!ok) problems.push(path);
	return ok ? override : base;
}

/** Profile by name or path: "default-zh", a .json path (relative to cwd), or <agentDir>/profiles/<name>.json. */
export function loadProfile(nameOrPath: string | undefined, cwd: string, agentDir: string): ExportProfile {
	// Built-in default.
	const name = (nameOrPath ?? "").trim();
	if (name === "" || name === DEFAULT_ZH.name) return DEFAULT_ZH;
	// Candidate files.
	const file = name.endsWith(".json")
		? isAbsolute(name)
			? name
			: resolve(cwd, name)
		: join(agentDir, "profiles", `${name}.json`);
	if (!existsSync(file)) throw new Error(t("export.noProfile", { name, file }));
	// Parse.
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(file, "utf-8"));
	} catch (e) {
		throw new Error(t("export.badProfile", { file, fields: e instanceof Error ? e.message : String(e) }));
	}
	// Merge over the default; any bad field stops the export.
	const problems: string[] = [];
	const merged = mergeProfile(DEFAULT_ZH, data, "", problems) as ExportProfile;
	if (problems.length > 0) throw new Error(t("export.badProfile", { file, fields: problems.join("、") }));
	// The profile, named after its file unless it names itself.
	return isObject(data) && typeof data.name === "string" ? merged : { ...merged, name };
}
