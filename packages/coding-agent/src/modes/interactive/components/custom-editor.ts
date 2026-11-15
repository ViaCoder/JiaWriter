import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
// JiaWriter: the prompt mark's colour.
import { theme } from "../theme/theme.ts";
import type { StatusIndicator } from "./status-indicator.ts";

/** How long the second key of a chord is awaited (ms). */
const CHORD_MS = 1000;

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;
	/** True while the send-now chord can do something; otherwise its first key keeps its own meaning at once. */
	public canSendNow?: () => boolean;
	/** Up on an empty editor: bring queued messages back for editing. True when there were any. */
	public onEditQueued?: () => boolean;

	// The first key of a chord in progress, and the timer that gives it its own meaning.
	private chordKey: string | undefined;
	private chordTimer: ReturnType<typeof setTimeout> | undefined;
	// The bottom border as last drawn: it marks where the autocomplete rows begin in the parent's output.
	private lastBottomBorder = "";

	/** The mark before the text: " >" with the editor's own padding after it, " > " without. */
	private promptMark(): string {
		return this.getPaddingX() > 0 ? " >" : " > ";
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.lastBottomBorder = super.renderBottomBorder(width, hiddenLineCount);
		return this.lastBottomBorder;
	}

	/**
	 * JiaWriter (2026-11-15, the user: the box's colour and style needed refinement): the editor in a rounded frame
	 * with a prompt mark, as Claude Code draws it. The parent draws the box narrower; the frame and the mark go
	 * around its lines, and the autocomplete rows below keep their place with the same indent.
	 */
	override render(width: number): string[] {
		const mark = this.promptMark();
		const markWidth = visibleWidth(mark);
		if (width < markWidth + 8) return super.render(width);
		const inner = super.render(width - 2 - markWidth);
		const bottom = inner.lastIndexOf(this.lastBottomBorder);
		if (bottom < 1) return inner;
		const edge = this.borderColor;
		// The frame: one column each side, the mark's width of dashes on the left (the lines inside are 2 + mark narrower).
		const out = [edge(`╭${"─".repeat(markWidth)}`) + inner[0] + edge("╮")];
		for (let i = 1; i < bottom; i++) {
			const lead = i === 1 ? theme.fg("accent", mark) : " ".repeat(markWidth);
			out.push(edge("│") + lead + inner[i] + edge("│"));
		}
		out.push(edge(`╰${"─".repeat(markWidth)}`) + inner[bottom] + edge("╯"));
		for (let i = bottom + 1; i < inner.length; i++) out.push(`${" ".repeat(markWidth + 1)}${inner[i]}`);
		return out;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// The frame and the mark stand before the parent's columns.
		const markWidth = visibleWidth(this.promptMark());
		if (event.width < markWidth + 8) return super.handleMouse(event);
		return super.handleMouse({ ...event, x: event.x - 1 - markWidth, width: event.width - 2 - markWidth });
	}

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}

		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	/** What a chord's first key does alone (Ctrl+X copies). */
	private runChordKey(data: string): void {
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}
	}

	/** Follow the send-now chord. True when the key belonged to it. */
	private followChord(data: string): boolean {
		// Second key, or anything else.
		if (this.chordKey !== undefined) {
			const first = this.chordKey;
			clearTimeout(this.chordTimer);
			this.chordKey = undefined;
			if (this.keybindings.matches(data, "app.message.sendNowChordEnd")) {
				this.actionHandlers.get("app.message.sendNow")?.();
				return true;
			}
			this.runChordKey(first);
			return false;
		}
		// First key: wait for the second only when the chord can do something.
		if (!this.keybindings.matches(data, "app.message.sendNowChordStart") || !this.canSendNow?.()) return false;
		this.chordKey = data;
		this.chordTimer = setTimeout(() => {
			this.chordKey = undefined;
			this.runChordKey(data);
		}, CHORD_MS);
		this.chordTimer.unref?.();
		return true;
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// The send-now chord, which shares its first key with other actions
		if (this.followChord(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Up on an empty editor edits what is queued, before it steps through history
		if (
			this.keybindings.matches(data, "tui.editor.cursorUp") &&
			this.getText().length === 0 &&
			!this.isShowingAutocomplete() &&
			this.onEditQueued?.()
		) {
			return;
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
