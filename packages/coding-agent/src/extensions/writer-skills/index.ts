/**
 * Built-in JiaWriter extension: writing skills.
 * - Offers the built-in skills (one set, rules in English since 2026-11-08) that are turned on and not
 *   replaced by a user skill of the same name.
 * - /skills: list with on/off marks; turn one or all on or off, edit (built-ins are copied to the
 *   user's skills first), update from this session (shown as a diff), delete after a backup.
 * - /skill-new: from this session, from a blank template, or written by the model with skill-creator.
 * Nothing is written before the user confirms, and every overwrite or deletion is backed up first.
 */

// Files.
import { readFileSync } from "node:fs";
// Path helpers.
import { join } from "node:path";
// Agent directory and the built-in skills folder.
import { getAgentDir, getWriterSkillsDir } from "../../config.ts";
// Extension API types.
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
// Output messages.
import { currentLang, t, type WriterLang } from "../../writer/i18n/index.ts";
// Skill files.
import {
	copyBuiltinForEdit,
	deleteSkill,
	enabledBuiltinDirs,
	listSkills,
	type SkillEntry,
	setSkillEnabled,
	writeUserSkill,
} from "../../writer/skills/manage.ts";
// Skills from a session.
import {
	collectUserRequests,
	diffSkill,
	renderSkillDraft,
	resolveLatest,
	skillNameProblems,
} from "../../writer/skills/session-skill.ts";

/** Today as YYYY-MM-DD in local time. */
function today(): string {
	// en-CA formats dates that way.
	return new Date().toLocaleDateString("en-CA");
}

/** One list line for a skill. */
export function skillLabel(s: SkillEntry, lang?: WriterLang): string {
	// Mark, title, name and origin.
	return t(
		"skills.item",
		{
			mark: s.enabled ? "●" : "○",
			title: s.title,
			name: s.name,
			origin: t(s.origin === "builtin" ? "skills.builtin" : "skills.user", {}, lang),
		},
		lang,
	);
}

/** Confirm, then write a user skill and report where it went. */
async function confirmAndWrite(
	ctx: ExtensionCommandContext,
	name: string,
	content: string,
	agentDir: string,
	title: string,
	body: string,
	prepare?: () => void,
): Promise<void> {
	// Ask first.
	if (!(await ctx.ui.confirm(title, body))) return;
	prepare?.();
	const { path, backup } = writeUserSkill(name, content, agentDir);
	ctx.ui.notify(t("skills.saved", { path, backup: backup ? t("skills.backupNote", { backup }) : "" }), "info");
}

/** Draft from the session's requests; undefined (with a note) when there are none. */
function sessionDraft(
	ctx: ExtensionCommandContext,
	meta: { name: string; title: string; description: string; lang: WriterLang },
): string | undefined {
	// Requests of the active branch, the latest per topic.
	const { kept, dropped } = resolveLatest(collectUserRequests(ctx.sessionManager.getBranch()));
	if (kept.length === 0) {
		ctx.ui.notify(t("skills.noRequests"), "warning");
		return undefined;
	}
	if (dropped.length > 0) ctx.ui.notify(t("skills.dropped", { count: dropped.length }).trim(), "info");
	return renderSkillDraft({ ...meta, requests: kept, date: today() });
}

/** Actions for one skill; returns when the user goes back. */
async function skillActions(s: SkillEntry, ctx: ExtensionCommandContext, agentDir: string): Promise<void> {
	// Menu entries.
	const toggle = s.enabled ? t("skills.disable") : t("skills.enable");
	const choice = await ctx.ui.select(t("skills.actions", { title: s.title }), [
		toggle,
		t("skills.edit"),
		t("skills.updateFromSession"),
		t("skills.delete"),
		t("skills.back"),
	]);
	// Turn on or off.
	if (choice === toggle) {
		setSkillEnabled(s, !s.enabled, agentDir);
		ctx.ui.notify(
			t("skills.toggled", { name: s.name, state: t(s.enabled ? "skills.stateOff" : "skills.stateOn") }),
			"info",
		);
	} else if (choice === t("skills.edit")) {
		// Built-ins are edited as the user's copy.
		const current = readFileSync(join(s.dir, "SKILL.md"), "utf-8");
		const edited = await ctx.ui.editor(t("skills.editTitle", { name: s.name }), current);
		if (edited === undefined) return;
		if (edited === current) {
			ctx.ui.notify(t("skills.unchanged"), "info");
			return;
		}
		// A built-in skill is copied only now: a cancelled edit leaves nothing behind.
		if (s.origin === "builtin") copyBuiltinForEdit(s, agentDir);
		const { path, backup } = writeUserSkill(s.name, edited, agentDir);
		ctx.ui.notify(t("skills.saved", { path, backup: backup ? t("skills.backupNote", { backup }) : "" }), "info");
	} else if (choice === t("skills.updateFromSession")) {
		// New draft with the skill's own name, title and description, shown as a diff.
		const current = readFileSync(join(s.dir, "SKILL.md"), "utf-8");
		const draft = sessionDraft(ctx, {
			name: s.name,
			title: s.title,
			description: s.description,
			lang: currentLang(),
		});
		if (draft === undefined) return;
		const diff = diffSkill(`${s.name}/SKILL.md`, current, draft);
		if (diff === "") {
			ctx.ui.notify(t("skills.unchanged"), "info");
			return;
		}
		// A built-in skill's other files have to come along, or the user's copy would replace it without them.
		await confirmAndWrite(ctx, s.name, draft, agentDir, t("skills.diffTitle", { name: s.name }), diff, () => {
			if (s.origin === "builtin") copyBuiltinForEdit(s, agentDir);
		});
	} else if (choice === t("skills.delete")) {
		// Built-ins are turned off; user skills are backed up and removed.
		if (s.origin === "builtin") {
			deleteSkill(s, agentDir);
			ctx.ui.notify(t("skills.builtinOff", { name: s.name }), "info");
		} else if (await ctx.ui.confirm(t("skills.confirmDelete", { name: s.name }), t("skills.confirmDeleteBody"))) {
			ctx.ui.notify(t("skills.deleted", { name: s.name, backup: deleteSkill(s, agentDir) }), "info");
		}
	}
}

/** Ask for name, title, description and language; undefined when the user cancels. */
async function askMeta(
	ctx: ExtensionCommandContext,
): Promise<{ name: string; title: string; description: string; lang: WriterLang } | undefined> {
	// Name, checked against the Agent Skills rules.
	const name = (await ctx.ui.input(t("skills.askName")))?.trim();
	if (!name) return undefined;
	if (skillNameProblems(name).length > 0) {
		ctx.ui.notify(t("skills.badName", { name }), "error");
		return undefined;
	}
	// Title and description.
	const title = (await ctx.ui.input(t("skills.askTitle")))?.trim();
	if (!title) return undefined;
	const description = (await ctx.ui.input(t("skills.askDescription")))?.trim();
	if (!description) return undefined;
	// Language, Chinese first.
	const langChoice = await ctx.ui.select(t("skills.askLang"), [t("skills.langZh"), t("skills.langEn")]);
	if (langChoice === undefined) return undefined;
	return { name, title, description, lang: langChoice === t("skills.langEn") ? "en" : "zh" };
}

/** Extension factory. */
export default function writerSkillsExtension(pi: ExtensionAPI): void {
	// Built-in skills of the output language, minus turned-off and replaced ones.
	pi.on("resources_discover", () => ({
		skillPaths: enabledBuiltinDirs(getAgentDir(), getWriterSkillsDir()),
	}));

	// /skills.
	pi.registerCommand("skills", {
		description: "Manage writing skills: turn on or off, edit, update from this session, delete",
		handler: async (_args, ctx) => {
			// Until the user leaves the list.
			const agentDir = getAgentDir();
			for (;;) {
				const skills = listSkills(agentDir, getWriterSkillsDir());
				const labels = skills.map((s) => skillLabel(s));
				const choice = await ctx.ui.select(t("skills.title", { count: skills.length }), [
					t("skills.new"),
					t("skills.enableAll"),
					t("skills.disableAll"),
					...labels,
				]);
				if (choice === undefined) return;
				if (choice === t("skills.new")) await newSkill(ctx);
				else if (choice === t("skills.enableAll") || choice === t("skills.disableAll")) {
					// Bulk change of every skill in the other state.
					const on = choice === t("skills.enableAll");
					const change = skills.filter((s) => s.enabled !== on);
					for (const s of change) setSkillEnabled(s, on, agentDir);
					ctx.ui.notify(
						t("skills.toggledAll", { count: change.length, state: t(on ? "skills.stateOn" : "skills.stateOff") }),
						"info",
					);
				} else {
					const s = skills[labels.indexOf(choice)];
					if (s) await skillActions(s, ctx, agentDir);
				}
			}
		},
	});

	/** /skill-new and the list's new entry. */
	async function newSkill(ctx: ExtensionCommandContext): Promise<void> {
		// How to create it.
		const how = await ctx.ui.select(t("skills.newTitle"), [
			t("skills.newFromSession"),
			t("skills.newBlank"),
			t("skills.newGuided"),
		]);
		if (how === undefined) return;
		// The model writes it with skill-creator.
		if (how === t("skills.newGuided")) {
			const description = (await ctx.ui.input(t("skills.askDescription")))?.trim();
			if (description) pi.sendUserMessage(t("skills.guided", { description }), { expandPromptTemplates: true });
			return;
		}
		// Metadata, then the draft.
		const meta = await askMeta(ctx);
		if (!meta) return;
		const draft =
			how === t("skills.newFromSession")
				? sessionDraft(ctx, meta)
				: renderSkillDraft({ ...meta, requests: [], date: today() });
		if (draft === undefined) return;
		// The user edits the full draft; saving asks once more.
		const edited = await ctx.ui.editor(t("skills.editTitle", { name: meta.name }), draft);
		if (edited === undefined) return;
		const path = join(getAgentDir(), "skills", meta.name, "SKILL.md");
		// The confirmation shows the first 12 lines.
		await confirmAndWrite(
			ctx,
			meta.name,
			edited,
			getAgentDir(),
			t("skills.confirmWrite", { path }),
			edited.split("\n").slice(0, 12).join("\n"),
		);
	}

	// /skill-new.
	pi.registerCommand("skill-new", {
		description: "Create a writing skill from this session, a blank template, or with skill-creator",
		handler: async (_args, ctx) => newSkill(ctx),
	});
}
