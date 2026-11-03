/**
 * 公文参数自检（gongwen_check）: a TypeScript port of scripts/check_params.py from the lieflat-gongwen skill
 * (https://github.com/larashero3-dotcom/lieflat-gongwen, commit 24147448). It measures a draft (length,
 * sentence length, heading levels, 一是二是, 顿号 density, force words, quotes) and compares it with the
 * corpus medians and p25–p75 ranges of seven genres. Only "hard conflicts" (a wrong genre) count as errors.
 *
 * License: this file is a change to that skill and is under the PolyForm Noncommercial License 1.0.0
 * (https://polyformproject.org/licenses/noncommercial/1.0.0), not under JiaWriter's MIT license; the full
 * terms are in skills/writer/zh/lieflat-gongwen/LICENSE.
 */

/** Corpus reference of one metric: p25, p75 and the median. */
type Range = readonly [number, number, number];

/** Reference values of one genre. */
interface GenreRef {
	// Corpus sample size.
	n: number;
	// Metric name → range.
	[metric: string]: number | Range;
}

/** Corpus medians and common ranges (p25–p75), from check_params.py REF. */
export const REF: Record<string, GenreRef> = {
	调研报告: {
		n: 75,
		chars: [3108, 3820, 3492],
		sent: [45, 59, 53],
		h1: [3, 3, 3],
		h2: [0, 11, 9],
		h3: [0, 0, 0],
		yishi: [0, 12, 9],
		dun: [19, 26, 22],
		qz: [0, 2, 1],
		yq: [18, 31, 26],
		jy: [2, 5, 3],
		pct: [0, 1, 0],
	},
	领导讲话: {
		n: 44,
		chars: [3100, 4200, 3700],
		sent: [48, 64, 56],
		h1: [3, 3, 3],
		h2: [3, 9, 5],
		h3: [0, 0, 0],
		yishi: [2, 8, 5],
		dun: [18, 27, 21],
		qz: [1, 3, 2],
		yq: [35, 55, 45],
		jy: [0, 4, 2],
		pct: [0, 0, 0],
	},
	工作意见: {
		n: 25,
		chars: [2900, 3800, 3300],
		sent: [52, 66, 58],
		h1: [4, 6, 5],
		h2: [9, 14, 13],
		h3: [0, 0, 0],
		yishi: [0, 3, 1],
		dun: [25, 31, 28],
		qz: [1, 3, 2],
		yq: [30, 55, 40],
		jy: [0, 2, 1],
		pct: [0, 1, 0],
	},
	经验材料: {
		n: 22,
		chars: [2900, 4600, 3600],
		sent: [50, 63, 56],
		h1: [2, 3, 2],
		h2: [0, 4, 2],
		h3: [0, 3, 1],
		yishi: [2, 9, 6],
		dun: [14, 23, 19],
		qz: [0, 3, 1],
		yq: [12, 30, 20],
		jy: [1, 5, 3],
		pct: [0, 2, 1],
	},
	工作方案: {
		n: 10,
		chars: [2700, 5000, 3600],
		sent: [45, 68, 55],
		h1: [4, 6, 5],
		h2: [4, 9, 8],
		h3: [5, 17, 11],
		yishi: [0, 2, 1],
		dun: [14, 22, 18],
		qz: [1, 4, 2],
		yq: [14, 32, 22],
		jy: [3, 10, 6],
		pct: [0, 1, 0],
	},
	经验总结: {
		n: 8,
		chars: [2100, 2700, 2500],
		sent: [58, 71, 64],
		h1: [3, 4, 3],
		h2: [2, 6, 4],
		h3: [0, 0, 0],
		yishi: [3, 8, 5],
		dun: [23, 31, 27],
		qz: [0, 1, 0],
		yq: [10, 20, 14],
		jy: [0, 1, 0],
		pct: [0, 0, 0],
	},
	短经验材料: {
		n: 77,
		chars: [950, 1300, 1119],
		sent: [45, 57, 51],
		h1: [0, 0, 0],
		h2: [0, 1, 0],
		h3: [0, 0, 0],
		yishi: [0, 1, 1],
		dun: [20, 27, 24],
		qz: [0, 1, 0],
		yq: [1, 4, 3],
		jy: [0, 1, 0],
		pct: [0, 1, 0],
		paras: [5, 7, 6],
		para_len: [130, 185, 156],
		quote: [10, 18, 14],
		quote_long: [1.8, 4.0, 2.9],
	},
};

/** One rule: the metric, the allowed bounds, the message and the corpus basis. */
export interface Rule {
	// Metric name.
	key: keyof Metrics;
	// Lowest allowed value.
	min?: number;
	// Highest allowed value.
	max?: number;
	// What is wrong.
	msg: string;
	// Corpus evidence.
	basis: string;
}

/** Length floor shared by the 公文族 genres. */
const GONGWEN_FLOOR: Rule = {
	key: "chars",
	min: 1200,
	msg: "公文族篇幅不应低于 1200 字（低于此值应按党建族写）",
	basis: "公文语料最短 1423 字",
};

/** Hard conflicts: breaking one means the genre is wrong, not the style. */
export const HARD: Record<string, Rule[]> = {
	调研报告: [GONGWEN_FLOOR],
	领导讲话: [{ key: "h3", max: 0, msg: "领导讲话不用三级标题", basis: "44篇语料三级标题总数为 0" }, GONGWEN_FLOOR],
	工作意见: [
		{ key: "h3", max: 2, msg: "工作意见几乎不用三级标题", basis: "25篇语料平均 0.1 个，最多 2 个" },
		GONGWEN_FLOOR,
	],
	经验材料: [GONGWEN_FLOOR],
	工作方案: [GONGWEN_FLOOR],
	经验总结: [{ key: "pct", max: 0, msg: "经验总结不用百分比", basis: "8篇语料 100% 零百分比" }, GONGWEN_FLOOR],
	短经验材料: [
		{ key: "h1", max: 1, msg: "千字级经验材料不应用多个一级标题", basis: "77篇语料共 3 个一级标题" },
		{
			key: "chars",
			min: 700,
			max: 2000,
			msg: "短经验材料篇幅应在 700-2000 字",
			basis: "语料区间 558-3022，中位 1119",
		},
	],
};

/** Soft hints: legitimate variants exist, so they only remind. */
const SOFT: Record<string, Rule[]> = {
	工作方案: [
		{
			key: "h3",
			min: 3,
			msg: "工作方案通常有三级标题（“1.”）",
			basis: "语料平均 11.5 个，但 10 篇中 3 篇为 0（存在无三级标题的变体）",
		},
	],
	工作意见: [
		{
			key: "h2",
			min: 5,
			msg: "工作意见通常有较多二级标题（“（一）”）",
			basis: "语料平均 13.2 个，但存在把重点任务拆成多个平行一级标题的扁平变体",
		},
	],
	调研报告: [
		{
			key: "yishi",
			min: 3,
			msg: "调研报告通常用“一是二是”做段内分层",
			basis: "语料中位 9 次，但四分之一的作品完全不用",
		},
	],
};

/** Share of the heaviest section: p25, p75, median and what is typical (full-corpus counts). */
const FOCUS: Record<string, [number, number, number, string]> = {
	工作方案: [37, 58, 46, "任务段较重"],
	工作意见: [24, 50, 42, "任务段较重"],
	经验材料: [27, 56, 33, "做法段较重"],
	调研报告: [35, 49, 41, "各功能段较均衡"],
	经验总结: [29, 42, 36, "各段近乎等重"],
	领导讲话: [33, 41, 36, "各段近乎等重"],
};

/** The parameters that identify each genre. */
const ID_PARAM: Record<string, string> = {
	调研报告: "一是二是分层最密 + 建议词最多（向上级建言）",
	领导讲话: "要求词密度最高 + 三级标题为 0",
	工作意见: "二级标题最多（约13个）+ 几乎不用“一是”",
	经验材料: "一级标题最少（约2个），靠段落推进",
	工作方案: "三级标题最多（约11个），唯一大量用“1.”的文种",
	经验总结: "引号概念密度冠军 + 零百分比",
	短经验材料: "零一级标题 + 长引号引语多（引群众原话）",
};

/** Statutory document types: fixed structure, so no parameter row. */
export const NO_PARAM = ["报告", "通知", "请示", "批复", "函", "决定", "条例", "意见", "通报", "纪要"];

/** Words to avoid and why. */
const BAD_WORDS: [string, string][] = [
	["我觉得", "公文不用第一人称主观判断 → 研究认为/实践表明"],
	["我认为", "公文不用第一人称主观判断 → 研究认为/实践表明"],
	["非常", "空洞程度副词 → 用数据或事实替代"],
	["取得了显著成效", "万能废话 → 说清具体成效"],
	["希望领导重视", "太直白 → 用论证逻辑自然导向结论"],
	["问题很多", "缺乏具体性 → 列举具体问题"],
	["尽快", "模糊时限 → 明确到月/日"],
	["相关部门", "模糊主体 → 明确牵头和配合单位"],
];

/** Labels of the comparison table, in display order. */
const LABEL: [keyof Metrics, string][] = [
	["chars", "字数"],
	["sent", "平均句长"],
	["h1", "一级标题"],
	["h2", "二级标题"],
	["h3", "三级标题"],
	["yishi", "“一是二是”"],
	["dun", "顿号密度‰"],
	["qz", "强制词"],
	["yq", "要求词"],
	["jy", "建议词"],
	["pct", "百分比"],
	["paras", "段落数"],
	["para_len", "段落长度"],
	["quote", "引号概念"],
	["quote_long", "长引语‰"],
];

/** Measurements of one draft. */
export interface Metrics {
	// Characters without line breaks.
	chars: number;
	// Mean sentence length.
	sent: number;
	// Level-1 headings (一、).
	h1: number;
	// Their titles (first clause, at most 40 characters).
	h1_titles: string[];
	// Level-2 headings (（一）).
	h2: number;
	// Level-3 headings (1.).
	h3: number;
	// 一是/二是 … count.
	yishi: number;
	// 顿号 per 1000 characters.
	dun: number;
	// Mandatory words (应当/必须/不得/严禁).
	qz: number;
	// Requirement words (要/切实/确保/务必).
	yq: number;
	// Suggestion words (建议/可以/鼓励/支持).
	jy: number;
	// Percentages outside placeholders.
	pct: number;
	// Short quoted concepts (1–8 characters).
	quote: number;
	// Long quotations (9+ characters, curly quotes) per 1000 characters.
	quote_long: number;
	// Body paragraphs over 40 characters.
	paras: number;
	// Their mean length.
	para_len: number;
	// ASCII straight quotes.
	ascii_quote: number;
	// Dashes (——).
	dash: number;
	// [section name, characters, percent] split at level-1 headings.
	sections: [string, number, number][];
	// Body text the counts ran on.
	plain: string;
}

/** Length in code points (Python len). */
function len(s: string): number {
	// Spread splits by code point.
	return [...s].length;
}

/** Python round(x, digits): nearest, ties (exact halves of the binary value) to even. */
export function pyRound(x: number, digits = 0): number {
	// Exact decimal expansion of the double (60 digits cover every fraction a double can hold here).
	const exact = Math.abs(x).toFixed(60);
	// Digits after the kept ones.
	const rest = exact.split(".")[1].slice(digits);
	// Not an exact half: toFixed already picks the nearest value of the exact number.
	if (!/^50*$/.test(rest)) return Number(x.toFixed(digits));
	// Exact half: keep the even neighbour.
	const scaled = Math.trunc(Math.abs(x) * 10 ** digits);
	const even = scaled % 2 === 0 ? scaled : scaled + 1;
	return (Math.sign(x) * even) / 10 ** digits;
}

/** Non-overlapping occurrences of word in text (Python str.count). */
function countOf(text: string, word: string): number {
	// split leaves one more piece than matches.
	return text.split(word).length - 1;
}

/** Matches of a global regex. */
function countRe(text: string, re: RegExp): number {
	// match returns null when nothing matches.
	return (text.match(re) ?? []).length;
}

/** Level-1 heading at the start of a line (optional bold marks). */
const H1_LINE = /^\**[一二三四五六七八九十]+、/u;

/** Section shares split at level-1 headings (导语 is the part before the first one). */
export function sectionWeights(bodyLines: string[]): [string, number, number][] {
	// Finished sections and the current one.
	const secs: [string, number][] = [];
	let cur: [string, number] = ["导语", 0];
	for (const l of bodyLines) {
		// A heading starts a new section named by its first 16 characters.
		if (H1_LINE.test(l)) {
			secs.push(cur);
			cur = [[...l.replace(/^\**/u, "")].slice(0, 16).join(""), 0];
		}
		// The line counts for the current section.
		cur[1] += len(l);
	}
	secs.push(cur);
	// Total (at least 1).
	const tot = secs.reduce((sum, [, n]) => sum + n, 0) || 1;
	return secs.map(([name, n]) => [name, n, pyRound((100 * n) / tot, 1)]);
}

/** Measure a Markdown or plain-text draft; null when there is no text. */
export function analyze(text: string): Metrics | null {
	// Non-empty trimmed lines.
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	// Body lines: heading marks removed; tables, rules and block quotes skipped.
	const bodyLines: string[] = [];
	for (const l of lines) {
		if (/^#{1,6}\s/u.test(l)) bodyLines.push(l.replace(/^#{1,6}\s*/u, ""));
		else if (!/^(\||-{3,}|>)/u.test(l)) bodyLines.push(l);
	}
	// Body with bold and code marks removed.
	const body = bodyLines.join("\n");
	const plain = body.replace(/\*\*|__|`/gu, "");
	const chars = len(plain.replace(/\n/gu, ""));
	if (chars === 0) return null;
	// Sentences of at least 4 characters (their length keeps inner line breaks, as in the original).
	const sents = plain.split(/[。！？；]/u).filter((s) => len(s.trim()) >= 4);
	// Paragraphs: long lines that are not numbered headings.
	const paras = bodyLines.filter(
		(l) => len(l) > 40 && !/^[一二三四五六七八九十]+、|^（[一二三四五六七八九十]+）|^\p{Nd}+[．.]/u.test(l),
	);
	// Level-1 headings with their first clause as the title.
	const h1: string[] = [];
	for (const m of body.matchAll(/^\**([一二三四五六七八九十]+、)([^\n]{2,80})/gmu)) {
		const first = m[2].split(/[。！？；]/u)[0].split(/　{2,}|\s{3,}/u)[0];
		h1.push([...first.trim()].slice(0, 40).join(""));
	}
	// Force words are counted outside short quotes; 不得不 means "has to", not a ban.
	const depunct = plain.replace(/[“"][^”"]{0,20}[”"]/gu, "");
	const qzText = depunct.replaceAll("不得不", "＃＃＃");
	return {
		chars,
		sent: sents.length ? pyRound(sents.reduce((sum, s) => sum + len(s), 0) / sents.length, 1) : 0,
		h1: h1.length,
		h1_titles: h1,
		h2: countRe(body, /^\**（[一二三四五六七八九十]+）/gmu),
		h3: countRe(body, /^\**\p{Nd}+[．.]\s*\P{Nd}/gmu),
		yishi: countRe(plain, /[一二三四五六七八九]是[，、]?/gu),
		dun: pyRound((1000 * countOf(plain, "、")) / chars, 1),
		qz: ["应当", "必须", "不得", "严禁"].reduce((sum, w) => sum + countOf(qzText, w), 0),
		yq: ["要", "切实", "确保", "务必"].reduce((sum, w) => sum + countOf(depunct, w), 0),
		jy: ["建议", "可以", "鼓励", "支持"].reduce((sum, w) => sum + countOf(depunct, w), 0),
		// Percent signs inside 【…】 placeholders are not data.
		pct: countRe(plain.replace(/【[^】]*】/gu, ""), /\p{Nd}+(?:\.\p{Nd}+)?%/gu),
		quote: countRe(plain, /[“"][^”"]{1,8}[”"]/gu),
		quote_long: pyRound((1000 * countRe(plain, /[“][^”]{9,}[”]/gu)) / chars, 1),
		paras: paras.length,
		para_len: paras.length ? pyRound(paras.reduce((sum, p) => sum + len(p), 0) / paras.length) : 0,
		ascii_quote: countOf(plain, '"'),
		dash: countOf(plain, "——"),
		sections: sectionWeights(bodyLines),
		plain,
	};
}

/** Metrics used for genre matching. */
const MATCH_KEYS: (keyof Metrics)[] = [
	"chars",
	"sent",
	"h1",
	"h2",
	"h3",
	"yishi",
	"dun",
	"qz",
	"yq",
	"jy",
	"pct",
	"quote_long",
];

/** Normalised distance to each genre's medians, nearest first. */
export function matchGenre(a: Metrics): [string, number][] {
	// One distance per genre.
	const out: [string, number][] = [];
	for (const [g, r] of Object.entries(REF)) {
		let d = 0;
		let cnt = 0;
		for (const k of MATCH_KEYS) {
			// Only metrics the genre defines.
			const range = r[k];
			if (!Array.isArray(range)) continue;
			const [lo, hi, mid] = range;
			// Spread of the range, at least 30% of the median and at least 1.
			const scale = Math.max(hi - lo, Math.abs(mid) * 0.3, 1);
			d += Math.abs((a[k] as number) - mid) / scale;
			cnt++;
		}
		out.push([g, d / cnt]);
	}
	// Stable sort keeps REF order on ties, like Python sorted.
	return out.sort((x, y) => x[1] - y[1]);
}

/** Whether a value keeps a rule. */
function keeps(rule: Rule, v: number): boolean {
	// Both bounds are optional.
	return (rule.min === undefined || v >= rule.min) && (rule.max === undefined || v <= rule.max);
}

/** Hard conflicts of a draft for a genre. */
export function hardFails(a: Metrics, genre: string): Rule[] {
	// Rules the draft breaks.
	return (HARD[genre] ?? []).filter((rule) => !keeps(rule, a[rule.key] as number));
}

/** Colons outside quotes, addressees and numbered headings. */
export function looseColons(plain: string): string[] {
	// Up to 12 characters before each colon.
	const out: string[] = [];
	for (const m of plain.matchAll(/([^\n]{0,12})：/gu)) {
		const before = m[1].trim();
		// Numbered heading, speech, addressee or placeholder before it.
		if (/[一二三四五六七八九十]+、|（[一二三四五六七八九十]）|\p{Nd}+[．.]/u.test(before)) continue;
		if (/说|问|讲|提|指出|反映|回忆|告诉|表示|答/u.test(before)) continue;
		if (/人民政府|部门|单位|书记|镇长|同志|负责人/u.test(before)) continue;
		if (before.includes("待补") || before.includes("待核")) continue;
		out.push([...m[0]].slice(0, 25).join(""));
	}
	return out;
}

/** Summary line of the measurements. */
export function measuredLine(a: Metrics): string {
	// Same order as the original --match output.
	return `实测：${a.chars}字 句长${a.sent} 一级${a.h1} 二级${a.h2} 三级${a.h3} 一是${a.yishi} 顿号${a.dun}‰ 引号${a.quote} 长引语${a.quote_long}‰`;
}

/** Report for a draft without a genre: the genres ranked by distance. */
export function formatMatch(a: Metrics): string {
	// Ranked list, nearest marked.
	const rows = matchGenre(a).map(([g, d], i) => `${i === 0 ? "★" : " "} ${g}  距离 ${d.toFixed(2)}`);
	const lines = ["参数向量匹配结果（距离越小越像）：", ...rows, "", measuredLine(a)];
	// Heaviest section after the lead.
	const body = a.sections.filter((s) => s[0] !== "导语");
	if (body.length) {
		const top = body.reduce((x, y) => (y[2] > x[2] ? y : x));
		lines.push(`重心：最重一段 ${top[2]}%（${top[0]}）　各文种语料中位 33-46%`);
	}
	return lines.join("\n");
}

/** Full report for a draft and a genre, with the number of hard conflicts. */
export function formatReport(a: Metrics, genre: string): { text: string; fails: number } {
	// Reference row.
	const r = REF[genre];
	const out = [`文体：${genre}　语料样本 n=${r.n}`, `身份证参数：${ID_PARAM[genre]}`, ""];
	// ① Hard conflicts.
	const fails = hardFails(a, genre);
	out.push("【硬冲突检查】判文种识别错误，非风格差异");
	if (fails.length === 0) out.push(`✓ 通过（${(HARD[genre] ?? []).length} 项）`);
	for (const f of fails) out.push(`✗ ${f.msg}`, `   实测 ${f.key}=${a[f.key]}　依据：${f.basis}`);
	// Soft hints.
	for (const s of (SOFT[genre] ?? []).filter((rule) => !keeps(rule, a[rule.key] as number))) {
		out.push(`⚠ ${s.msg}`, `   实测 ${s.key}=${a[s.key]}　${s.basis}`);
	}
	// ② Comparison table.
	out.push("", "【参数对照】仅供参考，偏离不等于错误", "指标 | 你的 | 中位 | 常见区间");
	for (const [k, label] of LABEL) {
		const range = r[k];
		if (!Array.isArray(range)) continue;
		const [lo, hi, mid] = range;
		const v = a[k] as number;
		out.push(`${label} | ${v} | ${mid} | ${lo}-${hi}${v >= lo && v <= hi ? "" : "　⚠偏离"}`);
	}
	// ②b Punctuation used as rhetoric.
	const issues: string[] = [];
	if (a.dash > 1) issues.push(`正文破折号 ${a.dash} 个（语料平均 0.2-0.9 个/篇，建议不超过 1 个）`);
	const colons = looseColons(a.plain);
	if (colons.length)
		issues.push(
			`非引语冒号 ${colons.length} 处（冒号应只用于引语引入、主送机关、层次标题）：${colons.slice(0, 5).join("；")}`,
		);
	// Meta comments outside quotations.
	const meta = a.plain.replace(/[“][^”]*[”]/gu, "").match(/其实[是就]|说到底|归根到底|本质上/gu) ?? [];
	if (meta.length) issues.push(`元评论词 ${meta.length} 处（${[...new Set(meta)].join("、")}）`);
	if (issues.length) out.push("", "【标点修辞检查】", ...issues.map((i) => `⚠ ${i}`));
	// ③ Level-1 heading length.
	if (a.h1_titles.length) {
		const avg = a.h1_titles.reduce((sum, t) => sum + len(t), 0) / a.h1_titles.length;
		const target = genre === "工作意见" || genre === "工作方案" ? "4-12（业务类）" : "14-24（分析类）";
		out.push(
			"",
			`一级标题平均 ${avg.toFixed(1)} 字，目标 ${target}`,
			...a.h1_titles.slice(0, 6).map((t) => `   · ${t}`),
		);
	}
	// ③b Weight of the heaviest section.
	const focus = FOCUS[genre];
	if (focus && a.sections.length > 1) {
		const [lo, hi, mid, note] = focus;
		out.push("", "【重心分布】仅供对照，偏离不等于错误");
		const body = a.sections.filter((s) => s[0] !== "导语");
		const top = body.length ? body.reduce((x, y) => (y[2] > x[2] ? y : x)) : undefined;
		for (const [name, n, pct] of a.sections)
			out.push(`${pct.toFixed(1)}%　${n}字　${name}${top && name === top[0] ? " ←最重" : ""}`);
		if (top) {
			out.push(`最重一段 ${top[2]}%　语料中位 ${mid}%，常见 ${lo}-${hi}%（${note}）`);
			if (top[2] < lo || top[2] > hi)
				out.push("   个体离散度大，此项区间外不作为错误；若同时有多项参数同向偏离，再考虑整体节奏问题。");
		}
	}
	// ③c Straight quotes distort the quote counts.
	if (a.ascii_quote)
		out.push(
			"",
			`⚠ 检出 ${a.ascii_quote} 个 ASCII 直角引号（"）。语料使用中文弯引号，混用会使引号概念与长引语统计失真`,
		);
	// ④ Genre family check.
	const ranked = matchGenre(a);
	const names = ranked.map(([g]) => g);
	const family = (g: string) => (g === "短经验材料" ? "党建族" : "公文族");
	if (family(genre) !== family(names[0])) {
		out.push(
			"",
			"【文体族检查】",
			`⚠ 你声明「${genre}」（${family(genre)}），但参数上更像「${names[0]}」（${family(names[0])}）`,
			`   两族参数互斥，判错族后所有参数都会偏。距离：${ranked
				.slice(0, 3)
				.map(([g, d]) => `${g} ${d.toFixed(2)}`)
				.join("  ")}`,
		);
	} else if (names.slice(3).includes(genre)) {
		out.push(
			"",
			"【结构习惯提示】",
			`ⓘ 参数上「${genre}」排在第 ${names.indexOf(genre) + 1} 位，前三位是 ${names.slice(0, 3).join("、")}`,
			"   同族文种参数重叠大，此信号仅供参考，不代表文种判错。",
		);
	}
	// ⑤ Words to avoid.
	const hits = BAD_WORDS.filter(([w]) => a.plain.includes(w));
	if (hits.length) out.push("", "【避坑词】", ...hits.map(([w, why]) => `⚠ “${w}” — ${why}`));
	// ⑥ Mandatory-word quota.
	const qz = r.qz as Range;
	if (a.qz > qz[1]) {
		out.push(
			"",
			`⚠ 强制词超配额（${a.qz} > ${qz[1]}）。“要”属要求词、“必须/应当”属强制词，两者配额独立且相差一个量级，改稿时把“要”整批替换成“必须”会直接顶破上限。`,
		);
	}
	return { text: out.join("\n"), fails: fails.length };
}
