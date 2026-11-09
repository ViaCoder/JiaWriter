/**
 * JiaWriter: Ctrl+R, the search through earlier inputs, as in Claude Code (2026-11-09: "The operation should be
 * consistent with Claude Code"). Typing filters the list, the arrows move, Enter puts the entry in the input box and
 * Esc leaves the box as it was.
 */

import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { uiText } from "../../../writer/ui-text.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** Entries shown at once. */
const SHOWN = 8;

/** The entries that hold every word of the query, ignoring case; the newest first, as given. */
export function filterHistory(entries: readonly string[], query: string): string[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return entries.filter((entry) => words.every((word) => entry.toLowerCase().includes(word)));
}

/** One line of an entry: its first line, cut to the width the list allows. */
function oneLine(entry: string): string {
	const first = entry.split("\n")[0] ?? "";
	return entry.includes("\n") ? `${first} …` : first;
}

export class HistorySearchComponent extends Container {
	private entries: readonly string[];
	private query = "";
	private matches: string[];
	private selected = 0;
	private queryText: Text;
	private list: Container;
	private onPick: (entry: string) => void;
	private onCancel: () => void;

	constructor(entries: readonly string[], onPick: (entry: string) => void, onCancel: () => void) {
		super();
		this.entries = entries;
		this.matches = [...entries];
		this.onPick = onPick;
		this.onCancel = onCancel;
		this.addChild(new DynamicBorder());
		this.addChild(
			new Text(theme.fg("accent", theme.bold(uiText("Search the input history (type to filter)"))), 1, 0),
		);
		this.queryText = new Text("", 1, 0);
		this.addChild(this.queryText);
		this.addChild(new Spacer(1));
		this.list = new Container();
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`,
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder());
		this.update();
	}

	/** Redraw the query and the matches. */
	private update(): void {
		this.queryText.setText(`${theme.fg("muted", "›")} ${this.query}${theme.fg("accent", "▏")}`);
		this.list.clear();
		// The window of matches around the selected one.
		const start = Math.max(0, Math.min(this.selected - SHOWN + 1, this.matches.length - SHOWN));
		for (const [i, entry] of this.matches.slice(Math.max(0, start), Math.max(0, start) + SHOWN).entries()) {
			const at = Math.max(0, start) + i;
			const line = oneLine(entry);
			this.list.addChild(
				new Text(at === this.selected ? theme.fg("accent", `→ ${line}`) : `  ${theme.fg("text", line)}`, 1, 0),
			);
		}
		if (this.matches.length === 0) this.list.addChild(new Text(theme.fg("muted", "  —"), 1, 0));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (kb.matches(data, "tui.select.confirm")) {
			const entry = this.matches[this.selected];
			if (entry !== undefined) this.onPick(entry);
		} else if (kb.matches(data, "tui.select.up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.update();
		} else if (kb.matches(data, "tui.select.down")) {
			this.selected = Math.min(Math.max(0, this.matches.length - 1), this.selected + 1);
			this.update();
		} else if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.query = [...this.query].slice(0, -1).join("");
			this.refilter();
		} else if (data.length > 0 && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data)) {
			// Printable text, typed or pasted.
			this.query += data;
			this.refilter();
		}
	}

	/** Filter again from the top. */
	private refilter(): void {
		this.matches = filterHistory(this.entries, this.query);
		this.selected = 0;
		this.update();
	}
}
