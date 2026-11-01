/**
 * English messages for WriterAgent tool output (WA_LANG=en).
 * The type forces exactly the same keys as the Chinese table.
 */

// Key list of the default (Chinese) table.
import type { MessageKey } from "./zh.ts";

/** English table, one entry per Chinese key. */
export const en: Record<MessageKey, string> = {
	// Shared input errors.
	"input.none": "Provide either path (a file path) or text.",
	// Unsupported binary formats.
	"input.binary": "{path} is a {ext} file; this check reads text files (.md, .txt and similar).",
	// File read failure.
	"input.unreadable": "Cannot read {path}: {reason}",
	// Unknown style pack.
	"style.badPack": 'There is no pattern pack named "{pack}". Available packs: {packs}.',
	// Report heading.
	"style.title": "AI-style check (packs: {packs})",
	// Section heading for pattern hits.
	"style.hits": "{count} pattern hits:",
	// One hit.
	"style.hit": "- line {line}, column {column} [{label}] {matched}",
	// Hits left out of the listing.
	"style.more": "- {count} more hits not listed",
	// Negation density line.
	"style.negation":
		"Negative assertions: {count} in {sentences} sentences, {per10} per 10 sentences, threshold {threshold}, {status}.",
	// Density over the threshold.
	"style.negationOver": "over the threshold",
	// Density within the threshold.
	"style.negationOk": "within the threshold",
	// Negation positions (listed only when over the threshold).
	"style.negationHit": "- line {line}, column {column}: {matched}",
	// Structure line.
	"style.structure": "Format: {listLines}/{lines} list lines, {bold} bold spans.",
	// Too many list lines.
	"style.listOver": "More than a third of the lines are list items; rewrite the body as paragraphs.",
	// Too much bold.
	"style.boldOver": "Too much bold (over {limit} per 1,000 characters); keep it for real emphasis.",
	// Clean result.
	"style.clean": "Check passed: no hits.",
	// What to do with the hits.
	"style.advice":
		"Only positions are reported; the text is left as it was. Rewrite just the flagged passages with edit, then run style_check again.",
	// word_count heading.
	"count.title": "Word count",
	// Totals.
	"count.total":
		"Total {total} (Chinese characters {cjk}, English words {words}, numbers {numbers}), plus {punct} punctuation marks.",
	// One section.
	"count.section": "- {title}: {total}",
	// Text before the first heading.
	"count.preamble": "(before the first heading)",
	// Target comparison.
	"count.target": "Target {target}, difference {diff} ({percent}), {status}.",
	// Within tolerance.
	"count.within": "within the allowed range (±{tolerance})",
	// Too long.
	"count.over": "too long",
	// Too short.
	"count.under": "too short",
	// readability_check heading.
	"read.title": "Readability check",
	// Character summary.
	"read.chars":
		"{cjk} Chinese characters, {rare} of them ({kinds} distinct) outside level 1 of the General Standard Chinese Characters table.",
	// One rare character.
	"read.rare": "- {char} ({level}), {count} times, first on line {line}",
	// Level-2 character.
	"read.level2": "level 2",
	// Level-3 character.
	"read.level3": "level 3",
	// Character outside the table.
	"read.level0": "outside the table",
	// Sentence summary.
	"read.sentences":
		"{count} Chinese sentences, {average} characters on average; {long} sentences longer than {limit} characters.",
	// One long sentence.
	"read.long": "- line {line}, {length} characters: {head}…",
	// English summary.
	"read.english":
		"{words} English words in {sentences} sentences, Flesch reading ease {score}; {longWords} words of 4 or more syllables.",
	// Clean result.
	"read.clean": "Check passed: no rare characters or long sentences.",
	// What to do with the findings.
	"read.advice":
		"Keep names of people, places and organizations and quotations as they are; replace other rare characters with common ones and split long sentences.",
};
