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
]);

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

/** Order of the levels, for taking the highest. */
const LEVEL: Readonly<Record<Risk, number>> = { read: 0, act: 1, high: 2 };

/** The higher of two levels. */
function higher(a: Risk, b: Risk): Risk {
	return LEVEL[b] > LEVEL[a] ? b : a;
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
	if (name === "git") {
		const sub = args.find((a) => !a.startsWith("-")) ?? "";
		if (GIT_HIGH.has(sub) || (sub === "branch" && args.some((a) => /^-D$|^--delete$/.test(a)))) return "high";
		if (sub === "checkout" && args.includes("--")) return "high";
		return GIT_READ.has(sub) || (sub === "branch" && args.length === 1) ? "read" : "act";
	}
	// find deletes or runs commands with these.
	if (name === "find")
		return args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a)) ? "high" : "read";
	// sed edits in place with -i.
	if (name === "sed") return args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")) ? "act" : "read";
	return READ_COMMANDS.has(name) ? "read" : "act";
}

/** The risk of a whole shell command. */
export function bashRisk(command: string): Risk {
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

/** What the gate needs for a call of bash, powershell, write or edit; undefined for any other tool. */
export function toolRequest(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	titles: { command: string; file: string; outside: string },
): (PermissionRequest & { inDirFile: boolean }) | undefined {
	if (toolName === "bash" || toolName === "powershell") {
		const command = String(input.command ?? "");
		return {
			risk: bashRisk(command),
			scope: `shell\n${resolve(cwd)}`,
			title: titles.command,
			detail: command,
			inDirFile: false,
		};
	}
	if (toolName === "write" || toolName === "edit") {
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
