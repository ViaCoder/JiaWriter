/**
 * Built-in WriterAgent extension: the interface language and the configuration page.
 * - /lang [zh|en]: choose the interface and tool-output language (saved in writer-settings.json;
 *   WA_LANG, when set, takes precedence).
 * - /wa: a full-screen, read-only page of the model and search configuration (any key closes it).
 */

// Width-safe line truncation of the terminal UI.
import { truncateToWidth } from "@earendil-works/pi-tui";
// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// The configuration page.
import { formatWaConfig } from "../../writer/config-view.ts";
// Messages and the language setting.
import { setUiLang, t, type WriterLang } from "../../writer/i18n/index.ts";
// Main-model state after startup.
import { getWriterModel } from "../../writer/writer-model.ts";

/** Language from a /lang argument, or undefined when it is not one of zh and en. */
export function parseLangArg(arg: string): WriterLang | undefined {
	// Lower case, Chinese names accepted.
	const a = arg.trim().toLowerCase();
	if (a === "zh" || a === "中文" || a === "cn") return "zh";
	if (a === "en" || a === "english" || a === "英文") return "en";
	return undefined;
}

/** A component that shows fixed lines and closes on any key. */
export class ReadOnlyPage {
	// Lines to show.
	private readonly lines: string[];
	// Called once on the first key.
	private readonly onClose: () => void;
	constructor(lines: string[], onClose: () => void) {
		this.lines = lines;
		this.onClose = onClose;
	}
	/** Lines cut to the terminal width. */
	render(width: number): string[] {
		// One terminal row per line.
		return this.lines.map((l) => truncateToWidth(l, Math.max(1, width)));
	}
	/** Any key closes the page. */
	handleInput(_data: string): void {
		this.onClose();
	}
	/** Nothing is cached between renders. */
	invalidate(): void {}
}

/** Extension factory. */
export default function writerUiExtension(pi: ExtensionAPI): void {
	// /lang.
	pi.registerCommand("lang", {
		description: "Switch the interface language: /lang zh or /lang en",
		getArgumentCompletions: (prefix) =>
			["zh", "en"].filter((l) => l.startsWith(prefix)).map((l) => ({ value: l, label: l })),
		handler: async (args, ctx) => {
			// The argument, or a choice.
			let lang = parseLangArg(args);
			if (!lang && args.trim() === "" && ctx.hasUI) {
				const choice = await ctx.ui.select(t("lang.choose"), ["中文", "English"]);
				if (choice === undefined) return;
				lang = choice === "English" ? "en" : "zh";
			}
			if (!lang) {
				ctx.ui.notify(t("lang.bad"), "error");
				return;
			}
			// Saved; the message is already in the new language.
			setUiLang(lang);
			const env = process.env.WA_LANG?.trim();
			ctx.ui.notify(env ? t("lang.envWins", { value: env }) : t("lang.saved"), env ? "warning" : "info");
		},
	});

	// /wa.
	pi.registerCommand("wa", {
		description: "Show the WriterAgent model and search configuration (read-only)",
		handler: async (_args, ctx) => {
			// The page from the environment and the startup state.
			const lines = formatWaConfig(process.env, getWriterModel(), process.platform);
			// Full screen in the terminal; a note elsewhere.
			if (ctx.mode === "tui")
				await ctx.ui.custom<void>((_tui, _theme, _kb, done) => new ReadOnlyPage(lines, () => done(undefined)));
			else ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
