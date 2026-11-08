/**
 * The shape of an analysis paragraph in a report (the user, 2026-11-08): a few general sentences on the situation,
 * risks, developments or trends first, then a case or data point as evidence; what sets them apart is whether
 * specific people, matters or figures appear. A paragraph whose first sentence already carries them has its evidence
 * before its point. Content that is not analysis needs no case, so only the order is checked, never a missing case.
 */

/** Specifics: a figure with its unit, a date with month, or a cited title. */
const SPECIFIC =
	/\d+(?:\.\d+)?\s*(?:%|个百分点|万|亿|千|百|个|家|人|名|艘|座|处|项|起|公里|千米|平方公里|公顷|亩|吨|元|美元|倍)|\d{4}年\d{1,2}月|《[^》\n]{2,60}》/;

/** Shortest paragraph (in sentences) that is a point with evidence rather than one statement. */
const MIN_SENTENCES = 2;

/** The openings of paragraphs that start with their evidence, each as its first sentence. */
export function evidenceFirst(text: string): string[] {
	return (
		text
			.split(/\n\s*\n/)
			.map((block) => block.trim())
			// Headings, lists, tables and quotes are not analysis paragraphs.
			.filter((block) => block && !/^(#|[-*>|]|\d+\.\s)/.test(block))
			.flatMap((block) => {
				const sentences = block.match(/[^。！？!?]+[。！？!?]/g) ?? [];
				if (sentences.length < MIN_SENTENCES) return [];
				const first = (sentences[0] ?? "").trim();
				return SPECIFIC.test(first) ? [first.length > 40 ? `${first.slice(0, 40)}…` : first] : [];
			})
	);
}

/** Section titles of analysis that needs evidence: problems, shortcomings, risks, challenges. */
const NEEDS_EVIDENCE = /问题|短板|不足|风险|挑战|困难/;

/** The openings of paragraphs in problem or risk sections that carry no specifics at all (a 2026-11-08 report stated
 * four problems with no figure, while its material had them). */
export function unsupportedAnalysis(text: string): string[] {
	const found: string[] = [];
	// Whether the current level-1 section is one that needs evidence.
	let inside = false;
	for (const block of text.split(/\n\s*\n/).map((b) => b.trim())) {
		const heading = /^##\s+(.*)$/.exec(block);
		if (heading) {
			inside = NEEDS_EVIDENCE.test(heading[1] ?? "");
			continue;
		}
		if (!inside || !block || /^(#|[-*>|])/.test(block)) continue;
		const sentences = block.match(/[^。！？!?]+[。！？!?]/g) ?? [];
		if (sentences.length < MIN_SENTENCES || SPECIFIC.test(block)) continue;
		const first = (sentences[0] ?? "").trim();
		found.push(first.length > 30 ? `${first.slice(0, 30)}…` : first);
	}
	return found;
}

/** A figure with its unit, the mark of one piece of material (60292个, 11万艘, 96.7%). */
const FIGURE =
	/\d[\d,.]*\s*(?:万|亿)?(?:%|个百分点|个|家|人|名|艘|座|处|项|起|公里|平方公里|公顷|亩|吨|元|美元|倍|件|次|条)/g;

/** Figures used in more than one paragraph (the user, from WriterSuite: each case and figure is used once in a
 * document; a 2026-11-08 report gave 60292 outlets as an achievement and again as a problem). */
export function repeatedFigures(text: string): string[] {
	// The paragraphs each figure appears in.
	const seen = new Map<string, Set<number>>();
	text.split(/\n\s*\n/).forEach((block, i) => {
		if (/^\s*#/.test(block)) return;
		for (const m of block.matchAll(FIGURE)) {
			const figure = m[0].replace(/\s+/g, "");
			// Bare small counts (3个, 2次) recur by chance; only figures with three or more digits, or a decimal, count.
			if (!/\d{3,}|\d\.\d/.test(figure.replace(/,/g, ""))) continue;
			const where = seen.get(figure) ?? new Set<number>();
			where.add(i);
			seen.set(figure, where);
		}
	});
	return [...seen].filter(([, where]) => where.size > 1).map(([figure]) => figure);
}
