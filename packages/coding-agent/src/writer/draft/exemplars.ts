/**
 * Exemplar paragraphs for a section: passages of published official documents of the section's kind, given with the
 * clean request so that the model has a register to match that is not the register of the material (the user,
 * 2026-11-12: "if the input material already carries an 'AI-like' tone, the output almost inevitably will as well").
 * The passages are State Council documents, public and free of copyright; the private corpus is never used here.
 */

/** The kinds of section an exemplar is for. */
export type ExemplarKind = "situation" | "problem" | "measure";

/** One exemplar: its kind, its source as the request names it, and the passage. */
export interface Exemplar {
	kind: ExemplarKind;
	source: string;
	text: string;
}

/** The exemplars, one or two of each kind, each under 300 characters. */
export const EXEMPLARS: Exemplar[] = [
	{
		// The situation: the judgment in the first sentence, the figures after it, one matter a sentence.
		kind: "situation",
		source: "《政府工作报告》，国务院，2026年3月",
		text: "一年来，我国经济顶压前行、展现强大韧性。经济运行总体平稳、稳中有进，国内生产总值增长5%，总量达到140.19万亿元。就业总体稳定，城镇新增就业1267万人，城镇调查失业率平均为5.2%。对外贸易较快增长，出口多元化成效明显，国际收支基本平衡。民生保障更加有力，居民收入增长和经济增长同步，脱贫攻坚成果巩固拓展，实施学前一年免费教育政策、惠及1400万儿童，全面实施育儿补贴制度、惠及3000多万婴幼儿。粮食产量达到1.43万亿斤。",
	},
	{
		// The problems: named one after another, from outside to inside, each in a short clause; no commentary between.
		kind: "problem",
		source: "《政府工作报告》，国务院，2026年3月",
		text: "在肯定成绩的同时，我们也清醒看到面临的困难和挑战。外部环境变化影响加深，地缘政治风险持续上升，世界经济动能疲弱，多边主义、自由贸易受到严重冲击。国内经济发展和转型中面临的老问题、新挑战仍然不少。新旧动能转换任务艰巨，供强需弱矛盾突出，市场预期偏弱，重点领域风险隐患较多。一些企业经营困难，群众就业和增收难度加大，部分地方财政收支矛盾突出，房地产市场仍在调整。公共服务仍有不少短板弱项。",
	},
	{
		// The measures: the measure first, in a short sentence, then what is done and with how much.
		kind: "measure",
		source: "《政府工作报告》，国务院，2026年3月",
		text: "优化提升传统产业。持续推进重点产业提质升级，新部署一批重大技术改造升级项目，安排2000亿元超长期特别国债资金支持大规模设备更新。实施新一轮制造业重点产业链高质量发展行动，强化产业基础再造和重大技术装备攻关，打造一批国家先进制造业集群。推行普惠性“上云用数赋智”服务，持续加大对中小企业数智化转型的支持。",
	},
	{
		// The measures with the body that takes each: 各地区、各有关部门要…；国家知识产权局要…会同…
		kind: "measure",
		source: "《国务院关于印发〈知识产权保护和运用“十五五”规划〉的通知》，国发〔2026〕30号",
		text: "各地区、各有关部门要高度重视，加强协调配合，结合实际抓好本规划贯彻落实。国家知识产权局要加强统筹协调，会同有关部门做好政策宣传解读，制定年度推进计划，做好规划实施情况动态监测、中期评估和总结评估，确保规划实施有序推进。重大事项及时按程序向党中央、国务院请示报告。",
	},
];

// Words in a section's outline line that give its kind; the first group that matches wins, measures before problems
// (对策 lines often name the problem they answer: 问题的对策).
const KIND_WORDS: Array<[ExemplarKind, RegExp]> = [
	["measure", /对策|建议|启示|措施|举措|路径|思路|打算|下一步|任务|工作安排|借鉴|经验/],
	["problem", /问题|困难|挑战|短板|不足|风险|矛盾|瓶颈|制约/],
	["situation", /现状|情况|进展|成效|做法|背景|形势|基本|概况|发展|趋势/],
];

/** Parts that close a document: no exemplar, since they sum up rather than present. */
const CLOSING = /^(结语|结尾|结束语|参考文献|附录|附件)/;

/**
 * The exemplars for a section: those of the kind its outline line names; the situation's for an opening without a
 * heading (it states the subject and the first judgment) and for a line that names no kind; none for a closing part.
 */
export function exemplarsFor(line: string, heading: string, isFirst: boolean): Exemplar[] {
	const head = line
		.split(/[：:]/)[0]
		.replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, "")
		.trim();
	if (CLOSING.test(head)) return [];
	if (!heading && isFirst) return EXEMPLARS.filter((e) => e.kind === "situation");
	const kind = KIND_WORDS.find(([, re]) => re.test(line))?.[0] ?? "situation";
	return EXEMPLARS.filter((e) => e.kind === kind);
}
