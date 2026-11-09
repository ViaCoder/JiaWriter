/**
 * The user's rules that the program holds to, each defined once (the user, 2026-11-09: optimize from a systemic view,
 * not rule by rule). A rule records what the user said, the forms it forbids, a sentence that breaks it and the check
 * that catches that sentence. test/writer/rules-registry.test.ts reads every text the model reads (prompts, the
 * review, skills, check messages) and fails when one shows a forbidden form as fine, or when a rule's breaking
 * sentence passes the draft checks: the contradictions of 2026-11-09 (the review called 一是……二是…… normal, a
 * skill file used 不是……而是) are caught before a commit, not by a real run.
 */

import { PLACEHOLDER } from "../style/draft-checks.ts";

/** One rule of the user's that the program can check. */
export interface UserRule {
	// Short name, for tests.
	id: string;
	// The user's words and the date.
	said: string;
	// The forms the rule forbids, as they would appear in a text; absent when only a whole text can break it.
	forbidden?: RegExp;
	// A short draft that breaks the rule: the draft checks must not pass it.
	breaks: string;
}

/** The rules. */
export const USER_RULES: readonly UserRule[] = [
	{
		id: "in-text-ordinals",
		said: '2026-11-08: in-text ordinals 一是/二是/一要 are "禁止使用"',
		// 统一是, 万一要 and the like are words, not ordinals.
		forbidden: /(?<![统万单唯同])[一二三四五](?:是|要)(?!的)|其[一二三][，,、]/,
		breaks: "# 关于加强安全生产的通知\n\n各单位：\n\n一是加强领导，压实责任。二是完善机制，强化保障。\n",
	},
	{
		id: "headings",
		said: '2026-11-08: "Level-1 heading: 一、; Level-2 heading: （一）"',
		breaks: "# 调研报告\n\n## 基本情况\n\n全市新增城镇就业5.2万人。\n",
	},
	{
		id: "citation-form",
		said: '2026-11-08: a report is cited as "xx年xx月xx日《xx》报道"',
		// A source in brackets, or the outlet before the date.
		forbidden: /[（(]来源[:：]|据[^，。\n]{1,8}(?:社|报|网|台)\d{1,2}月\d{1,2}日/,
		breaks: "# 简报\n\n国际油价全周下跌约17%（来源：路透社，11月6日）。\n",
	},
	{
		id: "no-verification-marks",
		said: 'the citation rule: "No content is presented as requiring verification"',
		forbidden: new RegExp(PLACEHOLDER.source),
		breaks: "# 简报\n\n2025年全市新增城镇就业5.2万人（待核实）。\n",
	},
	{
		id: "defensive-negation",
		said: 'the AI-tone rule: check contrastive structures ("not X, but Y") and negative phrasing ("does not mean")',
		forbidden: /不是[^，。\n]{0,12}而是|并不意味着/,
		breaks: "# 简报\n\n这不是简单的技术问题，而是治理问题。这并不意味着放松监管。\n",
	},
];

/**
 * True when the clause around a forbidden form treats it as forbidden: the clause, without the form itself, has a
 * word of refusal (never, no, not, avoid, denies, remove, cut, 不, 禁, 避免, 删) or limits it (only, instead).
 */
export function refusedInClause(clause: string, form: string): boolean {
	const rest = clause.replace(form, " ");
	return /\bnever\b|\bno\b|\bnot\b|n't|\bavoid|\bden(?:y|ies)\b|\bforbid|\bonly\b|\binstead\b|\b(?:remove|cut|drop|delete)\b|不|禁|勿|避免|删|别/i.test(
		rest,
	);
}

/** The clauses of a text: split at sentence ends, semicolons, line breaks and list separators. */
export function clauses(text: string): string[] {
	return text.split(/[。；;！!？?\n]|\.\s/).filter((c) => c.trim() !== "");
}

/** Where a text shows a rule's forbidden form as fine: each clause that has it with no word against it. */
export function shownAsFine(text: string, rule: UserRule): string[] {
	if (!rule.forbidden) return [];
	const found: string[] = [];
	for (const clause of clauses(text)) {
		const m = rule.forbidden.exec(clause);
		if (m && !refusedInClause(clause, m[0])) found.push(clause.trim().slice(0, 120));
	}
	return found;
}
