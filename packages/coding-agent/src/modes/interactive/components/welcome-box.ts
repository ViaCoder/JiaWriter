/**
 * JiaWriter (2026-11-15): the welcome box at the top of a session, after Claude Code's: a rounded frame with the
 * name and version, the model, the folder, and the few commands a new user needs. It replaces the pixel logo of the
 * release package, which told the user nothing and took six lines.
 */

// Width helpers of the terminal UI.
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** What the box says; read at each render so it follows theme and model changes. */
export interface WelcomeContent {
	// The product name, already coloured.
	title: string;
	// Plain text after the title (the version).
	subtitle: string;
	// The rows below, each a label and a value.
	rows: { label: string; value: string }[];
	// A closing line of hints, already coloured.
	hints: string;
}

/** Widest the box grows; narrower terminals get the width they have. */
export const WELCOME_MAX_WIDTH = 72;

/** The welcome box. */
export class WelcomeBox implements Component {
	private readonly content: () => WelcomeContent;
	private readonly paddingX: number;

	constructor(content: () => WelcomeContent, paddingX = 1) {
		this.content = content;
		this.paddingX = paddingX;
	}

	invalidate(): void {
		// Nothing cached: the content is read at each render.
	}

	render(width: number): string[] {
		const c = this.content();
		const outer = Math.min(WELCOME_MAX_WIDTH, Math.max(20, width - this.paddingX));
		// Columns inside the frame, minus one space of padding on each side.
		const inner = outer - 4;
		const edge = (s: string) => theme.fg("border", s);
		const pad = " ".repeat(this.paddingX);
		const line = (text: string) => {
			const cut = truncateToWidth(text, inner, "…");
			return `${pad}${edge("│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${edge("│")}`;
		};
		const labelWidth = Math.max(0, ...c.rows.map((r) => visibleWidth(r.label)));
		const lines = [
			`${pad}${edge(`╭${"─".repeat(outer - 2)}╮`)}`,
			line(`${c.title} ${theme.fg("dim", c.subtitle)}`),
			line(""),
			...c.rows.map((r) =>
				line(`${theme.fg("muted", r.label)}${" ".repeat(labelWidth - visibleWidth(r.label))}  ${r.value}`),
			),
			line(""),
			line(c.hints),
			`${pad}${edge(`╰${"─".repeat(outer - 2)}╯`)}`,
		];
		return lines;
	}
}
