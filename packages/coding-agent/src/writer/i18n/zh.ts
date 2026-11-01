/**
 * Chinese messages for WriterAgent tool output (the default language).
 * {name} marks a value filled in by t().
 */
export const zh = {
	// Shared input errors.
	"input.none": "请提供 path（文件路径）或 text（文本）之一。",
	// Unsupported binary formats.
	"input.binary": "{path} 是 {ext} 文件，这里只能检查文本文件（.md、.txt 等）。",
	// File read failure.
	"input.unreadable": "无法读取 {path}：{reason}",
	// Unknown style pack.
	"style.badPack": "没有名为「{pack}」的词表。可用词表：{packs}。",
	// Report heading.
	"style.title": "AI 腔检查（词表：{packs}）",
	// Section heading for pattern hits.
	"style.hits": "逐处命中 {count} 处：",
	// One hit.
	"style.hit": "- 第 {line} 行第 {column} 列〔{label}〕{matched}",
	// Hits left out of the listing.
	"style.more": "- 另有 {count} 处未列出",
	// Negation density line.
	"style.negation": "否定式：{count} 处，共 {sentences} 句，每 10 句 {per10} 处，阈值 {threshold}，{status}。",
	// Density over the threshold.
	"style.negationOver": "超出阈值",
	// Density within the threshold.
	"style.negationOk": "在阈值内",
	// Negation positions (listed only when over the threshold).
	"style.negationHit": "- 第 {line} 行第 {column} 列：{matched}",
	// Structure line.
	"style.structure": "格式：列表行 {listLines}/{lines}，加粗 {bold} 处。",
	// Too many list lines.
	"style.listOver": "列表行超过三分之一，正文宜改写成段落。",
	// Too much bold.
	"style.boldOver": "加粗过多（每千字超过 {limit} 处），只保留真正需要强调的地方。",
	// Clean result.
	"style.clean": "检查通过：没有命中。",
	// What to do with the hits.
	"style.advice": "以上只标出位置，原文保持原样。请用 edit 只改写命中的片段，改完再运行一次 style_check。",
	// word_count heading.
	"count.title": "字数统计",
	// Totals.
	"count.total": "合计 {total} 字（汉字 {cjk}，英文词 {words}，数字 {numbers}），另有标点 {punct} 个。",
	// One section.
	"count.section": "- {title}：{total} 字",
	// Text before the first heading.
	"count.preamble": "（标题前）",
	// Target comparison.
	"count.target": "目标 {target} 字，相差 {diff} 字（{percent}），{status}。",
	// Within tolerance.
	"count.within": "在允许范围（±{tolerance}）内",
	// Too long.
	"count.over": "偏长",
	// Too short.
	"count.under": "偏短",
	// readability_check heading.
	"read.title": "可读性检查",
	// Character summary.
	"read.chars": "汉字 {cjk} 个，其中《通用规范汉字表》一级字以外的 {rare} 个（{kinds} 种）。",
	// One rare character.
	"read.rare": "- 「{char}」{level}，出现 {count} 次，首次在第 {line} 行",
	// Level-2 character.
	"read.level2": "二级字",
	// Level-3 character.
	"read.level3": "三级字",
	// Character outside the table.
	"read.level0": "表外字",
	// Sentence summary.
	"read.sentences": "中文句子 {count} 句，平均 {average} 字；超过 {limit} 字的长句 {long} 句。",
	// One long sentence.
	"read.long": "- 第 {line} 行，{length} 字：{head}……",
	// English summary.
	"read.english": "英文 {words} 词，{sentences} 句，Flesch 易读度 {score}；4 个音节及以上的长词 {longWords} 个。",
	// Clean result.
	"read.clean": "检查通过：没有生僻字和长句。",
	// What to do with the findings.
	"read.advice": "人名、地名、机构名和引文保持原样；其余生僻字换成常用字，长句拆成短句。",
};

/** Message keys shared by all languages. */
export type MessageKey = keyof typeof zh;
