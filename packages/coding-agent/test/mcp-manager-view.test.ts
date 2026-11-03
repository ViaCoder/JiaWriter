import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { McpManagerView } from "../src/extensions/mcp/ui.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ESCAPE = "\x1b";
const tui = { requestRender: vi.fn() } as unknown as TUI;

function rendered(view: McpManagerView): string {
	return stripAnsi(view.render(80).join("\n"));
}

// JiaWriter: these tests read the upstream English hint text; the interface defaults to Chinese
// (vitest restores stubbed variables after each test, so the stub runs before each one).
beforeEach(() => {
	vi.stubEnv("JW_LANG", "en");
});

describe("MCP manager status screen", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	// #10565
	test("cancels the running operation with the cancel key", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const onCancel = vi.fn();
		view.status("Sign in to issues", "Contacting the authorization server…", onCancel);
		expect(rendered(view)).toContain("cancel");
		view.handleInput(ESCAPE);
		expect(onCancel).toHaveBeenCalledOnce();
	});

	test("ignores the cancel key for operations that cannot be cancelled", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		view.status("Sign in to issues", "Connecting…");
		expect(rendered(view)).not.toContain("cancel");
		view.handleInput(ESCAPE);
	});
});
