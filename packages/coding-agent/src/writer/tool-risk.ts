/**
 * The risk of a shell command or a file change, from fixed tables and rules, never from the model: bash, write and
 * edit join the permission modes of permission.ts (the user's choice, 2026-11-08: permissions "the same as Claude
 * Code"). A command is split at ; && || | and new lines and takes the highest risk of its parts; what the tables do
 * not know counts as an ordinary action, so an unknown command is asked about, never let through as reading.
 */

// Paths.
import { isAbsolute, relative, resolve } from "node:path";
// The risk levels and the request the gate asks with.
import type { PermissionRequest, Risk } from "./permission.ts";

/** Commands that only read or print. */
const READ_COMMANDS = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"wc",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"stat",
	"file",
	"du",
	"df",
	"pwd",
	"echo",
	"printf",
	"date",
	"which",
	"whoami",
	"id",
	"uname",
	"tree",
	"diff",
	"cmp",
	"sort",
	"uniq",
	"cut",
	"tr",
	"jq",
	"basename",
	"dirname",
	"realpath",
	"true",
	"test",
	// Moving between folders changes nothing (2026-11-17: `cd 检索 && head -20 文件` was refused with nobody to ask).
	"cd",
	"pushd",
	"popd",
]);

/**
 * A command with its here-document bodies taken out: the lines between `<< EOF` (or `<<'EOF'`, `<<-EOF`) and the
 * terminator are data, not commands (2026-11-17: `cat >> 稿件.md << 'EOF'` with reference lines was refused, since each
 * body line was read as a command of its own).
 */
export function withoutHeredocs(command: string): string {
	const lines = command.split("\n");
	const out: string[] = [];
	let ending: string | undefined;
	for (const line of lines) {
		if (ending !== undefined) {
			if (line.replace(/^\t+/, "") === ending) ending = undefined;
			continue;
		}
		const m = /<<-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/.exec(line);
		if (m) ending = m[1] ?? m[2] ?? m[3];
		out.push(line);
	}
	return out.join("\n");
}

/** Commands that delete, move, change rights, run as another user, or stop processes and machines. */
const HIGH_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mv",
	"dd",
	"shred",
	"truncate",
	"chmod",
	"chown",
	"chgrp",
	"sudo",
	"su",
	"doas",
	"kill",
	"pkill",
	"killall",
	"shutdown",
	"reboot",
	"halt",
	"poweroff",
	"systemctl",
	"service",
	"crontab",
	"mount",
	"umount",
	"del",
	"rd",
	"remove-item",
	"move-item",
]);

/** git subcommands that only read. */
const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "grep"]);
/** git subcommands that rewrite history, discard work or publish. */
const GIT_HIGH = new Set(["push", "reset", "clean", "rebase", "filter-branch", "filter-repo"]);

/** Commands that run another command named in their arguments: the risk is that command's, never lower than an action. */
const WRAPPERS = new Set([
	"xargs",
	"env",
	"nohup",
	"nice",
	"ionice",
	"time",
	"timeout",
	"command",
	"builtin",
	"exec",
	"stdbuf",
]);
/** Shells that run the command text after -c (`sh -c "rm -rf x"` names rm only inside the text). */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Order of the levels, for taking the highest. */
const LEVEL: Readonly<Record<Risk, number>> = { read: 0, act: 1, high: 2 };

/** The higher of two levels. */
function higher(a: Risk, b: Risk): Risk {
	return LEVEL[b] > LEVEL[a] ? b : a;
}

/** The risk of a git command from its subcommand and flags. */
function gitRisk(args: readonly string[]): Risk {
	const sub = args.find((a) => !a.startsWith("-")) ?? "";
	if (GIT_HIGH.has(sub) || (sub === "branch" && args.some((a) => /^-D$|^--delete$/.test(a)))) return "high";
	if (sub === "checkout" && args.includes("--")) return "high";
	return GIT_READ.has(sub) || (sub === "branch" && args.length === 1) ? "read" : "act";
}

/** The risk named inside a wrapper's arguments: high when a word is a high command or git with a high subcommand. */
function wrappedRisk(args: readonly string[]): Risk {
	for (let i = 0; i < args.length; i++) {
		const word = (args[i].split(/[\\/]/).pop() ?? "").toLowerCase();
		if (HIGH_COMMANDS.has(word)) return "high";
		if (word === "git" && gitRisk(args.slice(i + 1)) === "high") return "high";
	}
	return "act";
}

/** The risk of one simple command (no ; && || | inside). */
function partRisk(part: string): Risk {
	// Words, without leading VAR=value assignments.
	const words = part.trim().split(/\s+/).filter(Boolean);
	while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
	if (words.length === 0) return "read";
	// The command's bare name: no path, lower case (PowerShell names are case-blind).
	const name = (words[0].split(/[\\/]/).pop() ?? "").toLowerCase();
	const args = words.slice(1);
	if (HIGH_COMMANDS.has(name)) return "high";
	if (name === "git") return gitRisk(args);
	// A wrapper runs what its arguments name (2026-11-16 review: `xargs rm`, `nohup rm`, `timeout 10 rm` counted as
	// ordinary actions, since only the first word was looked at): an action at least, high when a word names a high command.
	if (WRAPPERS.has(name)) return higher("act", wrappedRisk(args));
	// A shell with -c runs the text after it as a command line of its own.
	if (SHELLS.has(name) && args.includes("-c")) {
		const text = args
			.slice(args.indexOf("-c") + 1)
			.join(" ")
			.replace(/^["']|["']$/g, "");
		return higher("act", bashRisk(text));
	}
	// find deletes or runs commands with these.
	if (name === "find")
		return args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a)) ? "high" : "read";
	// sed edits in place with -i.
	if (name === "sed") return args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")) ? "act" : "read";
	return READ_COMMANDS.has(name) ? "read" : "act";
}

/** The risk of a whole shell command. */
export function bashRisk(given: string): Risk {
	const command = withoutHeredocs(given);
	let risk: Risk = "read";
	// Output into a file other than /dev/null writes.
	if (/(^|[^0-9&>])>{1,2}\s*(?!\/dev\/null\b)[^\s&|;]/.test(command) || /\btee\b/.test(command)) risk = "act";
	// Command substitution runs what the tables cannot see.
	if (/\$\(|`/.test(command)) risk = higher(risk, "act");
	// A download piped into a shell runs code from the network.
	if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(command)) return "high";
	for (const part of command.split(/;|&&|\|\||\||\n/)) risk = higher(risk, partRisk(part));
	return risk;
}

/** True when the path lies inside the working directory. */
export function insideDir(path: string, cwd: string): boolean {
	const rel = relative(resolve(cwd), resolve(cwd, path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Commands that create or copy files, and change nothing else, when every path they name is inside the folder. */
// mv joined on 2026-11-15: a run with nobody to ask could not sort files into subfolders (baseline P25 files).
const IN_DIR_COMMANDS = new Set(["mkdir", "cp", "touch", "mv"]);

/**
 * True when a shell command does to the working folder's files only what write does: its parts read, or create and
 * copy files inside the folder (mkdir, cp, touch with paths inside it; output redirected into a file inside it), with
 * no substitution. Such a command goes through as a write in the folder does (2026-11-14, exp-p24r1 F2: with nobody
 * to ask, `mkdir -p 备份 && cp 说明.md 备份/说明.md` was refused while write of the same file would have gone on).
 */
export function inDirCommand(given: string, cwd: string): boolean {
	const command = withoutHeredocs(given);
	// Substitution runs what the tables cannot see.
	if (/\$\(|`/.test(command)) return false;
	// Every redirection target inside the folder.
	for (const m of command.matchAll(/(?:^|[^0-9&>])>{1,2}\s*([^\s&|;]+)/g))
		if (m[1] !== "/dev/null" && (/^["']?[~$]/.test(m[1]) || !insideDir(m[1].replace(/^["']|["']$/g, ""), cwd)))
			return false;
	// Every part a reading command or an in-folder file command.
	for (const raw of command.split(/;|&&|\|\||\||\n/)) {
		const part = raw.replace(/(?:^|[^0-9&>])>{1,2}\s*[^\s&|;]+/g, " ");
		if (partRisk(part) === "read") continue;
		const words = part.trim().split(/\s+/).filter(Boolean);
		while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
		const name = (words[0]?.split(/[\\/]/).pop() ?? "").toLowerCase();
		if (!IN_DIR_COMMANDS.has(name)) return false;
		const paths = words.slice(1).filter((w) => !w.startsWith("-"));
		if (paths.length === 0) return false;
		for (const p of paths) {
			const bare = p.replace(/^["']|["']$/g, "");
			if (/^[~$]/.test(bare) || /[*?]/.test(bare) || !insideDir(bare, cwd)) return false;
		}
	}
	return true;
}

/** What the gate needs for a call of bash, powershell, write or edit; undefined for any other tool. */
export function toolRequest(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	titles: { command: string; file: string; outside: string },
): (PermissionRequest & { inDirFile: boolean }) | undefined {
	if (toolName === "bash" || toolName === "powershell") {
		const command = String(input.command ?? "");
		const risk = bashRisk(command);
		// A command that only creates, copies or moves files inside the folder counts as a write there (mv is high on
		// its own, since it can move files out; inside the folder it is an ordinary action, as a write is, so that auto
		// mode's judge decides it rather than the user being asked every time while a run with nobody to ask lets it through).
		const inDir = risk !== "read" && inDirCommand(command, cwd);
		return {
			risk: inDir ? "act" : risk,
			scope: `shell\n${resolve(cwd)}`,
			title: titles.command,
			detail: command,
			inDirFile: inDir,
		};
	}
	// draft_section writes the draft at its path as write does.
	if (toolName === "write" || toolName === "edit" || toolName === "draft_section") {
		const path = String(input.path ?? "");
		const inside = insideDir(path, cwd);
		return {
			risk: inside ? "act" : "high",
			scope: `files\n${resolve(cwd)}`,
			title: inside ? titles.file : titles.outside,
			detail: resolve(cwd, path),
			inDirFile: inside,
		};
	}
	return undefined;
}
