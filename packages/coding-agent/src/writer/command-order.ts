/**
 * The order of the / menu (2026-11-15): the commands a writer reaches for lead, in a fixed order; everything else
 * keeps the order it was registered in (upstream's built-ins, then the other extensions, templates and skills).
 */

/** The leading commands, first to last. */
export const LEADING_COMMANDS: readonly string[] = [
	"write",
	"research",
	"search",
	"import-doc",
	"export-doc",
	"memory",
	"plan",
	"schedule",
	"tasks",
	"browser",
	"computer",
	"rewind",
	"skills",
	"skill-new",
	"jw",
	"model",
	"effort",
	"lang",
	"resume",
	"fork",
	"compact",
	"settings",
];

/** The list with the leading commands first (a stable sort: ties keep their order). */
export function orderCommands<T extends { name: string }>(commands: readonly T[]): T[] {
	// Rank of a leading command; the others rank after all of them.
	const rank = (name: string) => {
		const at = LEADING_COMMANDS.indexOf(name);
		return at < 0 ? LEADING_COMMANDS.length : at;
	};
	return [...commands].sort((a, b) => rank(a.name) - rank(b.name));
}
