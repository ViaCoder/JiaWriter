/**
 * JiaWriter (2026-11-15, the interface redone after Claude Code's layout): a component drawn behind a marker. The
 * first line gets the marker (● for a reply or a tool call, ⎿ for a tool's result, > for the user's words), the other
 * lines an indent of the marker's width, so a message reads as one block with a clear start. Leading empty lines of
 * the child are dropped, so the marker never stands on an empty line.
 */

// Component and width helpers of the terminal UI.
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
// Styled lines carry escape codes even when blank: the words decide.
import { stripAnsi } from "../../../utils/ansi.ts";

/** Whether a rendered line shows any character. */
function hasText(line: string): boolean {
	return stripAnsi(line).trim() !== "";
}

/** A marker and how to colour it; the child is drawn `indent` columns in. */
export interface PrefixOptions {
	// The marker of the first line, styled; its visible width sets the indent of the other lines.
	marker: () => string;
	// Colours a whole line (a background band); none for plain lines.
	band?: (line: string) => string;
	// Columns to indent by, when the marker's visible width is not the measure (a two-cell marker in a one-cell font).
	indent?: number;
	// Keep the child's leading empty lines (a band with a blank row above its text); dropped otherwise.
	keepLeading?: boolean;
}

/** The child behind a marker. */
export class Prefixed implements Component {
	private readonly child: Component;
	private readonly options: PrefixOptions;

	constructor(child: Component, options: PrefixOptions) {
		this.child = child;
		this.options = options;
	}

	/** The wrapped component, for callers that keep it between renders. */
	get inner(): Component {
		return this.child;
	}

	invalidate(): void {
		this.child.invalidate?.();
	}

	render(width: number): string[] {
		const marker = this.options.marker();
		const indent = this.options.indent ?? visibleWidth(marker);
		const pad = " ".repeat(indent);
		const lines = this.child.render(Math.max(1, width - indent));
		// The marker goes on the first line that says something.
		let first = 0;
		if (!this.options.keepLeading) while (first < lines.length && !hasText(lines[first])) first++;
		const kept = lines.slice(first);
		if (kept.length === 0) return [];
		const band = this.options.band ?? ((line: string) => line);
		// The marker goes on the first line with text; blank rows kept above it get the indent.
		const at = Math.max(0, kept.findIndex(hasText));
		return kept.map((line, i) => band(`${i === at ? marker : pad}${line}`));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const handler = this.child.handleMouse;
		if (!handler) return undefined;
		const indent = this.options.indent ?? visibleWidth(this.options.marker());
		return handler.call(this.child, { ...event, x: Math.max(0, event.x - indent) });
	}
}
