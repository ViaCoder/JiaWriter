/**
 * Chinese punctuation for finished drafts (the user, 2026-11-01: Chinese full-width punctuation
 * throughout, also next to English terms; a -, – or -- between two Chinese characters becomes —).
 * Works on one paragraph at a time, so an unpaired quote never flips the quotes of later paragraphs.
 * URLs, e-mail addresses, inline code, numbers, times, versions, abbreviations and word-internal
 * hyphens and apostrophes are kept as they are.
 */

/** Result of normalizing one paragraph. */
export interface PunctResult {
	// The paragraph with Chinese punctuation.
	text: string;
	// 0-based offsets (in the result) of quotes left without a partner.
	unpaired: number[];
}

// Private-use markers around the index of a protected span.
const OPEN = "\uE000";
const CLOSE = "\uE001";

// Spans kept verbatim, tried in this order: inline code, Markdown links, URLs, e-mail, abbreviations (U.S., e.g.),
// versions and dotted numbers (gpt-5.4, v1.2.3, 3.14, 1,000.5, 18.7%), times (10:30), words with an
// inner hyphen or apostrophe (Wi-Fi, NB-IoT, don't).
const PROTECT_RE = new RegExp(
	[
		"`[^`]*`",
		"!?\\[[^\\]\\n]*\\]\\([^)\\s]+\\)",
		"\\bhttps?://[^\\s\\u3000-\\u303f\\uff00-\\uffef\\u4e00-\\u9fff]+",
		"\\b[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+",
		"\\b(?:[A-Za-z]\\.){2,}",
		"\\b(?:e\\.g|i\\.e|etc|vs|Mr|Mrs|Dr|No|Fig|Vol|pp)\\.",
		"\\b[A-Za-z]+-\\d+(?:\\.\\d+)+\\b",
		"\\bv?\\d+(?:[.,]\\d+)+%?",
		"\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\b",
		"\\b[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)+\\b",
	].join("|"),
	"g",
);

// One Chinese character (Han script).
const HAN = "\\p{Script=Han}";
// A -, – or -- between two Chinese characters (spaces allowed around it).
const HAN_DASH_RE = new RegExp(`(${HAN})\\s*(?:--|–|-)\\s*(?=${HAN})`, "gu");
// Simple one-to-one replacements.
const SIMPLE: Readonly<Record<string, string>> = {
	",": "，",
	";": "；",
	":": "：",
	"!": "！",
	"?": "？",
	"(": "（",
	")": "）",
};
// Full-width marks that take no space on either side.
const TIGHT_RE = /\s*([，；：！？。．、）》」』】…])\s*/g;
// Opening full-width marks that take no space after them.
const OPEN_TIGHT_RE = /([（《「『【])\s+/g;

/** Chinese punctuation for one paragraph; quotes are paired with a stack inside the paragraph. */
export function normalizePunct(paragraph: string): PunctResult {
	// Protected spans, replaced by numbered markers.
	const kept: string[] = [];
	let s = paragraph.replace(PROTECT_RE, (m) => `${OPEN}${kept.push(m) - 1}${CLOSE}`);
	// A leading list number "1." becomes the full-width "1．" used in Chinese documents.
	s = s.replace(/^(\s*\d{1,3})\.(?!\d)/, "$1．");
	// Dashes between Chinese characters.
	s = s.replace(HAN_DASH_RE, "$1—");
	// Ellipsis.
	s = s.replace(/\.{3,}|…+/g, "……");
	// Sentence-final full stop: a dot followed by space, a quote, a closing bracket, a Chinese character or the end.
	s = s.replace(/\.(?=\s|$|["'”’)）\p{Script=Han}])/gu, "。");
	// Commas, colons and the rest.
	s = s.replace(/[,;:!?()]/g, (c) => SIMPLE[c]);
	// Quotes, paired per paragraph.
	const paired = pairQuotes(s);
	s = paired.text;
	// No spaces around full-width marks.
	s = s.replace(TIGHT_RE, "$1").replace(OPEN_TIGHT_RE, "$1");
	// Protected spans back.
	const text = s.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_m, i: string) => kept[Number(i)]);
	// Offsets of unpaired quotes, located again in the final text.
	return { text, unpaired: locateUnpaired(text, paired.unpairedCount) };
}

/** Pair straight and curly quotes with a stack: “” outside, ‘’ inside. */
export function pairQuotes(s: string): { text: string; unpairedCount: number } {
	// Open quotes waiting for their partner ('"' or "'").
	const stack: string[] = [];
	// Output characters.
	let out = "";
	// Quotes that closed nothing.
	let stray = 0;
	// Each character.
	for (const ch of s) {
		// Double quotes of any form.
		if (ch === '"' || ch === "“" || ch === "”") {
			// Close when the innermost open quote is a double one (a ” always closes).
			if (stack.at(-1) === '"' && ch !== "“") {
				stack.pop();
				out += "”";
			} else if (ch === "”") {
				// A closing quote with nothing to close.
				stray++;
				out += "”";
			} else {
				// Open.
				stack.push('"');
				out += "“";
			}
			continue;
		}
		// Single quotes of any form.
		if (ch === "'" || ch === "‘" || ch === "’") {
			// Same rule for the inner level.
			if (stack.at(-1) === "'" && ch !== "‘") {
				stack.pop();
				out += "’";
			} else if (ch === "’") {
				stray++;
				out += "’";
			} else {
				stack.push("'");
				out += "‘";
			}
			continue;
		}
		// Anything else.
		out += ch;
	}
	// Quotes still open at the end, plus stray closers.
	return { text: out, unpairedCount: stack.length + stray };
}

/** Offsets of the first `count` quotes that break pairing when the text is read left to right. */
function locateUnpaired(text: string, count: number): number[] {
	// Nothing to find.
	if (count === 0) return [];
	// Open quotes with their offsets.
	const stack: { q: string; at: number }[] = [];
	// Offsets of stray closers.
	const stray: number[] = [];
	// Walk by UTF-16 offset.
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		// Openers.
		if (ch === "“" || ch === "‘") stack.push({ q: ch, at: i });
		// Closers match their own kind.
		else if (ch === "”" || ch === "’") {
			const want = ch === "”" ? "“" : "‘";
			if (stack.at(-1)?.q === want) stack.pop();
			else stray.push(i);
		}
	}
	// Both kinds, in text order.
	return [...stray, ...stack.map((x) => x.at)].sort((a, b) => a - b).slice(0, count);
}

/** Count ASCII punctuation directly next to a Chinese character (the export check). */
export function countAsciiNextToHan(text: string): number {
	// ASCII punctuation with a Chinese character on either side.
	const re = new RegExp(`(?<=${HAN})[,.;:!?()"']|[,.;:!?()"'](?=${HAN})`, "gu");
	// Number of matches.
	return (text.match(re) ?? []).length;
}
