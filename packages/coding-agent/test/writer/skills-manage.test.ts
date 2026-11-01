// Unit tests for src/writer/skills/manage.ts on temp folders.

// Files.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Functions under test.
import {
	backupSkill,
	copyBuiltinForEdit,
	deleteSkill,
	disabledBuiltins,
	enabledBuiltinDirs,
	listSkills,
	readSkillInfo,
	setSkillEnabled,
	stamp,
	writeUserSkill,
} from "../../src/writer/skills/manage.ts";

// Agent folder and built-in folder.
let agent = "";
let builtin = "";
beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "wa-skills-"));
	agent = join(root, "agent");
	builtin = join(root, "builtin");
	mkdirSync(agent);
	// Two built-ins.
	for (const [n, title] of [
		["alpha", "甲"],
		["beta", "乙"],
	]) {
		mkdirSync(join(builtin, n), { recursive: true });
		writeFileSync(
			join(builtin, n, "SKILL.md"),
			`---\nname: ${n}\ndescription: d-${n}\nmetadata:\n  title: ${title}\n---\n\n# ${title}\n`,
		);
	}
});
afterEach(() => rmSync(join(agent, ".."), { recursive: true, force: true }));

// A fixed time for backup names.
const NOW = new Date(2026, 10, 1, 21, 5, 9);

describe("readSkillInfo / stamp", () => {
	it("reads frontmatter fields with fallbacks, and formats backup stamps", () => {
		// Full and minimal files.
		expect(readSkillInfo(join(builtin, "alpha"))).toEqual({ name: "alpha", title: "甲", description: "d-alpha" });
		mkdirSync(join(agent, "bare"));
		writeFileSync(join(agent, "bare", "SKILL.md"), "# no frontmatter\n");
		expect(readSkillInfo(join(agent, "bare"))).toEqual({ name: "bare", title: "bare", description: "" });
		expect(stamp(NOW)).toBe("20261101-210509");
	});
});

describe("listSkills / setSkillEnabled / enabledBuiltinDirs", () => {
	it("lists user skills first, hides replaced built-ins, and turns skills on and off", () => {
		// A user skill replacing beta, and one of its own.
		writeUserSkill("beta", "---\nname: beta\ndescription: mine\n---\n", agent, NOW);
		writeUserSkill("gamma", "---\nname: gamma\ndescription: g\n---\n", agent, NOW);
		const list = () => listSkills(agent, builtin).map((s) => `${s.name}:${s.origin}:${s.enabled}`);
		expect(list()).toEqual(["beta:user:true", "gamma:user:true", "alpha:builtin:true"]);
		// Off: the built-in through the state file, the user skill by moving it.
		const [beta, , alpha] = listSkills(agent, builtin);
		setSkillEnabled(alpha, false, agent);
		setSkillEnabled(beta, false, agent);
		expect(list()).toEqual(["gamma:user:true", "beta:user:false", "alpha:builtin:false"]);
		expect([disabledBuiltins(agent), existsSync(join(agent, "skills-disabled", "beta", "SKILL.md"))]).toEqual([
			["alpha"],
			true,
		]);
		expect(enabledBuiltinDirs(agent, builtin)).toEqual([]);
		// On again; a no-op change does nothing.
		for (const s of listSkills(agent, builtin)) setSkillEnabled(s, true, agent);
		expect(list()).toEqual(["beta:user:true", "gamma:user:true", "alpha:builtin:true"]);
		expect(enabledBuiltinDirs(agent, builtin)).toEqual([join(builtin, "alpha")]);
		// A broken state file counts as nothing turned off.
		writeFileSync(join(agent, "writer-skills.json"), "{");
		expect(disabledBuiltins(agent)).toEqual([]);
	});
});

describe("writeUserSkill / backupSkill / deleteSkill / copyBuiltinForEdit", () => {
	it("backs up before overwriting and deleting, never reuses a backup name, and copies built-ins for editing", () => {
		// First write: no backup; second write: backup of the first.
		expect(writeUserSkill("mine", "v1", agent, NOW).backup).toBe("");
		const second = writeUserSkill("mine", "v2", agent, NOW);
		expect([readFileSync(join(second.backup, "SKILL.md"), "utf-8"), readFileSync(second.path, "utf-8")]).toEqual([
			"v1",
			"v2",
		]);
		// A second backup in the same second gets a suffix.
		expect(backupSkill(join(agent, "skills", "mine"), "mine", agent, NOW)).toBe(
			join(agent, "skills-backup", "mine-20261101-210509-2"),
		);
		// Delete: backup, then gone.
		const mine = listSkills(agent, builtin).find((s) => s.name === "mine");
		if (!mine) throw new Error("mine missing");
		const backup = deleteSkill(mine, agent, NOW);
		expect([existsSync(mine.dir), readFileSync(join(backup, "SKILL.md"), "utf-8")]).toEqual([false, "v2"]);
		// A built-in is turned off instead of deleted.
		const alpha = listSkills(agent, builtin).find((s) => s.name === "alpha");
		if (!alpha) throw new Error("alpha missing");
		expect([deleteSkill(alpha, agent, NOW), disabledBuiltins(agent), existsSync(alpha.dir)]).toEqual([
			"",
			["alpha"],
			true,
		]);
		// Editing a built-in works on the user's copy.
		const copy = copyBuiltinForEdit(alpha, agent);
		expect([copy, readFileSync(join(copy, "SKILL.md"), "utf-8").includes("# 甲")]).toEqual([
			join(agent, "skills", "alpha"),
			true,
		]);
	});
});
