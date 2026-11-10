/**
 * The program's checks of a draft, as one table: each check says which registers it applies to and returns the
 * lines that fail the draft and the lines that only note something. draftCheck runs the table after the AI-style
 * check, so a new check is one entry here, not another block of string building.
 */

// Output messages.
import { t } from "../i18n/index.ts";
// The register of a text.
import type { StyleRegister } from "./check.ts";
// Citation form.
import { citationIssues, formatCitationIssues, incompleteReferences, numberedCitations } from "./citation.ts";
// Heading numbers and in-text ordinals.
import { headingIssues, listMarkers } from "./numbering.ts";
// Paragraph shape and repeated material.
import { evidenceFirst, repeatedFigures, unsupportedAnalysis } from "./shape.ts";

/** What one check found: lines that fail the draft, lines that only note. */
export interface CheckResult {
	fail: string[];
	note: string[];
}

/** One check of the table. */
export interface DraftCheck {
	// Short name, for tests and logs.
	id: string;
	// The registers it applies to.
	when: (register: StyleRegister) => boolean;
	// What it finds in the text.
	run: (text: string) => CheckResult;
}

/** Nothing found. */
const NONE: CheckResult = { fail: [], note: [] };
/** Documents: reports and official documents. */
const DOCUMENTS = (register: StyleRegister) => register !== "general";
/** Every text. */
const ALL = () => true;
/**
 * Words that leave something to check or fill in later (the user: "No content is presented as requiring
 * verification"): 待核实, 待补, 需核实, 【待…】, 此处补充, ××. 待定 stays: a notice may say a time is still to be set.
 */
export const PLACEHOLDER =
	/待核[实查]|待补(?![助偿贴发])|待确认|(?:需|有待)(?:进一步)?核实|[【[]待[^】\]\n]{0,10}[】\]]|此处(?:补充|填写|插入)|×{2,}/g;

/** A list of quoted openings under a heading line. */
const quoted = (head: string, items: readonly string[]) => `${head}\n${items.map((s) => `- “${s}”`).join("\n")}`;

/** The checks, in the order their lines appear: failures first, then notes. */
export const DRAFT_CHECKS: readonly DraftCheck[] = [
	{
		// Citations in another form than 2026年10月31日《路透社》报道 (the user, 2026-11-08).
		id: "citation",
		when: ALL,
		run: (text) => {
			const found = citationIssues(text);
			// A wrong form fails; a citation with no date only asks for the source's date, since a source may have none.
			const wrong = found.filter((i) => !i.undated);
			const undated = found.filter((i) => i.undated);
			return {
				fail: wrong.length
					? [`${t("style.citation", { count: wrong.length })}\n${formatCitationIssues(wrong)}`]
					: [],
				note: undated.length
					? [`${t("style.citationUndated", { count: undated.length })}\n${formatCitationIssues(undated)}`]
					: [],
			};
		},
	},
	{
		// Headings 一、 and （一） (the user, 2026-11-08).
		id: "headings",
		when: DOCUMENTS,
		run: (text) => {
			const found = headingIssues(text);
			if (found.length === 0) return NONE;
			return {
				fail: [`${t("style.headings")}\n${found.map((h) => `- “${h.quote}” → ${h.form}`).join("\n")}`],
				note: [],
			};
		},
	},
	{
		// No 一是/一要 inside the text (the user, 2026-11-08).
		id: "list-markers",
		when: DOCUMENTS,
		run: (text) => {
			const found = listMarkers(text);
			return found.length === 0 ? NONE : { fail: [t("style.listMarkers", { markers: found.join("、") })], note: [] };
		},
	},
	{
		// Nothing left to check or fill in later (the user's citation rule; no check held it until 2026-11-09).
		id: "placeholders",
		when: ALL,
		run: (text) => {
			const found = [...new Set(text.match(PLACEHOLDER) ?? [])];
			return found.length === 0 ? NONE : { fail: [t("style.placeholders", { marks: found.join("、") })], note: [] };
		},
	},
	{
		// English quotes around Chinese words: the export fixes them, the Markdown draft the user reads does not.
		id: "ascii-quotes",
		when: ALL,
		run: (text) => {
			const count = (text.match(/"[^"\n]*[一-鿿][^"\n]*"/g) ?? []).length;
			return count === 0 ? NONE : { fail: [t("style.asciiQuotes", { count })], note: [] };
		},
	},
	{
		// The same figure in two paragraphs: one piece of material used twice.
		id: "repeated",
		when: DOCUMENTS,
		run: (text) => {
			const found = repeatedFigures(text);
			return found.length === 0 ? NONE : { fail: [t("style.repeated", { figures: found.join("、") })], note: [] };
		},
	},
	{
		// A report that cites by number instead of 2026年10月31日《路透社》报道 (the user, 2026-11-08).
		// Every register: a brief with web references cited [1]…[9] beside the user's form (2026-11-10); a paper in GB/T 7714
		// is left out by numberedCitations itself.
		id: "numbered-citation",
		when: ALL,
		run: (text) => {
			const found = numberedCitations(text);
			return found.length === 0
				? NONE
				: { fail: [quoted(t("style.numberedCitation", { count: found.length }), found)], note: [] };
		},
	},
	{
		// Reference entries without the title, publisher or date of [page title, publisher, date](URL): a note.
		id: "reference-form",
		when: ALL,
		run: (text) => {
			const found = incompleteReferences(text);
			return found.length === 0
				? NONE
				: {
						fail: [],
						note: [
							`${t("style.referenceForm", { count: found.length })}\n${found.map((s) => `- ${s}`).join("\n")}`,
						],
					};
		},
	},
	{
		// Analysis paragraphs that open with their evidence: a note, since method and background paragraphs may too.
		id: "evidence-first",
		when: (register) => register === "report",
		run: (text) => {
			const found = evidenceFirst(text);
			return found.length === 0
				? NONE
				: { fail: [], note: [quoted(t("style.evidenceFirst", { count: found.length }), found)] };
		},
	},
	{
		// Problem and risk paragraphs with no case or figure: a note, since some problems have no data.
		id: "unsupported",
		when: (register) => register === "report",
		run: (text) => {
			const found = unsupportedAnalysis(text);
			return found.length === 0
				? NONE
				: { fail: [], note: [quoted(t("style.unsupported", { count: found.length }), found)] };
		},
	},
];

/** Run the checks that apply to a register; failures and notes in table order. */
export function runDraftChecks(
	text: string,
	register: StyleRegister,
	checks: readonly DraftCheck[] = DRAFT_CHECKS,
): CheckResult {
	const fail: string[] = [];
	const note: string[] = [];
	for (const check of checks) {
		if (!check.when(register)) continue;
		const found = check.run(text);
		fail.push(...found.fail);
		note.push(...found.note);
	}
	return { fail, note };
}
