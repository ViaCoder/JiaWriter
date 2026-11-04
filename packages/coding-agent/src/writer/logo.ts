/**
 * The JiaWriter logo in the startup header: a colorful "Jia" drawn like the upstream pi logo, with half
 * blocks, but 4 lines tall (8 pixel rows) so the letters are easy to recognize: capital J, a thin dotted
 * i and a single-story a. The version follows the last line; the key hints go below the logo. A release package
 * (name "jiawriter") shows it; the source tree keeps the pi logo.
 */

// Colors and the terminal's color mode.
import { foregroundAnsi, rgbColor } from "@earendil-works/pi-tui";
// The command name from package.json.
import { APP_NAME } from "../config.ts";
// The active theme, which knows the terminal's color mode.
import { theme } from "../modes/interactive/theme/theme.ts";

// The pi logo's brand colors, kept for "Jia": coral, yellow and blue.
const CORAL = rgbColor(228, 138, 122);
const YELLOW = rgbColor(234, 182, 93);
const BLUE = rgbColor(79, 142, 179);
// Ends a colored run.
const RESET = "\x1b[0m";
// Blank columns between letters.
const GAP = "  ";

/** One letter: 8 pixel rows ("#" lit, "." dark) of equal width, and its color. */
interface Letter {
	rows: string[];
	color: typeof CORAL;
}

/** "J" full height; "i" one column wide with its dot; "a" a round bowl with a right stem on the lower five rows. */
const LETTERS: Letter[] = [
	{ rows: [".###", "...#", "...#", "...#", "...#", "...#", "#..#", ".##."], color: CORAL },
	{ rows: [".", "#", ".", "#", "#", "#", "#", "#"], color: YELLOW },
	{ rows: ["....", "....", "....", ".###", "#..#", "#..#", "#..#", ".###"], color: BLUE },
];

/** Two pixel rows as one line of half blocks: both lit "█", upper "▀", lower "▄", neither " ". */
export function halfBlockLine(upper: string, lower: string): string {
	// One character per pixel column.
	let line = "";
	for (let i = 0; i < upper.length; i++) {
		// Which halves of this cell are lit.
		const up = upper[i] === "#";
		const down = lower[i] === "#";
		line += up && down ? "█" : up ? "▀" : down ? "▄" : " ";
	}
	return line;
}

/** The four lines of the "Jia" logo: each letter in its color, two blank columns between letters. */
export function jiaLogoLines(): string[] {
	// The terminal's color mode (truecolor, 256 colors, ...).
	const mode = theme.getColorMode();
	// One output line per pair of pixel rows.
	const lines: string[] = [];
	for (let row = 0; row < 8; row += 2) {
		// The letters' cells of this line, each in its color.
		const cells = LETTERS.map((letter) => {
			const color = foregroundAnsi(letter.color, mode);
			return `${color}${halfBlockLine(letter.rows[row], letter.rows[row + 1])}${RESET}`;
		});
		lines.push(cells.join(GAP));
	}
	return lines;
}

/** The header's top: the logo with the version after its last line, then the key hints below. */
export function jiaHeader(version: string, hints: string): string {
	// The logo lines; the last one carries the version.
	const lines = jiaLogoLines();
	lines[lines.length - 1] += `  ${version}`;
	return `${lines.join("\n")}\n${hints}`;
}

/** Text fallback for terminals without half blocks: "Jia" in the logo's colors. */
export function jiaWordmark(): string {
	// One color per letter, as in the logo.
	const mode = theme.getColorMode();
	return LETTERS.map((letter, i) => `${foregroundAnsi(letter.color, mode)}${"Jia"[i]}${RESET}`).join("");
}

/** Whether the header shows the JiaWriter logo: in a release package, not in the source tree ("pi"). */
export function showsJiaLogo(name: string = APP_NAME): boolean {
	return name !== "pi";
}
