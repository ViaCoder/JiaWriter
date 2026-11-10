/**
 * The form of citations in a document (the user, 2026-11-08: "xx年xx月xx日《xx》报道"): a report as
 * 2026年10月31日《路透社》报道, a file as 2021年6月7日《文件名》. The program finds the forms that break it, so the
 * model never has to notice them itself: an outlet after a date without book-title marks, a date without its year,
 * a date put after the title in brackets.
 */

import { bodyBeforeReferences } from "../text-stats.ts";

/** One citation in a wrong form: the words in the draft and the form they should take. */
export interface CitationIssue {
	// The words, character for character.
	quote: string;
	// The right form for them.
	form: string;
	// No date, or no day, in the words: right as they stand when the source gives none (the user, 2026-11-10: "if
	// there's no date, don't write it down—and certainly don't fabricate one").
	undated?: boolean;
}

/** A date with its year, as the form wants it. */
const FULL_DATE = /^\d{4}年\d{1,2}月\d{1,2}日$/;
/** An outlet's name: what news agencies, papers, sites and stations end in. */
// 新闻, 周刊 and 杂志 since 2026-11-09 (CBS新闻 was not taken for an outlet).
const OUTLET = "[\\u4e00-\\u9fa5A-Za-z]{1,12}?(?:通讯社|电视台|新闻社|新闻|周刊|杂志|社|日报|晚报|报|网|台)";

/** True for a name in book-title marks that is an outlet's (证券时报网, 新华社, 广州日报), not a document's. */
export function isOutletName(name: string): boolean {
	return new RegExp(`^${OUTLET}$`).test(name.trim()) && !GENERIC_NAME.test(name.trim());
}

/** The opening words of a phrase that ends like an outlet but names none. */
const GENERIC = /^(?:相关|有关|各|多家|该|此|本|这|那|上述|其他|其它|境外|境内|国内|国外|海外|主流|官方|地方|新闻)/;
/** The same, for a whole name. */
const GENERIC_NAME = GENERIC;

/** The citations in a wrong form, in the order they come. */
export function citationIssues(text: string): CitationIssue[] {
	const issues: CitationIssue[] = [];
	// An outlet right after a date, without book-title marks: 11月7日，路透社 / 2026年11月7日新华网报道.
	const bare = new RegExp(
		`((?:\\d{4}年)?\\d{1,2}月\\d{1,2}日)[，,、\\s]{0,2}据?(${OUTLET})(?=报道|消息|称|发布|援引|刊文|刊发|文章|[，,。；）)\\s]|$)`,
		"g",
	);
	for (const m of text.matchAll(bare)) {
		// A date without its year gets a mark for the year the materials give.
		const date = FULL_DATE.test(m[1]) ? m[1] : `YYYY年${m[1]}`;
		issues.push({ quote: m[0], form: `${date}《${m[2]}》报道` });
	}
	// An outlet with no date at all: 路透社援引澳新银行称 / 据新华社报道 (2026-11-09, a research brief). Only in the
	// body, since a reference entry names its outlet in its own way.
	const body = bodyBeforeReferences(text);
	for (const m of body.matchAll(new RegExp(`据?(${OUTLET})(报道|(?=援引))`, "g"))) {
		const at = m.index ?? 0;
		// A date just before it is the rule above (the match may start at its 日: 31日新华网); an open bracket is the
		// 来源 rule below.
		if (/\d{1,2}月\d{1,2}(?:日[，,、\s]{0,2})?$/.test(body.slice(Math.max(0, at - 14), at))) continue;
		if (/[（(][^）)]*$/.test(body.slice(Math.max(0, at - 40), at))) continue;
		// The quote starts at 据 when the words before it were taken in (但据路透社 is 据路透社).
		const quote = m[0].slice(Math.max(0, m[0].lastIndexOf("据")));
		const name = m[1].slice(m[1].lastIndexOf("据") + 1);
		// Words that name no outlet: 相关新闻报道, 本报报道, 各地电视台报道.
		if (GENERIC.test(name)) continue;
		issues.push({ quote, form: `YYYY年MM月DD日《${name}》${m[2]}` });
	}
	// An outlet with words before its 报道 and no date: 美联社市场综述也报道了这一跌幅 (2026-11-10, a research brief; 4
	// such phrases in 1,575 published texts, two of them real citations).
	// Only names that end as outlets do, not in 新闻 or a bare 报 (通过新闻媒体报道, 美报刊上报道).
	const named = "[\\u4e00-\\u9fa5A-Za-z]{1,12}?(?:通讯社|电视台|新闻社|日报|晚报|时报|社|网|台)";
	for (const m of body.matchAll(
		new RegExp(`(?<![《\\u4e00-\\u9fa5\\d])(${named})[^，,。；《》\\n\\d]{1,8}?报道`, "g"),
	)) {
		if (GENERIC.test(m[1])) continue;
		issues.push({ quote: m[0], form: `YYYY年MM月DD日《${m[1]}》报道` });
	}
	// Forms found by the patterns below, with where they start.
	const found: [number, CitationIssue][] = [];
	// The outlet before the date: 据路透社2026年11月6日报道 / 彭博社11月7日调查显示 (2026-11-09, a research brief).
	// A following 报道 is part of the quote, so the replacement does not say it twice; other words stay after it.
	const before = new RegExp(
		`据?(${OUTLET})((?:\\d{4}年)?\\d{1,2}月\\d{1,2}日)(报道)?(?=消息|称|发布|援引|调查|电|[，,。；\\s]|$)`,
		"g",
	);
	for (const m of text.matchAll(before)) {
		const date = FULL_DATE.test(m[2]) ? m[2] : `YYYY年${m[2]}`;
		found.push([m.index ?? 0, { quote: m[0], form: `${date}《${m[1]}》${m[3] ? "报道" : ""}` }]);
	}
	// The outlet and date in brackets after the fact: （路透社，11月6日）.
	const bracket = new RegExp(
		`[（(]\\s*(?:来源[:：]\\s*)?(${OUTLET})[，,、\\s]*((?:\\d{4}年)?\\d{1,2}月\\d{1,2}日)\\s*[）)]`,
		"g",
	);
	for (const m of text.matchAll(bracket)) {
		const date = FULL_DATE.test(m[2]) ? m[2] : `YYYY年${m[2]}`;
		found.push([m.index ?? 0, { quote: m[0], form: `${date}《${m[1]}》报道` }]);
	}
	issues.push(...found.map(([, issue]) => issue));
	// An outlet alone in brackets, or with words the bracket rule above does not take: （路透社）, （路透社11月6日周度报道）
	// (2026-11-10, a research brief). The bracket holds the outlet and at most a date or a word for the report; 简称 and
	// 含 open other brackets (（以下简称人教社）, （含合流制管网）): none left in 1,575 published texts.
	for (const m of body.matchAll(new RegExp(`[（(]\\s*(${OUTLET})([^）)\\n《》]{0,14})[）)]`, "g"))) {
		const [quote, name, rest] = [m[0], m[1], m[2]];
		if (GENERIC.test(name) || /^(?:以下简称|简称|含|包括|如|即)/.test(name)) continue;
		const date = /^[，,、\s]*((?:\d{4}年)?\d{1,2}月\d{1,2}日)(.*)$/.exec(rest);
		// A date and nothing after it is the bracket rule's.
		if (date && !date[2].trim()) continue;
		if (date)
			issues.push({ quote, form: `${FULL_DATE.test(date[1]) ? date[1] : `YYYY年${date[1]}`}《${name}》报道` });
		else if (!rest.trim() || /(?:报道|消息)$/.test(rest))
			issues.push({ quote, form: `YYYY年MM月DD日《${name}》报道` });
	}
	// A source in brackets with no date at all: （来源：央广网援引中汽协） (2026-11-09).
	for (const m of text.matchAll(/[（(]\s*来源[:：]\s*([^（）()\n]{1,40}?)\s*[）)]/g))
		if (!/\d{1,2}月\d{1,2}日/.test(m[1]))
			issues.push({ quote: m[0], form: `YYYY年MM月DD日《${m[1].split(/援引|转引|，|,/)[0]}》报道` });
	// Book-title marks with no date at all: 据《中国经济时报》报道 (2026-11-09, a research report: three times; the 17
	// such phrases in 1,575 published texts all name an outlet).
	for (const m of body.matchAll(/(?<![日\d])据?《([^》\n]{1,14})》(报道|刊文|援引|发文|撰文)/g)) {
		const at = m.index ?? 0;
		if (/\d{1,2}月\d{1,2}日[，,、\s]{0,2}$/.test(body.slice(Math.max(0, at - 14), at))) continue;
		issues.push({ quote: m[0], form: `YYYY年MM月DD日《${m[1]}》${m[2]}` });
	}
	// An outlet that carried an article, with no date: 《21世纪经济报道》刊发的《低空经济下半场》一文 (2026-11-10, a
	// research report). Only names that end as outlets: 5 of the 7 《…》刊发/发表 in 1,575 published texts name a document.
	for (const m of body.matchAll(
		/(?<![日\d])据?《([^》\n]{0,12}(?:报道|报|网|社|台|刊|杂志|新闻))》上?(刊发|刊登|发表|登载)/g,
	)) {
		const at = m.index ?? 0;
		if (/\d{1,2}月\d{1,2}日[，,、\s]{0,2}$/.test(body.slice(Math.max(0, at - 14), at))) continue;
		issues.push({ quote: m[0], form: `YYYY年MM月DD日《${m[1]}》${m[2]}` });
	}
	// A year and month with no day before book-title marks: 2025年5月《中国民航报》 (2026-11-09, a research report).
	for (const m of text.matchAll(/(\d{4}年\d{1,2}月)(?!\d)《([^》\n]{1,40})》/g))
		issues.push({ quote: m[0], form: `${m[1]}DD日《${m[2]}》` });
	// Book-title marks with a date that has no year: 11月7日《路透社》报道.
	for (const m of text.matchAll(/(?<!\d{4}年)(?<![\d年])(\d{1,2}月\d{1,2}日)《([^》\n]{1,40})》/g))
		issues.push({ quote: m[0], form: `YYYY年${m[1]}《${m[2]}》` });
	// The date after the title, in brackets: 《报告》（2021年6月7日）, also with the word for the text between them:
	// 《……》一文（2025年4月9日）, 《……》报道（2025年12月3日） (2026-11-10, a research report; none in 1,575 published
	// texts).
	for (const m of text.matchAll(
		/《([^》\n]{2,60})》(一文|报道|文章|刊文)?[（(]\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*[）)]/g,
	))
		issues.push({ quote: m[0], form: `${m[3]}《${m[1]}》${m[2] ?? ""}` });
	// In the order they come in the text; a form that still has to be given its date or day is undated.
	return issues
		.map((issue) => [text.indexOf(issue.quote), issue] as const)
		.sort((x, y) => x[0] - y[0])
		.map(([, issue]) => (/MM月DD日|DD日/.test(issue.form) ? { ...issue, undated: true } : issue));
}

/**
 * Sentences of the body that cite by number ([3], [6][7]) where the user's form names the date and the outlet (2 of 18
 * research reports until 2026-11-10 did so throughout). None when the references are in GB/T 7714 form ([J], [M],
 * [EB/OL]), as an academic paper's are.
 */
export function numberedCitations(text: string): string[] {
	const body = bodyBeforeReferences(text);
	const references = text.slice(body.length);
	if (/\[(?:J|M|D|C|N|R|S|P|EB\/OL|DB\/OL)\]/.test(references)) return [];
	// The words before each run of numbers, up to the start of their sentence.
	return [...body.matchAll(/[^。！？\n]{0,24}(?:\[\d{1,3}\])+/g)].map((m) => m[0].trim());
}

/**
 * Reference entries whose link text lacks the title, publisher or date of the user's form [page title, publisher,
 * date](URL): [Reuters, 2026-11-03](…) gives no title (2026-11-10, a research brief: six of nine entries).
 */
export function incompleteReferences(text: string): string[] {
	const references = text.slice(bodyBeforeReferences(text).length);
	return [...references.matchAll(/^\s*(?:\d+[.．、]\s*|[-*]\s*)?\[([^\]\n]+)\]\((https?:[^)\s]+)\)/gm)]
		.filter((m) => m[1].split(/[,，]/).filter((part) => part.trim()).length < 3)
		.map((m) => `[${m[1]}]`);
}

/** The issues as lines the drafting model works through. */
export function formatCitationIssues(issues: readonly CitationIssue[]): string {
	return issues.map((i) => `- “${i.quote}” → ${i.form}`).join("\n");
}
