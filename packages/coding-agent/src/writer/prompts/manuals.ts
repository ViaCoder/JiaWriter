/**
 * Rules given when their stage comes, once each (see stages.ts). One sentence per rule, only what the model
 * would not do unasked. The user's own requirements stay in full; the words around them do not.
 */

// Folder and file names of a topic.
import { MATERIAL_FILE, TOPIC_DIRS } from "../topic/topic.ts";

/** How a document is written: the moment writing starts. */
export const WRITING_MANUAL: readonly string[] = [
	`Order: confirm purpose, audience and length; outline in ${TOPIC_DIRS.drafts}/大纲.md; ask once which parts need cases or data, unless the user's plan says; research those parts and record what you will use with material_add; check ${MATERIAL_FILE} against the outline; draft; run style_check, word_count and readability_check, and gongwen_check on 公文; revise only what they flag`,
	"Parts with cases or data: each paragraph opens with a summary, then a case (time, reporter, subject, action) or data point (time, region, industry, indicator, value). Other parts are plain prose",
	"A case names the company, body or person, date, act and figures; failing that, official data with period, scope and value. Never 某企业",
	"Cite in the text as 2026年10月31日《路透社》报道 or 《文件名》第3页, never an address",
	"End with 参考文献: every source used, numbered, as [page title, publisher, date](full URL) of a page opened with web_fetch",
	"Write mainly in Chinese with full-width punctuation; no spaces around Chinese (使用GPT-5模型), only between English words",
	"Use common words and explain a needed term once. State facts directly and attribute opinions, with no remarks on reliability and no verification markers",
	"Say what something is and what to do; keep 不是……而是 and negation for real prohibitions",
	"Open with the substance: no summary or uplifting close",
	"Use # for the title, ## to #### for levels 1–3, Unicode symbols (×, ≤, x²) without LaTeX, and — instead of arrows",
	`Read 参考资料/.parsed for parsed files, quote them as written, and check ${TOPIC_DIRS.search}/ and ${TOPIC_DIRS.web}/ before repeating a search`,
];

/** How to research: the first search or fetch. */
export const RESEARCH_MANUAL: readonly string[] = [
	"Write queries as 2–6 key terms, in Chinese for Chinese sources and English for international ones",
	"For recent events put the year and month in the query; a fact is current only when its page shows the date",
	"Read the whole list and choose by address and title: major outlets (Reuters, AP, AFP, Bloomberg, BBC, NYT, WSJ, FT, and national ones) and official sources with named actors or data. Forums, blogs, Q&A sites and reposts are only leads",
	"When nothing fits, search again in English, with an outlet named, or with the official name",
	"Keep each fact's URL, and take the outlet's usual Chinese name from the address, as 路透社 for reuters.com",
];

/** Recording materials: the first material_add. */
export const MATERIAL_MANUAL: readonly string[] = [
	"Record each case and figure right after reading its source; a search result's address counts, a fetched page is fuller",
	"Before drafting, search again for what the outline still lacks",
];

/** Handling check results: the first run of each check. */
export const CHECK_MANUALS: Readonly<Record<string, readonly string[]>> = {
	style_check: [
		"Rewrite only the flagged passages with edit, as plain statements with concrete content, and run it until it passes",
		'Add packs: ["core-zh", "gongwen-zh"] for 公文 and reports for government readers',
	],
	word_count: ["Lengthen or shorten the sections it reports, against the target in the brief"],
	readability_check: ["Replace the rare characters and split the long sentences, keeping names and quotations"],
	gongwen_check: ["Fix every ✗ and explain each deliberate ⚠"],
};

/** What to do with an export's report: the first export. */
export const EXPORT_MANUAL: readonly string[] = [
	"Drafts are exported to .docx at the end of each run; use export_document for another format or profile",
	"Fix unpaired quotes with edit. Open each reference URL reported as unopened with web_fetch: keep it when it loads and matches, else replace or remove it. Then export again",
];

/** Going back: the first draft_restore. */
export const RESTORE_MANUAL: readonly string[] = ["List the versions, restore the matching one, and say what changed"];
