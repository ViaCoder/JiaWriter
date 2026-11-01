/**
 * Writing-skill management for /skills: built-in skills (shipped per language, turned off through
 * <agentDir>/writer-skills.json) and the user's skills (<agentDir>/skills/<name>/SKILL.md, turned off
 * by moving them to <agentDir>/skills-disabled/). A user skill with a built-in name replaces it.
 * Every overwrite and every deletion first copies the skill to <agentDir>/skills-backup/.
 */

// Files.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
// Path helpers.
import { join } from "node:path";
// Frontmatter parser used by the skill loader.
import { parseFrontmatter } from "../../utils/frontmatter.ts";

/** One skill as /skills shows it. */
export interface SkillEntry {
	// Skill name (the command /skill:name).
	name: string;
	// Display title (metadata.title, else the name).
	title: string;
	// Routing description.
	description: string;
	// Folder holding SKILL.md.
	dir: string;
	// Built-in or the user's own.
	origin: "builtin" | "user";
	// Offered to the model.
	enabled: boolean;
}

/** State file of turned-off built-in skills. */
const STATE = "writer-skills.json";

/** Names of turned-off built-in skills. */
export function disabledBuiltins(agentDir: string): string[] {
	// Missing or broken file: none.
	try {
		const data = JSON.parse(readFileSync(join(agentDir, STATE), "utf-8")) as { disabled?: unknown };
		return Array.isArray(data.disabled) ? data.disabled.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/** Skill folders (each with SKILL.md) directly under root. */
function skillDirs(root: string): string[] {
	// Missing root: none.
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(root, e.name, "SKILL.md")))
		.map((e) => join(root, e.name))
		.sort();
}

/** Name, title and description of a SKILL.md (folder name when the frontmatter has no name). */
export function readSkillInfo(dir: string): { name: string; title: string; description: string } {
	// Frontmatter of the file.
	const { frontmatter } = parseFrontmatter<{ name?: unknown; description?: unknown; metadata?: { title?: unknown } }>(
		readFileSync(join(dir, "SKILL.md"), "utf-8"),
	);
	const name = typeof frontmatter.name === "string" ? frontmatter.name : (dir.split(/[\\/]/).pop() ?? "");
	const title = typeof frontmatter.metadata?.title === "string" ? frontmatter.metadata.title : name;
	return { name, title, description: typeof frontmatter.description === "string" ? frontmatter.description : "" };
}

/** All skills: the user's (on and off), then the built-ins they do not replace. */
export function listSkills(agentDir: string, builtinLangDir: string): SkillEntry[] {
	// The user's skills.
	const user = [
		...skillDirs(join(agentDir, "skills")).map((dir) => ({ dir, enabled: true })),
		...skillDirs(join(agentDir, "skills-disabled")).map((dir) => ({ dir, enabled: false })),
	].map(({ dir, enabled }) => ({ ...readSkillInfo(dir), dir, origin: "user" as const, enabled }));
	// Built-ins not replaced by a user skill.
	const off = new Set(disabledBuiltins(agentDir));
	const taken = new Set(user.map((s) => s.name));
	const builtin = skillDirs(builtinLangDir)
		.map((dir) => ({ ...readSkillInfo(dir), dir, origin: "builtin" as const }))
		.filter((s) => !taken.has(s.name))
		.map((s) => ({ ...s, enabled: !off.has(s.name) }));
	// User skills first.
	return [...user, ...builtin];
}

/** Folders of the built-in skills to offer (on and not replaced). */
export function enabledBuiltinDirs(agentDir: string, builtinLangDir: string): string[] {
	// From the full list.
	return listSkills(agentDir, builtinLangDir)
		.filter((s) => s.origin === "builtin" && s.enabled)
		.map((s) => s.dir);
}

/** Timestamp for backup folder names (local time, YYYYMMDD-HHMMSS). */
export function stamp(now: Date): string {
	// Two digits.
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Copy a skill folder to <agentDir>/skills-backup/<name>-<stamp>/ and return the copy's path. */
export function backupSkill(dir: string, name: string, agentDir: string, now = new Date()): string {
	// Backup folder, never overwriting an older backup.
	const root = join(agentDir, "skills-backup");
	let target = join(root, `${name}-${stamp(now)}`);
	for (let i = 2; existsSync(target); i++) target = join(root, `${name}-${stamp(now)}-${i}`);
	mkdirSync(root, { recursive: true });
	cpSync(dir, target, { recursive: true });
	return target;
}

/** Turn a skill on or off. Built-ins: the state file; user skills: move between skills/ and skills-disabled/. */
export function setSkillEnabled(skill: SkillEntry, enabled: boolean, agentDir: string): void {
	// Nothing to do.
	if (skill.enabled === enabled) return;
	if (skill.origin === "builtin") {
		// Update the list of turned-off built-ins.
		const off = new Set(disabledBuiltins(agentDir));
		if (enabled) off.delete(skill.name);
		else off.add(skill.name);
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, STATE), `${JSON.stringify({ disabled: [...off].sort() }, null, 2)}\n`);
		return;
	}
	// Move the folder.
	const target = join(agentDir, enabled ? "skills" : "skills-disabled", skill.dir.split(/[\\/]/).pop() ?? skill.name);
	if (existsSync(target)) throw new Error(target);
	mkdirSync(join(target, ".."), { recursive: true });
	renameSync(skill.dir, target);
}

/** Delete a user skill after backing it up; returns the backup path. Built-ins are turned off instead. */
export function deleteSkill(skill: SkillEntry, agentDir: string, now = new Date()): string {
	// Built-ins stay shipped; they can only be turned off.
	if (skill.origin === "builtin") {
		setSkillEnabled(skill, false, agentDir);
		return "";
	}
	// Backup, then remove.
	const backup = backupSkill(skill.dir, skill.name, agentDir, now);
	rmSync(skill.dir, { recursive: true, force: true });
	return backup;
}

/** Write a user skill's SKILL.md (backing up an existing one) and return its path and the backup path. */
export function writeUserSkill(
	name: string,
	content: string,
	agentDir: string,
	now = new Date(),
): { path: string; backup: string } {
	// The folder (an existing one is backed up first).
	const dir = join(agentDir, "skills", name);
	const backup = existsSync(join(dir, "SKILL.md")) ? backupSkill(dir, name, agentDir, now) : "";
	mkdirSync(dir, { recursive: true });
	// Atomic write.
	const path = join(dir, "SKILL.md");
	writeFileSync(`${path}.tmp`, content);
	renameSync(`${path}.tmp`, path);
	return { path, backup };
}

/** A user copy of a built-in skill (with its other files) to edit; returns the copy's folder. */
export function copyBuiltinForEdit(skill: SkillEntry, agentDir: string): string {
	// Target folder under the user's skills.
	const dir = join(agentDir, "skills", skill.name);
	if (!existsSync(dir)) cpSync(skill.dir, dir, { recursive: true });
	return dir;
}
