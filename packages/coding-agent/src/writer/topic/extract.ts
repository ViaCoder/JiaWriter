/**
 * Facts extracted from one source by the model in a context of its own. The main model names only the source and
 * what it needs from it; the program sends the archived text to the model with these instructions and nothing else
 * (no conversation, no search list), reads the fact lines back, and keeps only those whose figures and names are in
 * the source. So the material holds no sentence of the source, and the register of a page written by a machine does
 * not travel into the document (the user, 2026-11-14: one tool to "extract basic facts and data", another "dedicated
 * to writing, so that the context of each tool is clean"). Pure text work; the extension reads the files and asks.
 */

// The material a fact becomes.
import type { Material } from "./topic.ts";

/** Reasoning tokens an extraction may use: it reads and lists, it does not compose. */
export const EXTRACT_REASONING_TOKENS = 512;
/** Longest wait for one extraction. */
export const EXTRACT_TIMEOUT_MS = 120_000;
/** Most characters of a source that go with a request: a page's text, not a book. */
export const MAX_EXTRACT_CHARS = 12_000;
/** Longest fact (characters): a sentence that states one thing, not a paragraph. */
export const MAX_FACT = 120;
/** Most facts from one source. */
export const MAX_FACTS = 12;

/** The instructions of an extraction request. */
export function extractInstructions(): string {
	return [
		"You extract facts from one source text for a Chinese official document. The program files them as material; another request writes the document from them. Return only fact lines, one fact a line, in one of these two forms and nothing else:",
		"案例｜时间：<time>｜主体：<company, body or person>｜事实：<what happened or was decided>",
		"数据｜时间：<time>｜事实：<the indicator and its value>",
		`Take only what the request asks for, at most ${MAX_FACTS} lines, the most specific facts first; return no line when the text holds nothing on it.`,
		"A fact is one plain Chinese sentence of at most 80 characters stating what is, what happened or what was decided, with its figures, dates and names: no judgment, comment, connective, image or metaphor. A person quoted gives the fact, figure or decision they stated (大众汽车首席执行官布鲁默表示，2026年起在华产能减少两成); their wording, emphasis and figures of speech stay out.",
		"Figures as the source gives them: every number from the text, none worked out, rounded or combined; a unit may be written in Chinese (2.6 million as 260万) when the number stays the same.",
		"时间 as the text states it (2026年1月14日, 2025年, 2025年第三季度); the field stays empty when the text states none; never infer one.",
		"A fact about what a named company, body or person did, decided or stated is a 案例 line with that name as 主体 (a company or body by its name; a person by name and post in the text's own language and spelling); a measurement with no actor is a 数据 line.",
		"A text in another language gives facts in Chinese, with the names of people and companies as the text spells them. Nothing from outside the text.",
	].join("\n");
}

// Head lines of an archived page or search that are the archive's, not the source's.
const ARCHIVE_LINES = /^(?:网址|请求网址|抓取方式|抓取时间|检索时间)：.*$/gm;

/** The request: the source's text, bounded, then what is needed from it and for which part. */
export function extractRequest(text: string, focus: string, section: string): string {
	const body = text
		.replace(ARCHIVE_LINES, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const clipped = body.length > MAX_EXTRACT_CHARS ? `${body.slice(0, MAX_EXTRACT_CHARS)}\n（后文略）` : body;
	return [
		`来源正文：\n${clipped}`,
		`需要的内容：${focus.trim() || "与下面这一节有关的事实和数据"}`,
		`用于：${section.trim() || "全文"}`,
	].join("\n\n");
}

/** The fact lines of a reply as materials: kind, time, subject and fact; lines without a fact are left out. */
export function parseFacts(reply: string): Material[] {
	const out: Material[] = [];
	for (const raw of reply.split("\n")) {
		// A list mark or number before the line, and a code fence around the reply, are the model's, not facts.
		const line = raw.replace(/^\s*(?:[-*•]|\d+[.、)]|```[a-z]*)\s*/, "").trim();
		if (!line) continue;
		const fields = line.split(/\s*[｜|]\s*/);
		const kindWord = fields[0]?.trim() ?? "";
		const value = (name: string) => {
			const field = fields.find((f) => new RegExp(`^${name}\\s*[：:]`).test(f));
			return field ? field.replace(/^[^：:]*[：:]\s*/, "").trim() : "";
		};
		const fact = value("事实").replace(/[。.]$/, "");
		if (!fact) continue;
		const subject = value("主体");
		const time = value("时间").replace(/^(无|不明|未知|未说明|none|-)$/i, "");
		// A case needs its subject; a 案例 line without one is a data line.
		const kind: Material["kind"] = /^(案例|case)/i.test(kindWord) && subject ? "case" : "data";
		out.push({
			kind,
			fact,
			...(time ? { time } : {}),
			...(kind === "case" ? { subject } : {}),
		});
		if (out.length >= MAX_FACTS) break;
	}
	return out;
}

/**
 * text as the program compares a fact with its source: compatibility forms folded (，to , and full-width digits to
 * ASCII), case dropped, and spaces, quotation marks and Markdown marks left out.
 */
export function comparable(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[\s*_#>|`[\]"'“”‘’「」『』]/g, "")
		.toLowerCase();
}

// Numbers a source writes as words, which a fact writes as digits (three models → 3款; 两家 → 2家).
const NUMBER_WORDS: Readonly<Record<string, number>> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	twenty: 20,
	thirty: 30,
	forty: 40,
	fifty: 50,
	sixty: 60,
	seventy: 70,
	eighty: 80,
	ninety: 90,
	hundred: 100,
	thousand: 1000,
	million: 1e6,
	billion: 1e9,
	trillion: 1e12,
	一: 1,
	两: 2,
	二: 2,
	三: 3,
	四: 4,
	五: 5,
	六: 6,
	七: 7,
	八: 8,
	九: 9,
	十: 10,
	百: 100,
	千: 1000,
	万: 1e4,
	亿: 1e8,
};

/** The numbers of a text as values: 1,267 is 1267; 12.5 is 12.5; with words, three and 三 are 3. */
function numbersOf(text: string, words = false): number[] {
	const flat = text.normalize("NFKC");
	const digits = (flat.match(/\d+(?:[,，]\d{3})*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/[,，]/g, "")));
	if (!words) return digits;
	const named = (flat.toLowerCase().match(/[a-z]+|[一两二三四五六七八九十百千万亿]/g) ?? []).flatMap((w) =>
		w in NUMBER_WORDS ? [NUMBER_WORDS[w]] : [],
	);
	return [...digits, ...named];
}

/** Whether a number of the fact is a number of the source, or one at another power of ten (2.6 million as 260万). */
function numberInSource(value: number, source: readonly number[]): boolean {
	if (value === 0) return true;
	return source.some((s) => {
		if (s === 0) return false;
		const power = Math.log10(s / value);
		return Math.abs(power - Math.round(power)) < 1e-9;
	});
}

/**
 * What keeps a fact out: longer than a sentence, a number the source does not hold, or a Latin name or word of three
 * letters or more that the source does not hold. Empty when the fact passes. A number may stand at another power of
 * ten (260万 for 2.6 million); dates and the time field are checked by the material's time check.
 */
export function factProblem(fact: string, source: string): string {
	if (fact.length > MAX_FACT) return `${fact.length} 字，超过 ${MAX_FACT} 字`;
	const sourceNumbers = numbersOf(source, true);
	const missing = numbersOf(fact).find((n) => !numberInSource(n, sourceNumbers));
	if (missing !== undefined) return `数字 ${missing} 不在来源里`;
	const flat = comparable(source);
	const word = (fact.match(/[A-Za-z][A-Za-z'’.-]{2,}/g) ?? []).find((w) => !flat.includes(comparable(w)));
	return word ? `“${word}” 不在来源里` : "";
}
