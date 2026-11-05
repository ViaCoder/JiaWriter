import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const CTRL_X = "\x18";
const CTRL_S = "\x13";
const UP = "\x1b[A";

/** An editor with counters on the send-now and copy actions. */
function setup(canSendNow: boolean) {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
	const count = { send: 0, copy: 0 };
	editor.onAction("app.message.sendNow", () => count.send++);
	editor.onAction("app.message.copy", () => count.copy++);
	editor.canSendNow = () => canSendNow;
	return { editor, count };
}

afterEach(() => {
	vi.useRealTimers();
	setKeybindings(new KeybindingsManager());
});

describe("send-now chord", () => {
	it("sends on Ctrl+X Ctrl+S and does not copy", () => {
		const { editor, count } = setup(true);
		editor.handleInput(CTRL_X);
		editor.handleInput(CTRL_S);
		expect(count).toEqual({ send: 1, copy: 0 });
	});

	it("gives Ctrl+X its own meaning when the second key does not come", () => {
		vi.useFakeTimers();
		const { editor, count } = setup(true);
		editor.handleInput(CTRL_X);
		expect(count.copy).toBe(0);
		vi.advanceTimersByTime(1000);
		expect(count).toEqual({ send: 0, copy: 1 });
	});

	it("gives Ctrl+X its own meaning, and keeps the next key, when another key follows", () => {
		const { editor, count } = setup(true);
		editor.handleInput(CTRL_X);
		editor.handleInput("a");
		expect(count).toEqual({ send: 0, copy: 1 });
		expect(editor.getText()).toBe("a");
	});

	it("copies at once when there is nothing to send", () => {
		const { editor, count } = setup(false);
		editor.handleInput(CTRL_X);
		expect(count).toEqual({ send: 0, copy: 1 });
	});

	it("leaves Ctrl+S alone outside the chord", () => {
		const { editor, count } = setup(true);
		editor.handleInput(CTRL_S);
		expect(count).toEqual({ send: 0, copy: 0 });
	});

	it("sends on Ctrl+Enter in a terminal that reports it", () => {
		const { editor, count } = setup(true);
		editor.handleInput("\x1b[13;5u");
		expect(count.send).toBe(1);
	});
});

describe("Up on the editor", () => {
	it("edits queued messages when the editor is empty", () => {
		const { editor } = setup(true);
		editor.onEditQueued = () => {
			editor.setText("queued");
			return true;
		};
		editor.addToHistory("older prompt");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("queued");
	});

	it("steps through history when nothing is queued", () => {
		const { editor } = setup(true);
		editor.onEditQueued = () => false;
		editor.addToHistory("older prompt");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("older prompt");
	});

	it("does not take the queue over a draft", () => {
		const { editor } = setup(true);
		let asked = 0;
		editor.onEditQueued = () => {
			asked++;
			return true;
		};
		editor.setText("draft");
		editor.handleInput(UP);
		expect(asked).toBe(0);
		expect(editor.getText()).toBe("draft");
	});
});
