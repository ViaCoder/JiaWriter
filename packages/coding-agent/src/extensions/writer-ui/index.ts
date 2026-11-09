/**
 * Built-in JiaWriter extension: the interface language and the configuration page.
 * - /lang [zh|en]: choose the interface and tool-output language (saved in writer-settings.json;
 *   JW_LANG, when set, takes precedence).
 * - /jw: a full-screen, read-only page of the model and search configuration (any key closes it).
 */

// Width-safe line truncation of the terminal UI.
import { truncateToWidth } from "@earendil-works/pi-tui";
// Extension API types.
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { formatWaConfig } from "../../writer/config-view.ts";
// The levels /effort offers.
import { WRITER_REASONING_CHOICES, type WriterReasoning } from "../../writer/env-config.ts";
// Messages and the language setting.
import { setUiLang, t, type WriterLang } from "../../writer/i18n/index.ts";
// The permission mode.
import {
	PERMISSION_MODES,
	parsePermissionMode,
	permissionMode,
	savePermissionMode,
	setSessionPermissionMode,
} from "../../writer/permission.ts";
// The configuration page.
import { stageLines } from "../../writer/prompts/stages.ts";
// The keys held in memory (shown only as set or unset).
import { withSecrets } from "../../writer/secrets.ts";
// Where the search log is.
import { fileSize, searchLogPath } from "../../writer/websearch/log.ts";
// Main-model state after startup.
import { getWriterModel } from "../../writer/writer-model.ts";
// Desktop control and the overall check.
import { computerSetup, doctorLines } from "../writer-computer/index.ts";

/** Language from a /lang argument, or undefined when it is not one of zh and en. */
export function parseLangArg(arg: string): WriterLang | undefined {
	// Lower case, Chinese names accepted.
	const a = arg.trim().toLowerCase();
	if (a === "zh" || a === "中文" || a === "cn") return "zh";
	if (a === "en" || a === "english" || a === "英文") return "en";
	return undefined;
}

/** True for a level /effort accepts. */
export function isEffort(level: string): level is WriterReasoning {
	// The same choices as JW_EFFORT.
	return (WRITER_REASONING_CHOICES as readonly string[]).includes(level);
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

/** The /jw log page: where the file is and what it holds. */
export function logLines(): string[] {
	// The file, whether or not it exists yet.
	const path = searchLogPath();
	return [t("jw.logPath", { path, bytes: fileSize(path) }), t("jw.logNote")];
}

/** /jw permission: the argument, or a choice with the current mode named. */
export async function setPermission(arg: string, ctx: ExtensionCommandContext): Promise<void> {
	let choice = arg.trim();
	if (!choice && ctx.hasUI) {
		choice = (await ctx.ui.select(t("perm.choose", { mode: permissionMode() }), [...PERMISSION_MODES])) ?? "";
		if (!choice) return;
	}
	const mode = parsePermissionMode(choice);
	if (!mode) {
		ctx.ui.notify(t("perm.bad", { modes: PERMISSION_MODES.join(" / ") }), "error");
		return;
	}
	// Saved for every session, and in effect now: a mode chosen with Shift+Tab gives way. An environment value goes
	// on winning, and the user hears so.
	savePermissionMode(mode);
	setSessionPermissionMode(undefined);
	const env = process.env.JW_PERMISSION?.trim();
	ctx.ui.notify(env ? t("perm.envWins", { value: env }) : t("perm.saved", { mode }), env ? "warning" : "info");
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
			const env = process.env.JW_LANG?.trim();
			ctx.ui.notify(env ? t("lang.envWins", { value: env }) : t("lang.saved"), env ? "warning" : "info");
		},
	});

	// /effort: how hard the model thinks, the one setting worth changing during a conversation.
	pi.registerCommand("effort", {
		description: "Set the thinking intensity: /effort off, low, medium, high, xhigh or max",
		getArgumentCompletions: (prefix) =>
			WRITER_REASONING_CHOICES.filter((l) => l.startsWith(prefix)).map((l) => ({ value: l, label: l })),
		handler: async (args, ctx) => {
			// The argument, or a choice with the current level named.
			let level: string | undefined = args.trim().toLowerCase();
			if (!level && ctx.hasUI)
				level = await ctx.ui.select(t("effort.choose", { level: pi.getThinkingLevel() }), [
					...WRITER_REASONING_CHOICES,
				]);
			if (level === undefined) return;
			if (!isEffort(level)) {
				ctx.ui.notify(t("effort.bad", { levels: WRITER_REASONING_CHOICES.join(" / ") }), "error");
				return;
			}
			// The model may not have this level: pi picks the nearest one, and the user hears which.
			pi.setThinkingLevel(level);
			const actual = pi.getThinkingLevel();
			ctx.ui.notify(
				actual === level ? t("effort.set", { level }) : t("effort.nearest", { level, actual }),
				actual === level ? "info" : "warning",
			);
		},
	});

	// /jw.
	pi.registerCommand("jw", {
		description:
			"Show the JiaWriter configuration; /jw prompts shows the rules sent, /jw log the search log, /jw permission sets the mode, /jw computer sets up desktop control, /jw doctor checks everything",
		getArgumentCompletions: (prefix) => {
			// The sub-pages that fit.
			const fit = ["prompts", "log", "permission", "computer", "doctor"].filter((name) => name.startsWith(prefix));
			return fit.length > 0 ? fit.map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			// The word after /jw.
			const page = args.trim();
			// Setting up the desktop tool is the program's job, step by step, with no model involved.
			if (page === "computer" || page === "computer install") {
				await computerSetup(ctx, page !== "computer");
				return;
			}
			// The permission mode has its own step, and needs no page.
			if (page === "permission" || page.startsWith("permission ")) {
				await setPermission(page.slice("permission".length), ctx);
				return;
			}
			// The stage table, the search log, or the page from the environment and the startup state.
			const lines =
				page === "prompts"
					? stageLines()
					: page === "log"
						? logLines()
						: page === "doctor"
							? await doctorLines()
							: formatWaConfig(withSecrets(process.env), getWriterModel(), process.platform);
			// Full screen in the terminal; a note elsewhere.
			if (ctx.mode === "tui")
				await ctx.ui.custom<void>((_tui, _theme, _kb, done) => new ReadOnlyPage(lines, () => done(undefined)));
			else ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
