/**
 * The semantic review of a draft: what pattern rules cannot see (failed figures, far-fetched links, inflation,
 * unnamed sources, formula), found by one separate request to the session's own model. Measured on seeded
 * passages it found 34 of 36 marks with one false alarm in 12 clean passages, while the drafting model reviewing
 * its own text left them in place (2026-11-08). Only findings whose quote is really in the draft are kept.
 */

/** One finding. */
export interface ReviewIssue {
	// One of REVIEW_CATEGORIES.
	category: string;
	// The words in the draft, character for character.
	quote: string;
	// Why it reads as machine prose.
	why: string;
	// What to do: facts only from the materials, never invented.
	fix: string;
}

/** The kinds of marks, in the order the prompt explains them. */
export const REVIEW_CATEGORIES = [
	"defensive-negation",
	"bad-metaphor",
	"far-fetched-link",
	"significance-inflation",
	"vague-attribution",
	"vague-no-facts",
	"formulaic-structure",
	"stock-phrase",
	"false-balance",
	"assistant-voice",
	"sentimental-closure",
	"missing-actor",
	"unsupported-method",
	"weak-evidence",
] as const;

/** Most findings kept from one review, so a long draft's list stays readable. */
export const MAX_ISSUES = 30;

/** The reviewer's instructions. */
export const REVIEW_PROMPT = `You review a draft for the marks of machine-written prose and report each one you are sure of. You do not rewrite it.

First decide the register: official document (通知, 意见, 报告, 调研报告, 工作总结), news, academic, promotional, speech, essay, or other. Judge every line by what careful human writers of that register do. Fixed forms of official Chinese (一是……二是……, 进一步, 抓手, 推动, 加强) and a reasonable amount of set phrases are normal; report them only when they carry no content or pile up.

Categories, by id:
- defensive-negation: denies a claim nobody made, to set up its own point (不是……而是, 并不意味着, 不只是, "isn't just", "it's not X, it's Y").
- bad-metaphor: a figure that is mixed, worn out, wrong for the register, or fails when read literally; also stock imagery standing in for the real thing, in a text that names nothing specific.
- far-fetched-link: a cause, consequence or comparison the text does not support; a jump from a small fact to a sweeping conclusion; a statement that cannot be true as written (an action timed before its cause, such as evacuating people before the flood season; a contradiction).
- significance-inflation: importance, milestones or new chapters that the facts given do not carry.
- vague-attribution: 研究表明, 专家认为, 越来越多的人, "studies show", "experts agree" with no source named.
- vague-no-facts: the register needs facts (numbers, names, dates, places, cases, quotes) and the text gives only 部分, 一些, 逐步, 有所, 不断, 取得成效.
- formulaic-structure: lists or headings cut to one mould, rule-of-three rhythm, every item the same length and pattern, a stock opening of background and a stock ending of outlook.
- stock-phrase: filler that machine text overuses, when it piles up (值得注意的是, 综上所述, 不难看出, 具有重要意义, 赋能, 闭环, delve, tapestry, testament).
- false-balance: lists good and bad sides and takes no position (既有……也有……, 需要辩证看待, "it depends on each individual").
- assistant-voice: words to a requester rather than to the reader (以下是, 希望对您有帮助, 供参考, "Great question", "let me know"), and notes about the document itself (its genre, structure, where its data came from, what is still to fill in).
- sentimental-closure: an ending lifted into feeling or slogans the body did not earn (仿佛又听见, 书写精彩篇章, "perhaps the greatest gift").
- missing-actor: statements that hide who did what (相关工作得到推进, 有关问题得到解决, "steps have been taken").
- unsupported-method: fieldwork, visits, interviews, surveys or analysis the text claims but does not show (实地走访, 座谈了解到, 问卷显示, 调研发现 with no record of who, when or how many).
- weak-evidence: a case or figure that does not prove the point of its paragraph, proves a neighbouring point instead, or repeats material used elsewhere in the text.

Rules:
- Quote the exact words from the draft, at most 40 characters, copied character for character.
- Report nothing for sentences that state concrete facts plainly, and nothing you would not defend to an editor of that register.
- Judge no fact by what you know: names, dates and figures come from the writer's materials, which you do not see, and may be later than anything you know. A statement given with its source (据……, ……报道, according to) is the source's: judge only the writer's own reasoning, never ask more support for a sourced statement.
- For each issue give a fix direction. Never invent facts; where facts are missing, the fix is to take them from the writer's materials, or else to state the point plainly or cut it. Never ask for more content.
- A clean draft gets an empty list.

Answer with JSON only: {"register": "...", "issues": [{"category": "<id>", "quote": "...", "why": "...", "fix": "..."}]}`;

/** The findings in a reviewer's answer that hold: a known category and a quote that is really in the draft. */
export function parseReview(answer: string, draft: string): ReviewIssue[] | undefined {
	// The JSON object, whatever surrounds it.
	const start = answer.indexOf("{");
	const end = answer.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let parsed: { issues?: unknown };
	try {
		parsed = JSON.parse(answer.slice(start, end + 1)) as { issues?: unknown };
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed.issues)) return undefined;
	const known = new Set<string>(REVIEW_CATEGORIES);
	return parsed.issues
		.flatMap((raw) => {
			const issue = raw as Partial<Record<keyof ReviewIssue, unknown>>;
			const quote = typeof issue.quote === "string" ? issue.quote.trim() : "";
			const category = typeof issue.category === "string" ? issue.category : "";
			// A finding the draft does not contain is the reviewer's invention.
			if (!quote || !known.has(category) || !draft.includes(quote)) return [];
			return [
				{
					category,
					quote,
					why: typeof issue.why === "string" ? issue.why : "",
					fix: typeof issue.fix === "string" ? issue.fix : "",
				},
			];
		})
		.slice(0, MAX_ISSUES);
}

/** Categories whose fix is facts: without materials to take them from, they would only invite invented ones. */
export const NEEDS_MATERIALS: ReadonlySet<string> = new Set(["vague-no-facts"]);

/** The findings the writer can act on: those asking for facts only when there are materials (the user, 2026-11-08: no
 * request for content that is not there). */
export function keepAnswerable(issues: readonly ReviewIssue[], materials: boolean): ReviewIssue[] {
	return materials ? [...issues] : issues.filter((issue) => !NEEDS_MATERIALS.has(issue.category));
}

/** The findings as lines the drafting model works through. */
export function formatReview(issues: readonly ReviewIssue[]): string {
	return issues.map((i) => `- [${i.category}] “${i.quote}”: ${i.why} → ${i.fix}`).join("\n");
}

/** Whether the review runs: JW_REVIEW=off saves its request. */
export function reviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.JW_REVIEW?.trim().toLowerCase() !== "off";
}

/** Review a draft through `ask` (instructions, text → answer); undefined when the model could not be asked. */
export async function reviewDraft(
	draft: string,
	ask: (instructions: string, text: string) => Promise<string>,
): Promise<ReviewIssue[] | undefined> {
	try {
		return parseReview(await ask(REVIEW_PROMPT, draft), draft);
	} catch {
		// The review helps; its failure never stops the writing.
		return undefined;
	}
}
