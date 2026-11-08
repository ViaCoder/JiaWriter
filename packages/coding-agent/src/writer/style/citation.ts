/**
 * The form of citations in a document (the user, 2026-11-08: "xx年xx月xx日《xx》报道"): a report as
 * 2026年10月31日《路透社》报道, a file as 2021年6月7日《文件名》. The program finds the forms that break it, so the
 * model never has to notice them itself: an outlet after a date without book-title marks, a date without its year,
 * a date put after the title in brackets.
 */

/** One citation in a wrong form: the words in the draft and the form they should take. */
export interface CitationIssue {
	// The words, character for character.
	quote: string;
	// The right form for them.
	form: string;
}

/** A date with its year, as the form wants it. */
const FULL_DATE = /^\d{4}年\d{1,2}月\d{1,2}日$/;
/** An outlet's name: what news agencies, papers, sites and stations end in. */
const OUTLET = "[\\u4e00-\\u9fa5A-Za-z]{1,12}?(?:通讯社|电视台|新闻社|社|日报|晚报|报|网|台)";

/** The citations in a wrong form, in the order they come. */
export function citationIssues(text: string): CitationIssue[] {
	const issues: CitationIssue[] = [];
	// An outlet right after a date, without book-title marks: 11月7日，路透社 / 2026年11月7日新华网报道.
	const bare = new RegExp(
		`((?:\\d{4}年)?\\d{1,2}月\\d{1,2}日)[，,、\\s]{0,2}据?(${OUTLET})(?=报道|消息|称|发布|援引|[，,。；\\s]|$)`,
		"g",
	);
	for (const m of text.matchAll(bare)) {
		// A date without its year gets a mark for the year the materials give.
		const date = FULL_DATE.test(m[1]) ? m[1] : `YYYY年${m[1]}`;
		issues.push({ quote: m[0], form: `${date}《${m[2]}》报道` });
	}
	// Book-title marks with a date that has no year: 11月7日《路透社》报道.
	for (const m of text.matchAll(/(?<!\d{4}年)(?<![\d年])(\d{1,2}月\d{1,2}日)《([^》\n]{1,40})》/g))
		issues.push({ quote: m[0], form: `YYYY年${m[1]}《${m[2]}》` });
	// The date after the title, in brackets: 《报告》（2021年6月7日）.
	for (const m of text.matchAll(/《([^》\n]{2,60})》[（(]\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*[）)]/g))
		issues.push({ quote: m[0], form: `${m[2]}《${m[1]}》` });
	return issues;
}

/** The issues as lines the drafting model works through. */
export function formatCitationIssues(issues: readonly CitationIssue[]): string {
	return issues.map((i) => `- “${i.quote}” → ${i.form}`).join("\n");
}
