/**
 * Token estimates for Chinese and mixed text. A Chinese character is about one token, while other text
 * averages about four characters per token, so upstream's chars/4 reads Chinese at a quarter of its size.
 */

/** Characters counted as one token each: CJK punctuation and ideographs, hangul, full-width forms. */
function isWide(code: number): boolean {
	// The same ranges the output clamp has always used.
	return (
		(code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef)
	);
}

/** Number of wide characters in text. */
export function wideCount(text: string): number {
	// A plain loop: tool results can be long and this runs before every request.
	let wide = 0;
	for (let i = 0; i < text.length; i++) if (isWide(text.charCodeAt(i))) wide++;
	return wide;
}

/** Estimated tokens of text, rounded up so the estimate errs on the large side. */
export function estimateTextTokens(text: string): number {
	// Wide characters count one each; the rest four per token.
	const wide = wideCount(text);
	return wide + Math.ceil((text.length - wide) / 4);
}

/** Length of text in "four per token" units, for code that adds characters up and divides by four. */
export function weightedChars(text: string): number {
	// Each wide character weighs four.
	return text.length + 3 * wideCount(text);
}
