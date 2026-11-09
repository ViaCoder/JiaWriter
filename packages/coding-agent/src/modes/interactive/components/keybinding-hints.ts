/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { uiText } from "../../../writer/ui-text.ts";
import { theme } from "../theme/theme.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

/** Key names as Claude Code writes them (2026-11-09): Esc, PageUp; Option on a Mac, where the key is labelled so. */
const KEY_NAMES: Readonly<Record<string, string>> = { escape: "esc", pageup: "pageUp", pagedown: "pageDown" };

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const lower = part.toLowerCase();
	const displayPart = process.platform === "darwin" && lower === "alt" ? "option" : (KEY_NAMES[lower] ?? part);
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	// JiaWriter: hints write keys as Claude Code does (Ctrl+O, Shift+Tab, Esc).
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyHint(keybinding: Keybinding, description: string): string {
	// JiaWriter: hint text in the interface language.
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${uiText(description)}`);
}

export function rawKeyHint(key: string, description: string): string {
	// JiaWriter: hint text in the interface language, keys as Claude Code writes them.
	return theme.fg("dim", formatKeyText(key, { capitalize: true })) + theme.fg("muted", ` ${uiText(description)}`);
}
