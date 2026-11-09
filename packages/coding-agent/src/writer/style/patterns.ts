/**
 * Pattern packs for style_check.
 * Each pattern is a known AI-style tell that ordinary human prose of the pack's register almost
 * never uses; the regex bounds and anchors keep the listed false positives out (see the tests).
 * The Chinese entries start from WriterSuite's tripwire.rs (59 patterns, 公文 register) and are
 * split into a general pack and a 公文 pack, because words such as 然而 are normal in fiction and
 * academic prose.
 */

/** One pattern. */
export interface StylePattern {
	// Stable identifier.
	id: string;
	// Chinese label shown in reports.
	zh: string;
	// English label shown in reports.
	en: string;
	// Global regular expression.
	re: RegExp;
	// A weak sign: careful human writers use it now and then, so only a density of them counts (WEAK_PER_1000).
	weak?: boolean;
}

/**
 * Patterns that careful writers use too, so one hit is shown for the model to judge and only their density asks for
 * another round: in the user's 22 model documents and 4 State Council documents (2026-11-09) zh-denial matched 93
 * times (22 of them in the model documents' own notes), zh-bushi-ershi 8 and zh-fou-ershi 5. The semantic review's
 * defensive-negation category judges what a single one says.
 */
export const DENSITY_ONLY: ReadonlySet<string> = new Set(["zh-denial", "zh-bushi-ershi", "zh-fou-ershi"]);

/** Characters that end a clause frame in Chinese (a frame never spans them). */
const ZH_END = "。！？!?\\n";

/** Chinese pattern helper. */
function zhp(id: string, zh: string, en: string, source: string): StylePattern {
	// Global, case-sensitive.
	return { id, zh, en, re: new RegExp(source, "g") };
}

/** English pattern helper. */
function enp(id: string, zh: string, en: string, source: string): StylePattern {
	// Global, case-insensitive.
	return { id, zh, en, re: new RegExp(source, "gi") };
}

/** General Chinese pack: contrast frames and stock phrases that fit no register. */
const CORE_ZH: readonly StylePattern[] = [
	// "X is not Y": each one is looked at, whatever the density. 是不是 and 要不是 ask or suppose, and deny nothing.
	// 不再是 ("no longer Y") is the same move; 0 times in 217,000 characters of human official documents (2026-11-08).
	zhp(
		"zh-denial",
		"否定判断 不是/不等于",
		"denial 不是/不等于",
		"(?<![是要若还])(?:并不意味着|不意味着|不代表|不等于|并非|不在于|不只是|不仅仅是|不单是|不是|不再(?:是|只是|仅仅是|仅是|局限于))",
	),
	// 不是……而是 (bounded to one clause frame).
	zhp("zh-bushi-ershi", "对比框架 不是……而是", "contrast 不是……而是", `不是[^${ZH_END}]{0,40}?而是`),
	// The rest of the negation-contrast family; 而在 alone is ordinary prose, only 而是/而在于 frame it.
	zhp(
		"zh-fou-ershi",
		"对比框架 不/并非/没有……而是",
		"contrast 不/并非/没有……而是",
		`(?:不|并非|没有|绝非|非但)[^${ZH_END}；;]{0,16}?而(?:是|在于)`,
	),
	// 不仅……更是 (不仅……而且 is normal and stays legal).
	zhp("zh-bujin-gengshi", "对比框架 不仅……更是", "contrast 不仅……更是", `不(?:仅仅?|只|光)[^${ZH_END}；;]{0,20}?更是`),
	// 与其说 is the tell; 与其他 is spared.
	zhp("zh-yuqishuo", "对比框架 与其说……不如说", "contrast 与其说……不如说", "与其说"),
	// Summary openers.
	zhp("zh-zongshang", "套话", "stock phrase", "综上所述|总而言之|总的来说|一言以蔽之"),
	// "Worth noting" announcements.
	zhp("zh-zhide", "套话", "stock phrase", "值得(?:注意|关注|一提|警惕|重视)的是"),
	// "Needs pointing out" announcements.
	zhp("zh-xuyao-zhichu", "套话", "stock phrase", "需要指出的是|需要强调的是|应当指出"),
	// Appeals to the obvious.
	zhp("zh-zhongsuo", "套话", "stock phrase", "众所周知|不可否认|毋庸置疑|毫无疑问|显而易见|不言而喻"),
	// Adverbial 无疑 only (无疑似病例 and 并无疑义 are spared).
	zhp("zh-wuyi", "套话", "stock phrase", "无疑[，,。；;是将会]"),
	// "In the final analysis" frames; 说到底 needs punctuation so 说到底线 is spared.
	zhp("zh-guigen", "套话", "stock phrase", "归根结底|归根到底|说到底[，,。]"),
	// Rephrasing signposts.
	zhp("zh-huanjuhua", "套话", "stock phrase", "换句话说|换言之"),
	// "It is not hard to see".
	zhp("zh-bunan", "套话", "stock phrase", "不难发现|不难看出"),
	// "It can be seen".
	zhp("zh-youci", "套话", "stock phrase", "由此可见"),
	// 可以说 as a filler; 可以说明 is spared by the comma.
	zhp("zh-keyishuo", "套话", "stock phrase", "可以说[，,]"),
	// "More importantly" announcements (尤为重要 stays legal).
	zhp("zh-gengzhongyao", "套话", "stock phrase", "更(?:为)?重要的是"),
	// Hedging frames.
	zhp("zh-mouzhong", "套话", "stock phrase", "[从在]某种程度上|某种意义上"),
	// Worn metaphor.
	zhp("zh-shuangren", "套话", "stock phrase", "双刃剑"),
	// 备受 + attention words only (备受煎熬 is spared).
	zhp("zh-beishou", "套话", "stock phrase", "备受(?:关注|瞩目|期待|青睐|争议)"),
	// Formal filler.
	zhp("zh-bushiwei", "套话", "stock phrase", "不失为"),
	// Inclusive call to action.
	zhp("zh-rangwomen", "套话", "stock phrase", "让我们"),
	// Template placeholders left for someone to fill: a finished document has none. [1] and [text](url) are spared;
	// 〔2026〕 号 is a document number left blank.
	zhp(
		"zh-placeholder",
		"模板占位",
		"placeholder",
		"\\[(?!\\d+\\])[^\\]\\n]{1,16}\\](?!\\()|20\\d[XxＸ]年|[XxＸ]{1,2}月[XxＸ]{1,2}日|[XＸ]{2,}|某(?:省|市|县|区|镇|乡|村|单位|部门|企业|公司|学校|高校|医院)|〔20\\d{2}〕\\s*号",
	),
	// "What really matters is".
	zhp("zh-zhenzheng", "套话", "stock phrase", "真正(?:重要|关键|难|值钱)的[是在]"),
];

/** General English pack. */
const CORE_EN: readonly StylePattern[] = [
	// "X is not Y": each one is looked at, whatever the density.
	{
		id: "en-denial",
		zh: "否定判断 is not",
		en: "denial: is not, does not mean",
		re: /\b(?:does not mean|doesn['’]t mean|do not mean|don['’]t mean|(?:is|are|was|were) not|(?:is|are|was|were)n['’]t|['’]s not|not (?:just|only|merely|simply)|not to say)\b/gi,
	},
	// not just/only/merely X but Y.
	enp(
		"en-not-just-but",
		"对比框架 not just X but Y",
		"contrast not just X but Y",
		"\\bnot (?:just|only|merely|simply)\\b[^.!?\\n]{0,60}?\\bbut\\b",
	),
	// It's not about X, it's about Y.
	enp(
		"en-not-about",
		"对比框架 it's not about X, it's about Y",
		"contrast it's not about X, it's about Y",
		"\\bit(?:['’]s| is) not about\\b[^.!?\\n]{0,60}?\\bit(?:['’]s| is) about\\b",
	),
	// X isn't just A — it's B.
	enp(
		"en-isnt-just",
		"对比框架 isn't just X, it's Y",
		"contrast isn't just X, it's Y",
		"\\b(?:isn['’]t|is not|aren['’]t|are not) (?:just|only|merely)\\b[^.!?\\n]{0,60}?[,;—–-]\\s*(?:it|they|this)(?:['’]s|['’]re| is| are)\\b",
	),
	// not X, but Y.
	enp("en-not-but", "对比框架 not X, but Y", "contrast not X, but Y", "\\bnot\\b[^.!?\\n,]{1,40}?,\\s*but\\b"),
	// delve.
	enp("en-delve", "套话", "stock phrase", "\\bdelv(?:e|es|ed|ing)\\b"),
	// tapestry.
	enp("en-tapestry", "套话", "stock phrase", "\\btapestry\\b"),
	// testament to.
	enp("en-testament", "套话", "stock phrase", "\\b(?:a )?testament to\\b"),
	// It's important/worth noting.
	enp(
		"en-worth-noting",
		"套话",
		"stock phrase",
		"\\bit(?:['’]s| is) (?:important|worth|crucial|essential) to (?:note|remember|mention|recognize)\\b|\\bit is worth noting\\b",
	),
	// In today's fast-paced world.
	enp(
		"en-todays-world",
		"套话",
		"stock phrase",
		"\\bin today['’]s (?:fast-paced|digital|modern|ever-changing|rapidly evolving|interconnected) world\\b",
	),
	// Evolving landscape.
	enp(
		"en-landscape",
		"套话",
		"stock phrase",
		"\\b(?:ever-evolving|ever-changing|evolving|rapidly changing) landscape\\b",
	),
	// Navigate the complexities.
	enp("en-navigate", "套话", "stock phrase", "\\bnavigat(?:e|es|ing) the complexit(?:y|ies)\\b"),
	// Embark on a journey.
	enp("en-embark", "套话", "stock phrase", "\\bembark(?:s|ed|ing)? on a journey\\b"),
	// Summary openers.
	enp("en-in-conclusion", "套话", "stock phrase", "\\bin (?:conclusion|summary),"),
	// Let's dive in.
	enp("en-dive-in", "套话", "stock phrase", "\\blet['’]s dive (?:in|into|deeper)\\b"),
	// Game-changer.
	enp("en-game-changer", "套话", "stock phrase", "\\bgame[- ]changer\\b"),
	// Unlock the potential.
	enp("en-unlock", "套话", "stock phrase", "\\bunlock(?:s|ed|ing)? (?:the |its |their )?(?:full )?potential\\b"),
	// Plays a crucial role.
	enp("en-crucial-role", "套话", "stock phrase", "\\bplay(?:s|ed|ing)? a (?:crucial|pivotal|vital|key) role\\b"),
];

/** 公文 pack: connectors and academic or consultancy jargon that a 公文 does not use. */
const GONGWEN_ZH: readonly StylePattern[] = [
	// Spoken words where the written term exists: 0 times in 217,000 characters of human official documents, 4 times in
	// JiaWriter's eval drafts (随手可承受, 2026-11-09). Each one is looked at, not counted by density.
	// Spoken words that real reports almost never use: at most 2 hits in 1,575 published texts each (2026-11-09); 一刀切,
	// 走过场, 接地气, 硬骨头, 兜底 and 抓手 stay out, at 3 to 38 hits.
	zhp(
		"gw-casual",
		"公文 口语词",
		"official style spoken word",
		"随手|顺手|压根|没啥|一下子|搞定|卡在|大头|收不上来|等不来|缩水|扎堆|一窝蜂|拍脑袋|最难啃|掉链子",
	),
	// Contrast connector.
	zhp("gw-raner", "公文 然而", "official style 然而", "然而"),
	// 首先，其次， skeleton; mid-sentence uses are spared by the comma.
	zhp("gw-shouxian", "公文 首先，其次，", "official style 首先，其次，", "首先[，,]|其次[，,]"),
	// 从……到 / 从……转向 transitions; digits and clause breaks keep ranges such as 从2020年到2025年 out.
	zhp("gw-cong-dao", "公文 从……到", "official style 从……到", "从[^。！？!?\\n，、；;0-9]{1,10}?(?:到|转向)"),
	// 在……的同时.
	zhp("gw-tongshi", "公文 在……的同时", "official style 在……的同时", `在[^${ZH_END}]{0,30}?的同时|与此同时`),
	// "This means".
	zhp("gw-yiweizhe", "公文 这意味着", "official style 这意味着", "这(?:就)?意味着"),
	// Single jargon words.
	zhp(
		"gw-jargon",
		"学术腔",
		"academic jargon",
		"泛在|范式|底座|赋能|抓手|闭环|势能|数智|生态位|维度|价值重构|价值重塑|重塑价值|有效路径|重要路径|实现路径",
	),
	// Architectural compounds; ordinary 一体推进 and 融为一体 are spared.
	zhp(
		"gw-yiti",
		"学术腔 算网一体",
		"academic jargon 算网一体",
		"(?:算网|云网|云边|端边云|数智|智算)一体|一体化底座|智能底座",
	),
	// "Shows the features of".
	zhp(
		"gw-tezheng",
		"学术腔 呈现……特征",
		"academic jargon 呈现……特征",
		`呈现[^${ZH_END}]{0,8}?特征|特征[^${ZH_END}]{0,6}?显现`,
	),
];

/** A stock phrase as a weak sign; every other pattern as it is. */
function weakStock(pattern: StylePattern): StylePattern {
	return pattern.en === "stock phrase" ? { ...pattern, weak: true } : pattern;
}

/**
 * Weak signs allowed per 1,000 characters: official documents had 0.1 to 0.3, generated drafts up to 8; the user's model
 * reports reach 1.4 (2026-11-09: 从……转向 five times in a careful survey report), so the limit stands above them.
 */
export const WEAK_PER_1000 = 2;

/** All packs by name. */
export const STYLE_PACKS: Readonly<Record<string, readonly StylePattern[]>> = {
	// General Chinese and English. Stock phrases are weak signs: a reasonable amount is fine, only piling them up
	// counts (the user, 2026-11-08); contrast frames and denials count each time.
	"core-zh": CORE_ZH.map(weakStock),
	"core-en": CORE_EN.map(weakStock),
	// 公文 extension: every one a weak sign, found in State Council documents too.
	"gongwen-zh": GONGWEN_ZH.map((pattern) => (pattern.id === "gw-casual" ? pattern : { ...pattern, weak: true })),
};

/** Packs used when the caller names none. */
export const DEFAULT_PACKS: readonly string[] = ["core-zh", "core-en"];

/** Chinese negative assertions (prohibitions such as 不得、严禁、禁止 are not on the list). */
export const NEGATION_ZH = /并不意味着|不意味着|不代表|不等于|不足以|无法|难以|不能|未能|并不|并非/g;

/** English negative assertions (must not and shall not are not on the list). */
export const NEGATION_EN =
	/\b(?:does not mean|doesn['’]t mean|do not mean|don['’]t mean|is not enough to|isn['’]t enough to|insufficient to|cannot|can['’]t|fails? to|failed to|no longer)\b/gi;

/** Default limit of negative assertions per 10 sentences. */
export const DEFAULT_NEGATION_THRESHOLD = 3;

// Measures of the whole text. A dash, or a single 不是, appears in careful human prose as often as in machine
// prose (official documents 0.4 dashes per 1,000 characters, generated drafts 0.9, Lu Xun 0.9), so only these
// densities tell the two apart. The limits come from twelve State Council and provincial documents of 2011-2021
// against generated drafts of the same registers (2026-11-08).

/** Dashes: counted, and reported only when they are many. */
export const DASHES = /——|(?<=[A-Za-z,]) ?— ?(?=[A-Za-z])/g;
/** Dashes allowed per 1,000 characters. */
export const DASH_PER_1000 = 3;

/** Vague quantities and stock verbs that stand in for facts. */
export const VAGUE_ZH = /部分|一些|较多|较为|逐步|有所|不断|持续|进一步|日益|一定程度|取得(?:一定|明显|显著)?成效/g;
/** Vague words allowed per 1,000 characters: official documents had 2.6 to 5.9, generated reports 5.6 to 19.6. */
export const VAGUE_PER_1000 = 6;

/** A fact with a unit: numbers with what they count. */
export const FACTS =
	/\d+(?:\.\d+)?\s*(?:%|％|万|亿|个|人|户|元|次|所|家|项|年|月|日|名|岁|公里|平方米|亩|吨|天|小时|percent)/g;
/** Facts needed per 1,000 characters in a report: official reports had 8 to 18, generated ones none. */
export const FACTS_PER_1000 = 1;

/** Sentence-length spread (standard deviation over mean) below which every sentence is cut to one size. */
export const SPREAD_FLOOR = 0.45;
